// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { RouteContext } from "emdash";
import { describe, expect, it } from "vitest";

import { CONFIG_KEY, normalizeConfig } from "../src/config.js";
import { clientConfig } from "../src/fragment.js";
import { createPlugin } from "../src/index.js";
import { ENGLISH, knownLanguage, LANGUAGES, wordsCode, wordsFor } from "../src/words.js";
import { fakeContext } from "./helpers.js";

const GA = { tools: { ga4: "G-AB12CD34EF" } };
const BOTH = { tools: { ga4: "G-AB12CD34EF", meta: "123456789012345" } };

describe("the banner's languages", () => {
	it("knows German, French, Spanish, Italian, Dutch and Portuguese, from the page's lang", () => {
		expect(Object.keys(LANGUAGES).sort()).toEqual(["de", "es", "fr", "it", "nl", "pt"]);
		expect(knownLanguage("de")).toBe("de");
		expect(knownLanguage("de-AT")).toBe("de");
		expect(knownLanguage("PT-br")).toBe("pt");
		for (const other of ["en", "en-GB", "pl", "", undefined, "d", "<x"]) {
			expect(knownLanguage(other), String(other)).toBeUndefined();
		}
	});

	it("has every word in every language, none left empty or in English by mistake", () => {
		for (const [code, words] of Object.entries(LANGUAGES)) {
			for (const key of Object.keys(ENGLISH)) {
				const word = words[key as keyof typeof ENGLISH];
				expect(word, `${code}.${key}`).toBeTruthy();
				// "Marketing" and "Cookies" are the same word in several languages.
				if (!["mk", "settings"].includes(key)) {
					expect(word, `${code}.${key}`).not.toBe(ENGLISH[key as keyof typeof ENGLISH]);
				}
			}
			for (const key of ["title", "ma", "mm", "mb", "ess", "sl"] as const) {
				expect(words[key], `${code}.${key}`).toBeTruthy();
			}
		}
	});

	it("writes the standard heading and text in the language, naming the purposes in use", () => {
		const de = wordsFor(normalizeConfig(GA), "de");
		expect(de.title).toBe("Dürfen wir Cookies verwenden?");
		expect(de.text).toBe(
			"Wir möchten Statistik-Cookies verwenden, um zu sehen, wie diese Website genutzt wird. Notwendige Cookies sind immer aktiv.",
		);
		expect(de.accept).toBe("Alle akzeptieren");
		expect(de.reject).toBe("Alle ablehnen");
		expect(wordsFor(normalizeConfig(BOTH), "fr").text).toBe(
			"Nous aimerions utiliser des cookies de mesure d’audience pour voir comment ce site est utilisé, et des cookies marketing pour mesurer notre publicité. Les cookies essentiels sont toujours actifs.",
		);
	});

	it("keeps a heading and text the owner typed, as typed, in every language", () => {
		const own = normalizeConfig({
			...GA,
			banner: { title: "Kekse?", message: "Wir backen auch Cookies." },
		});
		expect(wordsFor(own, "de")).toMatchObject({
			title: "Kekse?",
			text: "Wir backen auch Cookies.",
		});
		expect(wordsFor(own, "it")).toMatchObject({
			title: "Kekse?",
			text: "Wir backen auch Cookies.",
		});
	});

	it("shows the owner's button words over the built-in ones, in English and every language", () => {
		const own = normalizeConfig({
			...GA,
			banner: { labels: { accept: "Yes, fine", reject: "No, thanks", settings: "Privacy" } },
		});
		for (const lang of [undefined, "de", "nl"]) {
			expect(wordsFor(own, lang)).toMatchObject({
				accept: "Yes, fine",
				reject: "No, thanks",
				settings: "Privacy",
			});
		}
		expect(wordsFor(own, "de").choose).toBe("Auswählen");
		expect(clientConfig(own, "analytics-consent").t.accept).toBe("Yes, fine");
	});

	it("gives English for any other language, exactly as the page carries it", () => {
		const config = normalizeConfig(GA);
		expect(wordsFor(config, "pl")).toEqual(clientConfig(config, "analytics-consent").t);
	});

	it("has a code that changes with the words, so browsers fetch them again", () => {
		const one = wordsCode(normalizeConfig(GA));
		expect(one).toMatch(/^[a-z0-9]+$/);
		expect(wordsCode(normalizeConfig(GA))).toBe(one);
		expect(wordsCode(normalizeConfig({ ...GA, banner: { title: "Hi" } }))).not.toBe(one);
		expect(wordsCode(normalizeConfig({ ...GA, banner: { labels: { accept: "OK" } } }))).not.toBe(
			one,
		);
		expect(wordsCode(normalizeConfig(BOTH))).not.toBe(one);
	});
});

describe("the words route", () => {
	const get = async (query: string, stored: unknown = GA) => {
		const fake = fakeContext({ [CONFIG_KEY]: stored });
		return (await createPlugin().routes.words!.handler({
			...fake.ctx,
			input: undefined,
			request: new Request(
				`https://acme.test/_emdash/api/plugins/analytics-consent/words?${query}`,
			),
		} as unknown as RouteContext)) as { t: Record<string, string> };
	};

	it("is public, read-only and cacheable for a day", () => {
		const route = createPlugin().routes.words!;
		expect(route.public).toBe(true);
		expect(route.methods).toEqual(["GET"]);
		expect(route.cacheControl).toBe("public, max-age=86400");
	});

	it("answers with the banner's words in the language asked for", async () => {
		expect((await get("l=de&w=abc")).t).toEqual(wordsFor(normalizeConfig(GA), "de"));
	});

	it("answers in English for a language it does not know, or none", async () => {
		expect((await get("l=xx")).t.accept).toBe("Accept all");
		expect((await get("")).t.accept).toBe("Accept all");
	});
});
