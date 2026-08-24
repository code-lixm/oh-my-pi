import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { type BlobPutResult, blobExtensionForImageMimeType } from "../session/blob-store";
import { fileHyperlink } from "../tui/hyperlink";

/** Probed pixel dimensions riding on the draft image object itself; `null` records a failed
 *  probe so the chips band never re-decodes a corrupt header every frame. */
const kImageDims = Symbol("omp.imageDimensions");

interface ImageContentWithDims extends ImageContent {
	[kImageDims]?: { width: number; height: number } | null;
}

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
/** Cached probe result for a draft image: dimensions, `null` (probe failed), or `undefined`
 *  (never probed). */
export function cachedImageDimensions(image: ImageContent): { width: number; height: number } | null | undefined {
	return (image as ImageContentWithDims)[kImageDims];
}

/** Record a probe result for a draft image (see {@link cachedImageDimensions}). */
export function setCachedImageDimensions(image: ImageContent, dims: { width: number; height: number } | null): void {
	(image as ImageContentWithDims)[kImageDims] = dims;
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
