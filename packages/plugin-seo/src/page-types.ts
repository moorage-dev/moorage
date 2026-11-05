// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

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

/** Plain business groups mapped to the schema.org type each one emits. */
export const BUSINESS_GROUPS: Array<{ value: string; label: string }> = [
	{ value: "FoodEstablishment", label: "Restaurant, cafe or bakery" },
	{ value: "Store", label: "Shop" },
	{ value: "MedicalBusiness", label: "Health and medical" },
	{ value: "Dentist", label: "Dentist" },
	{ value: "LegalService", label: "Legal" },
	{ value: "FinancialService", label: "Financial" },
	{ value: "HomeAndConstructionBusiness", label: "Home services (plumber, electrician, builder)" },
	{ value: "HealthAndBeautyBusiness", label: "Beauty and hair" },
	{ value: "SportsActivityLocation", label: "Fitness" },
	{ value: "LodgingBusiness", label: "Hotel or lodging" },
	{ value: "AutomotiveBusiness", label: "Automotive" },
	{ value: "ProfessionalService", label: "Professional service" },
	{ value: "LocalBusiness", label: "Other" },
];

export const PRICE_RANGES = ["", "$", "$$", "$$$", "$$$$"];

export function typeLabel(type: PageSchemaType): string {
	return PAGE_TYPES.find((option) => option.value === type)?.short ?? type;
}
