/**
 * Deferred blob-ref resolution for hydrated session entries.
 *
 * Session load intentionally leaves persisted `blob:sha256:` image payloads as
 * reference strings — re-inlining every historical image to base64 at load pinned
 * megabytes of resident strings for history the model may never resend and the
 * user may never scroll to. Instead, each consumer that actually needs bytes
 * resolves them at the moment of use:
 *
 * - LLM conversion (`session/messages.ts`) resolves per-message right before the
 *   fragment is built, so converted wire copies carry data exactly as before.
 * - TUI rebuild (`modes/utils/ui-helpers.ts`) resolves per message before
 *   component construction.
 * - Provider/web projections resolve at the projection boundary.
 *
 * All resolution here is synchronous (`BlobStore.getSync`) because every current
 * consumer sits on a synchronous path; the async entry-level loader keeps its own
 * walker in `session-loader.ts` for the callers that still want eager inlining
 * (cross-session fork copies).
 *
 * Blob files live under the agent dir's shared blobs store, so a ref is
 * resolvable from any session in the process.
 */

import { getBlobsDir } from "@oh-my-pi/pi-utils";
import { BlobStore, isBlobRef, resolveImageDataSync, resolveImageDataUrlSync } from "./blob-store";
import { isImageBlock, isImageDataPayload } from "./session-persistence";

let sharedStore: BlobStore | undefined;
function sharedBlobStore(): BlobStore {
	if (!sharedStore) sharedStore = new BlobStore(getBlobsDir());
	return sharedStore;
}

/**
 * Resolve a single persisted image reference string to its base64 payload.
 * Non-refs pass through unchanged; a missing blob logs a warning and returns
 * the ref as-is (matching the eager loader's tolerance).
 */
export function resolveImageDataRefSync(data: string): string {
	return isBlobRef(data) ? resolveImageDataSync(sharedBlobStore(), data) : data;
}

function hasImageUrl(value: unknown): value is { image_url: string } {
	return typeof value === "object" && value !== null && "image_url" in value && typeof value.image_url === "string";
}

function shouldResolveImagePayload(value: unknown, key: string | undefined): value is { data: string } {
	if (!isImageDataPayload(value) || !isBlobRef(value.data)) return false;
	return (key === "content" && isImageBlock(value)) || key === "images";
}

function resolveClone(value: unknown, key: string | undefined, store: BlobStore): void {
	if (shouldResolveImagePayload(value, key)) {
		value.data = resolveImageDataSync(store, value.data);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) resolveClone(item, key, store);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	if (
		"type" in value &&
		value.type === "image_generation_call" &&
		"result" in value &&
		typeof value.result === "string" &&
		isBlobRef(value.result)
	) {
		value.result = resolveImageDataSync(store, value.result);
	}
	if (hasImageUrl(value) && isBlobRef(value.image_url)) {
		// Data-URL refs store the original URL text, so restore it verbatim.
		value.image_url = resolveImageDataUrlSync(store, value.image_url);
	}
	for (const [childKey, item] of Object.entries(value)) resolveClone(item, childKey, store);
}

/**
 * Returns `value` unchanged when it carries no blob refs; otherwise returns a
 * structured clone with every persisted image payload resolved to inline data.
 * The input is never mutated, so session-entry graphs keep holding compact refs
 * while the returned copy feeds data-hungry consumers.
 */
export function resolveMessageBlobRefsSync<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	if (!containsBlobRef(value)) return value;
	let clone: unknown;
	try {
		clone = structuredClone(value);
	} catch {
		// Un-cloneable payload: degrade to the ref-bearing original rather than
		// crash — consumers already tolerate unresolved refs like missing blobs.
		return value;
	}
	resolveClone(clone, undefined, sharedBlobStore());
	return clone as T;
}

/**
 * Cheap recursive precheck: does this value's tree contain any `blob:sha256:`
 * string? Conservative — a ref in a non-resolved position still returns true,
 * which only costs an extra (no-op) resolution walk.
 */
export function containsBlobRef(value: unknown): boolean {
	if (typeof value === "string") return isBlobRef(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			if (containsBlobRef(item)) return true;
		}
		return false;
	}
	if (typeof value !== "object" || value === null) return false;
	for (const key in value) {
		if (containsBlobRef((value as Record<string, unknown>)[key])) return true;
	}
	return false;
}
