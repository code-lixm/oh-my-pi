import { describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	openImageInSystemViewer,
	type PlaceholderKind,
	renderPlaceholders,
	shiftImageMarkers,
} from "@oh-my-pi/pi-coding-agent/modes/image-references";
import type { BlobPutResult } from "../../src/session/blob-store";

function capture(text: string): {
	out: string;
	refs: Array<{ label: string; kind: PlaceholderKind; index: number }>;
} {
	const refs: Array<{ label: string; kind: PlaceholderKind; index: number }> = [];
	const out = renderPlaceholders(text, {
		renderText: t => t,
		renderReference: (label, kind, index) => {
			refs.push({ label, kind, index });
			return `<${kind}:${index}>`;
		},
	});
	return { out, refs };
}

describe("renderPlaceholders", () => {
	it("classifies image and paste markers with their index and full label", () => {
		const { out, refs } = capture("see [Image #1, 800x600] then [Paste #2, +30 lines] done");
		expect(refs).toEqual([
			{ label: "[Image #1, 800x600]", kind: "image", index: 1 },
			{ label: "[Paste #2, +30 lines]", kind: "paste", index: 2 },
		]);
		expect(out).toBe("see <image:1> then <paste:2> done");
	});

	it("matches the bare image form and the char-count paste form", () => {
		expect(capture("[Image #3]").refs[0]).toMatchObject({ kind: "image", index: 3 });
		expect(capture("[Paste #4, 1500 chars]").refs[0]).toMatchObject({ kind: "paste", index: 4 });
	});

	it("passes plain text straight through renderText with no references", () => {
		const { out, refs } = capture("no markers here");
		expect(refs).toHaveLength(0);
		expect(out).toBe("no markers here");
	});

	it("does not treat an unterminated marker as a reference", () => {
		// This is the half-eaten state atomic deletion prevents — it must render as plain text.
		const { refs } = capture("[Paste #1, +30 lines");
		expect(refs).toHaveLength(0);
	});
});

describe("shiftImageMarkers", () => {
	it("returns text unchanged when the offset is zero", () => {
		const text = "[Image #1] then [Image #2, 100x100] and [Paste #3, +5 lines]";
		expect(shiftImageMarkers(text, 0)).toBe(text);
	});

	it("renumbers every Image marker by the offset and preserves the WxH tail", () => {
		expect(shiftImageMarkers("see [Image #1, 800x600] then [Image #2]", 3)).toBe(
			"see [Image #4, 800x600] then [Image #5]",
		);
	});

	it("never touches Paste markers", () => {
		expect(shiftImageMarkers("[Image #1] [Paste #1, +5 lines]", 2)).toBe("[Image #3] [Paste #1, +5 lines]");
	});
});

describe("openImageInSystemViewer", () => {
	it("materializes the original bytes with a typed extension before opening", () => {
		const image: ImageContent = {
			type: "image",
			data: Buffer.from("original-image-bytes").toString("base64"),
			mimeType: "image/webp",
		};
		let written: Buffer | undefined;
		let extension: string | undefined;
		const opened: string[] = [];

		openImageInSystemViewer(
			image,
			(data, options) => {
				written = data;
				extension = options?.extension;
				return {
					hash: "hash",
					path: "/tmp/hash",
					displayPath: "/tmp/hash.webp",
					get ref() {
						return "blob:sha256:hash";
					},
				} satisfies BlobPutResult;
			},
			path => opened.push(path),
		);

		expect(written?.toString()).toBe("original-image-bytes");
		expect(extension).toBe("webp");
		expect(opened).toEqual(["/tmp/hash.webp"]);
	});

	it("does not surface materialization or opener failures", () => {
		const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
		expect(() =>
			openImageInSystemViewer(
				image,
				() => {
					throw new Error("write failed");
				},
				() => {
					throw new Error("must not open");
				},
			),
		).not.toThrow();

		expect(() =>
			openImageInSystemViewer(
				image,
				() =>
					({
						hash: "hash",
						path: "/tmp/hash",
						displayPath: "/tmp/hash.png",
						get ref() {
							return "blob:sha256:hash";
						},
					}) satisfies BlobPutResult,
				() => {
					throw new Error("open failed");
				},
			),
		).not.toThrow();
	});
});
