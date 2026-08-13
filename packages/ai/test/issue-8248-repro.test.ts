import { describe, expect, it } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Issue #8248: with prewalk enabled, OMP switches into a DeepSeek Responses
// target (opencode-go) after mid-run compaction. The replayed assistant turns
// were minted by the previous model, so the Responses input builder re-encodes
// them and demotes their reasoning to plain text, emitting no reasoning item.
// DeepSeek then rejects the thinking-mode continuation:
//   400 The reasoning_text in the thinking mode must be passed back to the API.
// The encoder must synthesize a reasoning item carrying `reasoning_text` for
// each replayed assistant turn when the target requires it in thinking mode.

interface ReasoningTextPart {
	type: string;
	text: string;
}

interface ResponsesInputItem {
	type?: string;
	role?: string;
	content?: unknown;
	call_id?: string;
	name?: string;
	arguments?: unknown;
}

interface ResponsesPayload {
	reasoning?: { effort?: string };
	input?: ResponsesInputItem[];
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function capture(
	model: Model<"openai-responses">,
	context: Context,
	overrides: { reasoning?: Effort; disableReasoning?: boolean } = {},
): Promise<ResponsesPayload> {
	const { promise, resolve } = Promise.withResolvers<ResponsesPayload>();
	streamOpenAIResponses(model, context, {
		apiKey: "sk-test",
		reasoning: "reasoning" in overrides ? overrides.reasoning : Effort.XHigh,
		disableReasoning: overrides.disableReasoning,
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as ResponsesPayload),
	});
	return promise;
}

function reasoningItems(payload: ResponsesPayload): ResponsesInputItem[] {
	return (payload.input ?? []).filter(item => item.type === "reasoning");
}

function reasoningTextOf(item: ResponsesInputItem): string {
	const content = Array.isArray(item.content) ? (item.content as ReasoningTextPart[]) : [];
	return content
		.filter(part => part.type === "reasoning_text")
		.map(part => part.text)
		.join("");
}

const deepseek = getBundledModel("opencode-go", "deepseek-v4-flash") as Model<"openai-responses">;

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

