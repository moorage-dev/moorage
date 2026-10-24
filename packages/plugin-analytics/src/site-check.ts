// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { enabledTools, isExcluded, type AnalyticsConfig } from "./config.js";
import { TOOL_NAMES, type ToolId } from "./ids.js";
import { fetchOwnSite } from "./self-fetch.js";

/**
 * "Check what loads": the site's own home page and a few more, fetched as a
 * visitor gets them, searched for the common things that load outside this
 * plugin and so before anyone is asked.
 *
 * - Tracking code pasted into a page (an HTML block, the theme): the same tool
 *   this plugin adds, which then counts twice, or another one.
 * - Embedded videos, maps, booking boxes, social posts and chat boxes that set
 *   cookies as soon as the page shows.
 *
 * It is a check against a short list, not a cookie scanner: it never runs the
 * pages' scripts and cannot see what loads later or only for some visitors.
 * The admin page says so. Only this site's own address is fetched, without the
 * admin's cookie, and only links that stay on it are followed.
 */

export const SITE_CHECK_KEY = "site-check";
/** Pages besides the home page. */
export const MORE_PAGES = 4;
const TIMEOUT_MS = 8000;
const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;

export type FindingKind = "twice" | "pasted" | "embed" | "missing";

export interface Finding {
	kind: FindingKind;
	title: string;
	advice: string;
}

export interface SiteCheck {
	/** When it ran, ISO 8601. */
	at: string;
	origin: string;
	/** Each page asked for, and its answer (null when there was none). */
	pages: Array<{ path: string; status: number | null }>;
	/** What was found, and on which pages. */
	findings: Array<Finding & { pages: string[] }>;
	/** Why nothing could be checked, in plain words. */
	problem?: string;
}

// ── Reading a page ──────────────────────────────────────────

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const NOSCRIPT = /<noscript\b[^>]*>([\s\S]*?)<\/noscript\s*>/gi;
const EMBED_TAG = /<(?:script|iframe|embed|object|img)\b[^>]*>/gi;
const SRC = /\b(?:src|data)\s*=\s*["']([^"']+)["']/i;

interface PageParts {
	/** Inline script text, script and iframe tags, noscript content: where tracking code lives. */
	code: string;
	/** Addresses of scripts, frames and embedded objects. */
	sources: string[];
	/** Whether this plugin's own script is on the page. */
	ours: boolean;
}

