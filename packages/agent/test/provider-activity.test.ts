import { describe, expect, it } from "bun:test";
import { Agent, type AgentEvent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createAssistantMessage } from "./helpers";

function waitForEvent(agent: Agent, predicate: (event: AgentEvent) => boolean): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	let unsubscribe: (() => void) | undefined;
	unsubscribe = agent.subscribe(event => {
		if (!predicate(event)) return;
		unsubscribe?.();
		resolve();
	});
	return promise;
}

describe("Agent provider activity timestamps", () => {
	it("tracks request start, first byte, and deltas independently for each provider request", async () => {
		const model = createMockModel({ responses: [] }).model;
		const firstStreamReady = Promise.withResolvers<AssistantMessageEventStream>();
		const secondStreamReady = Promise.withResolvers<AssistantMessageEventStream>();
		let requests = 0;
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				const ready = requests++ === 0 ? firstStreamReady : secondStreamReady;
				ready.resolve(stream);
				return stream;
			},
		});

		const firstPrompt = agent.prompt("first request");
		const firstStream = await firstStreamReady.promise;
		expect(agent.state.requestStartedAt).toEqual(expect.any(Number));
		expect(agent.state.firstByteAt).toBeUndefined();
		expect(agent.state.lastDeltaAt).toBeUndefined();

		const firstMessage = createAssistantMessage([{ type: "text", text: "first reply" }]);
		const firstByte = waitForEvent(
			agent,
			event => event.type === "message_start" && event.message.role === "assistant",
		);
		firstStream.push({ type: "start", partial: firstMessage });
		await firstByte;
		expect(agent.state.firstByteAt).toEqual(expect.any(Number));
		expect(agent.state.lastDeltaAt).toBeUndefined();

		const delta = waitForEvent(
			agent,
			event => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
		);
		firstStream.push({ type: "text_start", contentIndex: 0, partial: firstMessage });
		firstStream.push({ type: "text_delta", contentIndex: 0, delta: "first reply", partial: firstMessage });
		await delta;
		expect(agent.state.lastDeltaAt).toEqual(expect.any(Number));

		firstStream.push({ type: "text_end", contentIndex: 0, content: "first reply", partial: firstMessage });
		firstStream.push({ type: "done", reason: "stop", message: firstMessage });
		await firstPrompt;

		const secondPrompt = agent.prompt("second request");
		const secondStream = await secondStreamReady.promise;
		expect(agent.state.requestStartedAt).toEqual(expect.any(Number));
		expect(agent.state.firstByteAt).toBeUndefined();
		expect(agent.state.lastDeltaAt).toBeUndefined();

		const secondMessage = createAssistantMessage([{ type: "text", text: "second reply" }]);
		secondStream.push({ type: "start", partial: secondMessage });
		secondStream.push({ type: "text_start", contentIndex: 0, partial: secondMessage });
		secondStream.push({ type: "text_delta", contentIndex: 0, delta: "second reply", partial: secondMessage });
		secondStream.push({ type: "text_end", contentIndex: 0, content: "second reply", partial: secondMessage });
		secondStream.push({ type: "done", reason: "stop", message: secondMessage });
		await secondPrompt;
	});
});
