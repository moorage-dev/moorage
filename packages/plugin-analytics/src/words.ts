// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { ClientConfig } from "./client/types.js";
import {
	DEFAULT_MESSAGE,
	DEFAULT_TITLE,
	defaultMessage,
	needsConsent,
	shortHash,
	vendorNames,
	type AnalyticsConfig,
} from "./config.js";

/**
 * Every word the banner shows, in English and in the six languages it knows.
 *
 * English travels inside the page. The others are fetched by the browser from
 * the plugin's `words` route when the page's `<html lang>` asks for one of them,
 * so a page carries one language, not seven. Words the site's owner typed
 * (the heading, the text, the buttons) are shown as typed, in every language.
 */

/** The wording visitors read. `title` and `text` come from the settings. */
export type Words = ClientConfig["t"];

/** Fixed wording of the banner in English. The title and message come from settings. */
export const ENGLISH = {
	policy: "Privacy policy",
	accept: "Accept all",
	reject: "Reject all",
	choose: "Choose",
	always: "Always on",
	saved: "Your choice is saved. Change it any time under Cookies.",
	save: "Save my choices",
	settings: "Cookies",
	panel: "Your cookie choices",
	need: "Essential",
	needText: "Remembers your answer, so you are not asked on every page.",
	an: "Analytics",
	anText: "Shows us how visitors use this site, so we can improve it.",
	mk: "Marketing",
	mkText: "Lets us measure our advertising and show you relevant ads elsewhere.",
	uses: "Used by:",
	gpc: "Your browser asks sites not to share your data (Global Privacy Control), so Marketing stays off.",
} as const;

type Fixed = Record<keyof typeof ENGLISH, string>;

interface Language extends Fixed {
	/** The banner's heading. */
	title: string;
	/** The standard text: analytics only, marketing only, both; then the line about essential cookies. */
	ma: string;
	mm: string;
	mb: string;
	ess: string;
	/** What the small "Cookies" button is called for screen readers. */
	sl: string;
	/** Held videos and maps: under Marketing ({list}), or a purpose of their own, with its name and description. */
	hm: string;
	hv: string;
	vm: string;
	vmText: string;
}

/** The held-video words in English; the same keys as each language below. */
const ENGLISH_HELD = {
	hm: "Marketing also covers videos and maps from {list}.",
	hv: "Videos and maps from {list} set their own cookies, so they wait for your choice.",
	vm: "Videos and maps",
	vmText: "Shows videos and maps from other sites, which set their own cookies.",
};

/** A space that does not break, before French ? and :. */
const NB = " ";

