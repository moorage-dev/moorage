// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// "Copy imported WordPress SEO values" as it runs in the site's process (plugins: [seo]), the only
// place EmDash 1.4.0 lets a plugin write the SEO panel. The sandbox harness the other tests use
// refuses `seo` on content.update (as the real sandbox runners do), so the copy itself is tested
// here against a small stand-in for EmDash, which also counts the calls each step makes.

import type { PluginContext } from "emdash";
import { describe, expect, it } from "vitest";

import { SANDBOX_CALLS, SCAN_KEY } from "../src/scan.js";
import {
	closeCopy,
	COPY_KEY,
	COPY_TASK,
	copiedMessage,
	copyScope,
	copyStep,
	countStep,
	newCopyJob,
	type CopyJob,
} from "../src/wordpress-copy.js";
import { planCopy, stripSiteName } from "../src/wordpress.js";

interface Entry {
	id: string;
	status: string;
	data: Record<string, unknown>;
	seo: { title: string | null; description: string | null };
}

class Site {
	entries = new Map<string, Entry[]>();
	kv = new Map<string, unknown>();
	calls: string[] = [];
	cron: string[] = [];
	/** Refuse `seo` on update, as EmDash 1.4.0's sandbox runners do. */
	sandboxed = false;
	pageSize = 100;

	add(collection: string, entry: Partial<Entry> & { id: string }): Entry {
		const full: Entry = {
			status: "published",
			data: {},
			seo: { title: null, description: null },
			...entry,
		};
		this.entries.set(collection, [...(this.entries.get(collection) ?? []), full]);
		return full;
	}

	find(collection: string, id: string): Entry {
		const entry = this.entries.get(collection)?.find((item) => item.id === id);
		if (!entry) throw new Error(`no ${collection}/${id}`);
		return entry;
	}

	ctx(): PluginContext {
		const call = (name: string) => this.calls.push(name);
		return {
			kv: {
				get: async (key: string) => {
					call("kvGet");
					return structuredClone(this.kv.get(key) ?? null);
				},
				set: async (key: string, value: unknown) => {
					call("kvSet");
					this.kv.set(key, structuredClone(value));
				},
				delete: async (key: string) => {
					call("kvDelete");
					return this.kv.delete(key);
				},
			},
			cron: {
				schedule: async (name: string) => {
					call("cronSchedule");
					this.cron.push(`schedule ${name}`);
				},
				cancel: async (name: string) => {
					call("cronCancel");
					this.cron.push(`cancel ${name}`);
				},
			},
			content: {
				list: async (collection: string, options: { limit?: number; cursor?: string } = {}) => {
					call("contentList");
					const all = this.entries.get(collection) ?? [];
					const limit = Math.min(options.limit ?? 50, this.pageSize);
					const start = Number(options.cursor ?? 0);
					const items = all.slice(start, start + limit).map((entry) => structuredClone(entry));
					const next = start + limit;
					return {
						items,
						hasMore: next < all.length,
						...(next < all.length ? { cursor: String(next) } : {}),
					};
				},
				update: async (collection: string, id: string, input: Record<string, unknown>) => {
					call("contentUpdate");
					if (this.sandboxed) throw new Error(`Unknown field 'seo' in collection '${collection}'`);
					const entry = this.find(collection, id);
					const seo = (input.seo ?? {}) as Partial<Entry["seo"]>;
					// As EmDash's SeoRepository.upsert: only the fields given are written.
					entry.seo = { ...entry.seo, ...seo };
					return entry;
				},
			},
		} as unknown as PluginContext;
	}
}

const wordpress = (id: string, title: string, seoTitle: string, seoDescription: string) => ({
	id,
	data: { title, seo_title: seoTitle, seo_description: seoDescription },
});

/** A site just moved from WordPress: three posts, one page whose panel already has its own. */
function moved(): Site {
	const site = new Site();
	site.add("posts", wordpress("p1", "Sourdough", "Our first sourdough | Harbour Bakery", "Bread."));
	site.add("posts", wordpress("p2", "Rye", "", "Dark rye, every Friday."));
	site.add("posts", {
		...wordpress("p3", "Opening hours", "New opening hours - Harbour Bakery", ""),
		status: "draft",
	});
	site.add("pages", {
		...wordpress("a1", "About us", "Our story | Harbour Bakery", "Family bakers."),
		seo: { title: null, description: "Written by hand." },
	});
	site.add("pages", { id: "a2", data: { title: "Contact" } });
	return site;
}

const run = async (site: Site, step: () => Promise<CopyJob>) => {
	site.calls = [];
	const job = await step();
	return { job, calls: [...site.calls] };
};

const collection = (slug: string, hasSeo: boolean, fields: string[]) =>
	({ slug, hasSeo, fields: fields.map((field) => ({ slug: field })) }) as never;

