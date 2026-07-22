import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { calculateTokensPerSecond } from "@oh-my-pi/pi-coding-agent/utils/token-rate";
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
		getAsyncJobSnapshot: () => ({ running: [] }),
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

		expect(stripVTControlCharacters(component.getTopBorder(80).content)).toContain("32.5 tok/s");
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