export const LANGUAGES: Record<string, Language> = {
	de: {
		title: "Dürfen wir Cookies verwenden?",
		policy: "Datenschutzerklärung",
		accept: "Alle akzeptieren",
		reject: "Alle ablehnen",
		choose: "Auswählen",
		always: "Immer aktiv",
		saved: "Ihre Auswahl ist gespeichert. Sie können sie jederzeit unter Cookies ändern.",
		save: "Auswahl speichern",
		settings: "Cookies",
		sl: "Cookie-Einstellungen",
		panel: "Ihre Cookie-Auswahl",
		need: "Notwendig",
		needText: "Merkt sich Ihre Antwort, damit Sie nicht auf jeder Seite gefragt werden.",
		an: "Statistik",
		anText: "Zeigt uns, wie Besucher diese Website nutzen, damit wir sie verbessern können.",
		mk: "Marketing",
		mkText: "Damit messen wir unsere Werbung und zeigen Ihnen anderswo passende Anzeigen.",
		uses: "Verwendet von:",
		gpc: "Ihr Browser bittet Websites, Ihre Daten nicht weiterzugeben (Global Privacy Control), daher bleibt Marketing aus.",
		ma: "Wir möchten Statistik-Cookies verwenden, um zu sehen, wie diese Website genutzt wird.",
		mm: "Wir möchten Marketing-Cookies verwenden, um unsere Werbung zu messen.",
		mb: "Wir möchten Statistik-Cookies verwenden, um zu sehen, wie diese Website genutzt wird, und Marketing-Cookies, um unsere Werbung zu messen.",
		ess: "Notwendige Cookies sind immer aktiv.",
		hm: "Zu Marketing gehören auch Videos und Karten von {list}.",
		hv: "Videos und Karten von {list} setzen eigene Cookies und warten deshalb auf Ihre Wahl.",
		vm: "Videos und Karten",
		vmText: "Zeigt Videos und Karten anderer Websites, die eigene Cookies setzen.",
	},
	fr: {
		title: `Pouvons-nous utiliser des cookies${NB}?`,
		policy: "Politique de confidentialité",
		accept: "Tout accepter",
		reject: "Tout refuser",
		choose: "Choisir",
		always: "Toujours actifs",
		saved: "Votre choix est enregistré. Vous pouvez le modifier à tout moment via Cookies.",
		save: "Enregistrer mes choix",
		settings: "Cookies",
		sl: "Paramètres des cookies",
		panel: "Vos choix de cookies",
		need: "Essentiels",
		needText: "Mémorisent votre réponse, pour ne pas vous la redemander à chaque page.",
		an: "Mesure d’audience",
		anText: "Nous montre comment les visiteurs utilisent ce site, pour l’améliorer.",
		mk: "Marketing",
		mkText:
			"Nous permet de mesurer notre publicité et de vous montrer des annonces pertinentes ailleurs.",
		uses: `Utilisés par${NB}:`,
		gpc: `Votre navigateur demande aux sites de ne pas partager vos données (Global Privacy Control)${NB}: le marketing reste désactivé.`,
		ma: "Nous aimerions utiliser des cookies de mesure d’audience pour voir comment ce site est utilisé.",
		mm: "Nous aimerions utiliser des cookies marketing pour mesurer notre publicité.",
		mb: "Nous aimerions utiliser des cookies de mesure d’audience pour voir comment ce site est utilisé, et des cookies marketing pour mesurer notre publicité.",
		ess: "Les cookies essentiels sont toujours actifs.",
		hm: "Le marketing couvre aussi les vidéos et cartes de {list}.",
		hv: "Les vidéos et cartes de {list} déposent leurs propres cookies et attendent donc votre choix.",
		vm: "Vidéos et cartes",
		vmText: "Affiche des vidéos et des cartes d’autres sites, qui déposent leurs propres cookies.",
	},
	es: {
		title: "¿Podemos usar cookies?",
		policy: "Política de privacidad",
		accept: "Aceptar todo",
		reject: "Rechazar todo",
		choose: "Elegir",
		always: "Siempre activas",
		saved: "Tu elección se ha guardado. Puedes cambiarla cuando quieras en Cookies.",
		save: "Guardar mi elección",
		settings: "Cookies",
		sl: "Configuración de cookies",
		panel: "Tus opciones de cookies",
		need: "Esenciales",
		needText: "Recuerdan tu respuesta para no preguntarte en cada página.",
		an: "Analítica",
		anText: "Nos muestra cómo se usa este sitio, para poder mejorarlo.",
		mk: "Marketing",
		mkText: "Nos permite medir nuestra publicidad y mostrarte anuncios relevantes en otros sitios.",
		uses: "Usadas por:",
		gpc: "Tu navegador pide a los sitios que no compartan tus datos (Global Privacy Control), así que Marketing sigue desactivado.",
		ma: "Nos gustaría usar cookies de analítica para ver cómo se usa este sitio.",
		mm: "Nos gustaría usar cookies de marketing para medir nuestra publicidad.",
		mb: "Nos gustaría usar cookies de analítica para ver cómo se usa este sitio, y cookies de marketing para medir nuestra publicidad.",
		ess: "Las cookies esenciales están siempre activas.",
		hm: "Marketing incluye también los vídeos y mapas de {list}.",
		hv: "Los vídeos y mapas de {list} usan sus propias cookies, así que esperan a tu elección.",
		vm: "Vídeos y mapas",
		vmText: "Muestra vídeos y mapas de otros sitios, que usan sus propias cookies.",
	},
	it: {
		title: "Possiamo usare i cookie?",
		policy: "Informativa sulla privacy",
		accept: "Accetta tutti",
		reject: "Rifiuta tutti",
		choose: "Scegli",
		always: "Sempre attivi",
		saved: "La tua scelta è stata salvata. Puoi cambiarla in qualsiasi momento da Cookie.",
		save: "Salva le mie scelte",
		settings: "Cookie",
		sl: "Impostazioni dei cookie",
		panel: "Le tue scelte sui cookie",
		need: "Essenziali",
		needText: "Ricordano la tua risposta, così non te la chiediamo a ogni pagina.",
		an: "Statistiche",
		anText: "Ci mostrano come i visitatori usano questo sito, per migliorarlo.",
		mk: "Marketing",
		mkText:
			"Ci permettono di misurare la nostra pubblicità e di mostrarti annunci pertinenti altrove.",
		uses: "Usati da:",
		gpc: "Il tuo browser chiede ai siti di non condividere i tuoi dati (Global Privacy Control), quindi il Marketing resta disattivato.",
		ma: "Vorremmo usare cookie statistici per vedere come viene usato questo sito.",
		mm: "Vorremmo usare cookie di marketing per misurare la nostra pubblicità.",
		mb: "Vorremmo usare cookie statistici per vedere come viene usato questo sito, e cookie di marketing per misurare la nostra pubblicità.",
		ess: "I cookie essenziali sono sempre attivi.",
		hm: "Il marketing comprende anche video e mappe di {list}.",
		hv: "Video e mappe di {list} usano cookie propri, quindi attendono la tua scelta.",
		vm: "Video e mappe",
		vmText: "Mostra video e mappe di altri siti, che usano cookie propri.",
	},
	nl: {
		title: "Mogen we cookies gebruiken?",
		policy: "Privacyverklaring",
		accept: "Alles accepteren",
		reject: "Alles weigeren",
		choose: "Kiezen",
		always: "Altijd aan",
		saved: "Je keuze is opgeslagen. Je kunt die altijd wijzigen via Cookies.",
		save: "Mijn keuze opslaan",
		settings: "Cookies",
		sl: "Cookie-instellingen",
		panel: "Jouw cookiekeuzes",
		need: "Noodzakelijk",
		needText: "Onthoudt je antwoord, zodat we het niet op elke pagina opnieuw vragen.",
		an: "Statistieken",
		anText: "Laat ons zien hoe bezoekers deze site gebruiken, zodat we die kunnen verbeteren.",
		mk: "Marketing",
		mkText: "Hiermee meten we onze advertenties en tonen we je elders relevante advertenties.",
		uses: "Gebruikt door:",
		gpc: "Je browser vraagt sites je gegevens niet te delen (Global Privacy Control), dus Marketing blijft uit.",
		ma: "We willen graag statistische cookies gebruiken om te zien hoe deze site wordt gebruikt.",
		mm: "We willen graag marketingcookies gebruiken om onze advertenties te meten.",
		mb: "We willen graag statistische cookies gebruiken om te zien hoe deze site wordt gebruikt, en marketingcookies om onze advertenties te meten.",
		ess: "Noodzakelijke cookies staan altijd aan.",
		hm: "Marketing omvat ook video’s en kaarten van {list}.",
		hv: "Video’s en kaarten van {list} plaatsen eigen cookies en wachten daarom op je keuze.",
		vm: "Video’s en kaarten",
		vmText: "Toont video’s en kaarten van andere sites, die eigen cookies plaatsen.",
	},
	pt: {
		title: "Podemos usar cookies?",
		policy: "Política de privacidade",
		accept: "Aceitar todos",
		reject: "Rejeitar todos",
		choose: "Escolher",
		always: "Sempre ativos",
		saved: "A sua escolha foi guardada. Pode alterá-la a qualquer momento em Cookies.",
		save: "Guardar as minhas escolhas",
		settings: "Cookies",
		sl: "Definições de cookies",
		panel: "As suas escolhas de cookies",
		need: "Essenciais",
		needText: "Guardam a sua resposta, para não lhe perguntarmos em cada página.",
		an: "Estatísticas",
		anText: "Mostram-nos como os visitantes usam este site, para o podermos melhorar.",
		mk: "Marketing",
		mkText:
			"Permitem-nos medir a nossa publicidade e mostrar-lhe anúncios relevantes noutros sites.",
		uses: "Usados por:",
		gpc: "O seu navegador pede aos sites que não partilhem os seus dados (Global Privacy Control), por isso o Marketing fica desligado.",
		ma: "Gostaríamos de usar cookies de estatísticas para ver como este site é usado.",
		mm: "Gostaríamos de usar cookies de marketing para medir a nossa publicidade.",
		mb: "Gostaríamos de usar cookies de estatísticas para ver como este site é usado, e cookies de marketing para medir a nossa publicidade.",
		ess: "Os cookies essenciais estão sempre ativos.",
		hm: "O Marketing inclui também vídeos e mapas de {list}.",
		hv: "Os vídeos e mapas de {list} usam os seus próprios cookies, por isso esperam pela sua escolha.",
		vm: "Vídeos e mapas",
		vmText: "Mostra vídeos e mapas de outros sites, que usam os seus próprios cookies.",
	},
};

