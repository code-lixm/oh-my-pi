import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { type BlobPutResult, blobExtensionForImageMimeType } from "../session/blob-store";
import { fileHyperlink } from "../tui/hyperlink";

/** Matches `[Image #N]`/`[Image #N, WxH]` and `[Paste #N, +X lines]`/`[Paste #N, Y chars]` tokens.
 *  Group 1 is the kind (`Image`/`Paste`), group 2 the 1-based index. The optional metadata
 *  tail (`, …`) is captured loosely (no `]`/newline) so future label tweaks keep matching. */
export const PLACEHOLDER_REGEX = /\[(Image|Paste) #([1-9]\d*)(?:,[^\]\n]*)?\]/g;

/** Matches a single `[Image #N]` / `[Image #N, WxH]` marker. Group 1 is the
 *  1-based index, group 2 the optional metadata tail (leading comma, no `]` or
 *  newline) so future label tweaks keep matching. Paste markers are excluded
 *  on purpose: their numbering is owned by the editor's paste store, not by
 *  the pending-image buffer. */
const IMAGE_MARKER_REGEX = /\[Image #([1-9]\d*)((?:,[^\]\n]*)?)\]/g;

/** Whether `text` contains at least one positional image marker. */
export function hasImageMarker(text: string): boolean {
	IMAGE_MARKER_REGEX.lastIndex = 0;
	const found = IMAGE_MARKER_REGEX.test(text);
	IMAGE_MARKER_REGEX.lastIndex = 0;
	return found;
}

/** Renumber every `[Image #N]` marker in `text` by `offset` (added to the
 *  existing index), preserving the optional `, WxH` tail. Paste markers are
 *  left untouched. Used when restoring queued image-messages back into a draft
 *  that already holds pending images so the merged text's positional markers
 *  still line up with `pendingImages`. */
export function shiftImageMarkers(text: string, offset: number): string {
	if (offset === 0) return text;
	return text.replace(
		IMAGE_MARKER_REGEX,
		(_match, idx: string, tail: string) => `[Image #${Number(idx) + offset}${tail}]`,
	);
}

export interface ResolvedImageReferences {
	text: string;
	images: ImageContent[];
	imageLinks: (string | undefined)[];
}

/** Resolve positional image markers against their backing draft images. When markers
 * are authoritative, unreferenced images are dropped and surviving markers are
 * compacted to a continuous 1-based sequence. Duplicate markers keep pointing to
 * the same image. */
export function resolveImageReferences(
	text: string,
	images: readonly ImageContent[],
	imageLinks: readonly (string | undefined)[],
	markersAuthoritative: boolean,
): ResolvedImageReferences {
	if (!markersAuthoritative) {
		return { text, images: [...images], imageLinks: [...imageLinks] };
	}

	const referenced = new Set<number>();
	IMAGE_MARKER_REGEX.lastIndex = 0;
	for (;;) {
		const match = IMAGE_MARKER_REGEX.exec(text);
		if (match === null) break;
		const index = Number(match[1]);
		if (index <= images.length) referenced.add(index);
	}
	IMAGE_MARKER_REGEX.lastIndex = 0;

	const ordered = [...referenced].sort((a, b) => a - b);
	const compactIndexes = new Map<number, number>();
	for (let index = 0; index < ordered.length; index++) {
		const original = ordered[index];
		if (original !== undefined) compactIndexes.set(original, index + 1);
	}

	const resolvedText = text.replace(IMAGE_MARKER_REGEX, (match, rawIndex: string, tail: string) => {
		const compactIndex = compactIndexes.get(Number(rawIndex));
		return compactIndex === undefined ? match : `[Image #${compactIndex}${tail}]`;
	});

	return {
		text: resolvedText,
		images: ordered.flatMap(index => {
			const image = images[index - 1];
			return image === undefined ? [] : [image];
		}),
		imageLinks: ordered.map(index => imageLinks[index - 1]),
	};
}

type ImageBlobWriter = (data: Buffer, options?: { extension?: string }) => Promise<BlobPutResult>;
type ImageBlobWriterSync = (data: Buffer, options?: { extension?: string }) => BlobPutResult;

export type PlaceholderKind = "image" | "paste";

export interface PlaceholderRenderers {
	renderText: (text: string) => string;
	renderReference: (label: string, kind: PlaceholderKind, index: number) => string;
}

export function renderPlaceholders(text: string, renderers: PlaceholderRenderers): string {
	PLACEHOLDER_REGEX.lastIndex = 0;
	let result = "";
	let last = 0;
	let matched = false;

	for (;;) {
		const match = PLACEHOLDER_REGEX.exec(text);
		if (match === null) break;
		matched = true;
		if (match.index > last) {
			result += renderers.renderText(text.slice(last, match.index));
		}
		const kind: PlaceholderKind = match[1] === "Paste" ? "paste" : "image";
		result += renderers.renderReference(match[0], kind, Number(match[2]));
		last = match.index + match[0].length;
	}

	if (!matched) {
		return renderers.renderText(text);
	}
	if (last < text.length) {
		result += renderers.renderText(text.slice(last));
	}
	return result;
}

export function imageReferenceHyperlink(
	label: string,
	index: number,
	imageLinks: readonly (string | undefined)[] | undefined,
	renderLabel: (text: string) => string,
): string {
	const rendered = renderLabel(label);
	const target = imageLinks?.[index - 1];
	return target ? fileHyperlink(target, rendered) : rendered;
}

async function materializeImageReferenceLinkAsync(
	image: ImageContent,
	index: number,
	putBlob: ImageBlobWriter,
): Promise<string | undefined> {
	try {
		const result = await putBlob(Buffer.from(image.data, "base64"), {
			extension: blobExtensionForImageMimeType(image.mimeType),
		});
		return result.displayPath;
	} catch (error) {
		logger.warn("Failed to write image reference blob", {
			index,
			mimeType: image.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function materializeImageReferenceLink(
	image: ImageContent,
	index: number,
	putBlob: ImageBlobWriterSync,
): string | undefined {
	try {
		const result = putBlob(Buffer.from(image.data, "base64"), {
			extension: blobExtensionForImageMimeType(image.mimeType),
		});
		return result.displayPath;
	} catch (error) {
		logger.warn("Failed to write image reference blob", {
			index,
			mimeType: image.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

export async function materializeImageReferenceLinks(
	images: readonly ImageContent[] | undefined,
	putBlob: ImageBlobWriter,
): Promise<(string | undefined)[] | undefined> {
	if (!images || images.length === 0) return undefined;
	const links = await Promise.all(
		images.map((image, index) => materializeImageReferenceLinkAsync(image, index + 1, putBlob)),
	);
	return links.some(link => link !== undefined) ? links : undefined;
}

export function materializeImageReferenceLinksSync(
	images: readonly ImageContent[] | undefined,
	putBlob: ImageBlobWriterSync,
): (string | undefined)[] | undefined {
	if (!images || images.length === 0) return undefined;
	const links = images.map((image, index) => materializeImageReferenceLink(image, index + 1, putBlob));
	return links.some(link => link !== undefined) ? links : undefined;
}

/** Materialize the original image bytes and open the viewer-safe typed path. */
export function openImageInSystemViewer(
	image: ImageContent,
	putBlob: ImageBlobWriterSync,
	openTarget: (path: string) => void,
): void {
	const target = materializeImageReferenceLink(image, 1, putBlob);
	if (!target) return;
	try {
		openTarget(target);
	} catch (error) {
		logger.warn("Failed to open image reference", {
			path: target,
			mimeType: image.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
