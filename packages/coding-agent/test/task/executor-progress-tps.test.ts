import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, AgentProgress, SubagentProgressPayload } from "@oh-my-pi/pi-coding-agent/task/types";
import { TASK_SUBAGENT_PROGRESS_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

afterEach(() => {
	setSystemTime();
	vi.restoreAllMocks();
});

const agent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

function usage(output: number): AssistantMessage["usage"] {
	return {
		input: 0,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: usage(0),
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function createSession(onPrompt: (emit: (event: AgentSessionEvent) => void) => void): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	let lastAssistant: AssistantMessage | undefined;
	const emit = (event: AgentSessionEvent) => {
		if (
			(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "assistant"
		) {
			lastAssistant = event.message as AssistantMessage;
		}
		for (const listener of listeners) listener(event);
	};
	return {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			onPrompt(emit);
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => lastAssistant,
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

describe("runSubprocess progress TPS", () => {
	it("publishes live current-request TPS from assistant message_update usage and marks it final on message_end", async () => {
		setSystemTime(1_000);
		const progressEvents: AgentProgress[] = [];
		const busProgressEvents: AgentProgress[] = [];
		const eventBus = new EventBus();
		eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, payload => {
			busProgressEvents.push((payload as SubagentProgressPayload).progress);
		});
		const session = createSession(emit => {
			emit({ type: "message_start", message: assistantMessage({ timestamp: 1_000, usage: usage(0) }) });

			setSystemTime(2_000);
			const streamingMessage = assistantMessage({ timestamp: 1_000, usage: usage(50) });
			emit({
				type: "message_update",
				message: streamingMessage,
				assistantMessageEvent: { type: "text_delta", delta: "done" },
			} as AgentSessionEvent);

			setSystemTime(3_000);
			const finalMessage = assistantMessage({ timestamp: 1_000, duration: 2_000, usage: usage(50) });
			emit({ type: "message_end", message: finalMessage });
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-tps",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "measure progress",
			index: 0,
			id: "subagent-tps",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			keepAlive: false,
			eventBus,
			onProgress: progress => progressEvents.push(progress),
		});

		expect(result.exitCode).toBe(0);
		const live = progressEvents.find(progress => progress.tokensPerSecondLive === true && progress.tokensPerSecond);
		expect(live?.tokensPerSecond).toBeGreaterThan(0);
		expect(live?.tokensPerSecond).toBe(50);

		const final = progressEvents.findLast(
			progress => progress.tokensPerSecondLive === false && progress.tokensPerSecond,
		);
		expect(final?.tokensPerSecond).toBe(25);
		expect(final?.requests).toBe(1);

		expect(
			busProgressEvents.some(progress => progress.tokensPerSecond === 50 && progress.tokensPerSecondLive === true),
		).toBe(true);
		expect(
			busProgressEvents.some(progress => progress.tokensPerSecond === 25 && progress.tokensPerSecondLive === false),
		).toBe(true);
	});

	it("publishes final TPS from message_end event usage when the adapter keeps message.usage empty", async () => {
		setSystemTime(10_000);
		const progressEvents: AgentProgress[] = [];
		const busProgressEvents: AgentProgress[] = [];
		const eventBus = new EventBus();
		eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, payload => {
			busProgressEvents.push((payload as SubagentProgressPayload).progress);
		});
		const session = createSession(emit => {
			emit({
				type: "message_start",
				message: assistantMessage({
					timestamp: 10_000,
					usage: undefined as unknown as AssistantMessage["usage"],
				}),
			});

			setSystemTime(12_000);
			emit({
				type: "message_end",
				message: assistantMessage({
					timestamp: 10_000,
					duration: 2_000,
					usage: undefined as unknown as AssistantMessage["usage"],
				}),
				usage: usage(40),
			} as AgentSessionEvent);
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-event-usage-tps",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "measure event usage progress",
			index: 0,
			id: "subagent-event-usage-tps",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			keepAlive: false,
			eventBus,
			onProgress: progress => progressEvents.push(progress),
		});

		expect(result.exitCode).toBe(0);
		const final = progressEvents.findLast(progress => progress.tokensPerSecond !== undefined);
		expect(final?.tokensPerSecond).toBe(20);
		expect(final?.tokensPerSecondLive).toBe(false);
		expect(final?.requests).toBe(1);
		expect(
			busProgressEvents.some(progress => progress.tokensPerSecond === 20 && progress.tokensPerSecondLive === false),
		).toBe(true);
	});
});
