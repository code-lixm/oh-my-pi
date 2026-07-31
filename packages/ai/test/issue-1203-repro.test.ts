import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessageEvent, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function createSseResponse(events: unknown[]): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createMockFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return createSseResponse(events);
	}
	return Object.assign(mockFetch, { preconnect: fetch.preconnect });
}

function baseContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: "hello",
				timestamp: Date.now(),
			},
		],
	};
}

function minimaxChunk(model: Model<"openai-completions">, content: string): unknown {
	return {
		id: "chatcmpl-minimax-cn",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, delta: { content, role: "assistant" } }],
	};
}

function stopChunk(model: Model<"openai-completions">): unknown {
	return {
		id: "chatcmpl-minimax-cn",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	};
}

describe("issue #1203 - MiniMax Coding Plan CN think tags", () => {
	it("parses minimax-code-cn <think> content into a thinking block", async () => {
		const model = getBundledModel("minimax-code-cn", "MiniMax-M2.5") as Model<"openai-completions">;
		const fetchMock = createMockFetch([
			minimaxChunk(model, "<think>"),
			minimaxChunk(model, "hidden reasoning"),
			minimaxChunk(model, "</think>"),
			minimaxChunk(model, "visible answer"),
			stopChunk(model),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.content).toEqual([
			{ type: "thinking", thinking: "hidden reasoning", thinkingSignature: undefined },
			{ type: "text", text: "visible answer" },
		]);
	});

	it("does not duplicate MiniMax-M3 reasoning when content also carries think tags", async () => {
		const model = getBundledModel("minimax-code-cn", "MiniMax-M3") as Model<"openai-completions">;
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-minimax-cn",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							content: "<think>The user just",
							reasoning_content: "The user just",
						},
					},
				],
			},
			{
				id: "chatcmpl-minimax-cn",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: {
							content: " said hi.</think>Hello!",
							reasoning_content: "The user just said hi.",
						},
					},
				],
			},
			stopChunk(model),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.content).toEqual([
			{ type: "thinking", thinking: "The user just said hi.", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "Hello!" },
		]);
	});

	it("dedupes MiniMax-M3 cumulative reasoning snapshots after answer text has started", async () => {
		const model = getBundledModel("minimax-code-cn", "MiniMax-M3") as Model<"openai-completions">;
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-minimax-cn",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							content: "<think>The user just",
							reasoning_content: "The user just",
						},
					},
				],
			},
			{
				id: "chatcmpl-minimax-cn",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: {
							content: " said hi.</think>Hello!",
							reasoning_content: "The user just said hi.",
						},
					},
				],
			},
			{
				// Visible text continues, yet the host keeps echoing the same
				// cumulative reasoning snapshot. currentBlock is now "text", so the
				// old (block-scoped) dedup would re-emit the entire snapshot as a
				// second thinking block.
				id: "chatcmpl-minimax-cn",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: {
							content: " How can I help?",
							reasoning_content: "The user just said hi.",
						},
					},
				],
			},
			stopChunk(model),
			"[DONE]",
		]);

		const stream = streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		const thinkingDeltas = events.filter(
			(event): event is Extract<AssistantMessageEvent, { type: "thinking_delta" }> =>
				event.type === "thinking_delta",
		);
		const doneIndex = events.findIndex(event => event.type === "done" || event.type === "error");
		const thinkingDeltaIndices = events.flatMap((event, index) => (event.type === "thinking_delta" ? [index] : []));
		expect(thinkingDeltas.map(event => event.delta)).toEqual(["The user just", " said hi."]);
		expect(doneIndex).toBeGreaterThan(0);
		expect(thinkingDeltaIndices.every(index => index < doneIndex)).toBe(true);
		expect(events.filter(event => event.type === "thinking_end")).toHaveLength(1);
		const thinkingBlocks = result.content.filter(block => block.type === "thinking");
		expect(thinkingBlocks).toHaveLength(1);
		expect(thinkingBlocks[0]?.thinking).toBe(thinkingDeltas.map(event => event.delta).join(""));

		expect(result.content).toEqual([
			{ type: "thinking", thinking: "The user just said hi.", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "Hello! How can I help?" },
		]);
	});
});
