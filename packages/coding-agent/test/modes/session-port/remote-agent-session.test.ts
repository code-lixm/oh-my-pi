import { describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	Effort,
	type Model,
	type ResetCreditAccountStatus,
	type ResetCreditRedeemOutcome,
	type ResetCreditTarget,
	type UsageReport,
} from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { AdvisorConfig } from "../../../src/advisor";
import type { ModelRegistry } from "../../../src/config/model-registry";
import type { Settings } from "../../../src/config/settings";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
} from "../../../src/extensibility/extensions/types";
import { RpcClient } from "../../../src/modes/rpc/rpc-client";
import type { RpcTransport } from "../../../src/modes/rpc/rpc-transport";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcSessionState,
} from "../../../src/modes/rpc/rpc-types";
import { RemoteAgentSession } from "../../../src/modes/session-port/remote-agent-session";
import { buildToolsMarkdown } from "../../../src/modes/utils/tools-markdown";
import type { AsyncJobSnapshot } from "../../../src/session/agent-session-types";
import { SessionManager } from "../../../src/session/session-manager";
import { MemorySessionStorage } from "../../../src/session/session-storage";
import {
	type AgentProgress,
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../../../src/task/types";
import { EventBus } from "../../../src/utils/event-bus";

type QueuedFrame = {
	frame: unknown;
	consumed: () => void;
};

/**
 * A deterministic duplex transport. `sendFromServer` settles only after the
 * client has pulled the frame, which makes protocol assertions independent of
 * wall-clock scheduling.
 */
class InMemoryRpcTransport implements RpcTransport {
	readonly writes: unknown[] = [];
	#incoming: QueuedFrame[] = [];
	#waiter: (() => void) | undefined;
	#stopped = false;
	#writeHandler: ((frame: unknown) => void) | undefined;
	#closeListeners = new Set<() => void>();
	#errorListeners = new Set<(error: Error) => void>();

	setWriteHandler(handler: (frame: unknown) => void): void {
		this.#writeHandler = handler;
	}

	async start(): Promise<void> {
		void this.sendFromServer({ type: "ready" });
	}

	async *read(signal: AbortSignal): AsyncIterable<unknown> {
		while (!signal.aborted && !this.#stopped) {
			const queued = this.#incoming.shift();
			if (queued) {
				yield queued.frame;
				queued.consumed();
				continue;
			}
			await new Promise<void>(resolve => {
				const wake = () => {
					signal.removeEventListener("abort", wake);
					if (this.#waiter === wake) this.#waiter = undefined;
					resolve();
				};
				this.#waiter = wake;
				signal.addEventListener("abort", wake, { once: true });
				if (signal.aborted || this.#stopped) wake();
			});
		}
	}

	write(frame: unknown): void {
		this.writes.push(frame);
		this.#writeHandler?.(frame);
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		this.#wakeReader();
	}

	getStderr(): string {
		return "";
	}

	onClose(listener: () => void): () => void {
		this.#closeListeners.add(listener);
		return () => this.#closeListeners.delete(listener);
	}

	onError(listener: (error: Error) => void): () => void {
		this.#errorListeners.add(listener);
		return () => this.#errorListeners.delete(listener);
	}

	async sendFromServer(frame: unknown): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#incoming.push({ frame, consumed: resolve });
		this.#wakeReader();
		await promise;
	}

	#wakeReader(): void {
		const wake = this.#waiter;
		this.#waiter = undefined;
		wake?.();
	}
}

type RpcCommandEnvelope = RpcCommand & { id: string };

function isRpcCommandEnvelope(value: unknown): value is RpcCommandEnvelope {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { id?: unknown }).id === "string" &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

function isExtensionUiResponse(frame: unknown): frame is RpcExtensionUIResponse {
	return typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "extension_ui_response";
}

const initialState: RpcSessionState = {
	thinkingLevel: undefined,
	configuredThinkingLevel: undefined,
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "all",
	interruptMode: "immediate",
	sessionId: "remote-session",
	autoCompactionEnabled: false,
	fastModeEnabled: false,
	fastModeActive: false,
	tokensPerSecond: null,
	messageCount: 0,
	queuedMessageCount: 0,
	queuedMessages: { steering: [], followUp: [] },
	todoPhases: [],
};

type BootstrapRpcServerOptions = {
	readonly state?: () => RpcSessionState;
	readonly onCommand?: (
		command: RpcCommandEnvelope,
		respond: (data: unknown) => void,
		reject: (error: string, code?: string) => void,
	) => boolean;
};

function installBootstrapRpcServer(transport: InMemoryRpcTransport, options: BootstrapRpcServerOptions = {}): void {
	transport.setWriteHandler(frame => {
		if (!isRpcCommandEnvelope(frame)) return;
		const respond = (data: unknown) => {
			void transport.sendFromServer({
				id: frame.id,
				type: "response",
				command: frame.type,
				success: true,
				data,
			});
		};
		const reject = (error: string, code?: string) => {
			void transport.sendFromServer({
				id: frame.id,
				type: "response",
				command: frame.type,
				success: false,
				error,
				...(code ? { code } : {}),
			});
		};
		if (options.onCommand?.(frame, respond, reject)) return;

		switch (frame.type) {
			case "set_subagent_subscription":
				respond({ level: frame.level });
				return;
			case "get_state":
				respond(options.state ? options.state() : initialState);
				return;
			case "get_messages":
				respond({ messages: [] });
				return;
			case "get_available_commands":
				respond({ commands: [] });
				return;
			case "get_subagents":
				respond({ subagents: [] });
				return;
		}
	});
}

type RemoteSessionHarnessOptions = BootstrapRpcServerOptions & {
	readonly eventBus?: EventBus;
	readonly sessionManager?: SessionManager;
};

async function createRemoteSession(options: RemoteSessionHarnessOptions = {}): Promise<{
	session: RemoteAgentSession;
	transport: InMemoryRpcTransport;
}> {
	const sessionManager = options.sessionManager ?? SessionManager.inMemory("/workspace/remote-session");
	const transport = new InMemoryRpcTransport();
	installBootstrapRpcServer(transport, options);
	const client = new RpcClient({ transport });
	await client.start();
	try {
		const session = await RemoteAgentSession.connect({
			client,
			cwd: "/workspace/remote-session",
			sessionManager,
			settings: {} as Settings,
			modelRegistry: {} as ModelRegistry,
			...(options.eventBus ? { eventBus: options.eventBus } : {}),
		});
		return { session, transport };
	} catch (error) {
		await client.stop();
		throw error;
	}
}

async function flushQueuedMicrotasks(): Promise<void> {
	for (let index = 0; index < 4; index++) await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let index = 0; index < 100; index++) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for remote session state");
}

