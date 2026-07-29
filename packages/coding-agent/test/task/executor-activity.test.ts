import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type {
	AgentDefinition,
	AgentProgress,
	SingleResult,
	TaskToolDetails,
} from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const agent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

type ActivityPhase = NonNullable<AgentProgress["activity"]>["phase"];

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "streaming" }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createMockSession(
	onPrompt: (params: { promptIndex: number; emit: (event: AgentSessionEvent) => void }) => void,
	onWaitForIdle: () => void = () => {},
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	let lastAssistant: AssistantMessage | undefined;
	let promptIndex = 0;
	const emit = (event: AgentSessionEvent) => {
		if (
			(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "assistant"
		) {
			lastAssistant = event.message as AssistantMessage;
		}
		for (const listener of [...listeners]) listener(event);
	};

	return {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["bash", "task", "yield"],
		getEnabledToolNames: () => ["bash", "task", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			promptIndex += 1;
			onPrompt({ promptIndex, emit });
			return true;
		},
		waitForIdle: async () => {
			onWaitForIdle();
		},
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

function successfulYieldEvent(toolCallId: string): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "yield",
		result: {
			content: [{ type: "text", text: "Result submitted." }],
			details: { status: "success", data: { ok: true } },
		},
		isError: false,
	} as unknown as AgentSessionEvent;
}

function snapshotsForPhase(snapshots: AgentProgress[], phase: ActivityPhase): AgentProgress[] {
	return snapshots.filter(snapshot => snapshot.activity?.phase === phase);
}

function snapshotForPhase(snapshots: AgentProgress[], phase: ActivityPhase, occurrence = 0): AgentProgress {
	const snapshot = snapshotsForPhase(snapshots, phase)[occurrence];
	if (!snapshot) throw new Error(`Missing ${phase} activity snapshot`);
	return snapshot;
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
});

afterEach(() => {
	setSystemTime();
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
});

