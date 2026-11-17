// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * The public address of a media library picture, read in-process: no cookie and no
 * request to the site's own API, so a save from an AI tool's key works as well as one
 * from the admin page.
 *
 * A plugin's `ctx.media` gives only a signed-in address (`/_emdash/api/media/asset/...`)
 * and no storage key (EmDash 1.5.0), so this reads the media row through EmDash's own
 * exports: `getDb` from `emdash/runtime` and `MediaRepository` from `emdash`. Native
 * plugins run inside the site, where both are available. Loaded on first use, so the
 * plugin's other code (and its tests) never pull in the site's runtime.
 */
export async function storedFileUrl(
	mediaId: string,
	log?: { warn(message: string, data?: unknown): void },
): Promise<string | null> {
	if (!/^[A-Za-z0-9_-]{1,60}$/.test(mediaId)) return null;
	try {
		const [{ getDb }, { MediaRepository }] = await Promise.all([
			import("emdash/runtime"),
			import("emdash"),
		]);
		const item = await new MediaRepository(await getDb()).findById(mediaId);
		if (!item || item.status !== "ready" || !item.mimeType?.startsWith("image/")) return null;
		const url = `/_emdash/api/media/file/${item.storageKey}`;
		return /^\/_emdash\/api\/media\/file\/[A-Za-z0-9._/-]+$/.test(url) && !url.includes("..")
			? url
			: null;
	} catch (error) {
		// The error's own words only: no request, no key.
		log?.warn("could not read a picture's file address", { error: String(error) });
		return null;
	}
}