function parts(html: string, pluginId: string): PageParts {
	const marker = `/_emdash/api/plugins/${pluginId}/`;
	const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
	let ours = false;
	const code: string[] = [];
	const rest = withoutComments.replace(SCRIPT, (_whole, attributes: string, body: string) => {
		// This plugin's own script names every tool it loads: never count it.
		if (body.includes(marker)) {
			ours = true;
			return "";
		}
		// Page data (structured data for search engines) names videos without loading them.
		if (/\btype\s*=\s*["']?application\/(?:ld\+)?json/i.test(attributes)) return "";
		code.push(`<script${attributes}>`, body);
		return `<script${attributes}></script>`;
	});
	for (const match of rest.matchAll(NOSCRIPT)) code.push(match[1] ?? "");
	const sources: string[] = [];
	for (const match of rest.matchAll(EMBED_TAG)) {
		const tag = match[0];
		if (!/^<img/i.test(tag)) code.push(tag);
		const src = SRC.exec(tag)?.[1];
		if (src && !/^<img/i.test(tag)) sources.push(src.replace(/&amp;/g, "&"));
	}
	return { code: code.join("\n"), sources, ours };
}

// ── Tracking code ───────────────────────────────────────────

interface ToolRule {
	tool: ToolId;
	/** Code that loads the tool. */
	present: RegExp;
	/** Where its ID sits; the first group is the ID. */
	ids: RegExp[];
	/** IDs that belong to this tool (gtag.js carries Analytics and Ads IDs alike). */
	accept?: RegExp;
}

const TOOL_RULES: ToolRule[] = [
	{
		tool: "gtm",
		present: /googletagmanager\.com\/(?:gtm\.js|ns\.html)|['"]GTM-[A-Z0-9]{4,12}['"]/i,
		ids: [
			/googletagmanager\.com\/(?:gtm\.js|ns\.html)\?id=(GTM-[A-Z0-9]{4,12})/gi,
			/['"](GTM-[A-Z0-9]{4,12})['"]/g,
		],
	},
	{
		tool: "ga4",
		present: /googletagmanager\.com\/gtag\/js\?id=G-|gtag\(\s*['"]config['"]\s*,\s*['"]G-/i,
		ids: [
			/googletagmanager\.com\/gtag\/js\?id=(G-[A-Z0-9]{4,20})/gi,
			/gtag\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]{4,20})['"]/gi,
		],
	},
	{
		tool: "ads",
		present: /googletagmanager\.com\/gtag\/js\?id=AW-|gtag\(\s*['"]config['"]\s*,\s*['"]AW-/i,
		ids: [
			/googletagmanager\.com\/gtag\/js\?id=(AW-[0-9]{6,15})/gi,
			/gtag\(\s*['"]config['"]\s*,\s*['"](AW-[0-9]{6,15})['"]/gi,
		],
	},
	{
		tool: "meta",
		present:
			/connect\.facebook\.net\/[^"'\s]*\/fbevents\.js|fbq\(\s*['"]init['"]|facebook\.com\/tr\?id=/i,
		ids: [/fbq\(\s*['"]init['"]\s*,\s*['"](\d{10,20})['"]/g, /facebook\.com\/tr\?id=(\d{10,20})/g],
	},
	{
		tool: "clarity",
		present: /clarity\.ms\/tag/i,
		ids: [
			/clarity\.ms\/tag\/([a-z0-9]{8,14})\b/gi,
			/["']clarity["']\s*,\s*["']script["']\s*,\s*["']([a-z0-9]{8,14})["']/gi,
		],
	},
	{
		tool: "hubspot",
		present: /hs-scripts\.com\//i,
		ids: [/hs-scripts\.com\/(\d{5,12})\.js/gi],
	},
	{
		tool: "cloudflare",
		present: /static\.cloudflareinsights\.com\/beacon(?:\.min)?\.js/i,
		ids: [/["']?token["']?\s*:\s*["']([a-f0-9]{32})["']/gi],
	},
];

interface OtherRule {
	name: string;
	present: RegExp;
	title?: string;
	advice?: string;
}

const LATER =
	"It loads before anyone is asked, and this plugin cannot hold it back. Remove it, or use one of the tools on the Tracking tools tab instead.";

/** Tracking tools this plugin does not add. Kept short: the ones small sites paste most. */
const OTHER_TRACKERS: OtherRule[] = [
	{
		name: "Universal Analytics",
		present: /google-analytics\.com\/(?:analytics|ga)\.js|['"]UA-\d{4,10}-\d{1,4}['"]/i,
		title: "An old Google Analytics tag (Universal Analytics) is pasted into your pages",
		advice:
			"Google switched it off in 2023, so it counts nothing, but it still loads Google's code before anyone is asked. Remove it.",
	},
	{ name: "Hotjar", present: /static\.hotjar\.com|hotjar\.com\/c\/hotjar-/i },
	{ name: "TikTok Pixel", present: /analytics\.tiktok\.com/i },
	{ name: "LinkedIn Insight Tag", present: /snap\.licdn\.com/i },
	{ name: "Pinterest Tag", present: /s\.pinimg\.com\/ct\//i },
	{ name: "X (Twitter) Pixel", present: /static\.ads-twitter\.com/i },
	{ name: "Microsoft Advertising (UET)", present: /bat\.bing\.com\/bat\.js/i },
	{
		name: "Google AdSense",
		present: /pagead2\.googlesyndication\.com/i,
		title: "Google ads (AdSense) are on your pages",
		advice:
			"Google requires a Google-certified consent tool for ads on your own pages, and this cookie banner is not one. Remove the ad code, or use a certified consent tool for the whole site instead.",
	},
];

// ── Embeds ──────────────────────────────────────────────────

interface EmbedRule {
	title: string;
	match: (src: string) => boolean;
	advice: string;
}

const LINK_INSTEAD =
	"Link to it instead of embedding it, or use a picture that links to it: then it only loads for visitors who choose to open it.";
const SOCIAL = "Link to the post instead, or use a screenshot that links to it.";
const CHAT =
	"Chat boxes usually set cookies as they load. Look in the chat tool's own settings for a way to wait for consent, or show a button that opens the chat.";

const has = (pattern: RegExp) => (src: string) => pattern.test(src);

const EMBED_RULES: EmbedRule[] = [
	{
		title: "A YouTube video sets cookies before visitors answer",
		match: has(/\/\/(?:www\.|m\.)?youtube\.com\/embed\//i),
		advice:
			"Change the video's address from youtube.com/embed/ to youtube-nocookie.com/embed/. The video plays the same, and YouTube sets no cookies until it is played.",
	},
	{
		title: "A Vimeo video tracks visitors",
		match: (src) => /player\.vimeo\.com\/video\//i.test(src) && !/[?&]dnt=(?:1|true)\b/i.test(src),
		advice:
			"Add ?dnt=1 to the end of the Vimeo address (or &dnt=1 if it already has a ?). Vimeo then sets no tracking cookies.",
	},
	{
		title: "A Google map sets cookies before visitors answer",
		match: has(
			/google\.[a-z.]+\/maps\/(?:embed|d\/embed)|maps\.google\.[a-z.]+\/maps\?[^"']*output=embed|maps\.googleapis\.com\/maps\/api\/js/i,
		),
		advice:
			"Google Maps sets cookies as soon as the map shows. Use a picture of the map that links to Google Maps instead: visitors who click choose to go there.",
	},
	{
		title: "A Calendly booking box sets cookies before visitors answer",
		match: has(/(?:^|\/\/)(?:assets\.)?calendly\.com\//i),
		advice:
			"Link to your Calendly page instead of embedding it, so it only loads when a visitor chooses to book.",
	},
	{
		title: "A Facebook post or button sets cookies before visitors answer",
		match: has(/facebook\.com\/plugins\/|connect\.facebook\.net\/[^"'\s]*\/sdk\.js/i),
		advice: SOCIAL,
	},
	{
		title: "An Instagram post sets cookies before visitors answer",
		match: has(/instagram\.com\/(?:embed\.js|p\/[^"'\s]*\/embed|reel\/[^"'\s]*\/embed)/i),
		advice: SOCIAL,
	},
	{
		title: "A TikTok video sets cookies before visitors answer",
		match: has(/tiktok\.com\/(?:embed|player)/i),
		advice: SOCIAL,
	},
	{
		title: "An X (Twitter) post sets cookies before visitors answer",
		match: has(/platform\.(?:twitter|x)\.com\/widgets\.js/i),
		advice: SOCIAL,
	},
	{
		title: "A Typeform form sets cookies before visitors answer",
		match: has(/(?:embed|form)\.typeform\.com|\.typeform\.com\/to\//i),
		advice: LINK_INSTEAD,
	},
	{
		title: "A Spotify player sets cookies before visitors answer",
		match: has(/open\.spotify\.com\/embed/i),
		advice: LINK_INSTEAD,
	},
	{
		title: "A SoundCloud player sets cookies before visitors answer",
		match: has(/w\.soundcloud\.com\/player/i),
		advice: LINK_INSTEAD,
	},
	{
		title: "Disqus comments set cookies before visitors answer",
		match: has(/\.disqus\.com\/embed\.js/i),
		advice:
			"Disqus loads its own tracking with the comments. Show the comments only after a click, or use EmDash's own comments instead.",
	},
	{
		title: "A chat box sets cookies before visitors answer",
		match: has(
			/embed\.tawk\.to|widget\.intercom\.io|js\.intercomcdn\.com|client\.crisp\.chat|static\.zdassets\.com|js\.driftt\.com/i,
		),
		advice: CHAT,
	},
];

// ── One page ────────────────────────────────────────────────

function idsOf(code: string, rule: ToolRule): string[] {
	const found = new Set<string>();
	for (const pattern of rule.ids) {
		for (const match of code.matchAll(pattern)) {
			const id = match[1];
			if (!id) continue;
			found.add(
				rule.tool === "clarity" || rule.tool === "cloudflare" ? id.toLowerCase() : id.toUpperCase(),
			);
		}
	}
	return [...found];
}

/**
 * What one page loads outside this plugin, in the order the admin shows it:
 * tracking that counts twice, other pasted tracking, then embeds.
 */
export function scanPage(html: string, config: AnalyticsConfig, pluginId: string): Finding[] {
	const { code, sources, ours } = parts(html, pluginId);
	const twice: Finding[] = [];
	const pasted: Finding[] = [];
	for (const rule of TOOL_RULES) {
		if (!rule.present.test(code)) continue;
		const name = TOOL_NAMES[rule.tool];
		const mine = config.tools[rule.tool];
		const ids = idsOf(code, rule);
		const same =
			mine !== "" && (ids.length === 0 ? rule.tool !== "cloudflare" : ids.includes(mine));
		if (same) {
			twice.push({
				kind: "twice",
				title: `${name} is added twice`,
				advice: `Your pages also have ${name} code pasted into them (in an HTML block or the theme) with the same ID as on the Tracking tools tab. Remove the pasted code: Analytics adds it for you, and only after a visitor agrees. Until then every visit is counted twice, and the pasted code loads before anyone is asked.`,
			});
		}
		const others = ids.filter((id) => id !== mine);
		if (others.length || (!same && ids.length === 0)) {
			if (rule.tool === "cloudflare") {
				// Cookie-free counting is allowed without asking; only a second copy is worth a word.
				if (!mine) continue;
			}
			pasted.push({
				kind: "pasted",
				title: `${name}${others.length ? ` (${others.join(", ")})` : ""} is pasted into your pages`,
				advice:
					rule.tool === "cloudflare"
						? "Cloudflare Web Analytics is also added outside this plugin, perhaps by Cloudflare itself (its automatic setup). It sets no cookies, but visits may be counted twice. Keep one: turn off the automatic setup in Cloudflare, or empty the box on the Tracking tools tab."
						: `It loads without waiting for the cookie banner. Remove the pasted code${mine ? "" : `, and if you still need ${name}, paste its ID on the Tracking tools tab instead`}.`,
			});
		}
	}
	for (const rule of OTHER_TRACKERS) {
		if (!rule.present.test(code)) continue;
		pasted.push({
			kind: "pasted",
			title: rule.title ?? `${rule.name} is pasted into your pages`,
			advice: rule.advice ?? LATER,
		});
	}
	const embeds: Finding[] = [];
	for (const rule of EMBED_RULES) {
		if (sources.some((src) => rule.match(src))) {
			embeds.push({ kind: "embed", title: rule.title, advice: rule.advice });
		}
	}
	const missing: Finding[] =
		!ours && enabledTools(config).length > 0
			? [
					{
						kind: "missing",
						title: "Analytics' own code is not on this page",
						advice:
							"If you added a tool in the last few minutes, wait for cached pages to refresh and check again. Otherwise the site's theme may not include EmDash's page head, which this plugin needs.",
					},
				]
			: [];
	return [...twice, ...pasted, ...embeds, ...missing];
}

// ── Which pages ─────────────────────────────────────────────

const FILE =
	/\.(?:pdf|jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|json|xml|txt|zip|mp4|mp3|webm|woff2?)$/i;

function samePath(href: string, origin: string): string | null {
	let url: URL;
	try {
		url = new URL(href.replace(/&amp;/g, "&"), `${origin}/`);
	} catch {
		return null;
	}
	if (url.origin !== origin) return null;
	const path = url.pathname;
	if (path === "/" || path === "/_emdash" || path.startsWith("/_emdash/") || FILE.test(path))
		return null;
	return path;
}

/**
 * Up to `max` more pages to check: the home page's own links in order (the menu
 * usually comes first), then the sitemap's. Only this site, never the admin or files.
 */
export function pagesToCheck(
	homeHtml: string,
	origin: string,
	sitemapXml = "",
	max = MORE_PAGES,
): string[] {
	const found: string[] = [];
	const add = (href: string) => {
		const path = samePath(href, origin);
		if (path && !found.includes(path) && found.length < max) found.push(path);
	};
	// Links in the page itself, not ones a script writes (the banner's own policy link, for one).
	const markup = homeHtml.replace(/<!--[\s\S]*?-->/g, "").replace(SCRIPT, "");
	for (const match of markup.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)) {
		const href = match[1]!;
		if (/^(?:mailto|tel|javascript|data):/i.test(href)) continue;
		add(href);
	}
	for (const match of sitemapXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) add(match[1]!);
	return found;
}

// ── Fetching ────────────────────────────────────────────────

export interface CheckOptions {
	fetchImpl?: typeof fetch;
	now?: Date;
	timeoutMs?: number;
}

interface Fetched {
	status: number | null;
	html: string | null;
	/** The connection failed or took too long. */
	failed?: boolean;
}

async function readCapped(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size < MAX_BYTES) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		size += value.byteLength;
	}
	await reader.cancel().catch(() => {});
	const all = new Uint8Array(Math.min(size, MAX_BYTES));
	let offset = 0;
	for (const chunk of chunks) {
		const room = all.length - offset;
		if (room <= 0) break;
		all.set(chunk.subarray(0, room), offset);
		offset += Math.min(chunk.byteLength, room);
	}
	return new TextDecoder().decode(all);
}

/** One page, as a visitor gets it. Redirects are followed by hand, and only on this site. */
async function fetchPage(
	origin: string,
	path: string,
	fetchImpl: typeof fetch,
	timeoutMs: number,
	accept = "text/html,application/xhtml+xml",
): Promise<Fetched> {
	let current = path;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		let response: Response;
		try {
			response = await fetchOwnSite(
				origin,
				current,
				{ headers: { accept }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) },
				fetchImpl,
			);
		} catch {
			return { status: null, html: null, failed: true };
		}
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			await response.body?.cancel().catch(() => {});
			let next: URL;
			try {
				next = new URL(location, new URL(current, origin));
			} catch {
				return { status: response.status, html: null };
			}
			if (next.origin !== origin) return { status: response.status, html: null };
			current = next.pathname + next.search;
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			return { status: response.status, html: null };
		}
		const type = response.headers.get("content-type") ?? "";
		if (accept.startsWith("text/html") && !/html/i.test(type)) {
			await response.body?.cancel().catch(() => {});
			return { status: response.status, html: null };
		}
		try {
			return { status: response.status, html: await readCapped(response) };
		} catch {
			return { status: response.status, html: null, failed: true };
		}
	}
	return { status: null, html: null };
}

/** Check the home page and up to four more, and gather what was found by page. */
export async function checkSite(
	origin: string,
	config: AnalyticsConfig,
	pluginId: string,
	{ fetchImpl = fetch, now = new Date(), timeoutMs = TIMEOUT_MS }: CheckOptions = {},
): Promise<SiteCheck> {
	const result: SiteCheck = { at: now.toISOString(), origin, pages: [], findings: [] };
	const home = await fetchPage(origin, "/", fetchImpl, timeoutMs);
	result.pages.push({ path: "/", status: home.status });
	if (home.failed || home.status === null) {
		result.problem = `Your site could not open its own address (${origin}) from the server, so nothing was checked. Some setups do not let a site call itself. Open your pages in a private window instead, and look for videos, maps and pasted code.`;
		return result;
	}
	if (home.html === null) {
		result.problem = `Your home page answered with an error (${home.status}), so nothing was checked. Open ${origin}/ to see why. A login or a bot check in front of the site stops this check too.`;
		return result;
	}
	let more = pagesToCheck(home.html, origin);
	if (more.length < MORE_PAGES) {
		const sitemap = await fetchPage(
			origin,
			"/sitemap.xml",
			fetchImpl,
			timeoutMs,
			"application/xml,text/xml",
		);
		if (sitemap.html) more = pagesToCheck(home.html, origin, sitemap.html);
	}
	const fetched = await Promise.all(
		more.map((path) => fetchPage(origin, path, fetchImpl, timeoutMs)),
	);
	const scanned: Array<[string, string]> = [["/", home.html]];
	more.forEach((path, index) => {
		const page = fetched[index]!;
		result.pages.push({ path, status: page.status });
		if (page.html !== null) scanned.push([path, page.html]);
	});
	const byTitle = new Map<string, Finding & { pages: string[] }>();
	for (const [path, html] of scanned) {
		for (const finding of scanPage(html, config, pluginId)) {
			// A page left out under Advanced has no Analytics code on purpose.
			if (finding.kind === "missing" && isExcluded(path, config.exclude)) continue;
			const seen = byTitle.get(finding.title);
			if (seen) seen.pages.push(path);
			else byTitle.set(finding.title, { ...finding, pages: [path] });
		}
	}
	const order: FindingKind[] = ["twice", "pasted", "embed", "missing"];
	// A fresh copy is sorted; nothing shared changes.
	// oxlint-disable-next-line unicorn/no-array-sort
	result.findings = [...byTitle.values()].sort(
		(a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
	);
	return result;
}

/** A stored check, or null when there is none or it is not one. */
export function readSiteCheck(value: unknown): SiteCheck | null {
	if (typeof value !== "object" || value === null) return null;
	const check = value as Partial<SiteCheck>;
	if (typeof check.at !== "string" || !Array.isArray(check.pages) || !Array.isArray(check.findings))
		return null;
	return check as SiteCheck;
}