describe("issue #8248: DeepSeek Responses reasoning replay after prewalk/compaction", () => {
	it("targets a reasoning Responses model that requires reasoning replay", () => {
		expect(deepseek.api).toBe("openai-responses");
		expect(deepseek.compat.requiresReasoningContentForAllAssistantTurns).toBe(true);
	});

	it("synthesizes a reasoning item for a foreign assistant turn replayed after a prewalk switch", async () => {
		// Kept-tail turn minted by the previous model (prewalk hopped gpt-5.6-sol
		// -> deepseek). Same api, different provider+model -> block re-encode.
		const prior: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "github-copilot",
			model: "gpt-5.6-sol",
			stopReason: "stop",
			usage,
			content: [
				{
					type: "thinking",
					thinking: "Refactor plan for foo.",
					thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_prev" }),
				},
				{ type: "text", text: "Refactored bar.ts." },
			],
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Refactor foo", timestamp: Date.now() },
				prior,
				{ role: "user", content: "Now update the tests", timestamp: Date.now() },
			],
		};

		const payload = await capture(deepseek, context);
		expect(payload.reasoning?.effort).toBeDefined();

		const input = payload.input ?? [];
		const reasoning = reasoningItems(payload);
		expect(reasoning).toHaveLength(1);
		// The reasoning item must precede the assistant message it belongs to.
		const reasoningIdx = input.findIndex(item => item.type === "reasoning");
		const assistantIdx = input.findIndex(item => item.type === "message" && item.role === "assistant");
		expect(reasoningIdx).toBeGreaterThanOrEqual(0);
		expect(reasoningIdx).toBeLessThan(assistantIdx);
		// It carries a reasoning_text content part (the field DeepSeek requires).
		const content = Array.isArray(reasoning[0]!.content) ? (reasoning[0]!.content as ReasoningTextPart[]) : [];
		expect(content.some(part => part.type === "reasoning_text")).toBe(true);
	});

	it("carries the actual reasoning text when a same-model thinking block survives replay", async () => {
		// Same provider/model (deepseek) but no native providerPayload (dropped by
		// compaction). The thinking block survives transform with no native
		// Responses signature, so its text must ride in the synthesized item.
		const prior: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "opencode-go",
			model: "deepseek-v4-flash",
			stopReason: "stop",
			usage,
			content: [
				{ type: "thinking", thinking: "Inspect bar.ts before editing." },
				{ type: "text", text: "Edited bar.ts." },
			],
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Edit bar", timestamp: Date.now() },
				prior,
				{ role: "user", content: "Run the tests", timestamp: Date.now() },
			],
		};

		const payload = await capture(deepseek, context);
		const reasoning = reasoningItems(payload);
		expect(reasoning).toHaveLength(1);
		expect(reasoningTextOf(reasoning[0]!)).toBe("Inspect bar.ts before editing.");
	});

	it("synthesizes a non-empty placeholder reasoning item when the foreign turn captured no thinking at all", async () => {
		// GPT encrypted CoT / minimax / compacted turns carry no thinking block
		// at all. Console Go rejects BOTH an empty reasoning_text and a missing
		// reasoning item — "The reasoning_text in the thinking mode must be
		// passed back to the API" — so the replay must still ship a non-empty
		// item (regression: 400 retry loop on gpt -> deepseek fallback).
		const prior: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "github-copilot",
			model: "gpt-5.6-sol",
			stopReason: "stop",
			usage,
			content: [{ type: "text", text: "Refactored bar.ts." }],
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Refactor foo", timestamp: Date.now() },
				prior,
				{ role: "user", content: "Now update the tests", timestamp: Date.now() },
			],
		};

		const payload = await capture(deepseek, context);
		const reasoning = reasoningItems(payload);
		expect(reasoning).toHaveLength(1);
		const text = reasoningTextOf(reasoning[0]!);
		expect(text.trim().length).toBeGreaterThan(0);
	});

	it("synthesizes a non-empty placeholder reasoning item for a foreign tool-call turn with no thinking", async () => {
		// Console Go's DeepSeek gateway enforces reasoning replay on tool-call
		// turns specifically (verified against the live backend: a replayed
		// function_call without a reasoning item 400s, an empty reasoning_text
		// 400s, and a non-empty placeholder passes). Foreign tool-call turns
		// with no captured thinking must therefore still ship a non-empty item.
		const prior: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "github-copilot",
			model: "gpt-5.6-sol",
			stopReason: "toolUse",
			usage,
			content: [{ type: "toolCall", id: "call_prev", name: "read", arguments: { path: "a.ts" } }],
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Read a.ts", timestamp: Date.now() },
				prior,
				{
					role: "toolResult",
					toolCallId: "call_prev",
					toolName: "read",
					content: [{ type: "text", text: "contents" }],
					isError: false,
					timestamp: Date.now(),
				},
				{ role: "user", content: "Now what?", timestamp: Date.now() },
			],
		};

		const payload = await capture(deepseek, context);
		const reasoning = reasoningItems(payload);
		expect(reasoning.length).toBeGreaterThanOrEqual(1);
		const text = reasoningTextOf(reasoning[0]!);
		expect(text.trim().length).toBeGreaterThan(0);
	});

	it("synthesizes a reasoning item for every consecutive foreign tool-call turn", async () => {
		// The reported 400 logs show long runs of consecutive tool-call turns
		// (bash/read/... ) with no reasoning — each foreign turn must get its
		// own synthesized non-empty reasoning item.
		const priorA: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "github-copilot",
			model: "gpt-5.6-sol",
			stopReason: "toolUse",
			usage,
			content: [{ type: "toolCall", id: "call_a", name: "bash", arguments: { command: "ls" } }],
			timestamp: Date.now(),
		};
		const priorB: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "github-copilot",
			model: "gpt-5.6-sol",
			stopReason: "toolUse",
			usage,
			content: [{ type: "toolCall", id: "call_b", name: "read", arguments: { path: "b.ts" } }],
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Inspect the repo", timestamp: Date.now() },
				priorA,
				{
					role: "toolResult",
					toolCallId: "call_a",
					toolName: "bash",
					content: [{ type: "text", text: "a.ts b.ts" }],
					isError: false,
					timestamp: Date.now(),
				},
				priorB,
				{
					role: "toolResult",
					toolCallId: "call_b",
					toolName: "read",
					content: [{ type: "text", text: "contents" }],
					isError: false,
					timestamp: Date.now(),
				},
				{ role: "user", content: "Summarize", timestamp: Date.now() },
			],
		};

		const payload = await capture(deepseek, context);
		const reasoning = reasoningItems(payload);
		expect(reasoning.length).toBeGreaterThanOrEqual(2);
		for (const item of reasoning) {
			expect(reasoningTextOf(item).trim().length).toBeGreaterThan(0);
		}
		// Both tool calls must still replay alongside their reasoning items.
		const input = payload.input ?? [];
		expect(input.some(item => item.type === "function_call" && item.call_id === "call_a")).toBe(true);
		expect(input.some(item => item.type === "function_call" && item.call_id === "call_b")).toBe(true);
	});

	it("does not synthesize a reasoning item when reasoning is disabled for the turn", async () => {
		const prior: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "github-copilot",
			model: "gpt-5.6-sol",
			stopReason: "stop",
			usage,
			content: [
				{
					type: "thinking",
					thinking: "Refactor plan for foo.",
					thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_prev" }),
				},
				{ type: "text", text: "Refactored bar.ts." },
			],
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Refactor foo", timestamp: Date.now() },
				prior,
				{ role: "user", content: "Now update the tests", timestamp: Date.now() },
			],
		};

		const payload = await capture(deepseek, context, { reasoning: undefined, disableReasoning: true });
		expect(reasoningItems(payload)).toHaveLength(0);
	});

	it("does not synthesize reasoning items for non-DeepSeek Responses targets", async () => {
		const openai = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
		expect(openai.compat.requiresReasoningContentForAllAssistantTurns).toBe(false);

		const prior: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage,
			content: [
				{ type: "thinking", thinking: "Cross-provider reasoning." },
				{ type: "text", text: "Answer." },
			],
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Question", timestamp: Date.now() },
				prior,
				{ role: "user", content: "Follow up", timestamp: Date.now() },
			],
		};

		const payload = await capture(openai, context);
		expect(reasoningItems(payload)).toHaveLength(0);
	});
});
