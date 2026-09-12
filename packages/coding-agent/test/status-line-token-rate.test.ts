import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { countStreamingAssistantTokens } from "@oh-my-pi/pi-coding-agent/modes/utils/streaming-tokens";
import {
	calculateTokensPerSecond,
	getLastAssistantTtftMs,
	StreamingRateTracker,
} from "@oh-my-pi/pi-coding-agent/utils/token-rate";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

function assistantMessage(overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4.5",
		usage: {
			input: 10,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 60,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1_000,
		...overrides,
	};
}

function makeStatusLineComponent(options?: {
	messages?: AssistantMessage[];
	isStreaming?: boolean;
}): StatusLineComponent {
	const messages = options?.messages ?? [];
	const component = new StatusLineComponent({
		messages,
		state: { messages, model: { contextWindow: 200_000 } },
		model: { contextWindow: 200_000 },
		isStreaming: options?.isStreaming ?? false,
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
			getSessionName: () => "token-rate-test",
		},
		getVisibleAsyncJobCount: () => 0,
		getContextUsage: () => undefined,
		contextUsageRevision: 0,
		modelRegistry: { isUsingOAuth: () => false },
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0]);
	component.updateSettings({
		preset: "custom",
		leftSegments: ["token_rate"],
		rightSegments: [],
		separator: "powerline-thin",
		sessionAccent: false,
	});
	return component;
}

function ctxWithTokenRate(tokensPerSecond: number | null): SegmentContext {
	return {
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond,
		},
	} as unknown as SegmentContext;
}

describe("token_rate status-line segment", () => {
	it("renders per-second throughput without a numeric slash path", () => {
		const rendered = renderSegment("token_rate", ctxWithTokenRate(35.5));
		const content = stripVTControlCharacters(rendered.content);

		expect(rendered.visible).toBe(true);
		expect(content).toContain("35.5");
		expect(content).toMatch(/(?:\/s|\bs\b|\bsec(?:ond)?s?\b|\btps\b)/i);
		expect(content).not.toContain("35.5/s");
		expect(content).not.toMatch(/\b\d+(?:\.\d+)?\/s\b/);
	});

	it("adds worker throughput to the streaming main-session rate through the StatusLineComponent seam", () => {
		const base = assistantMessage();
		const component = makeStatusLineComponent({
			isStreaming: true,
			messages: [assistantMessage({ timestamp: 10_000, duration: undefined, usage: { ...base.usage, output: 30 } })],
		});
		vi.spyOn(Date, "now").mockReturnValue(12_000);

		component.setVibeWorkerTokenRateProvider(() => 17.5);

		expect(stripVTControlCharacters(component.getTopBorder(80).content)).toContain("32.5 t/s");
	});
});

describe("token rate calculation", () => {
	it("computes from completed message duration metadata", () => {
		const base = assistantMessage();
		const rate = calculateTokensPerSecond(
			[assistantMessage({ usage: { ...base.usage, output: 120 }, duration: 2_000 })],
			false,
		);
		expect(rate).toBe(60);
	});

	it("computes from elapsed time while streaming when duration metadata is missing", () => {
		const base = assistantMessage();
		const rate = calculateTokensPerSecond(
			[assistantMessage({ timestamp: 10_000, duration: undefined, usage: { ...base.usage, output: 45 } })],
			true,
			13_000,
		);
		expect(rate).toBe(15);
	});

	it("returns null for near-zero durations to avoid unstable spikes", () => {
		const base = assistantMessage();
		const rate = calculateTokensPerSecond(
			[assistantMessage({ duration: 50, usage: { ...base.usage, output: 5 } })],
			false,
		);
		expect(rate).toBeNull();
	});

	it("returns null when stream is interrupted and duration metadata is unavailable", () => {
		const rate = calculateTokensPerSecond([assistantMessage({ stopReason: "aborted", duration: undefined })], false);
		expect(rate).toBeNull();
	});

	it("returns null when usage metadata has no output tokens", () => {
		const base = assistantMessage();
		const rate = calculateTokensPerSecond(
			[assistantMessage({ usage: { ...base.usage, output: 0, totalTokens: 10 } })],
			false,
		);
		expect(rate).toBeNull();
	});
});