/** The buttons an owner can name in their own words. Empty means the built-in wording. */
export const LABEL_KEYS = ["accept", "reject", "choose", "save", "settings"] as const;
export type LabelKey = (typeof LABEL_KEYS)[number];
export type Labels = Record<LabelKey, string>;

/** A code that changes when any word a visitor could read changes, in any language. */
const TABLE_CODE = shortHash(JSON.stringify([ENGLISH, ENGLISH_HELD, LANGUAGES]));

/** The owner's button words that are set, ready to lay over the built-in ones. */
function ownLabels(config: AnalyticsConfig): Partial<Labels> {
	const out: Partial<Labels> = {};
	for (const key of LABEL_KEYS) if (config.banner.labels[key]) out[key] = config.banner.labels[key];
	return out;
}

/** The two-letter language this banner knows for a `lang` value ("de-AT" is German), or undefined. */
export function knownLanguage(lang: unknown): string | undefined {
	const code = typeof lang === "string" ? lang.trim().slice(0, 2).toLowerCase() : "";
	return /^[a-z]{2}$/.test(code) && Object.hasOwn(LANGUAGES, code) ? code : undefined;
}

/**
 * Everything the banner says, in English or one of the known languages. The
 * heading and text the owner typed stay as typed; left as standard, they are
 * written in the language too. In English the result is exactly what 0.3 showed.
 */
