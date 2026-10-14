// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * What the server hands the browser script on every page. Keys are short
 * because this object is written into every public page.
 */
export interface ClientConfig {
	/** Banner version: changes when the set of tools changes, which asks visitors again. */
	v: string;
	/** Who is asked: 0 nobody, 1 visitors in Europe and the UK, 2 everyone. */
	who: 0 | 1 | 2;
	/** Days a choice is remembered. */
	days: number;
	/** Base address of the plugin's public routes, ending in "/". */
	api: string;
	ga?: string;
	gtm?: string;
	aw?: string;
	fb?: string;
	cl?: string;
	hs?: string;
	/** HubSpot EU data centre. */
	hsEu?: 1;
	cf?: string;
	/** Cloudflare Web Analytics waits for Analytics consent. */
	cfWait?: 1;
	/** Load Google Tag Manager before the visitor has chosen. */
	gtmNow?: 1;
	/** Track enquiries (phone and email clicks, sent forms). */
	ev?: 1;
	/** Send a record of each choice to the site. */
	rec?: 1;
	pos: "bar" | "left" | "right";
	scheme: "auto" | "light" | "dark";
	/** Show the small "Cookie settings" button. */
	btn?: 1;
	policy?: string;
	/** Tool names shown under Analytics and Marketing. */
	an: string[];
	mk: string[];
	/** Every piece of text the visitor can see. */
	t: {
		title: string;
		text: string;
		policy: string;
		accept: string;
		reject: string;
		choose: string;
		save: string;
		settings: string;
		panel: string;
		need: string;
		needText: string;
		an: string;
		anText: string;
		mk: string;
		mkText: string;
		uses: string;
		gpc: string;
	};
}

/** A visitor's saved answer. */
export interface Choice {
	/** Banner version it was given for. */
	v: string;
	/** Analytics allowed. */
	a: boolean;
	/** Marketing allowed. */
	m: boolean;
	/** When it was given, in days since 1970. */
	d: number;
	/** Random reference for this answer; identifies no one. */
	id: string;
}
