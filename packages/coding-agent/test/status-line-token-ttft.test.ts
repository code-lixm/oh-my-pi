import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSegmentId } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
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

function makeStatusLineComponent(messages: unknown[], rightSegments: StatusLineSegmentId[]): StatusLineComponent {
	const component = new StatusLineComponent({
		messages,
		state: { messages, model: { contextWindow: 200_000 } },
		model: { contextWindow: 200_000 },
		isStreaming: false,
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
			getSessionName: () => "token-ttft-test",
		},
		getVisibleAsyncJobCount: () => 0,
		getContextUsage: () => undefined,
		contextUsageRevision: 0,
		modelRegistry: { isUsingOAuth: () => false },
		isFastModeActive: () => false,
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0]);
	component.updateSettings({
		preset: "custom",
		leftSegments: [],
		rightSegments,
		separator: "powerline-thin",
		sessionAccent: false,
	});
	return component;
}

function ctxWithTtft(ttftMs: number | null): SegmentContext {
	return {
		usageStats: {
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
			tokensPerSecond: null,
			ttftMs,
		},
	} as unknown as SegmentContext;
}

describe("token_ttft status-line segment", () => {
	it("renders seconds from milliseconds", () => {
		const rendered = renderSegment("token_ttft", ctxWithTtft(1234));

		expect(rendered.visible).toBe(true);
		expect(stripVTControlCharacters(rendered.content)).toContain("1.2s");
	});

	it("hides when no ttft is known", () => {
		expect(renderSegment("token_ttft", ctxWithTtft(null)).visible).toBe(false);
		expect(renderSegment("token_ttft", ctxWithTtft(0)).visible).toBe(false);
	});

	it("renders the last assistant message's ttft through the component seam", () => {
		const component = makeStatusLineComponent(
			[{ role: "user", content: "hi" }, assistantMessage({ ttft: 2500 })],
			["token_ttft"],
		);
		try {
			expect(stripVTControlCharacters(component.getTopBorder(80).content)).toContain("2.5s");
		} finally {
			component.dispose();
		}
	});

	it("skips trailing non-assistant messages when resolving ttft", () => {
		const component = makeStatusLineComponent(
			[{ role: "user", content: "hi" }, assistantMessage({ ttft: 2500 }), { role: "user", content: "next" }],
			["token_ttft"],
		);
		try {
			expect(stripVTControlCharacters(component.getTopBorder(80).content)).toContain("2.5s");
		} finally {
			component.dispose();
		}
	});

	it("does not render ttft when the segment is not configured", () => {
		const component = makeStatusLineComponent([assistantMessage({ ttft: 2500 })], ["cost"]);
		try {
			expect(stripVTControlCharacters(component.getTopBorder(80).content)).not.toContain("2.5s");
		} finally {
			component.dispose();
		}
	});

	it("hides zero or missing ttft on the component seam", () => {
		const zero = makeStatusLineComponent([assistantMessage({ ttft: 0 })], ["token_ttft"]);
		const missing = makeStatusLineComponent([assistantMessage()], ["token_ttft"]);
		try {
			expect(stripVTControlCharacters(zero.getTopBorder(80).content)).not.toMatch(/\d+\.\d+s/);
			expect(stripVTControlCharacters(missing.getTopBorder(80).content)).not.toMatch(/\d+\.\d+s/);
		} finally {
			zero.dispose();
			missing.dispose();
		}
	});
});
