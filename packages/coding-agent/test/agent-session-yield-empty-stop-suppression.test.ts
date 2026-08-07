/**
 * Regression: a terminal `yield` must stop the current prompt loop before a
 * provider continuation can produce a trailing empty assistant `stop`.
 *
 * The session's executor treats a successful yield as the terminal result for
 * a scripted subagent run; if the loop continues after that tool result, the
 * already-yielded child resumes and can enter post-yield retries or tool calls
 * (see issues #3389 and #4963).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockContent, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";
import { TempDir } from "@oh-my-pi/pi-utils";

const recordToolSchema = type({ value: type("string") });

type Harness = { session: AgentSession; authStorage: AuthStorage; tempDir: TempDir };
const activeHarnesses: Harness[] = [];

function createRecordTool(recordedValues: string[]): AgentTool<typeof recordToolSchema, { value: string }> {
	return {
		name: "record",
		label: "Record",
		description: "Record a value",
		parameters: recordToolSchema,
		async execute(_toolCallId, params) {
			recordedValues.push(params.value);
			return {
				content: [{ type: "text", text: `recorded:${params.value}` }],
				details: { value: params.value },
			};
		},
	};
}

function toolUse(...content: MockContent[]): MockResponse {
	return { content, stopReason: "toolUse" };
}

function yieldCall(value: string, id: string): MockResponse {
	return toolUse({ type: "toolCall", id, name: "yield", arguments: { result: { data: { value } } } });
}

function recordCall(value: string, id: string): MockResponse {
	return toolUse({ type: "toolCall", id, name: "record", arguments: { value } });
}

function emptyStop(): MockResponse {
	return {
		content: [],
		stopReason: "stop",
		usage: { output: 1, cacheRead: 100 },
	};
}

async function createHarness(
	responses: MockResponse[],
): Promise<Harness & { mock: MockModel; recordedValues: string[] }> {
	const tempDir = TempDir.createSync("@pi-yield-empty-stop-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("mock", "test-key");

	const mock = createMockModel({ responses });
	const recordedValues: string[] = [];
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.eager": "default",
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);

	const sessionManager = SessionManager.inMemory(tempDir.path());
	const tools: AgentTool[] = [
		new YieldTool({
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings,
		}),
		createRecordTool(recordedValues),
	];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: mock,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	const harness = { session, authStorage, tempDir };
	activeHarnesses.push(harness);
	return { ...harness, mock, recordedValues };
}

function reminderMessages(messages: AgentMessage[]): AgentMessage[] {
	const isEmptyStopRetryReminder = (text: string): boolean =>
		text.includes("<system-reminder>") || text.includes("<system-injection>");

	return messages.filter(message => {
		if (message.role !== "developer") return false;
		return typeof message.content === "string"
			? isEmptyStopRetryReminder(message.content)
			: message.content.some(content => content.type === "text" && isEmptyStopRetryReminder(content.text));
	});
}

function assistantText(messages: AgentMessage[]): string {
	return messages
		.filter((message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant")
		.flatMap(message => message.content.flatMap(content => (content.type === "text" ? [content.text] : [])))
		.join("\n");
}

function toolResultForCall(
	messages: AgentMessage[],
	toolCallId: string,
): Extract<AgentMessage, { role: "toolResult" }> {
	const result = messages.find(
		(message): message is Extract<AgentMessage, { role: "toolResult" }> =>
			message.role === "toolResult" && message.toolCallId === toolCallId,
	);
	if (!result) throw new Error(`Missing tool result for ${toolCallId}`);
	return result;
}

afterEach(async () => {
	for (const harness of activeHarnesses.splice(0)) {
		await harness.session.dispose();
		harness.authStorage.close();
		harness.tempDir.removeSync();
	}
	vi.restoreAllMocks();
});

describe("AgentSession yield empty-stop suppression", () => {
	it("does not continue to a trailing empty assistant stop after a successful yield", async () => {
		const { session, mock } = await createHarness([yieldCall("done", "call-yield-done")]);

		await session.prompt("do work then yield");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});

	it("stops at the terminal yield instead of consuming scripted trailing empty stops", async () => {
		const { session, mock } = await createHarness([
			yieldCall("done", "call-yield-multi"),
			emptyStop(),
			emptyStop(),
			emptyStop(),
		]);

		await session.prompt("yield then maybe trail");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});

	it("treats a successful yield as a transaction boundary for later calls in the same message", async () => {
		const yieldId = "call-yield-before-record";
		const skippedId = "call-record-after-yield";
		const { session, mock, recordedValues } = await createHarness([
			toolUse(
				{ type: "toolCall", id: yieldId, name: "yield", arguments: { result: { data: { value: "done" } } } },
				{ type: "toolCall", id: skippedId, name: "record", arguments: { value: "must-not-persist" } },
			),
		]);

		await session.prompt("submit, then attempt a side effect");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
		expect(recordedValues).toEqual([]);
		expect(toolResultForCall(session.agent.state.messages, yieldId).details).toMatchObject({
			data: { value: "done" },
			status: "success",
		});
		expect(toolResultForCall(session.agent.state.messages, skippedId).details).toEqual({
			__synthetic: true,
			source: "terminal_tool_result",
			executed: false,
		});
	});

	it("keeps a completed side effect and its real result when yield follows it in the same message", async () => {
		const recordId = "call-record-before-yield";
		const yieldId = "call-yield-after-record";
		const { session, mock, recordedValues } = await createHarness([
			toolUse(
				{ type: "toolCall", id: recordId, name: "record", arguments: { value: "persisted" } },
				{ type: "toolCall", id: yieldId, name: "yield", arguments: { result: { data: { value: "done" } } } },
			),
		]);

		await session.prompt("persist, then submit");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
		expect(recordedValues).toEqual(["persisted"]);
		const recordResult = toolResultForCall(session.agent.state.messages, recordId);
		expect(recordResult.content).toEqual([{ type: "text", text: "recorded:persisted" }]);
		expect(recordResult.details).toEqual({ value: "persisted" });
		expect(toolResultForCall(session.agent.state.messages, yieldId).details).toMatchObject({
			data: { value: "done" },
			status: "success",
		});
	});

	it("clears yield-termination on the next prompt so empty stops retry normally", async () => {
		const { session, mock } = await createHarness([
			// Run 1: terminal yield stops without consuming a trailing provider response.
			yieldCall("first", "call-yield-first"),
			// Run 2: empty stop should retry as usual now that the flag has cleared.
			recordCall("alpha", "call-record-alpha"),
			emptyStop(),
			{ content: ["finished after retry"], stopReason: "stop" },
		]);

		await session.prompt("yield first");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);

		await session.prompt("now record");
		await session.waitForIdle();

		// Three additional calls (record, emptyStop, finished). Exactly one
		// empty-stop reminder injected on the second run.
		expect(mock.calls).toHaveLength(4);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
	});

	it("treats an idle IRC wake after a yielded run as a fresh turn for empty-stop retry", async () => {
		const { session, mock } = await createHarness([
			// Run 1: terminal yield stops without consuming a trailing provider response.
			yieldCall("first", "call-yield-before-irc"),
			// Run 2: an idle IRC wake is a fresh turn, so its empty stop should retry normally.
			emptyStop(),
			{ content: ["recovered after IRC retry"], stopReason: "stop" },
		]);

		await session.prompt("yield first");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);

		const observerEvents: string[] = [];
		const observerSettled = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "agent_end") observerEvents.push(`agent_end:${mock.calls.length}`);
		});
		session.setIrcWakeTurnObserver(() => {
			observerEvents.push("started");
			return () => {
				observerEvents.push(`finished:${mock.calls.length}`);
				observerSettled.resolve();
			};
		});

		const outcome = await session.deliverIrcMessage({
			id: "irc-empty-stop-after-yield",
			from: "peer",
			to: "me",
			body: "ping",
			ts: Date.now(),
		} as IrcMessage);
		expect(outcome).toBe("woken");
		await session.waitForIdle();
		await observerSettled.promise;

		expect(mock.calls).toHaveLength(3);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
		expect(assistantText(session.agent.state.messages)).toContain("recovered after IRC retry");
		expect(observerEvents).toEqual(["started", "agent_end:3", "finished:3"]);
	});
});
