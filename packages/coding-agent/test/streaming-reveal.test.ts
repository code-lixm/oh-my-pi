import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import {
	BlockUnitCounter,
	buildDisplayMessage,
	CATCHUP_FRAMES,
	MIN_STEP,
	nextStep,
	STREAMING_REVEAL_FRAME_MS,
	StreamingRevealController,
	visibleUnits,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/streaming-reveal";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { splitAssistantMessageToolTimeline } from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";
import {
	getOutputBlockBorderStyle,
	type OutputBlockBorderStyle,
	setOutputBlockBorderStyle,
} from "@oh-my-pi/pi-coding-agent/tui/output-block";
import { getSegmenter } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme(false);
});

function makeUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: makeUsage(),
		stopReason: "stop",
		timestamp: 0,
	};
}

function textAt(message: AssistantMessage, index: number): string {
	const block = message.content[index];
	if (block?.type !== "text") {
		throw new Error(`Expected text block at index ${index}`);
	}
	return block.text;
}

function thinkingAt(message: AssistantMessage, index: number): string {
	const block = message.content[index];
	if (block?.type !== "thinking") {
		throw new Error(`Expected thinking block at index ${index}`);
	}
	return block.thinking;
}

class RecordingComponent {
	messages: AssistantMessage[] = [];
	transientFlags: Array<boolean | undefined> = [];

	updateContent(message: AssistantMessage, opts?: { transient?: boolean }): void {
		this.messages.push(message);
		this.transientFlags.push(opts?.transient);
	}

	// Component protocol stub — the reveal controller now hands the component
	// to `requestComponentRender`, which only exercises identity, so returning
	// an empty rendered frame is sufficient for these tests.
	render(): readonly string[] {
		return [];
	}
}

function latestMessage(component: RecordingComponent): AssistantMessage {
	const message = component.messages.at(-1);
	if (!message) {
		throw new Error("Expected at least one rendered message");
	}
	return message;
}

function makeController(
	options: { smooth?: boolean; hideThinking?: boolean; proseOnly?: () => boolean; requestRender?: () => void } = {},
) {
	const component = new RecordingComponent();
	const controller = new StreamingRevealController({
		getSmoothStreaming: () => options.smooth ?? true,
		getHideThinkingBlock: () => options.hideThinking ?? false,
		getProseOnlyThinking: options.proseOnly ?? (() => true),
		requestRender: options.requestRender ?? (() => {}),
	});
	return { component, controller };
}

function makeThinkingToolCallMessage(thinking = "planning"): AssistantMessage {
	return makeMessage([
		{ type: "thinking", thinking },
		{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
	]);
}

function splitBeforeToolsTimeline(message: AssistantMessage): {
	beforeTools: AssistantMessage;
	hasToolCalls: boolean;
} {
	const timeline = splitAssistantMessageToolTimeline(
		message as Parameters<typeof splitAssistantMessageToolTimeline>[0],
	);
	return {
		beforeTools: timeline.beforeTools as AssistantMessage,
		hasToolCalls: timeline.hasToolCalls,
	};
}

function renderPlainLines(component: { render(width: number): readonly string[] }, width = 80): string[] {
	return Bun.stripANSI(component.render(width).join("\n"))
		.replace(/\x1b\]133;[AB]\x07/g, "")
		.split("\n")
		.map(line => line.trimEnd());
}

function lineIndexContaining(lines: readonly string[], needle: string): number {
	const index = lines.findIndex(line => line.includes(needle));
	if (index < 0) {
		throw new Error(`Expected a rendered line containing ${JSON.stringify(needle)}`);
	}
	return index;
}

const toolUi = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
	imageBudget: undefined,
};

