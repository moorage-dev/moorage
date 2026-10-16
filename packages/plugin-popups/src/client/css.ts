// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * The look, shared by the browser script (slide-ins and popups) and the server
 * (the top bar, which is in the page's HTML). Colours and fonts come from a
 * theme's --popups-* variables, then the cookie banner's --cookie-consent-*
 * ones, then calm neutral defaults; they cross into the shadow root. Only
 * transform and opacity are animated, so nothing on the page moves.
 */

const v = (name: string, fallback: string) =>
	`var(--popups-${name},var(--cookie-consent-${name},${fallback}))`;

const LIGHT = `:host{--g:${v("background", "#fff")};--f:${v("text", "#141414")};--e:${v("rule", "color-mix(in srgb,var(--f) 32%,var(--g))")};--w:${v("shadow", "0 24px 64px -24px rgb(0 0 0/.35)")};--sw:0 12px 32px -12px rgb(0 0 0/.3);--bd:var(--popups-backdrop,rgb(0 0 0/.45))}`;

export const DARK = `:host{--g:${v("background", "#1c1c1c")};--f:${v("text", "#f2f2f2")};--e:${v("rule", "color-mix(in srgb,var(--f) 32%,var(--g))")};--w:${v("shadow", "0 24px 64px -24px rgb(0 0 0/.75)")};--sw:0 12px 32px -12px rgb(0 0 0/.8);--bd:var(--popups-backdrop,rgb(0 0 0/.6))}`;

export const CSS =
	LIGHT +
	`:host{--x:${v("accent", "var(--f)")};--y:${v("accent-text", "var(--g)")};--k:${v("font", 'system-ui,-apple-system,"Segoe UI",sans-serif')};--h:${v("heading-font", "var(--k)")};--s:${v("surface", "color-mix(in srgb,var(--g) 92%,var(--f))")};--r:var(--popups-radius,12px)}` +
	"*{box-sizing:border-box}[hidden]{display:none!important}" +
	".pp{font:16px/1.5 var(--k);color:var(--f);background:var(--s);border:1px solid var(--e)}" +
	".pp h2{font:600 22px/1.25 var(--h);margin:0}.pp p{margin:6px 0 0}a{color:inherit}" +
	"button{font:inherit;cursor:pointer}" +
	".p{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 20px;border-radius:6px;background:var(--x);color:var(--y);border:2px solid var(--x);font:600 16px/1.2 var(--k);text-decoration:none}" +
	".q{display:inline-flex;align-items:center;min-height:44px;padding:8px 6px;background:none;border:0;color:var(--f);text-decoration:underline;text-underline-offset:3px;font:16px/1.2 var(--k)}" +
	".x{position:absolute;top:8px;right:8px;z-index:1;width:44px;height:44px;border:0;background:none;color:var(--f);display:grid;place-items:center;border-radius:6px;padding:0}.x svg{width:18px;height:18px}" +
	".r{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin-top:18px}" +
	".fine{font-size:13px;opacity:.85;margin-top:10px}" +
	":focus-visible{outline:3px solid var(--f);outline-offset:2px}" +
	".pv{display:inline-block;margin:0 40px 8px 0;padding:2px 8px;font-size:13px;line-height:1.4;border:1px dashed var(--f);border-radius:4px}" +
	".sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}" +
	// The form, drawn from the forms plugin's own definition.
	".f{display:grid;gap:12px;margin-top:16px}.f label,.f legend{display:block;font-weight:600;font-size:15px;margin-bottom:4px;padding:0}.f fieldset{border:0;margin:0;padding:0;min-width:0}" +
	".in{display:block;width:100%;min-height:44px;padding:10px 12px;border:1px solid var(--e);border-radius:6px;background:var(--g);color:var(--f);font:16px var(--k)}textarea.in{min-height:88px}" +
	".f .c{display:flex;gap:8px;align-items:center;font-weight:400;min-height:32px}.f .c input{width:20px;height:20px;margin:0;accent-color:var(--x)}" +
	".opt{font-weight:400;opacity:.8}.help{display:block;font-size:13px;opacity:.85;margin-top:4px}.err{display:block;font-size:14px;font-weight:600;margin-top:4px}.err:empty{display:none}" +
	".hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}" +
	".msg{margin-top:10px;font-weight:600}.msg:empty{display:none}" +
	".ok{display:grid;justify-items:start;gap:4px}.ok .tick{width:40px;height:40px;border-radius:50%;border:2px solid var(--f);display:grid;place-items:center;margin-bottom:8px}.ok h2:focus{outline:none}" +
	// Picture: across the top of a popup, a thumbnail in a slide-in.
	".pic{display:block;width:calc(100% + 56px);max-width:none;margin:-28px -28px 18px;height:180px;object-fit:cover;border-radius:calc(var(--r) - 1px) calc(var(--r) - 1px) 0 0}" +
	".thumb{float:left;width:72px;height:72px;object-fit:cover;border-radius:8px;margin:0 14px 6px 0}" +
	// Top bar: in the page flow, above the header.
	".bar{position:relative;border-width:0 0 1px;min-height:44px;padding:10px 60px 10px 16px;font-size:15px}.bar .i{max-width:1200px;margin:0 auto;text-align:center}.bar .i a{font-weight:600;text-decoration:underline;text-underline-offset:3px;margin-left:6px}.bar .x{top:0;right:4px}" +
	// Slide-in: a bottom corner.
	".slide{position:fixed;right:16px;bottom:16px;width:360px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;padding:20px;border-radius:10px;box-shadow:var(--sw)}.slide.l{right:auto;left:16px}.slide h2{font-size:19px;padding-right:36px}.slide .x{top:4px;right:4px}.slide .r{clear:both}" +
	// Popup: a centred dialog that dims the page.
	"dialog.modal{width:min(480px,calc(100vw - 32px));max-width:none;max-height:calc(100vh - 32px);overflow:auto;margin:auto;padding:28px;border-radius:var(--r);box-shadow:var(--w)}dialog.modal::backdrop{background:var(--bd)}dialog.modal h2{padding-right:30px}dialog.modal .pic+h2{padding-right:0}dialog.modal.done[open]{display:grid;align-content:center}" +
	// Over the picture, the close button gets its own dark backing so it stays visible.
	".x.on-pic{color:#fff;background:rgb(0 0 0/.45)}" +
	"@media(prefers-reduced-motion:no-preference){.slide,dialog.modal[open]{animation:pi .25s ease-out}}@media(prefers-reduced-motion:reduce){.slide,dialog.modal[open]{animation:po .2s}}" +
	"@keyframes pi{from{opacity:0;transform:translateY(12px)}}@keyframes po{from{opacity:0}}" +
	// Phones: slide-ins, and popups that opened by themselves, become a sheet at the bottom.
	// A popup that opened by itself on a phone (narrower than 768 px) is a sheet at the bottom, by its class.
	"dialog.modal.sheet{inset:auto 0 0;margin:0;width:100%;max-width:100%;max-height:45vh;border-width:1px 0 0;border-radius:12px 12px 0 0;padding:18px 16px calc(22px + env(safe-area-inset-bottom));box-shadow:0 -12px 32px -16px rgb(0 0 0/.35)}" +
	"dialog.modal.sheet.hf{max-height:62vh}dialog.modal.sheet .pic{display:none}dialog.modal.sheet .x.on-pic{color:var(--f);background:none}dialog.modal.sheet .f{gap:8px;margin-top:12px}dialog.modal.sheet .r{margin-top:12px;gap:4px}" +
	"@media(max-width:600px){.pp h2{font-size:20px}.pp p{font-size:15px}" +
	".slide{inset:auto 0 0;margin:0;width:100%;max-width:100%;max-height:45vh;border-width:1px 0 0;border-radius:12px 12px 0 0;padding:18px 16px calc(22px + env(safe-area-inset-bottom));box-shadow:0 -12px 32px -16px rgb(0 0 0/.35)}.slide.l{left:0}" +
	"dialog.modal:not(.sheet){padding:20px}dialog.modal:not(.sheet) .pic{width:calc(100% + 40px);margin:-20px -20px 16px;height:140px}" +
	".r{flex-direction:column;align-items:stretch}.r .q{justify-content:center}" +
	".bar{font-size:14px}.bar .i{text-align:left}}";

/** The owner's own colours (already checked for contrast), used exactly as chosen. */
export function ownColors(col?: { g: string; f: string; x: string; y: string }): string {
	return col
		? `:host{--g:${col.g};--f:${col.f};--s:${col.g};--x:${col.x};--y:${col.y};--e:color-mix(in srgb,${col.f} 32%,${col.g})}`
		: "";
}

/** The whole stylesheet for a light, dark or device-following look. */
export function styles(
	scheme: "auto" | "light" | "dark",
	col?: { g: string; f: string; x: string; y: string },
): string {
	if (col) return CSS + ownColors(col);
	if (scheme === "dark") return CSS + DARK;
	if (scheme === "auto") return `${CSS}@media(prefers-color-scheme:dark){${DARK}}`;
	return CSS;
}