export function wordsFor(config: AnalyticsConfig, lang?: string): Words {
	const { title, message } = config.banner;
	const code = knownLanguage(lang);
	const marketing = vendorNames(config, "marketing").length > 0;
	const words = code ? LANGUAGES[code]! : ENGLISH_HELD;
	// Videos and maps held back are named: in the standard text, and in Choose, under
	// Marketing or, on a site with no Marketing tools, as a purpose of their own.
	const list = new Intl.ListFormat(code ?? "en-GB", { type: "conjunction" }).format(
		needsConsent(config) && config.banner.audience !== "none" ? config.heldEmbeds : [],
	);
	const held = list ? (marketing ? words.hm : words.hv).replace("{list}", list) : "";
	const own = !list || marketing ? {} : { mk: words.vm, mkText: words.vmText };
	if (!code) {
		const standard = defaultMessage(config);
		return {
			...ENGLISH,
			...own,
			...ownLabels(config),
			title,
			text:
				message ||
				(held ? standard.replace(/Essential cookies are always on\.$/, `${held} $&`) : standard),
		};
	}
	const { ma, mm, mb, ess, hm, hv, vm, vmText, title: theirTitle, ...fixed } = LANGUAGES[code]!;
	const analytics = vendorNames(config, "analytics").length > 0;
	const want = analytics && marketing ? mb : analytics ? ma : marketing ? mm : "";
	const text = [want, held, ess].filter(Boolean).join(" ");
	return {
		...fixed,
		...own,
		...ownLabels(config),
		title: title === DEFAULT_TITLE ? theirTitle : title,
		text: message === DEFAULT_MESSAGE ? text : message,
	};
}

/**
 * A short code for the words in every language, sent with the page so the
 * browser asks for them again, past its cache, when any of them changes.
 */
export function wordsCode(config: AnalyticsConfig): string {
	return shortHash(
		JSON.stringify([
			TABLE_CODE,
			config.banner.title,
			config.banner.message,
			config.banner.labels,
			config.heldEmbeds,
		]) +
			vendorNames(config, "analytics").length +
			vendorNames(config, "marketing").length,
	);
}