describe("streaming reveal", () => {
	let previousBorderStyle: OutputBlockBorderStyle;

	beforeEach(() => {
		previousBorderStyle = getOutputBlockBorderStyle();
		setOutputBlockBorderStyle("accent");
	});

	afterEach(() => {
		vi.useRealTimers();
		setOutputBlockBorderStyle(previousBorderStyle);
	});

	it("slices at grapheme boundaries without mutating the target message", () => {
		const familyEmoji = "👨‍👩‍👧‍👦";
		const target = makeMessage([{ type: "text", text: `${familyEmoji}B` }]);

		expect(visibleUnits(target, false)).toBe(2);
		const display = buildDisplayMessage(target, 1, false);

		expect(textAt(display, 0)).toBe(familyEmoji);
		expect(textAt(target, 0)).toBe(`${familyEmoji}B`);
	});

	it("excludes hidden thinking from the reveal budget and passes it through", () => {
		const thinkingBlock = { type: "thinking" as const, thinking: "thought" };
		const target = makeMessage([thinkingBlock, { type: "text", text: "answer" }]);

		expect(visibleUnits(target, true)).toBe("answer".length);
		const display = buildDisplayMessage(target, 1, true);

		expect(display.content[0]).toBe(thinkingBlock);
		expect(thinkingAt(display, 0)).toBe("thought");
		expect(textAt(display, 1)).toBe("a");
	});

	it("excludes dot-only reasoning placeholders from the reveal budget", () => {
		const thinkingBlock = { type: "thinking" as const, thinking: "...", thinkingSignature: "reasoning_content" };
		const target = makeMessage([thinkingBlock, { type: "text", text: "answer" }]);

		expect(visibleUnits(target, false)).toBe("answer".length);
		const display = buildDisplayMessage(target, 1, false);

		expect(display.content[0]).toBe(thinkingBlock);
		expect(textAt(display, 1)).toBe("a");
	});

	it("elides pure-code thinking to an ascii ellipsis in prose-only mode", () => {
		const target = makeMessage([
			{ type: "thinking", thinking: "```js\nconst x = 1;\n```" },
			{ type: "text", text: "answer" },
		]);

		expect(visibleUnits(target, false, true)).toBe("...answer".length);
		const display = buildDisplayMessage(target, 3, false, true);

		expect(thinkingAt(display, 0)).toBe("...");
		expect(textAt(display, 1)).toBe("");

		const component = new AssistantMessageComponent(display, false, undefined, [], undefined, true);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("...");
	});

	it("keeps fenced code thinking raw in full mode", () => {
		const code = "```js\nconst x = 1;\n```";
		const target = makeMessage([
			{ type: "thinking", thinking: code },
			{ type: "text", text: "answer" },
		]);

		expect(visibleUnits(target, false, false)).toBe(`${code}answer`.length);
		const display = buildDisplayMessage(target, `${code}answer`.length, false, false);
		expect(thinkingAt(display, 0)).toBe(code);
		expect(textAt(display, 1)).toBe("answer");
	});

	it("refreshes prose-only setting during unsmoothed streaming updates", () => {
		let proseOnly = true;
		const target = makeMessage([{ type: "thinking", thinking: "```js\nconst x = 1;\n```" }]);
		const { component, controller } = makeController({ smooth: false, proseOnly: () => proseOnly });

		controller.begin(component, target);
		expect(thinkingAt(latestMessage(component), 0)).toBe("...");

		proseOnly = false;
		controller.setTarget(target);
		expect(thinkingAt(latestMessage(component), 0)).toBe("```js\nconst x = 1;\n```");
	});

	it("smooths thinking content when thinking is shown", () => {
		const target = makeMessage([
			{ type: "thinking", thinking: "thought" },
			{ type: "text", text: "answer" },
		]);

		expect(visibleUnits(target, false)).toBe("thoughtanswer".length);
		const display = buildDisplayMessage(target, 3, false);

		expect(thinkingAt(display, 0)).toBe("tho");
		expect(textAt(display, 1)).toBe("");
	});

	it("uses an adaptive catchup step with the configured floor", () => {
		const largeBacklog = CATCHUP_FRAMES * 101;
		const step = nextStep(largeBacklog);

		expect(step).toBe(101);
		expect(step * CATCHUP_FRAMES).toBeGreaterThanOrEqual(largeBacklog);
		expect(nextStep(1)).toBe(MIN_STEP);
		expect(nextStep(MIN_STEP * CATCHUP_FRAMES)).toBe(MIN_STEP);
	});

	it("reveals cumulative targets to the exact final text with monotonic prefixes", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();
		const first = makeMessage([{ type: "text", text: "Hello" }]);
		const second = makeMessage([{ type: "text", text: "Hello world" }]);

		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(first);
		for (let i = 0; i < 4; i++) {
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		}
		controller.setTarget(second);
		for (let i = 0; i < 4; i++) {
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		}

		const renderedTexts = component.messages.map(message => textAt(message, 0));
		expect(renderedTexts.at(-1)).toBe("Hello world");
		for (let i = 1; i < renderedTexts.length; i++) {
			expect(renderedTexts[i].length).toBeGreaterThanOrEqual(renderedTexts[i - 1].length);
			expect("Hello world".startsWith(renderedTexts[i])).toBe(true);
		}
	});

	it("keeps grapheme counts correct when an append extends the final cluster", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "ab👨" }]));
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		// The appended ZWJ sequence merges into the previous final grapheme:
		// "👨" + "\u200D👩" becomes a single cluster, so the cached per-block
		// count must re-segment from that cluster, not just add the suffix.
		controller.setTarget(makeMessage([{ type: "text", text: "ab👨\u200D👩x" }]));
		for (let i = 0; i < 6; i++) {
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		}

		expect(textAt(latestMessage(component), 0)).toBe("ab👨\u200D👩x");
	});

	it("renders full targets immediately when smoothing is disabled", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const { component, controller } = makeController({ smooth: false, requestRender });

		controller.begin(component, makeMessage([{ type: "text", text: "chunk" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "chunky" }]));
		const updates = component.messages.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 10);

		expect(textAt(latestMessage(component), 0)).toBe("chunky");
		expect(component.messages).toHaveLength(updates);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("marks unsmoothed in-flight updates as transient", () => {
		const { component, controller } = makeController({ smooth: false });

		controller.begin(component, makeMessage([{ type: "text", text: "chunk" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "chunky" }]));

		expect(component.transientFlags).toEqual([true, true]);
	});

	it("keeps smooth catch-up renders transient until the final message_end render", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "abc" }]));
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);

		expect(textAt(latestMessage(component), 0)).toBe("abc");
		expect(component.transientFlags).not.toHaveLength(0);
		expect(component.transientFlags.every(flag => flag === true)).toBe(true);
	});

	it("stop halts pending ticker updates", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "abcdefghi" }]));
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		controller.stop();
		const updates = component.messages.length;
		const lastText = textAt(latestMessage(component), 0);
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 10);

		expect(component.messages).toHaveLength(updates);
		expect(textAt(latestMessage(component), 0)).toBe(lastText);
	});

	it("snaps to full text when a tool call arrives", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const { component, controller } = makeController({ requestRender });

		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "abcdefghi" }]));
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		expect(textAt(latestMessage(component), 0)).toBe("abc");

		controller.setTarget(
			makeMessage([
				{ type: "text", text: "abcdefghi" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
			]),
		);
		const updates = component.messages.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 10);

		expect(textAt(latestMessage(component), 0)).toBe("abcdefghi");
		expect(component.messages).toHaveLength(updates);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("fully reveals split thinking in begin when the original turn already has a tool call", () => {
		vi.useFakeTimers();
		const { controller } = makeController();
		const component = new AssistantMessageComponent();
		const timeline = splitBeforeToolsTimeline(makeThinkingToolCallMessage());

		expect(timeline.hasToolCalls).toBe(true);

		controller.begin(component, timeline.beforeTools, { snapToEnd: timeline.hasToolCalls });

		expect(renderPlainLines(component).some(line => line.includes("planning"))).toBe(true);
	});

	it("fully reveals split thinking in setTarget when a tool boundary replaces a partial smooth stream", () => {
		vi.useFakeTimers();
		const { controller } = makeController();
		const component = new AssistantMessageComponent();

		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "abcdefghi" }]));
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		expect(renderPlainLines(component).some(line => line.includes("abc"))).toBe(true);

		const timeline = splitBeforeToolsTimeline(makeThinkingToolCallMessage());
		controller.setTarget(timeline.beforeTools, { snapToEnd: timeline.hasToolCalls });

		expect(renderPlainLines(component).some(line => line.includes("planning"))).toBe(true);
	});

	it("keeps exactly one plain separator between snapped thinking and an accent tool block", () => {
		const { controller } = makeController();
		const assistant = new AssistantMessageComponent();
		const timeline = splitBeforeToolsTimeline(makeThinkingToolCallMessage());
		controller.begin(assistant, timeline.beforeTools, { snapToEnd: timeline.hasToolCalls });

		const tool = new ToolExecutionComponent("custom-tool", { path: "README.md" }, {}, undefined, toolUi);
		tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);

		const transcript = new TranscriptContainer();
		transcript.addChild(assistant);
		transcript.addChild(tool);

		const lines = renderPlainLines(transcript);
		const thinkingIndex = lineIndexContaining(lines, "planning");
		const toolIndex = lineIndexContaining(lines, "custom-tool");

		expect(toolIndex).toBeGreaterThan(thinkingIndex);
		const accentIndex = lines.findIndex((line, index) => index > thinkingIndex && line === "▌");
		expect(accentIndex).toBeGreaterThan(thinkingIndex);
		expect(lines.slice(thinkingIndex + 1, accentIndex)).toEqual([""]);
		expect(lines.slice(accentIndex, toolIndex)).toEqual(["▌"]);
	});

	it("passes the bound component to requestRender on each smooth tick", () => {
		// The controller must hand its component to `requestRender` so the caller
		// scopes the render to that subtree via `TUI.requestComponentRender`
		// instead of forcing a full-tree walk at 30fps (issue #4377).
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const { component, controller } = makeController({ requestRender });

		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "abcdef" }]));
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);

		expect(requestRender).toHaveBeenCalled();
		for (const call of requestRender.mock.calls) {
			expect(call[0]).toBe(component);
		}
	});
});

