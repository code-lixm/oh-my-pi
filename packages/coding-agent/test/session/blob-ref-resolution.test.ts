/**
 * Contracts: session/blob-ref-resolution defers persisted image payloads.
 *
 * Hydrated session entries keep `blob:sha256:` refs instead of inlined base64
 * (eager re-inlining pinned every historical image in resident memory). Every
 * consumer that needs bytes resolves through `resolveMessageBlobRefsSync`, so:
 *
 * - ref-free messages pass through by identity (zero-cost fast path);
 * - ref-bearing messages come back as a structured clone with data restored,
 *   while the input object keeps its ref (resolution never mutates the entry);
 * - `image_url` refs restore the stored data-URL text, not re-encoded base64.
 */
import { describe, expect, it } from "bun:test";
import { containsBlobRef, resolveMessageBlobRefsSync } from "@oh-my-pi/pi-coding-agent/session/blob-ref-resolution";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { getBlobsDir, TempDir } from "@oh-my-pi/pi-utils";

async function putBlobPayload(data: string): Promise<string> {
	const store = new BlobStore(getBlobsDir());
	const { hash } = await store.put(Buffer.from(data, "utf8"));
	return `blob:sha256:${hash}`;
}

/** Store raw image bytes the way `externalizeImageData` does (decoded, not the base64 text). */
async function putBlobBinary(base64: string): Promise<string> {
	const store = new BlobStore(getBlobsDir());
	const { hash } = await store.put(Buffer.from(base64, "base64"));
	return `blob:sha256:${hash}`;
}

describe("resolveMessageBlobRefsSync", () => {
	it("passes ref-free messages through by identity", async () => {
		using tempDir = TempDir.createSync("@pi-blob-ref-resolution-");
		const message = {
			role: "user",
			content: [{ type: "text", text: "no images here" }],
			timestamp: 1,
		};
		expect(containsBlobRef(message)).toBe(false);
		expect(resolveMessageBlobRefsSync(message)).toBe(message);
		expect(tempDir.path()).toBeDefined();
	});

	it("resolves content image refs into a clone without mutating the original", async () => {
		using tempDir = TempDir.createSync("@pi-blob-ref-resolution-");
		const data = Buffer.from("image-bytes-payload".repeat(64)).toString("base64");
		const ref = await putBlobBinary(data);
		expect(tempDir.path()).toBeDefined();
		const message = {
			role: "toolResult" as const,
			toolCallId: "t1",
			toolName: "eval",
			content: [
				{ type: "text", text: "rendered" },
				{ type: "image", data: ref, mimeType: "image/png" },
			],
			details: { images: [{ type: "image", data: ref, mimeType: "image/png" }] },
			isError: false,
			timestamp: 1,
		};

		expect(containsBlobRef(message)).toBe(true);
		const resolved = resolveMessageBlobRefsSync(message) as typeof message;

		// Clone carries inline data in both payload positions...
		expect(resolved.content[1]).toEqual({ type: "image", data, mimeType: "image/png" });
		expect((resolved.details as { images: Array<{ data: string }> }).images[0]?.data).toBe(data);
		// ...and the input entry graph keeps the compact ref.
		expect((message.content[1] as { data: string }).data).toBe(ref);
		expect((message.details as { images: Array<{ data: string }> }).images[0]?.data).toBe(ref);
		// A second resolution is stable and independent.
		expect(resolveMessageBlobRefsSync(message)).toEqual(resolved);
	});

	it("restores image_url refs to the stored data-URL text", async () => {
		const dataUrl = `data:image/png;base64,${"b".repeat(2048)}`;
		const ref = await putBlobPayload(dataUrl);
		const message = {
			role: "user" as const,
			content: "look",
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai-codex",
				items: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_image", detail: "auto", image_url: ref }],
					},
				],
			},
			timestamp: 1,
		};

		const resolved = resolveMessageBlobRefsSync(message) as Required<Pick<typeof message, "providerPayload">>;
		const item = resolved.providerPayload.items[0] as { content: Array<{ image_url: string }> };
		expect(item.content[0]?.image_url).toBe(dataUrl);
	});
});
