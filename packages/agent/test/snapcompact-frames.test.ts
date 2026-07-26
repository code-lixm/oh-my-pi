import { describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { estimateTokens } from "../src/compaction/compaction";
import { createCompactionSummaryMessage, defaultConvertToLlm } from "../src/compaction/messages";

describe("compaction summary message with snapcompact frames", () => {
	const images: ImageContent[] = [
		{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
		{ type: "image", data: "ZmFrZTI=", mimeType: "image/png" },
	];

	it("estimateTokens charges per attached frame", () => {
		const bare = createCompactionSummaryMessage("summary text", 1000, new Date().toISOString());
		const withFrames = createCompactionSummaryMessage(
			"summary text",
			1000,
			new Date().toISOString(),
			undefined,
			undefined,
			images,
		);
		expect(estimateTokens(withFrames) - estimateTokens(bare)).toBe(2 * snapcompact.FRAME_TOKEN_ESTIMATE);
	});

	it("defaultConvertToLlm forwards the raw markdown summary without any wrapper text", () => {
		const summary = `## Objective
	- Preserve the generated summary exactly.

## Important Details
	- Wrapper text must stay out of the provider request.

## Work State
### Completed
	- Added the focused conversion assertion.

### Active
	- (none)

### Blocked
	- (none)

## Next Move
	1. Run the compaction message tests.
	2. Report the results.

## Relevant Files
	- packages/agent/test/snapcompact-frames.test.ts: pins compaction-summary conversion`;
		const message = createCompactionSummaryMessage(summary, 1000, new Date().toISOString());
		const [converted] = defaultConvertToLlm([message]);
		expect(converted).toMatchObject({ role: "user" });
		expect(converted.content).toEqual([{ type: "text", text: summary }]);
	});

	it("defaultConvertToLlm appends frames as image blocks after the summary text", () => {
		const message = createCompactionSummaryMessage(
			"the snapcompact archive",
			1000,
			new Date().toISOString(),
			undefined,
			undefined,
			images,
		);
		const [converted] = defaultConvertToLlm([message]);
		expect(converted.role).toBe("user");
		const content = converted.content as Array<{ type: string; text?: string; data?: string }>;
		expect(content.length).toBe(3);
		expect(content[0].type).toBe("text");
		expect(content[0].text).toContain("the snapcompact archive");
		expect(content[1]).toEqual(images[0]);
		expect(content[2]).toEqual(images[1]);
	});
});