async function sendExtensionUiRequest(transport: InMemoryRpcTransport, request: RpcExtensionUIRequest): Promise<void> {
	await transport.sendFromServer(request);
	await flushQueuedMicrotasks();
}

function foregroundUiContext(): ExtensionUIContext {
	const uiContext = {
		select: async (
			title: string,
			options: ExtensionUISelectItem[],
			dialogOptions: ExtensionUIDialogOptions | undefined,
		) =>
			`${title}:${options.map(option => (typeof option === "string" ? option : option.label)).join(",")}:${dialogOptions?.timeout}`,
		confirm: async (title: string, message: string, dialogOptions: ExtensionUIDialogOptions | undefined) =>
			title === "Approve change" && message === "Apply the generated patch?" && dialogOptions?.timeout === 23,
		input: async (
			title: string,
			placeholder: string | undefined,
			dialogOptions: ExtensionUIDialogOptions | undefined,
		) => `${title}:${placeholder}:${dialogOptions?.timeout}`,
		editor: async (
			title: string,
			prefill: string | undefined,
			_dialogOptions: ExtensionUIDialogOptions | undefined,
			editorOptions: { promptStyle?: boolean } | undefined,
		) => `${title}:${prefill}:${editorOptions?.promptStyle}`,
	};
	return uiContext as unknown as ExtensionUIContext;
}

function createProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 3,
		id: "remote-worker",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Inspect remote session",
		assignment: "Verify protocol forwarding",
		description: "Remote worker",
		recentTools: [],
		recentOutput: [],
		toolCount: 2,
		requests: 1,
		tokens: 42,
		cost: 0.01,
		durationMs: 7,
		...overrides,
	};
}

describe("RpcClient extension UI request replay", () => {
	test("replays one request received before the first extension UI listener is registered", async () => {
		const transport = new InMemoryRpcTransport();
		const client = new RpcClient({ transport });
		const request: RpcExtensionUIRequest = {
			type: "extension_ui_request",
			id: "early-input",
			method: "input",
			title: "Describe the change",
			placeholder: "One sentence",
		};
		await client.start();
		try {
			await transport.sendFromServer(request);

			const received: RpcExtensionUIRequest[] = [];
			client.onExtensionUiRequest(frame => received.push(frame));
			await flushQueuedMicrotasks();

			expect(received).toEqual([request]);
		} finally {
			await client.stop();
		}
	});
});