// What one click on the SEO page may spend: all but loadData's two reads (no redirects list).
const CLICK = SANDBOX_CALLS - 2;

describe("planning the copy", () => {
	it("leaves the site's name off the end of a title, whichever separator WordPress used", () => {
		for (const title of [
			"Our story | Harbour Bakery",
			"Our story - Harbour Bakery",
			"Our story – harbour bakery ",
			"Our story » Harbour Bakery",
		]) {
			expect(stripSiteName(title, "Harbour Bakery")).toBe("Our story");
		}
		// Only at the end, and never down to nothing.
		expect(stripSiteName("Harbour Bakery | Our story", "Harbour Bakery")).toBe(
			"Harbour Bakery | Our story",
		);
		expect(stripSiteName("Harbour Bakery", "Harbour Bakery")).toBe("Harbour Bakery");
		expect(stripSiteName("Our story | Harbour Bakery", "")).toBe("Our story | Harbour Bakery");
		// The name in the SEO settings and EmDash's own name may differ: either is left off.
		expect(
			stripSiteName("Our story | Harbour Bakery", ["Harbour Bakery Ltd", "Harbour Bakery"]),
		).toBe("Our story");
	});

	it("never plans to write over a value in the SEO panel", () => {
		const data = { title: "About", seo_title: "Our story", seo_description: "Bakers." };
		expect(planCopy({ data, seo: { title: "Mine", description: null }, title: "About" })).toEqual({
			description: "Bakers.",
			own: true,
		});
		expect(
			planCopy({ data, seo: { title: "Our story", description: "Bakers." }, title: "About" }),
		).toEqual({ own: false });
		expect(planCopy({ data, seo: undefined, title: "About" })).toBeNull();
	});

	it("covers only collections with the SEO panel and an imported field", () => {
		expect(
			copyScope([
				collection("posts", true, ["title", "seo_title", "seo_description"]),
				collection("pages", true, ["title", "seo_description"]),
				collection("events", false, ["seo_title"]),
				collection("team", true, ["title"]),
			]),
		).toEqual(["posts", "pages"]);
	});
});

describe("counting before copying", () => {
	it("counts what would change, writes no value, and checks once that EmDash accepts the write", async () => {
		const site = moved();
		const { job, calls } = await run(site, () =>
			countStep(site.ctx(), newCopyJob(["posts", "pages"], ["Harbour Bakery"]), CLICK),
		);
		expect(job.status).toBe("counted");
		expect(job.writable).toBe(true);
		// p1 (both), p2 (description), p3 (title, a draft too); a1 keeps its own description.
		expect(job.found).toEqual({ pages: 4, titles: 3, descriptions: 2, own: 1 });
		expect(job.sample[0]).toEqual({
			page: "Sourdough",
			title: "Our first sourdough",
			description: "Bread.",
		});
		expect(calls).toEqual(["contentList", "contentUpdate", "contentList", "kvSet"]);
		expect(site.find("posts", "p1").seo).toEqual({ title: null, description: null });
		expect(site.kv.get(COPY_KEY)).toEqual(job);
	});

	it("finds out a sandboxed plugin may not write the SEO panel, and changes nothing", async () => {
		const site = moved();
		site.sandboxed = true;
		const job = await countStep(
			site.ctx(),
			newCopyJob(["posts", "pages"], ["Harbour Bakery"]),
			CLICK,
		);
		expect(job).toMatchObject({ status: "counted", writable: false });
		expect(job.found.pages).toBe(4);
	});

	it("counts a large site over several clicks, each within the sandbox's calls", async () => {
		const site = new Site();
		for (let index = 0; index < 950; index += 1) {
			site.add("posts", wordpress(`p${index}`, `Post ${index}`, "", "A description."));
		}
		let job = newCopyJob(["posts"], ["Acme"]);
		let clicks = 0;
		while (job.status === "counting") {
			const step = await run(site, () => countStep(site.ctx(), job, CLICK));
			expect(step.calls.length).toBeLessThanOrEqual(CLICK);
			job = step.job;
			clicks += 1;
		}
		expect(clicks).toBe(2);
		expect(job.found.pages).toBe(950);
		expect(job.sample).toHaveLength(10);
	});
});

async function counted(site: Site): Promise<CopyJob> {
	return countStep(site.ctx(), newCopyJob(["posts", "pages"], ["Harbour Bakery"]), CLICK);
}

/** The click, then background runs until the copy is over; every run within its calls. */
async function copyAll(site: Site, job: CopyJob): Promise<CopyJob> {
	let current = (await run(site, () => copyStep(site.ctx(), job, CLICK, { scheduled: false }))).job;
	expect(site.calls.length).toBeLessThanOrEqual(CLICK);
	while (current.status === "copying") {
		const step = await run(site, () => copyStep(site.ctx(), current, SANDBOX_CALLS - 1));
		expect(step.calls.length + 1).toBeLessThanOrEqual(SANDBOX_CALLS);
		current = step.job;
	}
	return current;
}

