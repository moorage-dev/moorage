// Copyright 2026 GoSi Tech. Licensed under FSL-1.1-MIT; see LICENSE.

import type { PageSchemaType } from "./config.js";

/** The page types an admin can choose, in the words the admin sees. */
export const PAGE_TYPES: Array<{ value: PageSchemaType; label: string; short: string }> = [
	{ value: "WebPage", label: "Web page", short: "Web page" },
	{ value: "AboutPage", label: "About page", short: "About page" },
	{ value: "ContactPage", label: "Contact page", short: "Contact page" },
	{ value: "BlogPosting", label: "Blog post", short: "Blog post" },
	{ value: "Article", label: "Article", short: "Article" },
	{ value: "Service", label: "Service", short: "Service" },
	{ value: "ProfilePage", label: "Person or team member", short: "Person" },
];

export function typeLabel(type: PageSchemaType): string {
	return PAGE_TYPES.find((option) => option.value === type)?.short ?? type;
}