describe("RemoteAgentSession RPC UI bridge", () => {
	test("returns foreground UI results for select, confirm, input, and editor RPC requests", async () => {
		const { session, transport } = await createRemoteSession();
		try {
			session.setToolUIContext(foregroundUiContext(), true);
			const cases: Array<{ request: RpcExtensionUIRequest; response: RpcExtensionUIResponse }> = [
				{
					request: {
						type: "extension_ui_request",
						id: "select-request",
						method: "select",
						title: "Pick target",
						options: ["current", "other"],
						timeout: 11,
					},
					response: { type: "extension_ui_response", id: "select-request", value: "Pick target:current,other:11" },
				},
				{
					request: {
						type: "extension_ui_request",
						id: "confirm-request",
						method: "confirm",
						title: "Approve change",
						message: "Apply the generated patch?",
						timeout: 23,
					},
					response: { type: "extension_ui_response", id: "confirm-request", confirmed: true },
				},
				{
					request: {
						type: "extension_ui_request",
						id: "input-request",
						method: "input",
						title: "Describe change",
						placeholder: "One sentence",
						timeout: 31,
					},
					response: {
						type: "extension_ui_response",
						id: "input-request",
						value: "Describe change:One sentence:31",
					},
				},
				{
					request: {
						type: "extension_ui_request",
						id: "editor-request",
						method: "editor",
						title: "Edit plan",
						prefill: "- inspect\n- test",
						promptStyle: true,
					},
					response: {
						type: "extension_ui_response",
						id: "editor-request",
						value: "Edit plan:- inspect\n- test:true",
					},
				},
			];

			for (const testCase of cases) await sendExtensionUiRequest(transport, testCase.request);

			expect(transport.writes.filter(isExtensionUiResponse)).toEqual(cases.map(testCase => testCase.response));
		} finally {
			await session.dispose();
		}
	});

	test("cancels queued unavailable dialogs and foreground cancellations instead of leaving RPC work pending", async () => {
		const { session, transport } = await createRemoteSession();
		try {
			const unavailableCases: Array<{ request: RpcExtensionUIRequest; response: RpcExtensionUIResponse }> = [
				{
					request: {
						type: "extension_ui_request",
						id: "no-ui-select",
						method: "select",
						title: "Choose mode",
						options: ["safe", "fast"],
					},
					response: { type: "extension_ui_response", id: "no-ui-select", cancelled: true },
				},
				{
					request: {
						type: "extension_ui_request",
						id: "no-ui-confirm",
						method: "confirm",
						title: "Delete branch",
						message: "This cannot be undone.",
					},
					response: { type: "extension_ui_response", id: "no-ui-confirm", confirmed: false },
				},
			];

			for (const testCase of unavailableCases) await sendExtensionUiRequest(transport, testCase.request);

			session.setToolUIContext(foregroundUiContext(), false);
			await flushQueuedMicrotasks();

			session.setToolUIContext({ input: async () => undefined } as unknown as ExtensionUIContext, true);
			const cancelledInput: RpcExtensionUIRequest = {
				type: "extension_ui_request",
				id: "cancelled-input",
				method: "input",
				title: "Optional note",
				placeholder: "Leave blank to cancel",
			};
			await sendExtensionUiRequest(transport, cancelledInput);

			expect(transport.writes.filter(isExtensionUiResponse)).toEqual([
				...unavailableCases.map(testCase => testCase.response),
				{ type: "extension_ui_response", id: "cancelled-input", cancelled: true },
			]);
		} finally {
			await session.dispose();
		}
	});
});

describe("RemoteAgentSession RPC state projection", () => {
	test("refreshes queued messages after dispatch and forwards title generation", async () => {
		let state: RpcSessionState = {
			...initialState,
			queuedMessages: { steering: ["initial steering"], followUp: ["initial follow-up"] },
		};
		const { session, transport } = await createRemoteSession({
			state: () => state,
			onCommand: (command, respond) => {
				switch (command.type) {
					case "prompt":
						state = { ...state, queuedMessages: { steering: ["steer after prompt"], followUp: [] } };
						respond(undefined);
						return true;
					case "steer":
						state = {
							...state,
							queuedMessages: { steering: ["newest steering"], followUp: ["follow-up after steer"] },
						};
						respond(undefined);
						return true;
					case "follow_up":
						state = {
							...state,
							queuedMessages: { steering: [], followUp: ["newest follow-up"] },
						};
						respond(undefined);
						return true;
					case "maybe_start_title_generation":
						respond(undefined);
						return true;
					default:
						return false;
				}
			},
		});
		try {
			expect(session.getQueuedMessages()).toEqual({
				steering: ["initial steering"],
				followUp: ["initial follow-up"],
			});

			await session.prompt("start work");
			expect(session.getQueuedMessages()).toEqual({ steering: ["steer after prompt"], followUp: [] });

			await session.steer("prioritize the regression");
			expect(session.getQueuedMessages()).toEqual({
				steering: ["newest steering"],
				followUp: ["follow-up after steer"],
			});

			await session.followUp("verify the result");
			expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: ["newest follow-up"] });

			session.maybeStartTitleGeneration("start work");
			await flushQueuedMicrotasks();
			expect(transport.writes).toContainEqual(
				expect.objectContaining({ type: "maybe_start_title_generation", firstMessage: "start work" }),
			);
		} finally {
			await session.dispose();
		}
	});

	test("refreshes and announces a queued message consumed by the backend", async () => {
		let state: RpcSessionState = {
			...initialState,
			queuedMessageCount: 1,
			queuedMessages: { steering: [], followUp: ["queued follow-up"] },
		};
		const { session, transport } = await createRemoteSession({ state: () => state });
		const observedEvents: string[] = [];
		const unsubscribe = session.subscribe(event => observedEvents.push(event.type));
		try {
			state = { ...state, queuedMessageCount: 0, queuedMessages: { steering: [], followUp: [] } };
			await transport.sendFromServer({
				type: "message_start",
				message: { role: "user", content: "queued follow-up", timestamp: 1 },
			});
			await waitFor(() => session.queuedMessageCount === 0 && observedEvents.includes("queue_changed"));

			expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
			expect(observedEvents).toContain("message_start");
		} finally {
			unsubscribe();
			await session.dispose();
		}
	});
});