describe("last assistant TTFT lookup", () => {
	it("returns the most recent assistant message's ttft", () => {
		expect(getLastAssistantTtftMs([assistantMessage({ ttft: 2500 })])).toBe(2500);
	});

	it("skips trailing non-assistant messages", () => {
		expect(getLastAssistantTtftMs([assistantMessage({ ttft: 2500 }), { role: "user" }])).toBe(2500);
	});

	it("returns null for absent or non-positive ttft", () => {
		expect(getLastAssistantTtftMs([])).toBeNull();
		expect(getLastAssistantTtftMs([assistantMessage()])).toBeNull();
		expect(getLastAssistantTtftMs([assistantMessage({ ttft: 0 })])).toBeNull();
	});
});

describe("streaming rate tracker", () => {
	it("reports a live rate from two observations inside the window", () => {
		const tracker = new StreamingRateTracker();
		tracker.begin(0, 1_000);
		tracker.sample(50, 2_000);
		expect(tracker.getLiveRate()).toBe(50);
	});

	it("withholds a rate until two observations span a measurable interval", () => {
		const tracker = new StreamingRateTracker();
		tracker.begin(0, 1_000);
		// Single reading, and a second one too close in time: neither is a rate.
		expect(tracker.getLiveRate()).toBeNull();
		tracker.sample(40, 1_050);
		expect(tracker.getLiveRate()).toBeNull();
	});

	it("averages the whole generation and freezes it when the stream ends", () => {
		const tracker = new StreamingRateTracker();
		tracker.begin(10, 1_000);
		tracker.sample(110, 3_000);
		// 100 tokens over 2s.
		expect(tracker.getAverageRate(3_000)).toBe(50);
		tracker.end(3_000);
		// The idle row must keep reporting the turn's real figure, not a rate
		// diluted by however long the user sat idle afterwards.
		expect(tracker.getAverageRate(60_000)).toBe(50);
	});

	it("drops observations older than the window so the live rate tracks the present", () => {
		const tracker = new StreamingRateTracker();
		tracker.begin(0, 0);
		tracker.sample(1_000, 1_000);
		// A long stall, then a burst: the early burst must not hold the rate up.
		tracker.sample(1_010, 10_000);
		tracker.sample(1_110, 12_000);
		expect(tracker.getLiveRate()).toBe(50);
	});

	it("stops sampling once the generation ended", () => {
		const tracker = new StreamingRateTracker();
		tracker.begin(0, 1_000);
		tracker.sample(50, 2_000);
		tracker.end(2_000);
		expect(tracker.active).toBe(false);
		tracker.sample(500, 3_000);
		expect(tracker.getAverageRate(3_000)).toBe(50);
	});

	it("opens a window from the first observation when the caller never began one", () => {
		const tracker = new StreamingRateTracker();
		tracker.sample(25, 1_000);
		tracker.sample(75, 2_000);
		expect(tracker.active).toBe(true);
		expect(tracker.getLiveRate()).toBe(50);
	});
});

describe("streaming assistant token counting", () => {
	it("prefers provider-reported output once it arrives", () => {
		const base = assistantMessage();
		const message = assistantMessage({ usage: { ...base.usage, output: 900 } });
		expect(countStreamingAssistantTokens(message)).toBe(900);
	});

	it("counts visible text while the provider has not reported usage yet", () => {
		const base = assistantMessage();
		const message = assistantMessage({
			content: [{ type: "text", text: "hello world, this is a streamed reply" }],
			usage: { ...base.usage, output: 0, totalTokens: 0 },
		});
		expect(countStreamingAssistantTokens(message)).toBeGreaterThan(0);
	});

	it("counts a thinking-only message so the rate exists through the reasoning phase", () => {
		const base = assistantMessage();
		const message = assistantMessage({
			content: [{ type: "thinking", thinking: "weighing the options at length" }],
			usage: { ...base.usage, output: 0, totalTokens: 0 },
		});
		expect(countStreamingAssistantTokens(message)).toBeGreaterThan(0);
	});

	it("reports zero for an absent message", () => {
		expect(countStreamingAssistantTokens(undefined)).toBe(0);
	});
});