/** Pure Intl.Segmenter grapheme count, independent of BlockUnitCounter's memoization. */
function refCount(text: string): number {
	let n = 0;
	for (const _segment of getSegmenter().segment(text)) n += 1;
	return n;
}

/** Pure Intl.Segmenter grapheme slice, independent of BlockUnitCounter's memoization. */
function refSlice(text: string, units: number): string {
	if (units <= 0) return "";
	let n = 0;
	for (const { index, segment } of getSegmenter().segment(text)) {
		n += 1;
		if (n >= units) return text.slice(0, index + segment.length);
	}
	return text;
}

describe("BlockUnitCounter.slice", () => {
	it("matches a pure segmenter reference for fixed-text growing units", () => {
		const counter = new BlockUnitCounter();
		const text = "café 👨‍👩‍👧‍👦 naïve 日本語 ❤️";
		const total = refCount(text);
		for (let units = 0; units <= total; units++) {
			expect(counter.slice(0, text, units)).toBe(refSlice(text, units));
		}
	});

	it("re-segments the boundary cluster when an append extends it (no stale slice)", () => {
		const counter = new BlockUnitCounter();
		// "a" cached at 1 grapheme; appending a combining mark keeps it 1 cluster
		// but changes the cluster's code units — the slice must not return stale "a".
		expect(counter.slice(0, "a", 1)).toBe("a");
		expect(counter.slice(0, "a\u0301", 1)).toBe("a\u0301");
		// A ZWJ append merges the previous final cluster into a family emoji.
		const merged = new BlockUnitCounter();
		expect(merged.slice(0, "ab👨", 3)).toBe("ab👨");
		expect(merged.slice(0, "ab👨\u200D👩x", 3)).toBe("ab👨\u200D👩");
	});

	it("keeps separate block indices independent", () => {
		const counter = new BlockUnitCounter();
		const a = "hello world";
		const b = "café résumé";
		const ta = refCount(a);
		const tb = refCount(b);
		for (let units = 0; units <= ta; units++) expect(counter.slice(0, a, units)).toBe(refSlice(a, units));
		for (let units = 0; units <= tb; units++) expect(counter.slice(1, b, units)).toBe(refSlice(b, units));
		// Re-slicing block 0 after touching block 1 still matches the reference.
		expect(counter.slice(0, a, ta)).toBe(a);
	});

	it("matches the reference after a shrink and regrow", () => {
		const counter = new BlockUnitCounter();
		const text = "the quick brown fox jumps over";
		const total = refCount(text);
		expect(counter.slice(0, text, total)).toBe(text);
		expect(counter.slice(0, text, 2)).toBe(refSlice(text, 2));
		expect(counter.slice(0, text, total - 1)).toBe(refSlice(text, total - 1));
	});

	it("matches the reference when the text is fully replaced", () => {
		const counter = new BlockUnitCounter();
		expect(counter.slice(0, "first block of text", 3)).toBe(refSlice("first block of text", 3));
		expect(counter.slice(0, "completely different café content", 5)).toBe(
			refSlice("completely different café content", 5),
		);
	});

	it("matches the reference under seeded append + monotonic reveal (fuzz)", () => {
		// Deterministic PRNG so the fuzz is reproducible across runs.
		let state = 0x1234abcd;
		const rand = (): number => {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			return ((state >>> 0) % 100000) / 100000;
		};
		// Appendable chunks include lone combining marks / ZWJ so appends randomly
		// merge into the previous boundary cluster, stressing that invariant.
		const chunks = ["a", "bc ", "e", "\u0301", "👨", "\u200D👩", "日", "本", "❤️", "xy", " ", "z"];
		const counter = new BlockUnitCounter();
		let text = "";
		let revealed = 0;
		for (let step = 0; step < 400; step++) {
			if (rand() < 0.6 || text.length === 0) {
				text += chunks[Math.floor(rand() * chunks.length)]!;
			}
			const total = refCount(text);
			// Monotonic reveal advance, with an occasional reset to a small value
			// to exercise the full re-segment path.
			revealed = rand() < 0.05 ? Math.floor(rand() * 3) : Math.min(total, revealed + 1 + Math.floor(rand() * 6));
			if (revealed < 0) revealed = 0;
			expect(counter.slice(0, text, revealed)).toBe(refSlice(text, revealed));
		}
	});
});