describe("RemoteAgentSession interactive facade", () => {
	test("keeps non-goal restore usable after goal accounting cleanup", async () => {
		const { session } = await createRemoteSession();
		try {
			const facade = session.asAgentSession();
			facade.goalRuntime.clearAccounting();

			expect(session.getGoalModeState()).toBeUndefined();
			expect(facade.getAdvisorStats()).toEqual({
				configured: false,
				active: false,
				contextWindow: 0,
				contextTokens: 0,
				tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
				messages: { user: 0, assistant: 0, total: 0 },
				advisors: [],
			});
			expect(facade.scopedModels).toEqual([]);
			expect(facade.getRoleModelCycle(["default"])).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("reports projected jobs and forwards confirmed Esc cancellation to the RPC child", async () => {
		const projectedJobs: AsyncJobSnapshot = {
			running: [
				{ id: "bg-1", type: "bash", status: "running", label: "sleep 30", startTime: 1 },
				{ id: "bg-2", type: "bash", status: "running", label: "sleep 60", startTime: 2 },
			],
			recent: [{ id: "bg-completed", type: "task", status: "completed", label: "finished task", startTime: 0 }],
			delivery: { queued: 0, delivering: false, pendingJobIds: [] },
		};
		const received: RpcCommandEnvelope[] = [];
		const { session } = await createRemoteSession({
			state: () => ({ ...initialState, asyncJobs: projectedJobs }),
			onCommand: (command, respond) => {
				if (command.type !== "cancel_async_jobs") return false;
				received.push(command);
				respond({ cancelled: 0 });
				return true;
			},
		});
		try {
			const facade = session.asAgentSession();

			expect(facade.runningAsyncJobCount).toBe(2);
			expect(facade.cancelAsyncJobs()).toBe(2);
			await flushQueuedMicrotasks();
			expect(received).toEqual([expect.objectContaining({ type: "cancel_async_jobs" })]);
		} finally {
			await session.dispose();
		}
	});

	test("projects model-picker roles and forwards temporary and role model changes", async () => {
		const primaryModel = {
			provider: "anthropic",
			id: "claude-sonnet",
			name: "Claude Sonnet",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8192,
		} as Model;
		const fastModel = { ...primaryModel, id: "claude-haiku", name: "Claude Haiku" };
		const roleOrder = ["default", "fast"];
		const cycle = {
			models: [
				{ role: "default", model: primaryModel, thinkingLevel: Effort.High, explicitThinkingLevel: true },
				{ role: "fast", model: fastModel, explicitThinkingLevel: false },
			],
			currentIndex: 0,
		};
		const received: RpcCommandEnvelope[] = [];
		const { session } = await createRemoteSession({
			state: () => ({
				...initialState,
				model: primaryModel,
				scopedModels: [{ model: fastModel, thinkingLevel: ThinkingLevel.Medium }],
				roleModelCycle: { roleOrder, cycle },
			}),
			onCommand: (command, respond) => {
				switch (command.type) {
					case "set_model_temporary":
					case "apply_role_model":
						received.push(command);
						respond(primaryModel);
						return true;
					case "cycle_role_models":
						received.push(command);
						respond({ model: fastModel, thinkingLevel: undefined, role: "fast" });
						return true;
					default:
						return false;
				}
			},
		});
		try {
			const facade = session.asAgentSession();
			expect(facade.scopedModels).toEqual([{ model: fastModel, thinkingLevel: ThinkingLevel.Medium }]);
			expect(facade.getRoleModelCycle(roleOrder)).toEqual(cycle);
			expect(facade.getRoleModelCycle(["fast", "default"])).toBeUndefined();
			expect(facade.resolveTemporaryModelThinkingLevel(primaryModel)).toBe(Effort.High);
			expect(facade.resolveTemporaryModelThinkingLevel(fastModel)).toBeUndefined();

			await facade.setModelTemporary(primaryModel, Effort.High);
			await facade.applyRoleModel(cycle.models[1]);
			expect(await facade.cycleRoleModels(roleOrder, "backward")).toEqual({
				model: fastModel,
				thinkingLevel: undefined,
				role: "fast",
			});
			expect(received).toEqual([
				expect.objectContaining({
					type: "set_model_temporary",
					provider: primaryModel.provider,
					modelId: primaryModel.id,
					thinkingLevel: Effort.High,
				}),
				expect.objectContaining({ type: "apply_role_model", role: "fast" }),
				expect.objectContaining({ type: "cycle_role_models", roleOrder, direction: "backward" }),
			]);
		} finally {
			await session.dispose();
		}
	});

	test("exposes advisor statistics projected by the RPC host", async () => {
		const advisorStats = {
			configured: true,
			active: true,
			contextWindow: 128_000,
			contextTokens: 4096,
			tokens: { input: 3000, output: 800, reasoning: 200, cacheRead: 96, cacheWrite: 0, total: 4096 },
			cost: 0.25,
			messages: { user: 2, assistant: 2, total: 4 },
			advisors: [],
		};
		const { session } = await createRemoteSession({
			state: () => ({ ...initialState, advisorStats }),
		});
		try {
			expect(session.asAgentSession().getAdvisorStats()).toEqual(advisorStats);
		} finally {
			await session.dispose();
		}
	});

	test("exposes supported thinking levels for the projected model", async () => {
		const primaryModel = {
			provider: "anthropic",
			id: "claude-sonnet",
			name: "Claude Sonnet",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8192,
		} as Model;
		const { session } = await createRemoteSession({
			state: () => ({ ...initialState, model: primaryModel }),
		});
		try {
			const facade = session.asAgentSession();
			expect(facade.getAvailableThinkingLevels()).toEqual(getSupportedEfforts(primaryModel));
		} finally {
			await session.dispose();
		}
	});

	test("toggles fast mode against the projected enabled state", async () => {
		const { session } = await createRemoteSession({
			state: () => ({ ...initialState, fastModeEnabled: false }),
		});
		try {
			const facade = session.asAgentSession();
			const setFastMode = vi.spyOn(session, "setFastMode").mockImplementation(async (next: boolean) => {
				expect(next).toBe(true);
				return true;
			});
			expect(facade.isFastModeEnabled()).toBe(false);
			expect(await facade.toggleFastMode()).toBe(true);
			expect(setFastMode).toHaveBeenCalledWith(true);
		} finally {
			await session.dispose();
		}
	});

	test("returns and projects disabled after an enabled-to-disabled fast-mode confirmation", async () => {
		const received: RpcCommandEnvelope[] = [];
		const { session } = await createRemoteSession({
			onCommand: (command, respond) => {
				if (command.type !== "set_fast_mode") return false;
				received.push(command);
				respond({ enabled: command.enabled, active: command.enabled });
				return true;
			},
		});
		try {
			const facade = session.asAgentSession();
			expect(await facade.setFastMode(true)).toBe(true);
			expect(facade.isFastModeEnabled()).toBe(true);
			expect(facade.isFastModeActive()).toBe(true);

			expect(await facade.setFastMode(false)).toBe(false);
			expect(facade.isFastModeEnabled()).toBe(false);
			expect(facade.isFastModeActive()).toBe(false);
			expect(received).toEqual([
				expect.objectContaining({ type: "set_fast_mode", enabled: true }),
				expect.objectContaining({ type: "set_fast_mode", enabled: false }),
			]);
		} finally {
			await session.dispose();
		}
	});

	test("forwards tool, prompt, and memory settings through RPC and returns daemon results", async () => {
		const received: RpcCommandEnvelope[] = [];
		const { session } = await createRemoteSession({
			onCommand: (command, respond) => {
				switch (command.type) {
					case "set_think_tool":
						received.push(command);
						respond({ enabled: false });
						return true;
					case "apply_inspect_image_mode":
						received.push(command);
						respond({ enabled: true });
						return true;
					case "apply_memory_backend":
					case "refresh_base_system_prompt":
						received.push(command);
						respond(undefined);
						return true;
					default:
						return false;
				}
			},
		});
		try {
			const facade = session.asAgentSession();
			expect(await facade.setThinkToolEnabled(true)).toBe(false);
			expect(await facade.applyInspectImageModeChange()).toBe(true);
			await expect(facade.applyMemoryBackend()).resolves.toBeUndefined();
			await expect(facade.refreshBaseSystemPrompt()).resolves.toBeUndefined();
			expect(received).toEqual([
				expect.objectContaining({ type: "set_think_tool", enabled: true }),
				expect.objectContaining({ type: "apply_inspect_image_mode" }),
				expect.objectContaining({ type: "apply_memory_backend" }),
				expect.objectContaining({ type: "refresh_base_system_prompt" }),
			]);
		} finally {
			await session.dispose();
		}
	});

	test("propagates asynchronous daemon errors through the facade", async () => {
		const received: RpcCommandEnvelope[] = [];
		const { session } = await createRemoteSession({
			onCommand: (command, _respond, reject) => {
				if (command.type !== "apply_memory_backend") return false;
				received.push(command);
				reject("Memory backend rejected the requested configuration.", "memory_backend_rejected");
				return true;
			},
		});
		try {
			await expect(session.asAgentSession().applyMemoryBackend()).rejects.toMatchObject({
				name: "RpcCommandError",
				command: "apply_memory_backend",
				code: "memory_backend_rejected",
				message: "Memory backend rejected the requested configuration.",
			});
			expect(received).toEqual([expect.objectContaining({ type: "apply_memory_backend" })]);
		} finally {
			await session.dispose();
		}
	});

	test("forwards advisor settings and returns daemon results", async () => {
		const advisors = [
			{
				name: "security-reviewer",
				model: "anthropic/claude-sonnet",
				tools: ["read", "grep"],
				instructions: "Find concrete security risks before proposing a patch.",
				enabled: true,
			},
		] satisfies AdvisorConfig[];
		const sharedInstructions = "Prioritize externally observable regressions.";
		const received: RpcCommandEnvelope[] = [];
		const { session } = await createRemoteSession({
			onCommand: (command, respond) => {
				switch (command.type) {
					case "set_advisor_enabled":
						received.push(command);
						respond({ active: false });
						return true;
					case "apply_advisor_configs":
						received.push(command);
						respond({ count: advisors.length });
						return true;
					case "get_advisor_available_tools":
						received.push(command);
						respond({ toolNames: ["read", "grep"] });
						return true;
					default:
						return false;
				}
			},
		});
		try {
			const facade = session.asAgentSession();
			expect(await facade.setAdvisorEnabled(true)).toBe(false);
			expect(await facade.applyAdvisorConfigs(advisors, sharedInstructions)).toBe(1);
			expect(await facade.getAdvisorAvailableToolNames()).toEqual(["read", "grep"]);
			expect(received).toEqual([
				expect.objectContaining({ type: "set_advisor_enabled", enabled: true }),
				expect.objectContaining({
					type: "apply_advisor_configs",
					advisors,
					sharedInstructions,
				}),
				expect.objectContaining({ type: "get_advisor_available_tools" }),
			]);
		} finally {
			await session.dispose();
		}
	});

	test("forwards usage and reset-credit queries with their structured daemon results", async () => {
		const reports = [
			{
				provider: "openai-codex",
				fetchedAt: 1_725_000_000_000,
				limits: [
					{
						id: "openai-codex:5h",
						label: "5 Hour",
						scope: { provider: "openai-codex", accountId: "acct-primary", windowId: "5h" },
						window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: 1_725_010_800_000 },
						amount: { used: 25, limit: 100, usedFraction: 0.25, unit: "percent" },
						status: "warning",
					},
				],
				resetCredits: {
					availableCount: 1,
					credits: [
						{
							grantedAt: "2024-08-01T00:00:00.000Z",
							expiresAt: "2024-08-02T00:00:00.000Z",
							status: "available",
						},
					],
				},
				metadata: { accountId: "acct-primary", email: "primary@example.test" },
			},
		] satisfies UsageReport[];
		const resetCreditStatuses = [
			{
				credentialId: 17,
				accountId: "acct-primary",
				email: "primary@example.test",
				availableCount: 1,
				credits: [
					{
						id: "RateLimitResetCredit_primary",
						resetType: "codex_rate_limits",
						status: "available",
						grantedAt: "2024-08-01T00:00:00.000Z",
						expiresAt: "2024-08-02T00:00:00.000Z",
					},
				],
				active: true,
			},
		] satisfies ResetCreditAccountStatus[];
		const target = {
			credentialId: 17,
			accountId: "acct-primary",
			email: "primary@example.test",
		} satisfies ResetCreditTarget;
		const outcome = {
			ok: true,
			code: "reset",
			accountId: "acct-primary",
			email: "primary@example.test",
			creditId: "RateLimitResetCredit_primary",
		} satisfies ResetCreditRedeemOutcome;
		const received: RpcCommandEnvelope[] = [];
		const { session } = await createRemoteSession({
			onCommand: (command, respond) => {
				switch (command.type) {
					case "fetch_usage_reports":
						received.push(command);
						respond({ reports });
						return true;
					case "list_reset_credits":
						received.push(command);
						respond({ statuses: resetCreditStatuses });
						return true;
					case "redeem_reset_credit":
						received.push(command);
						respond({ outcome });
						return true;
					default:
						return false;
				}
			},
		});
		try {
			const facade = session.asAgentSession();
			expect(await facade.fetchUsageReports()).toEqual(reports);
			expect(await facade.listResetCredits()).toEqual(resetCreditStatuses);
			expect(await facade.redeemResetCredit(target)).toEqual(outcome);
			expect(received).toEqual([
				expect.objectContaining({ type: "fetch_usage_reports" }),
				expect.objectContaining({ type: "list_reset_credits" }),
				expect.objectContaining({ type: "redeem_reset_credit", target }),
			]);
		} finally {
			await session.dispose();
		}
	});

	test("forwards usage reports to the model selector resolver and returns daemon selectors", async () => {
		const reports = [
			{
				provider: "anthropic",
				fetchedAt: 1_725_000_000_000,
				limits: [
					{
						id: "anthropic:5h:claude-sonnet",
						label: "Claude Sonnet 5 Hour",
						scope: {
							provider: "anthropic",
							accountId: "acct-selector",
							modelId: "claude-sonnet",
							windowId: "5h",
						},
						window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: 1_725_010_800_000 },
						amount: { used: 40, limit: 100, usedFraction: 0.4, unit: "percent" },
						status: "warning",
					},
				],
			},
		] satisfies UsageReport[];
		const selectors = ["anthropic/claude-sonnet", "anthropic/claude-haiku"];
		const received: RpcCommandEnvelope[] = [];
		const { session } = await createRemoteSession({
			onCommand: (command, respond) => {
				if (command.type !== "get_usage_reporting_model_selectors") return false;
				received.push(command);
				respond({ selectors });
				return true;
			},
		});
		try {
			expect(await session.asAgentSession().getUsageReportingModelSelectors(reports)).toEqual(selectors);
			expect(received).toEqual([expect.objectContaining({ type: "get_usage_reporting_model_selectors", reports })]);
		} finally {
			await session.dispose();
		}
	});

	test("forwards advisor history compactness and preserves string-or-null daemon results", async () => {
		const received: RpcCommandEnvelope[] = [];
		const { session } = await createRemoteSession({
			onCommand: (command, respond) => {
				if (command.type !== "format_advisor_history") return false;
				received.push(command);
				respond({ history: command.compact ? null : "Advisor security-reviewer: no unresolved findings." });
				return true;
			},
		});
		try {
			const facade = session.asAgentSession();
			expect(await facade.formatAdvisorHistoryAsText({ compact: false })).toBe(
				"Advisor security-reviewer: no unresolved findings.",
			);
			expect(await facade.formatAdvisorHistoryAsText({ compact: true })).toBeNull();
			expect(received).toEqual([
				expect.objectContaining({ type: "format_advisor_history", compact: false }),
				expect.objectContaining({ type: "format_advisor_history", compact: true }),
			]);
		} finally {
			await session.dispose();
		}
	});

	test("preserves omitted advisor history compactness and returns the daemon's complete history", async () => {
		const completeHistory = "Advisor security-reviewer: no unresolved findings.";
		const received: RpcCommandEnvelope[] = [];
		const { session } = await createRemoteSession({
			onCommand: (command, respond) => {
				if (command.type !== "format_advisor_history") return false;
				received.push(command);
				respond({ history: command.compact === undefined ? completeHistory : null });
				return true;
			},
		});
		try {
			expect(await session.asAgentSession().formatAdvisorHistoryAsText()).toBe(completeHistory);
			expect(received).toEqual([expect.objectContaining({ type: "format_advisor_history", compact: undefined })]);
		} finally {
			await session.dispose();
		}
	});

	test("rejects an aborted foreground usage request after issuing its RPC command", async () => {
		const received: RpcCommandEnvelope[] = [];
		const controller = new AbortController();
		const reason = new Error("Usage overlay closed");
		controller.abort(reason);
		const { session } = await createRemoteSession({
			onCommand: (command, respond) => {
				if (command.type !== "fetch_usage_reports") return false;
				received.push(command);
				respond({ reports: null });
				return true;
			},
		});
		try {
			const request = session.asAgentSession().fetchUsageReports(controller.signal);
			await expect(request).rejects.toBe(reason);
			expect(received).toEqual([expect.objectContaining({ type: "fetch_usage_reports" })]);
			await flushQueuedMicrotasks();
		} finally {
			await session.dispose();
		}
	});

	test("forwards idle compaction through RPC", async () => {
		const received: RpcCommandEnvelope[] = [];
		const { session } = await createRemoteSession({
			onCommand: (command, respond) => {
				if (command.type !== "run_idle_compaction") return false;
				received.push(command);
				respond(undefined);
				return true;
			},
		});
		try {
			await session.asAgentSession().runIdleCompaction();
			expect(received).toEqual([expect.objectContaining({ type: "run_idle_compaction" })]);
		} finally {
			await session.dispose();
		}
	});

	test("forwards session transitions through the RPC port", async () => {
		const received: RpcCommandEnvelope[] = [];
		const { session } = await createRemoteSession({
			onCommand: (command, respond) => {
				switch (command.type) {
					case "new_session":
						received.push(command);
						respond({ cancelled: false });
						return true;
					case "switch_session":
						received.push(command);
						respond({ cancelled: false });
						return true;
					case "branch":
						received.push(command);
						respond({ text: "branch source text", cancelled: false });
						return true;
					default:
						return false;
				}
			},
		});
		try {
			const facade = session.asAgentSession();
			expect(await facade.newSession({ parentSession: "/sessions/parent.jsonl" })).toBe(true);
			expect(await facade.switchSession("/sessions/next.jsonl")).toBe(true);
			expect(await facade.branch("user-message-7")).toEqual({
				selectedText: "branch source text",
				selectedImages: [],
				cancelled: false,
			});
			expect(received).toEqual([
				expect.objectContaining({ type: "new_session", parentSession: "/sessions/parent.jsonl" }),
				expect.objectContaining({ type: "switch_session", sessionPath: "/sessions/next.jsonl" }),
				expect.objectContaining({ type: "branch", entryId: "user-message-7" }),
			]);
		} finally {
			await session.dispose();
		}
	});

	test("forwards tree navigation and reloads the same session file after a successful response", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = SessionManager.createEmptySessionFile(process.cwd(), storage);
		const sessionManager = await SessionManager.open(sessionFile, undefined, storage, { suppressBreadcrumb: true });
		try {
			const remoteWriter = await SessionManager.open(sessionFile, undefined, storage, { suppressBreadcrumb: true });
			try {
				remoteWriter.appendMessage({ role: "user", content: "reloaded from the remote tree", timestamp: 1 });
				await remoteWriter.flush();
			} finally {
				await remoteWriter.close();
			}
			expect(sessionManager.getEntries()).toEqual([]);

			let state: RpcSessionState = { ...initialState, sessionFile };
			const { session, transport } = await createRemoteSession({
				sessionManager,
				state: () => state,
				onCommand: (command, respond) => {
					if (command.type !== "navigate_tree") return false;
					state = { ...state, sessionId: "tree-navigated" };
					respond({ editorText: "restored draft", cancelled: false });
					return true;
				},
			});
			try {
				const options = { summarize: true, customInstructions: "Keep the selected draft." };
				expect(await session.asAgentSession().navigateTree("entry-42", options)).toEqual({
					editorText: "restored draft",
					cancelled: false,
				});
				expect(transport.writes).toContainEqual(
					expect.objectContaining({ type: "navigate_tree", entryId: "entry-42", options }),
				);
				expect(session.sessionId).toBe("tree-navigated");
				expect(sessionManager.getEntries()).toEqual([
					expect.objectContaining({
						type: "message",
						message: expect.objectContaining({ role: "user", content: "reloaded from the remote tree" }),
					}),
				]);
			} finally {
				await session.dispose();
			}
		} finally {
			await sessionManager.close();
		}
	});

	test("exposes projected tool metadata to the /tools and extension facades", async () => {
		const parameters = {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		};
		const { session } = await createRemoteSession({
			state: () => ({
				...initialState,
				dumpTools: [{ name: "read", description: "Read a file", parameters }],
			}),
		});
		try {
			const facade = session.asAgentSession();
			expect(buildToolsMarkdown({ tools: facade.agent.state.tools })).toContain("| `read` | Read a file |");
			expect(facade.getAllToolInfos()).toEqual([
				expect.objectContaining({
					name: "read",
					description: "Read a file",
					parameters,
					sourceInfo: expect.objectContaining({ source: "builtin" }),
				}),
			]);
		} finally {
			await session.dispose();
		}
	});
});