describe("copying", () => {
	it("fills only empty SEO panel fields, without the site's name, and the pages are checked again", async () => {
		const site = moved();
		site.kv.set(SCAN_KEY, { status: "done" });
		const done = await copyAll(site, await counted(site));
		expect(done.status).toBe("done");
		expect(site.find("posts", "p1").seo).toEqual({
			title: "Our first sourdough",
			description: "Bread.",
		});
		expect(site.find("posts", "p2").seo).toEqual({
			title: null,
			description: "Dark rye, every Friday.",
		});
		expect(site.find("posts", "p3").seo).toEqual({ title: "New opening hours", description: null });
		// Its own description stays; the title it lacked is filled in.
		expect(site.find("pages", "a1").seo).toEqual({
			title: "Our story",
			description: "Written by hand.",
		});
		expect(site.find("pages", "a2").seo).toEqual({ title: null, description: null });
		expect(done.copied).toEqual({ pages: 4, titles: 3, descriptions: 2, own: 1 });
		expect(copiedMessage(done)).toBe(
			"Copied 2 descriptions and 3 titles into the SEO panel. 1 page already had its own, which was kept.",
		);
		// The records still describe the pages as they were, so the check starts again.
		expect(site.kv.has(SCAN_KEY)).toBe(false);
		expect(site.cron).toEqual([`schedule ${COPY_TASK}`, `cancel ${COPY_TASK}`]);
	});

	it("never writes over a value put in the SEO panel after the count", async () => {
		const site = moved();
		const job = await counted(site);
		site.find("posts", "p2").seo.description = "An editor wrote this meanwhile.";
		const done = await copyAll(site, job);
		expect(site.find("posts", "p2").seo.description).toBe("An editor wrote this meanwhile.");
		expect(done.copied.descriptions).toBe(1);
		expect(done.copied.own).toBe(2);
	});

	it("copies what fits in the click and the rest in the background, each run within the calls", async () => {
		const site = new Site();
		for (let index = 0; index < 12; index += 1) {
			site.add("posts", wordpress(`p${index}`, `Post ${index}`, `Title ${index} | Acme`, "Words."));
		}
		const job = await countStep(site.ctx(), newCopyJob(["posts"], ["Acme"]), CLICK);
		const first = await run(site, () => copyStep(site.ctx(), job, CLICK, { scheduled: false }));
		expect(first.job.status).toBe("copying");
		expect(first.calls.length).toBeLessThanOrEqual(CLICK);
		expect(first.job.copied.pages).toBe(3);
		expect(site.cron).toEqual([`schedule ${COPY_TASK}`]);

		// Each background run reads the copy (one call) and continues it with the rest.
		let current = first.job;
		let runs = 0;
		while (current.status === "copying") {
			const step = await run(site, () => copyStep(site.ctx(), current, SANDBOX_CALLS - 1));
			expect(step.calls.length + 1).toBeLessThanOrEqual(SANDBOX_CALLS);
			current = step.job;
			runs += 1;
		}
		expect(runs).toBe(3);
		expect(current.copied).toEqual({ pages: 12, titles: 12, descriptions: 12, own: 0 });
		expect(site.cron).toEqual([`schedule ${COPY_TASK}`, `cancel ${COPY_TASK}`]);
		for (let index = 0; index < 12; index += 1) {
			expect(site.find("posts", `p${index}`).seo.title).toBe(`Title ${index}`);
		}
	});

	it("stops at the first refusal and says which page", async () => {
		const site = moved();
		const job = await counted(site);
		site.sandboxed = true;
		const stopped = await copyStep(site.ctx(), job, CLICK, { scheduled: false });
		expect(stopped.status).toBe("failed");
		expect(stopped.error).toBe("Sourdough: Unknown field 'seo' in collection 'posts'");
		expect(stopped.copied.pages).toBe(0);
	});

	it("stopping part-way ends the background task and has the pages checked again", async () => {
		const site = new Site();
		for (let index = 0; index < 12; index += 1) {
			site.add("posts", wordpress(`p${index}`, `Post ${index}`, "", "Words."));
		}
		site.kv.set(SCAN_KEY, { status: "done" });
		const job = await countStep(site.ctx(), newCopyJob(["posts"], ["Acme"]), CLICK);
		const copying = await copyStep(site.ctx(), job, CLICK, { scheduled: false });
		site.kv.set(SCAN_KEY, { status: "done" });
		site.calls = [];
		await closeCopy(site.ctx(), copying);
		expect(site.calls).toEqual(["cronCancel", "kvDelete", "kvDelete"]);
		expect(site.kv.has(COPY_KEY)).toBe(false);
		expect(site.kv.has(SCAN_KEY)).toBe(false);
	});
});