describe("runSubprocess activity progress", () => {
	it("publishes lifecycle activity with fresh work timestamps and a clean terminal snapshot", async () => {
		setSystemTime(1_000);
		const snapshots: AgentProgress[] = [];
		const rawToolArgument = "SENSITIVE_TOOL_ARGUMENT_DO_NOT_DISPLAY";
		const inflightTaskDetails: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 42,
			progress: [],
		};
		let yielded = false;
		const session = createMockSession(
			({ promptIndex, emit }) => {
				if (promptIndex === 1) {
					emit({ type: "agent_end", messages: [], isTerminal: false } as unknown as AgentSessionEvent);

					setSystemTime(1_200);
					emit({ type: "agent_start" } as AgentSessionEvent);

					setSystemTime(1_400);
					emit({ type: "message_start", message: assistantMessage() } as AgentSessionEvent);

					setSystemTime(1_600);
					emit({
						type: "message_update",
						message: assistantMessage(),
						assistantMessageEvent: { type: "text_delta", delta: "first streamed chunk" },
					} as unknown as AgentSessionEvent);

					setSystemTime(1_800);
					emit({
						type: "tool_execution_start",
						toolCallId: "bash-call",
						toolName: "bash",
						args: { command: rawToolArgument },
					} as unknown as AgentSessionEvent);

					setSystemTime(1_900);
					emit({
						type: "tool_execution_end",
						toolCallId: "bash-call",
						toolName: "bash",
						result: { content: [{ type: "text", text: "done" }], details: {} },
						isError: false,
					} as unknown as AgentSessionEvent);

					setSystemTime(2_100);
					emit({
						type: "tool_execution_start",
						toolCallId: "task-call",
						toolName: "task",
						args: { task: "delegate this work" },
					} as unknown as AgentSessionEvent);

					setSystemTime(2_200);
					emit({
						type: "tool_execution_update",
						toolCallId: "task-call",
						toolName: "task",
						partialResult: { content: [], details: inflightTaskDetails },
					} as unknown as AgentSessionEvent);

					setSystemTime(2_400);
					emit({
						type: "auto_retry_start",
						attempt: 1,
						maxAttempts: 3,
						delayMs: 500,
						errorMessage: "provider busy",
					} as unknown as AgentSessionEvent);

					setSystemTime(2_600);
					emit({ type: "agent_end", messages: [] } as unknown as AgentSessionEvent);
					return;
				}

				setSystemTime(2_800);
				emit(successfulYieldEvent("activity-yield"));
				yielded = true;
			},
			() => {
				if (yielded) setSystemTime(3_000);
			},
		);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "exercise activity progress",
			index: 0,
			id: "activity-progress",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			keepAlive: false,
			onProgress: progress => snapshots.push(progress),
		});

		expect(result.exitCode).toBe(0);
		const phases = snapshots.map(snapshot => snapshot.activity?.phase);
		let priorPhaseIndex = -1;
		for (const phase of [
			"queued",
			"requesting",
			"streaming",
			"tool",
			"delegating",
			"retrying",
			"finishing",
			"idle",
		] as const) {
			const phaseIndex = phases.findIndex((current, index) => index > priorPhaseIndex && current === phase);
			expect(phaseIndex).toBeGreaterThan(priorPhaseIndex);
			priorPhaseIndex = phaseIndex;
		}

		for (const [phase, label] of [
			["queued", "Queued"],
			["requesting", "Requesting model"],
			["streaming", "Streaming response"],
			["tool", "Running bash"],
			["delegating", "Delegating task"],
			["retrying", "Retrying request"],
			["finishing", "Finishing"],
			["idle", "Idle"],
		] as const) {
			const activity = snapshotForPhase(snapshots, phase).activity;
			expect(activity).toMatchObject({ phase, label });
			expect(Number.isFinite(activity?.phaseStartedAtMs)).toBe(true);
			expect(Number.isFinite(activity?.lastActivityAtMs)).toBe(true);
		}

		for (const snapshot of snapshots) {
			const activity = snapshot.activity;
			expect(activity).toBeDefined();
			if (!activity) throw new Error("Executor progress omitted activity");
			expect("progress" in activity).toBe(false);
		}

		const firstStreaming = snapshotForPhase(snapshots, "streaming").activity;
		const streamingUpdate = snapshotForPhase(snapshots, "streaming", 1).activity;
		expect(firstStreaming).toMatchObject({ phaseStartedAtMs: 1_400, lastActivityAtMs: 1_400 });
		expect(streamingUpdate).toMatchObject({ phaseStartedAtMs: 1_400, lastActivityAtMs: 1_600 });

		const firstDelegating = snapshotForPhase(snapshots, "delegating").activity;
		const delegatingUpdate = snapshotForPhase(snapshots, "delegating", 1);
		expect(firstDelegating).toMatchObject({ phaseStartedAtMs: 2_100, lastActivityAtMs: 2_100 });
		expect(delegatingUpdate.activity).toMatchObject({ phaseStartedAtMs: 2_100, lastActivityAtMs: 2_200 });
		expect(delegatingUpdate.currentTool).toBe("task");
		expect(delegatingUpdate.inflightTaskDetails).toEqual(inflightTaskDetails);

		const tool = snapshotForPhase(snapshots, "tool");
		expect(tool.currentTool).toBe("bash");
		expect(tool.activity?.label).toBe("Running bash");
		expect(snapshots.some(snapshot => snapshot.activity?.label.includes(rawToolArgument))).toBe(false);

		const retrying = snapshotForPhase(snapshots, "retrying");
		expect(retrying.retryState).toMatchObject({
			attempt: 1,
			maxAttempts: 3,
			delayMs: 500,
			errorMessage: "provider busy",
			startedAtMs: 2_400,
		});

		const finishing = snapshotForPhase(snapshots, "finishing");
		expect(finishing.activity).toMatchObject({ phaseStartedAtMs: 2_600, lastActivityAtMs: 2_600 });
		for (const snapshot of [finishing, snapshots.at(-1)]) {
			expect(snapshot?.currentTool).toBeUndefined();
			expect(snapshot?.currentToolArgs).toBeUndefined();
			expect(snapshot?.currentToolStartMs).toBeUndefined();
			expect(snapshot?.retryState).toBeUndefined();
			expect(snapshot?.inflightTaskDetails).toBeUndefined();
		}

		const terminal = snapshots.at(-1);
		expect(terminal?.status).toBe("completed");
		expect(terminal?.activity).toMatchObject({
			phase: "idle",
			label: "Idle",
			phaseStartedAtMs: 2_800,
			lastActivityAtMs: 2_800,
		});
		expect(terminal?.activity && "progress" in terminal.activity).toBe(false);
	});

	it("coalesces registry metadata changes across streamed updates inside one activity window", async () => {
		setSystemTime(10_000);
		const snapshots: AgentProgress[] = [];
		const metadataActivityTimes: number[] = [];
		const rawMessageUpdates = 5;
		let metadataBeforeBurst = 0;
		let metadataAfterBurst = 0;
		let metadataAfterWindowFlush = 0;
		const session = createMockSession(({ emit }) => {
			emit({ type: "agent_start" } as AgentSessionEvent);

			setSystemTime(10_200);
			emit({ type: "message_start", message: assistantMessage() } as AgentSessionEvent);

			metadataBeforeBurst = metadataActivityTimes.length;
			for (let update = 0; update < rawMessageUpdates; update++) {
				setSystemTime(10_201 + update);
				emit({
					type: "message_update",
					message: assistantMessage(),
					assistantMessageEvent: { type: "text_delta", delta: `chunk ${update}` },
				} as unknown as AgentSessionEvent);
			}
			metadataAfterBurst = metadataActivityTimes.length;

			setSystemTime(10_350);
			emit({
				type: "message_update",
				message: assistantMessage(),
				assistantMessageEvent: { type: "text_delta", delta: "window boundary" },
			} as unknown as AgentSessionEvent);
			metadataAfterWindowFlush = metadataActivityTimes.length;

			setSystemTime(10_400);
			emit(successfulYieldEvent("coalesced-yield"));
		});
		const id = "activity-coalescing";
		const registry = AgentRegistry.global();
		registry.register({
			id,
			displayName: id,
			kind: "sub",
			session,
			sessionFile: null,
			status: "running",
		});
		const unsubscribe = registry.onChange(event => {
			if (event.type === "metadata_changed" && event.ref.id === id) {
				metadataActivityTimes.push(event.ref.activityState?.lastActivityAtMs ?? -1);
			}
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		let result: SingleResult | undefined;
		try {
			result = await runSubprocess({
				cwd: "/tmp",
				agent,
				task: "exercise coalesced activity progress",
				index: 0,
				id,
				settings: Settings.isolated(),
				modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
				enableLsp: false,
				keepAlive: false,
				onProgress: progress => snapshots.push(progress),
			});
		} finally {
			unsubscribe();
		}

		expect(result?.exitCode).toBe(0);
		expect(metadataAfterBurst).toBe(metadataBeforeBurst);
		expect(metadataAfterWindowFlush).toBe(metadataBeforeBurst + 1);
		expect(metadataActivityTimes[metadataAfterWindowFlush - 1]).toBe(10_350);
		expect(snapshots.findLast(snapshot => snapshot.activity?.phase === "streaming")?.activity?.lastActivityAtMs).toBe(
			10_350,
		);
	});
});