describe("RemoteAgentSession subagent frame bridge", () => {
	test("forwards lifecycle, progress, and raw event frames to their task EventBus channels", async () => {
		const eventBus = new EventBus();
		const observedLifecycle: SubagentLifecyclePayload[] = [];
		const observedProgress: SubagentProgressPayload[] = [];
		const observedEvents: SubagentEventPayload[] = [];
		eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
			observedLifecycle.push(payload as SubagentLifecyclePayload);
		});
		eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, payload => {
			observedProgress.push(payload as SubagentProgressPayload);
		});
		eventBus.on(TASK_SUBAGENT_EVENT_CHANNEL, payload => {
			observedEvents.push(payload as SubagentEventPayload);
		});

		const { session, transport } = await createRemoteSession({ eventBus });
		try {
			const lifecycle: SubagentLifecyclePayload = {
				id: "remote-worker",
				index: 3,
				agent: "task",
				agentSource: "bundled",
				status: "started",
				description: "Remote worker",
				sessionFile: "/workspace/remote-session/remote-worker.jsonl",
			};
			const progress: SubagentProgressPayload = {
				index: 3,
				agent: "task",
				agentSource: "bundled",
				task: "Inspect remote session",
				assignment: "Verify protocol forwarding",
				progress: createProgress(),
				sessionFile: "/workspace/remote-session/remote-worker.jsonl",
			};
			const event: SubagentEventPayload = {
				id: "remote-worker",
				event: { type: "agent_start" },
			};

			await transport.sendFromServer({ type: "subagent_lifecycle", payload: lifecycle });
			await transport.sendFromServer({ type: "subagent_progress", payload: progress });
			await transport.sendFromServer({ type: "subagent_event", payload: event });

			expect(observedLifecycle).toEqual([lifecycle]);
			expect(observedProgress).toEqual([progress]);
			expect(observedEvents).toEqual([event]);
		} finally {
			await session.dispose();
		}
	});
});
