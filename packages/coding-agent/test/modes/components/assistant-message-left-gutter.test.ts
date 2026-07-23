import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const W = 100;

function msg(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...extra,
	};
}

/** Leading-space count of a stripped line — the row's left gutter. */
function gutter(line: string): number {
	const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
	return stripped.length - stripped.trimStart().length;
}

/** First visible (non-blank) row after ANSI strip — the row we care about aligning. */
function firstVisibleLine(rendered: string): string {
	for (const line of rendered.split("\n")) {
		const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
		if (stripped.trim().length > 0) return stripped;
	}
	return "";
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

// Regression: assistant prose lines must share the same left gutter as user
// messages and tool cards so plain text doesn't sit flush against the viewport
// edge while everything else is indented.
describe("AssistantMessageComponent left gutter", () => {
	it("plain text message: first visible row starts in column 1", () => {
		const component = new AssistantMessageComponent();
		component.updateContent(msg([{ type: "text", text: "Hello, world." }]));
		const rendered = component.render(W).join("\n");
		const first = firstVisibleLine(rendered);
		expect(first).toBeTruthy();
		expect(gutter(first)).toBe(1);
	});

	it("plain text message: first visible row carries exactly one leading space", () => {
		// Lock the leaf-level pad. Companion rows (UserMessage, tool cards)
		// have their own contract checked elsewhere.
		const component = new AssistantMessageComponent();
		component.updateContent(msg([{ type: "text", text: "Hello, world." }]));
		const rendered = component.render(W).join("\n");
		const first = firstVisibleLine(rendered);
		expect(first).toBeTruthy();
		expect(gutter(first)).toBe(1);
	});
	it("numbered list inside assistant text: every item shares the same left gutter", () => {
		const component = new AssistantMessageComponent();
		component.updateContent(
			msg([
				{
					type: "text",
					text: "1. Use cache\n2. Stop the spinner\n3. Verify the fix",
				},
			]),
		);
		const rendered = component.render(W).join("\n");
		// Markers are "1. ", "2. ", "3. " — each rendered line begins with the
		// shared 1-cell gutter space then the numeric marker.
		const listLines = rendered
			.split("\n")
			.map(l => l.replace(/\x1b\[[0-9;]*m/g, ""))
			.filter(l => /^ \d+\.\s/.test(l));
		expect(listLines.length).toBeGreaterThanOrEqual(3);
		for (const line of listLines) {
			expect(gutter(line)).toBe(1);
		}
	});

	it("visible thinking row: first visible row starts in column 1 (matches text gutter)", () => {
		// hideThinkingBlock=false → the Markdown thinking branch renders at the
		// row level, padded with the same 1-cell left gutter as text prose. The
		// default constructor already sets hideThinkingBlock=false.
		const component = new AssistantMessageComponent();
		component.updateContent(
			msg([
				{ type: "thinking", thinking: "Reasoning aloud." },
				{ type: "text", text: "Hello, world." },
			]),
		);
		const rendered = component.render(W).join("\n");
		const first = firstVisibleLine(rendered);
		expect(first).toBeTruthy();
		expect(gutter(first)).toBe(1);
	});
});
