import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../i18n/settings-locale";
import type { FileMentionMessage } from "../../session/messages";
import { initTheme } from "../theme/theme";
import {
	assistantUsageIsBilled,
	buildFileMentionBlock,
	updateAssistantErrorAggregation,
} from "./transcript-render-helpers";

let previousLocale = getSettingsUiLocale();

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	previousLocale = getSettingsUiLocale();
});

afterEach(() => {
	setSettingsUiLocale(previousLocale);
});

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

function assistantErrorMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: usage(),
		stopReason: "error",
		timestamp: 1,
		errorMessage:
			"server_error: The server had an error processing your request. Please include the request ID req_default in your message.",
		...overrides,
	};
}

describe("updateAssistantErrorAggregation", () => {
	it("folds adjacent OpenAI server_error retries whose request IDs differ", () => {
		const applyCalls: Array<{ target: string; repeatCount: number; suppressed: boolean }> = [];
		const apply = (target: string, repeatCount: number, suppressed: boolean) => {
			applyCalls.push({ target, repeatCount, suppressed });
		};

		const first = assistantErrorMessage({
			errorMessage:
				"server_error: The server had an error processing your request. Please include the request ID req_first in your message.",
		});
		const second = assistantErrorMessage({
			errorMessage:
				"server_error: The server had an error processing your request. Please include the request ID req_second in your message.",
			timestamp: 2,
		});

		const firstRun = updateAssistantErrorAggregation(undefined, first, "leader", apply);
		expect(firstRun).toMatchObject({ leader: "leader", repeatCount: 1 });
		expect(applyCalls).toEqual([{ target: "leader", repeatCount: 1, suppressed: false }]);

		const secondRun = updateAssistantErrorAggregation(firstRun, second, "retry", apply);
		expect(secondRun).toMatchObject({ leader: "leader", repeatCount: 2 });
		expect(applyCalls).toEqual([
			{ target: "leader", repeatCount: 1, suppressed: false },
			{ target: "leader", repeatCount: 2, suppressed: false },
			{ target: "retry", repeatCount: 2, suppressed: true },
		]);
	});

	it("starts a new group when the OpenAI error body or code changes", () => {
		const cases = [
			{
				name: "different body",
				first: "server_error: The server had an error processing your request. Please include the request ID req_first in your message.",
				second:
					"server_error: The upstream timed out after 60 seconds. Please include the request ID req_second in your message.",
			},
			{
				name: "different code",
				first: "server_error: The server had an error processing your request. Please include the request ID req_first in your message.",
				second:
					"rate_limit_error: The server had an error processing your request. Please include the request ID req_second in your message.",
			},
		] as const;

		for (const testCase of cases) {
			const applyCalls: Array<{ target: string; repeatCount: number; suppressed: boolean }> = [];
			const apply = (target: string, repeatCount: number, suppressed: boolean) => {
				applyCalls.push({ target, repeatCount, suppressed });
			};

			const previous = updateAssistantErrorAggregation(
				undefined,
				assistantErrorMessage({ errorMessage: testCase.first }),
				"leader",
				apply,
			);
			const next = updateAssistantErrorAggregation(
				previous,
				assistantErrorMessage({ errorMessage: testCase.second, timestamp: 2 }),
				"next",
				apply,
			);

			expect(next, testCase.name).toMatchObject({ leader: "next", repeatCount: 1, errorMessage: testCase.second });
			expect(applyCalls, testCase.name).toEqual([
				{ target: "leader", repeatCount: 1, suppressed: false },
				{ target: "next", repeatCount: 1, suppressed: false },
			]);
		}
	});
});

describe("buildFileMentionBlock", () => {
	it("keeps transcript read summaries on the literal lowercase tool name in en and zh-CN", () => {
		const files = [{ path: "src/example.ts", lineCount: 12 }] as FileMentionMessage["files"];

		setSettingsUiLocale("en");
		const english = Bun.stripANSI(buildFileMentionBlock(files, 0).render(80).join("\n"));
		expect(english).toContain("read src/example.ts");
		expect(english).not.toContain("Read src/example.ts");

		setSettingsUiLocale("zh-CN");
		const chinese = Bun.stripANSI(buildFileMentionBlock(files, 0).render(80).join("\n"));
		expect(chinese).toContain("read src/example.ts");
		expect(chinese).not.toContain("读取 src/example.ts");
	});
});

describe("assistantUsageIsBilled", () => {
	it("suppresses the token badge only for turns that consumed nothing", () => {
		expect(assistantUsageIsBilled(usage())).toBe(false);
	});

	it("preserves cost transparency for empty replies whose prompt still cost input tokens", () => {
		expect(assistantUsageIsBilled(usage({ input: 321 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ output: 0, cacheRead: 512 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ cacheWrite: 128 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ premiumRequests: 1 }))).toBe(true);
	});

	// Documents the live/resume parity contract for #4532: both paths ask
	// `assistantUsageIsBilled` about `message.usage`, so an empty automated
	// reply that still cost input tokens renders identically on both surfaces.
	it("matches whether the assistant carrier renders visible content", () => {
		const emptyBilledMessage: Pick<AssistantMessage, "usage"> = { usage: usage({ input: 321 }) };
		const emptyFreeMessage: Pick<AssistantMessage, "usage"> = { usage: usage() };
		expect(assistantUsageIsBilled(emptyBilledMessage.usage)).toBe(true);
		expect(assistantUsageIsBilled(emptyFreeMessage.usage)).toBe(false);
	});
});
