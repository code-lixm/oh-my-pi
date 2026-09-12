import type {
	Agent,
	AgentMessage,
	AgentState,
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	Effort,
	ImageContent,
	Model,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResetCreditTarget,
	UsageReport,
} from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import type { SlashCommand } from "@oh-my-pi/pi-tui";
import { logger, postmortem } from "@oh-my-pi/pi-utils";
import type { AdvisorConfig } from "../../advisor";
import type { WorkspaceCheckpointAccessResult } from "../../commands/workspace-checkpoint-support";
import type { ModelRegistry } from "../../config/model-registry";
import { formatModelString, type ResolvedModelRoleValue } from "../../config/model-resolver";
import type { PromptTemplate } from "../../config/prompt-templates";
import type { Settings } from "../../config/settings";
import type { ExtensionUIContext } from "../../extensibility/extensions/types";
import type { Skill } from "../../extensibility/skills";
import type { FileSlashCommand } from "../../extensibility/slash-commands";
import { renderGoalPrompt } from "../../goals/runtime";
import type { Goal, GoalModeState } from "../../goals/state";
import { tSettingsUi } from "../../i18n/settings-locale";
import type { PlanApprovalDetails } from "../../plan-mode/approved-plan";
import type { PlanModeState } from "../../plan-mode/state";
import type { AgentActivityState } from "../../registry/agent-activity";
import type { AgentSession } from "../../session/agent-session";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import type {
	AsyncJobSnapshot,
	Prewalk,
	ResetSessionContextResult,
	ResolvedRoleModel,
	RoleModelCycle,
	RoleModelCycleResult,
} from "../../session/agent-session-types";
import { resolveRoleModelFull } from "../../session/role-models";
import type { AdvisorStats } from "../../session/session-advisors";
import type { SessionContext } from "../../session/session-context";
import type { SessionManager } from "../../session/session-manager";
import {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../../task/types";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type { PlanProposalHandler } from "../../tools/resolve";
import type { TodoPhase } from "../../tools/todo";
import type { EventBus } from "../../utils/event-bus";
import type { InspectImageMode } from "../../utils/inspect-image-mode";
import type { VibeModeState } from "../../vibe/state";
import type { WorkspaceRestoreResult, WorkspaceRestoreScope } from "../../workspace-checkpoints";
import type { JobsHubDataSource } from "../components/jobs-hub";
import { isRpcClientDisconnectedError, type RpcClient } from "../rpc/rpc-client";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHandoffResult,
	RpcNavigateTreeOptions,
	RpcNavigateTreeResult,
	RpcResponse,
} from "../rpc/rpc-types";
import type { InteractiveSessionPort, InteractiveSessionSettingsCapabilities } from "./port";
import { RpcInteractiveSessionPort } from "./rpc-session-port";
import type { InteractiveSessionProjection } from "./types";

/** Debounce window for mirror-history reloads; coalesces streaming deltas. */
const HISTORY_MIRROR_SYNC_DEBOUNCE_MS = 500;

export interface RemoteAgentSessionOptions {
	readonly client: RpcClient;
	readonly port: InteractiveSessionPort;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly modelRegistry: ModelRegistry;
	readonly eventBus?: EventBus;
}

function responseError(response: RpcResponse): Error | undefined {
	return response.success ? undefined : new Error(response.error);
}

function queuesEqual(
	left: InteractiveSessionProjection["queue"],
	right: InteractiveSessionProjection["queue"],
): boolean {
	return (
		left.steering.length === right.steering.length &&
		left.followUp.length === right.followUp.length &&
		left.steering.every((message, index) => message === right.steering[index]) &&
		left.followUp.every((message, index) => message === right.followUp[index])
	);
}

const DISABLED_ADVISOR_STATS: AdvisorStats = {
	configured: false,
	active: false,
	contextWindow: 0,
	contextTokens: 0,
	tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	cost: 0,
	messages: { user: 0, assistant: 0, total: 0 },
	advisors: [],
};

/**
 * Explicit AgentSession-compatible facade used while InteractiveMode migrates to
 * the transport-neutral port. Provider execution and tools remain in the RPC
 * child; this object owns only cached serializable state and typed commands.
 */
export class RemoteAgentSession implements InteractiveSessionSettingsCapabilities {
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly modelRegistry: ModelRegistry;
	readonly agent: Agent;
	readonly configWarnings: string[] = [];
	readonly customCommands: Array<{ command: FileSlashCommand; source: string }> = [];
	readonly skills: Skill[] = [];
	readonly promptTemplates: PromptTemplate[] = [];
	readonly skillsSettings = { enableSkillCommands: false };
	readonly extensionRunner = undefined;
	readonly asyncJobManager = undefined;
	readonly goalRuntime = {
		clearAccounting: (): void => {
			this.#fireRpc("clear goal accounting", this.#client.goalRuntimeClearAccounting());
		},
		onThreadResumed: async (options?: { preserveActiveGoal?: boolean }): Promise<GoalModeState | undefined> =>
			(await this.#client.goalRuntimeOnThreadResumed(options?.preserveActiveGoal)) ?? undefined,
		createGoal: async (input: { objective: string; tokenBudget?: number }): Promise<GoalModeState> =>
			await this.#client.goalRuntimeCreate(input.objective, input.tokenBudget),
		replaceGoal: async (input: { objective: string; tokenBudget?: number }): Promise<GoalModeState> =>
			await this.#client.goalRuntimeReplace(input.objective, input.tokenBudget),
		resumeGoal: async (): Promise<GoalModeState> => await this.#client.goalRuntimeResume(),
		pauseGoal: async (): Promise<GoalModeState | undefined> => (await this.#client.goalRuntimePause()) ?? undefined,
		dropGoal: async (): Promise<Goal | undefined> => (await this.#client.goalRuntimeDrop()) ?? undefined,
		onBudgetMutated: async (newBudget: number | undefined): Promise<GoalModeState | undefined> =>
			(await this.#client.goalRuntimeOnBudgetMutated(newBudget)) ?? undefined,
		buildContinuationPrompt: (): string | undefined => {
			const state = this.#projection.modes.goal;
			return state?.enabled && state.goal.status === "active"
				? renderGoalPrompt("continuation", state.goal)
				: undefined;
		},
	};
	readonly #client: RpcClient;
	readonly #port: InteractiveSessionPort;
	readonly #eventListeners = new Set<(event: AgentSessionEvent) => void>();
	readonly #commandMetadataListeners = new Set<() => void>();
	readonly #unsubscribers: Array<() => void> = [];
	#extensionUiContext: ExtensionUIContext | undefined;
	#pendingExtensionUiRequests: RpcExtensionUIRequest[] = [];
	/**
	 * In-flight `#handleExtensionUiRequest` promises, tracked so dispose() can
	 * reject them before the RPC transport tears down. Without this the awaited
	 * `uiContext.select/confirm/input/editor` may resolve after the client has
	 * stopped, the resulting `respondToExtensionUi` call throws "Client not
	 * started" synchronously, and the void caller lets it escape as an
	 * unhandled rejection.
	 */
	#inFlightExtensionUiRequests = new Set<Promise<void>>();
	#projection: InteractiveSessionProjection;
	#state: AgentState;
	/**
	 * In-flight assistant message, mirrored from the `message_start`/`message_update`
	 * events so the facade honors the {@link AgentState} contract. The child process
	 * owns the real `streamMessage`; without this mirror the foreground sees a
	 * permanent `null`, so the activity row's throughput sampler never opens a
	 * window and every reading degrades to the settled fallback of the last turn.
	 */
	#streamMessage: AgentMessage | null = null;
	/**
	 * Request/first-byte stamps mirrored alongside {@link #streamMessage}. The
	 * activity row derives its live time-to-first-token from these, so a facade
	 * that leaves them undefined reports no first-token latency until the child's
	 * settled `message.ttft` arrives at turn end.
	 */
	#requestStartedAt: number | undefined;
	#firstByteAt: number | undefined;
	#disposed = false;
	#mountedToolNames: string[] = [];
	#historyMirrorSyncTimer: NodeJS.Timeout | undefined;

	private constructor(options: RemoteAgentSessionOptions) {
		this.#client = options.client;
		this.#port = options.port;
		this.sessionManager = options.sessionManager;
		this.settings = options.settings;
		this.modelRegistry = options.modelRegistry;
		this.#projection = options.port.projection;
		this.#state = this.#buildAgentState();
		const owner = this;
		this.agent = {
			get state() {
				return owner.#state;
			},
			appendMessage(message: AgentMessage) {
				owner.#replaceMessages([...owner.#projection.messages, message]);
			},
			getSteeringMode() {
				return owner.steeringMode;
			},
			getFollowUpMode() {
				return owner.followUpMode;
			},
			getInterruptMode() {
				return owner.interruptMode;
			},
			hasQueuedMessages() {
				return false;
			},
			waitForIdle: () => owner.waitForIdle(),
			abort: () => {
				void owner.abort();
			},
		} as unknown as Agent;
		this.#unsubscribers.push(
			this.#port.onReliable(frame => {
				const previousCommands = this.#projection.commands;
				const previousQueue = this.#projection.queue;
				this.#projection = { ...this.#projection, ...frame.patch };
				this.#state = this.#buildAgentState();
				if (this.#projection.commands !== previousCommands) {
					for (const listener of this.#commandMetadataListeners) listener();
				}
				if (!queuesEqual(previousQueue, this.#projection.queue)) {
					for (const listener of this.#eventListeners) listener({ type: "queue_changed" });
				}
				this.#scheduleHistoryMirrorSync();
			}),
			this.#port.onView(frame => {
				this.#projection = { ...this.#projection, ...frame.patch };
				this.#state = this.#buildAgentState();
			}),
			this.#client.onSessionEvent(event => {
				// Rebuild the facade state on the same tick: `#state` is otherwise
				// only refreshed by projection frames, so a mid-stream reader would
				// observe the previous snapshot until the next one arrives.
				// `turn_start` precedes each provider dispatch on the child (the
				// local agent stamps `requestStartedAt` at the same point), and the
				// first assistant frame is its `firstByteAt`; mirroring both keeps
				// the row's live time-to-first-token available while it streams
				// instead of deferring to the settled `message.ttft`.
				if (event.type === "turn_start") {
					this.#requestStartedAt = Date.now();
					this.#firstByteAt = undefined;
					this.#state = this.#buildAgentState();
				} else if (event.type === "message_start" || event.type === "message_update") {
					this.#streamMessage = event.message;
					if (event.message.role === "assistant") this.#firstByteAt ??= Date.now();
					this.#state = this.#buildAgentState();
				} else if (event.type === "message_end") {
					this.#streamMessage = null;
					this.#state = this.#buildAgentState();
				}
				for (const listener of this.#eventListeners) listener(event);
			}),
			this.#client.onExtensionUiRequest(request => this.#routeExtensionUiRequest(request)),
		);
		if (options.eventBus) {
			this.#unsubscribers.push(
				this.#client.onSubagentLifecycle(payload =>
					options.eventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload),
				),
				this.#client.onSubagentProgress(payload => options.eventBus?.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, payload)),
				this.#client.onSubagentEvent(payload => options.eventBus?.emit(TASK_SUBAGENT_EVENT_CHANNEL, payload)),
			);
		}
	}

	static async connect(
		options: Omit<RemoteAgentSessionOptions, "port"> & { readonly cwd: string; readonly agentId?: string },
	): Promise<RemoteAgentSession> {
		await options.client.setSubagentSubscription("events");
		const port = await RpcInteractiveSessionPort.connect({
			client: options.client,
			cwd: options.cwd,
			...(options.agentId ? { agentId: options.agentId } : {}),
			ownsClient: true,
		});
		return new RemoteAgentSession({ ...options, port });
	}

	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#extensionUiContext = hasUI ? uiContext : undefined;
		if (!this.#extensionUiContext) {
			for (const request of this.#pendingExtensionUiRequests.splice(0)) this.#cancelExtensionUiRequest(request);
			return;
		}
		for (const request of this.#pendingExtensionUiRequests.splice(0))
			void this.#handleExtensionUiRequest(uiContext, request);
		void this.#client
			.initializeExtensions()
			.catch(error => logger.error("Failed to initialize isolated session extensions", { error: String(error) }));
	}

	#routeExtensionUiRequest(request: RpcExtensionUIRequest): void {
		const uiContext = this.#extensionUiContext;
		if (!uiContext) {
			this.#pendingExtensionUiRequests.push(request);
			return;
		}
		const promise = this.#handleExtensionUiRequest(uiContext, request).finally(() => {
			this.#inFlightExtensionUiRequests.delete(promise);
		});
		this.#inFlightExtensionUiRequests.add(promise);
	}

	#cancelExtensionUiRequest(request: RpcExtensionUIRequest): void {
		if (request.method === "select" || request.method === "input" || request.method === "editor") {
			this.#safeRespondToExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
		} else if (request.method === "confirm") {
			this.#safeRespondToExtensionUi({ type: "extension_ui_response", id: request.id, confirmed: false });
		}
	}

	/**
	 * Reply to a pending extension UI request without letting a transport
	 * shutdown ("Client not started") escape as an unhandled rejection. The
	 * response is fire-and-forget at every caller, so a throw here would
	 * otherwise bubble out of the `#handleExtensionUiRequest` try/catch chain
	 * once the client has been stopped by `dispose()`.
	 */
	#safeRespondToExtensionUi(response: RpcExtensionUIResponse): void {
		try {
			this.#client.respondToExtensionUi(response);
		} catch (error) {
			if (this.#disposed) return;
			logger.warn("Failed to respond to remote extension UI request", { error: String(error) });
		}
	}

	async #handleExtensionUiRequest(uiContext: ExtensionUIContext, request: RpcExtensionUIRequest): Promise<void> {
		try {
			// If `dispose()` already started, the local UI surface is gone and
			// any dialog awaiting user input will never resolve normally. Skip
			// straight to a best-effort cancel response so we don't await a
			// dead uiContext.
			if (this.#disposed) {
				if (request.method === "select" || request.method === "input" || request.method === "editor") {
					this.#safeRespondToExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
				} else if (request.method === "confirm") {
					this.#safeRespondToExtensionUi({ type: "extension_ui_response", id: request.id, confirmed: false });
				}
				return;
			}
			switch (request.method) {
				case "select": {
					const value = await uiContext.select(request.title, request.options, { timeout: request.timeout });
					this.#safeRespondToExtensionUi(
						value === undefined
							? { type: "extension_ui_response", id: request.id, cancelled: true }
							: { type: "extension_ui_response", id: request.id, value },
					);
					return;
				}
				case "confirm": {
					const confirmed = await uiContext.confirm(request.title, request.message, { timeout: request.timeout });
					this.#safeRespondToExtensionUi({ type: "extension_ui_response", id: request.id, confirmed });
					return;
				}
				case "input": {
					const value = await uiContext.input(request.title, request.placeholder, { timeout: request.timeout });
					this.#safeRespondToExtensionUi(
						value === undefined
							? { type: "extension_ui_response", id: request.id, cancelled: true }
							: { type: "extension_ui_response", id: request.id, value },
					);
					return;
				}
				case "editor": {
					const value = await uiContext.editor(request.title, request.prefill, undefined, {
						promptStyle: request.promptStyle,
					});
					this.#safeRespondToExtensionUi(
						value === undefined
							? { type: "extension_ui_response", id: request.id, cancelled: true }
							: { type: "extension_ui_response", id: request.id, value },
					);
					return;
				}
				case "cancel":
					return;
				case "notify":
					uiContext.notify(request.message, request.notifyType);
					return;
				case "setStatus":
					uiContext.setStatus(request.statusKey, request.statusText);
					return;
				case "setWidget":
					uiContext.setWidget(request.widgetKey, request.widgetLines, {
						...(request.widgetPlacement ? { placement: request.widgetPlacement } : {}),
					});
					return;
				case "setTitle":
					uiContext.setTitle(request.title);
					return;
				case "set_editor_text":
					uiContext.setEditorText(request.text);
					return;
				case "open_url":
					uiContext.notify(request.instructions ?? request.launchUrl ?? request.url, "info");
					return;
			}
		} catch (error) {
			if (this.#disposed && postmortem.isExpectedCleanupError(error)) return;
			if (request.method === "select" || request.method === "input" || request.method === "editor") {
				this.#safeRespondToExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
			}
		}
	}

	/** Temporary typed bridge for unchanged InteractiveMode call sites. */
	asAgentSession(): AgentSession {
		return this as unknown as AgentSession;
	}

	get state(): AgentState {
		return this.#state;
	}

	get model(): Model | undefined {
		return this.#projection.model;
	}

	get scopedModels(): ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }> {
		return this.#projection.scopedModels;
	}

	get thinkingLevel() {
		return this.#projection.thinkingLevel;
	}

	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined {
		return this.#projection.configuredThinkingLevel;
	}

	get isAutoThinking(): boolean {
		return this.#projection.configuredThinkingLevel === "auto";
	}

	autoResolvedThinkingLevel() {
		return undefined;
	}

	get isStreaming(): boolean {
		return this.#projection.busy.isStreaming;
	}

	get isBashRunning(): boolean {
		return this.#projection.busy.isBashRunning;
	}

	get isEvalRunning(): boolean {
		return this.#projection.busy.isEvalRunning;
	}

	get isCompacting(): boolean {
		return this.#projection.busy.isCompacting;
	}

	get hasPostPromptWork(): boolean {
		return false;
	}

	get autoCompactionEnabled(): boolean {
		return this.#projection.modes.autoCompactionEnabled;
	}

	get steeringMode() {
		return this.#projection.modes.steering;
	}

	get followUpMode() {
		return this.#projection.modes.followUp;
	}

	get interruptMode() {
		return this.#projection.modes.interrupt;
	}

	get sessionFile(): string | undefined {
		return this.#projection.path;
	}

	get sessionId(): string {
		return this.#projection.identity.sessionId;
	}

	get sessionName(): string | undefined {
		return this.#projection.name;
	}

	get messages(): AgentMessage[] {
		return [...this.#projection.messages];
	}

	get systemPrompt(): string[] {
		return [];
	}

	get queuedMessageCount(): number {
		return this.#projection.queue.steering.length + this.#projection.queue.followUp.length;
	}

	getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[] } {
		return this.#projection.queue;
	}

	get serviceTierByFamily() {
		return {};
	}

	getActivityState(): AgentActivityState {
		return (
			this.#projection.activity ?? {
				phase: this.isStreaming ? "streaming" : "idle",
				label: this.isStreaming ? "Streaming response" : "Idle",
				phaseStartedAtMs: Date.now(),
				lastActivityAtMs: Date.now(),
			}
		);
	}

	getAdvisorStats(): AdvisorStats {
		return this.#projection.advisorStats ?? DISABLED_ADVISOR_STATS;
	}

	get activity(): AgentActivityState {
		return this.getActivityState();
	}

	getPlanModeState() {
		return this.#projection.modes.plan;
	}

	getGoalModeState() {
		return this.#projection.modes.goal;
	}

	getVibeModeState() {
		return this.#projection.modes.vibe;
	}

	/** Effective inspect_image state required by the `/vision` autocomplete metadata. */
	inspectImageState(): { mode: InspectImageMode; active: boolean; model: string | undefined } {
		const model = this.model;
		return {
			mode: this.settings.get("inspect_image.mode"),
			active: this.#projection.tools.some(tool => tool.name === "inspect_image" && tool.enabled !== false),
			model: model ? formatModelString(model) : undefined,
		};
	}

	getContextUsage() {
		return this.#projection.context;
	}

	getTodoPhases(): TodoPhase[] {
		return [...this.#projection.todo];
	}

	getAsyncJobSnapshot(): AsyncJobSnapshot | null {
		return this.#projection.jobs;
	}

	getVisibleAsyncJobCount(): number {
		return this.#projection.jobs?.running.length ?? 0;
	}
	/**
	 * Running subagents mirrored from the worker's projection. This process only
	 * attaches to the `--mode rpc-ui` worker that owns the AgentRegistry, so the
	 * local registry is empty here and the status-line badge must read the
	 * projection instead.
	 */
	getRunningSubagentCount(): number {
		return this.#projection.subagents.filter(sub => sub.status === "running").length;
	}

	get runningAsyncJobCount(): number {
		return this.#projection.jobs?.running.length ?? 0;
	}

	getJobsHubDataSource(): JobsHubDataSource | undefined {
		if (!this.#projection.jobs) return undefined;
		return {
			getAllJobs: () => {
				const snapshot = this.#projection.jobs;
				return snapshot ? [...snapshot.running, ...snapshot.recent] : [];
			},
			getConcurrencySnapshot: () => ({
				running: this.#projection.jobs?.running.filter(job => !job.queued).length ?? 0,
				queued: this.#projection.jobs?.running.filter(job => job.queued).length ?? 0,
				limit: this.#projection.jobs?.running.length ?? 0,
			}),
		};
	}

	getAgentId(): string | undefined {
		return this.#projection.identity.agentId;
	}

	getActiveToolNames(): string[] {
		return this.#projection.tools.filter(tool => tool.enabled !== false).map(tool => tool.name);
	}

	getEnabledToolNames(): string[] {
		return this.getActiveToolNames();
	}

	getAllToolNames(): string[] {
		return this.#projection.tools.map(tool => tool.name);
	}

	getAllToolInfos() {
		return this.#projection.tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			sourceInfo: {
				path: `<builtin:${tool.name}>`,
				source: "builtin" as const,
				scope: "temporary" as const,
				origin: "top-level" as const,
			},
		}));
	}

	getMountedXdevToolNames(): string[] {
		return [...this.#mountedToolNames];
	}

	getXdevToolEntries(): Array<{ name: string; summary: string }> {
		return this.#mountedToolNames.map(name => {
			const tool = this.#projection.tools.find(candidate => candidate.name === name);
			return { name, summary: tool?.description ?? "" };
		});
	}

	hasBuiltInTool(name: string): boolean {
		return this.#projection.tools.some(tool => tool.name === name);
	}

	getToolByName(name: string): AgentTool | undefined {
		const tool = this.#projection.tools.find(candidate => candidate.name === name);
		if (!tool) return undefined;
		return {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		} as unknown as AgentTool;
	}

	isFastModeEnabled(): boolean {
		return this.#projection.modes.fastModeEnabled;
	}

	isFastModeActive(): boolean {
		return this.#projection.modes.fastModeActive;
	}

	isSessionPersisted(): boolean {
		return this.#projection.path !== undefined;
	}

	getInteractiveSlashCommands(): SlashCommand[] {
		return this.#projection.commands.map(command => ({
			name: command.name,
			...(command.description ? { description: command.description } : {}),
		}));
	}

	buildTranscriptSessionContext(): SessionContext {
		return { ...this.sessionManager.buildSessionContext(), messages: this.messages };
	}

	buildDisplaySessionContext(): SessionContext {
		return this.buildTranscriptSessionContext();
	}

	getUserMessagesForBranching(): Array<{ entryId: string; text: string }> {
		const result: Array<{ entryId: string; text: string }> = [];
		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const content = entry.message.content;
			const text =
				typeof content === "string"
					? content
					: content
							.filter((part): part is { type: "text"; text: string } => part.type === "text")
							.map(part => part.text)
							.join("");
			if (text) result.push({ entryId: entry.id, text });
		}
		return result;
	}

	buildAskReanswerContext(uiContext: ExtensionUIContext): AgentToolContext {
		return {
			sessionManager: this.sessionManager,
			modelRegistry: this.modelRegistry,
			model: this.model,
			isIdle: () => !this.isStreaming,
			hasQueuedMessages: () => this.queuedMessageCount > 0,
			abort: () => {
				void this.abort();
			},
			settings: this.settings,
			ui: uiContext,
			hasUI: true,
		};
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	subscribeCommandMetadataChanged(listener: () => void): () => void {
		this.#commandMetadataListeners.add(listener);
		return () => this.#commandMetadataListeners.delete(listener);
	}

	async newSession(options?: { parentSession?: string }): Promise<boolean> {
		const result = await this.#client.newSession(options?.parentSession);
		if (!result.cancelled) await this.#refreshProjection();
		return !result.cancelled;
	}

	async switchSession(sessionPath: string): Promise<boolean> {
		const result = await this.#client.switchSession(sessionPath);
		if (!result.cancelled) await this.#refreshProjection();
		return !result.cancelled;
	}

	async branch(
		entryId: string,
	): Promise<{ selectedText: string; selectedImages: ImageContent[]; cancelled: boolean }> {
		const result = await this.#client.branch(entryId);
		if (!result.cancelled) await this.#refreshProjection();
		return {
			selectedText: result.text,
			selectedImages: result.images ?? [],
			cancelled: result.cancelled,
		};
	}

	async navigateTree(entryId: string, options?: RpcNavigateTreeOptions): Promise<RpcNavigateTreeResult> {
		const result = await this.#client.navigateTree(entryId, options);
		if (!result.cancelled) await this.#refreshProjection(true);
		return result;
	}

	abortBranchSummary(): void {
		this.#fireRpc("abort branch summary", this.#client.abortBranchSummary());
	}

	resumeAfterAskReanswer(): void {
		this.#fireRpc("resume after ask reanswer", this.#client.resumeAfterAskReanswer());
	}

	async prompt(
		message: string,
		options?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" },
	): Promise<void> {
		await this.#dispatch({
			type: "prompt",
			message,
			...(options?.images ? { images: options.images } : {}),
			...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
		});
		await this.#refreshProjection();
	}

	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.#dispatch({ type: "steer", message, ...(images ? { images } : {}) });
		await this.#refreshProjection();
	}

	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.#dispatch({ type: "follow_up", message, ...(images ? { images } : {}) });
		await this.#refreshProjection();
	}

	async abort(): Promise<void> {
		await this.#dispatch({ type: "abort" });
	}

	async waitForIdle(): Promise<void> {
		await this.#client.waitForIdle();
	}

	async setModel(
		model: Model,
		role: string = "default",
		options?: {
			selector?: string;
			thinkingLevel?: ThinkingLevel;
			persist?: boolean;
		},
	): Promise<{ switched: boolean }> {
		const result = await this.#client.setModel(model.provider, model.id, {
			role,
			...(options?.selector ? { selector: options.selector } : {}),
			...(options?.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
			...(options?.persist !== undefined ? { persist: options.persist } : {}),
		});
		await this.#refreshProjection();
		return { switched: result.switched };
	}

	getRoleModelCycle(roleOrder: readonly string[]): RoleModelCycle | undefined {
		const projected = this.#projection.roleModelCycle;
		if (
			!projected ||
			projected.roleOrder.length !== roleOrder.length ||
			!projected.roleOrder.every((role, index) => role === roleOrder[index])
		)
			return undefined;
		return projected.cycle;
	}

	/** Resolve a role to its model AND thinking level from local settings/registry state. */
	resolveRoleModelWithThinking(role: string): ResolvedModelRoleValue {
		return resolveRoleModelFull(this.settings, role, this.modelRegistry.getAvailable(), this.model);
	}

	resolveTemporaryModelThinkingLevel(model: Model): ConfiguredThinkingLevel | undefined {
		const entry = this.#projection.roleModelCycle?.cycle.models.find(candidate =>
			modelsAreEqual(candidate.model, model),
		);
		return entry?.explicitThinkingLevel ? entry.thinkingLevel : undefined;
	}

	async setModelTemporary(model: Model, thinkingLevel?: ConfiguredThinkingLevel): Promise<void> {
		await this.#dispatch({
			type: "set_model_temporary",
			provider: model.provider,
			modelId: model.id,
			...(thinkingLevel ? { thinkingLevel } : {}),
		});
		await this.#refreshProjection();
	}

	async applyRoleModel(entry: ResolvedRoleModel): Promise<void> {
		await this.#dispatch({ type: "apply_role_model", role: entry.role });
		await this.#refreshProjection();
	}

	async cycleRoleModels(
		roleOrder: readonly string[],
		direction: "forward" | "backward" = "forward",
	): Promise<RoleModelCycleResult | undefined> {
		const response = await this.#dispatch({
			type: "cycle_role_models",
			roleOrder: [...roleOrder],
			direction,
		});
		await this.#refreshProjection();
		return response.success && response.command === "cycle_role_models" ? (response.data ?? undefined) : undefined;
	}

	getAvailableModels(): Model[] {
		return this.modelRegistry.getAvailable();
	}

	async cycleModel() {
		return this.#client.cycleModel();
	}

	setThinkingLevel(level: ConfiguredThinkingLevel): void {
		this.#fireRpc("set thinking level", this.#client.setThinkingLevel(level));
	}

	cycleThinkingLevel() {
		return this.#client.cycleThinkingLevel();
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.#fireRpc("set steering mode", this.#client.setSteeringMode(mode));
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.#fireRpc("set follow-up mode", this.#client.setFollowUpMode(mode));
	}

	setInterruptMode(mode: "immediate" | "wait"): void {
		this.#fireRpc("set interrupt mode", this.#client.setInterruptMode(mode));
	}

	setTodoPhases(phases: TodoPhase[]): void {
		this.#projection = { ...this.#projection, todo: phases };
		this.#state = this.#buildAgentState();
		this.#fireRpc("set todo phases", this.#client.setTodos(phases));
	}

	setAutoCompactionEnabled(enabled: boolean): void {
		this.#fireRpc("set auto compaction", this.#client.setAutoCompaction(enabled));
	}

	async setFastMode(enabled: boolean): Promise<boolean> {
		const result = await this.#client.setFastMode(enabled);
		this.#projection = {
			...this.#projection,
			modes: { ...this.#projection.modes, fastModeEnabled: result.enabled, fastModeActive: result.active },
		};
		this.#state = this.#buildAgentState();
		return result.enabled;
	}

	async toggleFastMode(): Promise<boolean> {
		return this.setFastMode(!this.isFastModeEnabled());
	}

	setThinkToolEnabled(enabled: boolean): Promise<boolean> {
		return this.#client.setThinkToolEnabled(enabled);
	}

	applyInspectImageModeChange(): Promise<boolean> {
		return this.#client.applyInspectImageModeChange();
	}

	applyMemoryBackend(): Promise<void> {
		return this.#client.applyMemoryBackend();
	}

	refreshBaseSystemPrompt(): Promise<void> {
		return this.#client.refreshBaseSystemPrompt();
	}
	async setAdvisorEnabled(enabled: boolean): Promise<boolean> {
		const active = await this.#client.setAdvisorEnabled(enabled);
		const advisorStats = this.getAdvisorStats();
		this.#projection = {
			...this.#projection,
			advisorStats: { ...advisorStats, configured: enabled, active },
		};
		return active;
	}

	isAdvisorEnabled(): boolean {
		return this.getAdvisorStats().configured;
	}

	toggleAdvisorEnabled(): Promise<boolean> {
		return this.setAdvisorEnabled(!this.isAdvisorEnabled());
	}

	applyAdvisorConfigs(advisors: AdvisorConfig[], sharedInstructions: string | undefined): Promise<number> {
		return this.#client.applyAdvisorConfigs(advisors, sharedInstructions);
	}

	getAdvisorAvailableToolNames(): Promise<string[]> {
		return this.#client.getAdvisorAvailableToolNames();
	}

	/**
	 * AbortSignal only stops the foreground caller from waiting. The RPC protocol
	 * has no per-request cancellation frame; backend work remains bounded by its
	 * response or session transport teardown.
	 */
	fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null> {
		return this.#awaitRpcRequest(this.#client.fetchUsageReports(), signal);
	}

	listResetCredits(signal?: AbortSignal): Promise<ResetCreditAccountStatus[]> {
		return this.#awaitRpcRequest(this.#client.listResetCredits(), signal);
	}

	/** See {@link RemoteAgentSession.fetchUsageReports} for remote cancellation semantics. */
	redeemResetCredit(target: ResetCreditTarget, signal?: AbortSignal): Promise<ResetCreditRedeemOutcome> {
		return this.#awaitRpcRequest(this.#client.redeemResetCredit(target), signal);
	}

	getUsageReportingModelSelectors(reports: readonly UsageReport[]): Promise<string[]> {
		return this.#client.getUsageReportingModelSelectors(reports);
	}

	formatAdvisorHistoryAsText(options?: { compact?: boolean }): Promise<string | null> {
		return this.#client.formatAdvisorHistoryAsText(options);
	}

	/** Lists thinking levels supported by the active model (facade for the daemon projection). */
	getAvailableThinkingLevels(): ReadonlyArray<Effort> {
		const model = this.model;
		if (!model) return [];
		return getSupportedEfforts(model);
	}

	clearQueue(options?: { forInterrupt?: boolean }): {
		steering: Array<{ text: string }>;
		followUp: Array<{ text: string }>;
	} {
		const queue = this.#projection.queue;
		this.#projection = { ...this.#projection, queue: { steering: [], followUp: [] } };
		this.#state = this.#buildAgentState();
		void this.#client.clearQueue(options).catch(error => {
			logger.warn("Failed to clear remote session queue", { error: String(error) });
			this.#safeRefresh();
		});
		return {
			steering: queue.steering.map(text => ({ text })),
			followUp: queue.followUp.map(text => ({ text })),
		};
	}
	/** Signal cancellation without blocking synchronous InteractiveMode input handling. */
	cancelAsyncJobs(): number {
		const running = this.runningAsyncJobCount;
		void this.#client.cancelAsyncJobs().catch(error => {
			logger.warn("Failed to cancel remote async jobs", { error: String(error) });
			this.#safeRefresh();
		});
		return running;
	}

	async undoWorkspace(
		scope?: WorkspaceRestoreScope,
	): Promise<WorkspaceCheckpointAccessResult<WorkspaceRestoreResult>> {
		return { available: true, value: await this.#client.undoWorkspace(scope) };
	}

	async redoWorkspace(): Promise<WorkspaceCheckpointAccessResult<WorkspaceRestoreResult>> {
		return { available: true, value: await this.#client.redoWorkspace() };
	}

	compact(customInstructions?: string) {
		return this.#client.compact(customInstructions);
	}
	async handoff(customInstructions?: string): Promise<RpcHandoffResult | undefined> {
		let response: RpcResponse;
		try {
			response = await this.#dispatch({
				type: "handoff",
				...(customInstructions ? { customInstructions } : {}),
			});
		} catch (error) {
			// A failed dispatch does not mean the child stopped: handoff generation
			// runs to completion there and commits the session switch even when this
			// client already gave up (timeout). Re-read the projection so the
			// foreground stops rendering the session the child has left; a resync
			// failure must not mask the original error.
			await this.#refreshProjection(true).catch(resyncError => {
				logger.warn("Failed to resync projection after handoff failure", {
					error: resyncError instanceof Error ? resyncError.message : String(resyncError),
				});
			});
			throw error;
		}
		// Handoff rewrites the remote session (compaction entry + new session file when
		// the child splits). Refresh the projection so `messages` reflects the new
		// transcript before the TUI rebuilds, and re-point the local mirror at the
		// child's session file so `sessionManager.getEntries()` reads the replacement.
		await this.#refreshProjection(true);
		if (!response.success) throw new Error(response.error);
		return response.command === "handoff" ? (response.data ?? undefined) : undefined;
	}

	/**
	 * Reset the child's conversation in place (`/clear`): drop every message,
	 * queued turn, and pending tool call while the session id, title, and
	 * transcript file survive. Returns `undefined` when the child refused —
	 * a response was streaming or a foreground bash/python execution was in
	 * flight — mirroring {@link AgentSession.resetSessionContext}.
	 */
	async resetSessionContext(): Promise<ResetSessionContextResult | undefined> {
		const response = await this.#dispatch({ type: "reset_session_context" });
		if (!response.success) throw new Error(response.error);
		// The reset dropped every message on the child and appended a reset
		// boundary; refresh the projection so `messages` reflects the collapsed
		// transcript before the TUI clears its rendered view.
		await this.#refreshProjection(true);
		return response.command === "reset_session_context" && response.data
			? { droppedCount: response.data.droppedCount }
			: undefined;
	}

	runIdleCompaction(): Promise<void> {
		return this.#client.runIdleCompaction().catch(error => {
			logger.warn("Failed to run remote idle compaction", { error: String(error) });
		});
	}

	abortCompaction(): void {
		this.#fireRpc("abort compaction", this.#client.abort());
	}

	abortRetry(): void {
		this.#fireRpc("abort retry", this.#client.abortRetry());
	}

	abortBash(): void {
		this.#fireRpc("abort bash", this.#client.abortBash());
	}

	executeBash(command: string) {
		return this.#client.bash(command);
	}

	getSessionStats() {
		return this.#client.getSessionStats();
	}

	setSessionName(name: string): void {
		this.#fireRpc("set session name", this.#client.setSessionName(name));
	}

	maybeStartTitleGeneration(firstMessage: string): void {
		this.#fireRpc("start title generation", this.#client.maybeStartTitleGeneration(firstMessage));
	}

	setTitleSystemPrompt(): void {}
	setSlashCommands(): void {}
	setBeforeAutoContinue(): void {}
	setSessionBeforeSwitchReconciler(): void {}
	setSessionSwitchReconciler(): void {}
	refreshSkills(): Promise<void> {
		return Promise.resolve();
	}

	async setActiveToolsByName(toolNames: string[]): Promise<void> {
		const result = await this.#client.setActiveTools(toolNames);
		this.#applyActiveTools(result.activeToolNames, result.mountedToolNames);
	}

	/** Install and activate the ephemeral vibe tool set in the backend session. */
	async activateVibeTools(baseToolNames: string[]): Promise<void> {
		await this.#client.activateVibeTools(baseToolNames);
		await this.#refreshProjection();
	}

	/** Uninstall vibe tools and activate the replacement set in the backend session. */
	async deactivateVibeTools(nextToolNames: string[]): Promise<void> {
		await this.#client.deactivateVibeTools(nextToolNames);
		await this.#refreshProjection();
	}

	/** Remove vibe tools from the backend session without restoring a source-session snapshot. */
	async removeVibeToolsPreservingActive(): Promise<void> {
		await this.#client.removeVibeToolsPreservingActive();
		await this.#refreshProjection();
	}

	/** Persist the backend session's vibe-mode state. */
	setVibeModeState(state: VibeModeState | undefined): void {
		this.#fireRpc("set vibe mode state", this.#client.setVibeModeState(state ?? null));
	}

	/** Deliver the vibe-mode context message to the backend session. */
	async sendVibeModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		await this.#client.sendVibeModeContext(options?.deliverAs);
	}

	/** Persist the backend session's goal-mode state. */
	setGoalModeState(state: GoalModeState | undefined): void {
		this.#fireRpc("set goal mode state", this.#client.setGoalModeState(state ?? null));
	}

	/** Deliver the goal-mode context message to the backend session. */
	async sendGoalModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		await this.#client.sendGoalModeContext(options?.deliverAs);
	}

	/** Persist the backend session's plan-mode state. */
	setPlanModeState(state: PlanModeState | undefined): void {
		this.#fireRpc("set plan mode state", this.#client.setPlanModeState(state ?? null));
	}

	/** Install or clear the backend session's plan-proposal handler. */
	setPlanProposalHandler(handler: PlanProposalHandler | null): void {
		this.#fireRpc("set plan proposal handler", this.#client.setPlanProposalHandler(handler !== null));
	}

	/** Run the backend session's plan-review preparation and return approval details. */
	async preparePlanForReview(title: string): Promise<AgentToolResult<PlanApprovalDetails>> {
		const details = await this.#client.preparePlanForReview(title);
		return {
			content: [{ type: "text", text: tSettingsUi("Plan ready for review.") }],
			details,
		};
	}

	/** Deliver the plan-mode context message to the backend session. */
	async sendPlanModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		await this.#client.sendPlanModeContext(options?.deliverAs);
	}

	/** Mark the backend session's silent plan-abort flag. */
	markPlanInternalAbortPending(): void {
		this.#fireRpc("mark plan internal abort pending", this.#client.markPlanInternalAbortPending());
	}

	/** Clear the backend session's silent plan-abort flag. */
	clearPlanInternalAbortPending(): void {
		this.#fireRpc("clear plan internal abort pending", this.#client.clearPlanInternalAbortPending());
	}

	/** Mark the backend session's plan reference as sent. */
	markPlanReferenceSent(): void {
		this.#fireRpc("mark plan reference sent", this.#client.markPlanReferenceSent());
	}

	/** Set the backend session's plan reference path. */
	setPlanReferencePath(path: string): void {
		this.#fireRpc("set plan reference path", this.#client.setPlanReferencePath(path));
	}

	/** Read the backend session's plan reference path. */
	async getPlanReferencePath(): Promise<string> {
		return await this.#client.getPlanReferencePath();
	}

	/** Read the cached backend prewalk state synchronously for render paths. */
	getPrewalkStateSnapshot(): Prewalk | undefined {
		return this.#projection.modes.prewalk;
	}

	/** Read the backend session's prewalk state through RPC. */
	async getPrewalkState(): Promise<Prewalk | undefined> {
		return (await this.#client.getPrewalkState()) ?? undefined;
	}

	/** Create a goal in the backend session's goal runtime. */
	async createGoal(input: { objective: string; tokenBudget?: number }): Promise<GoalModeState> {
		return await this.#client.goalRuntimeCreate(input.objective, input.tokenBudget);
	}

	/** Replace the backend session's active goal. */
	async replaceGoal(input: { objective: string; tokenBudget?: number }): Promise<GoalModeState> {
		return await this.#client.goalRuntimeReplace(input.objective, input.tokenBudget);
	}

	/** Resume the backend session's paused goal. */
	async resumeGoal(): Promise<GoalModeState> {
		return await this.#client.goalRuntimeResume();
	}

	/** Pause the backend session's active goal. */
	async pauseGoal(): Promise<GoalModeState | undefined> {
		return (await this.#client.goalRuntimePause()) ?? undefined;
	}

	/** Drop the backend session's goal. */
	async dropGoal(): Promise<Goal | undefined> {
		return (await this.#client.goalRuntimeDrop()) ?? undefined;
	}

	/** Mutate the backend session's goal budget. */
	async onBudgetMutated(newBudget: number | undefined): Promise<GoalModeState | undefined> {
		return (await this.#client.goalRuntimeOnBudgetMutated(newBudget)) ?? undefined;
	}

	/** Build the backend session's goal continuation prompt. */
	async buildContinuationPrompt(): Promise<string | undefined> {
		return (await this.#client.goalRuntimeBuildContinuationPrompt()) ?? undefined;
	}

	/** Resume accounting in the backend session's goal runtime. */
	async onThreadResumed(options?: { preserveActiveGoal?: boolean }): Promise<GoalModeState | undefined> {
		return (await this.#client.goalRuntimeOnThreadResumed(options?.preserveActiveGoal)) ?? undefined;
	}

	/** Clear accounting in the backend session's goal runtime. */
	clearAccounting(): void {
		this.#fireRpc("clear goal accounting", this.#client.goalRuntimeClearAccounting());
	}

	/** Branch the backend session from a /btw question. */
	async branchFromBtw(
		question: string,
		assistantMessage: AssistantMessage,
		leafId: string,
		sessionId: string,
	): Promise<{ cancelled: boolean; sessionFile: string | undefined }> {
		const result = await this.#client.branchFromBtw(question, assistantMessage, leafId, sessionId);
		return { cancelled: result.cancelled, sessionFile: result.sessionFile ?? undefined };
	}

	async setActiveToolPresentation(toolNames: string[], mountedToolNames: string[]): Promise<void> {
		const result = await this.#client.setActiveToolPresentation(toolNames, mountedToolNames);
		this.#applyActiveTools(result.activeToolNames, result.mountedToolNames);
	}

	beginDispose(): void {}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#historyMirrorSyncTimer) {
			clearTimeout(this.#historyMirrorSyncTimer);
			this.#historyMirrorSyncTimer = undefined;
		}
		this.#extensionUiContext = undefined;
		for (const request of this.#pendingExtensionUiRequests.splice(0)) this.#cancelExtensionUiRequest(request);
		// Drain any extension UI requests already routed into the switch before
		// tearing down the RPC transport. Their awaited `uiContext.xxx(...)`
		// may still be pending in the dying TUI; we let them settle (via the
		// `#disposed` short-circuit at the head of `#handleExtensionUiRequest`
		// or via the TUI cancelling its own dialogs) so the trailing
		// `respondToExtensionUi` doesn't fire after the transport is gone.
		if (this.#inFlightExtensionUiRequests.size > 0) {
			const inFlight = [...this.#inFlightExtensionUiRequests];
			await Promise.race([
				Promise.allSettled(inFlight),
				Bun.sleep(50), // bounded drain — don't hang on a stuck dialog
			]);
		}
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		await this.#port.dispose();
	}
	#applyActiveTools(activeToolNames: string[], mountedToolNames: string[]): void {
		const active = new Set(activeToolNames);
		this.#mountedToolNames = [...mountedToolNames];
		this.#projection = {
			...this.#projection,
			tools: this.#projection.tools.map(tool => ({ ...tool, enabled: active.has(tool.name) })),
		};
		this.#state = this.#buildAgentState();
	}

	async #awaitRpcRequest<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
		if (!signal) return await request;
		if (signal.aborted) throw signal.reason;
		const { promise: aborted, reject } = Promise.withResolvers<never>();
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([request, aborted]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	#fireRpc(label: string, request: Promise<unknown>): void {
		void request.catch(error => {
			logger.warn(`Failed to ${label} remote session`, { error: String(error) });
		});
	}

	/**
	 * Fire-and-forget `#refreshProjection()` wrapper. Plain
	 * `void this.#refreshProjection()` lets "Client not started" rejections
	 * escape after `dispose()`; this catches and swallows them so the caller
	 * can stay terse.
	 */
	#safeRefresh(): void {
		void this.#refreshProjection().catch(() => undefined);
	}

	async #refreshProjection(reloadSessionManager = false): Promise<void> {
		const snapshot = await this.#port.requestSnapshot();
		this.#projection = snapshot.projection;
		this.#state = this.#buildAgentState();
		const sessionFile = this.#projection.path;
		if (sessionFile && (reloadSessionManager || sessionFile !== this.sessionManager.getSessionFile())) {
			await this.sessionManager.setSessionFile(sessionFile);
		}
	}

	/**
	 * Debounced read-only reload of the mirror SessionManager. The rpc-ui child
	 * owns the session file; the foreground mirror only reads it, so without
	 * this `/history` (backed by `sessionManager.getBranch()`) stays frozen at
	 * whatever existed when the mirror opened. Debounced because reliable
	 * frames arrive per streaming delta.
	 */
	#scheduleHistoryMirrorSync(): void {
		if (this.#disposed || this.#historyMirrorSyncTimer) return;
		this.#historyMirrorSyncTimer = setTimeout(() => {
			this.#historyMirrorSyncTimer = undefined;
			void this.sessionManager.refreshFromDisk().catch(error => {
				logger.warn("Failed to refresh history mirror", { error: String(error) });
			});
		}, HISTORY_MIRROR_SYNC_DEBOUNCE_MS);
		this.#historyMirrorSyncTimer.unref?.();
	}

	async #dispatch(command: RpcCommand): Promise<RpcResponse> {
		let response: RpcResponse;
		try {
			response = await this.#port.dispatch(command);
		} catch (error) {
			if (this.#disposed || !isRpcClientDisconnectedError(error)) throw error;
			// The worker transport is gone (crash, closed stdio, or a facade that
			// was never attached). The session file is authoritative: respawn the
			// worker, restore the projection from it, then replay the command —
			// a "Client not started" rejection means nothing was ever written.
			await this.#recoverConnection();
			response = await this.#port.dispatch(command);
		}
		const error = responseError(response);
		if (error) throw error;
		return response;
	}

	#recoveryPromise: Promise<void> | undefined;

	/**
	 * Respawn the isolated agent worker after a transport loss and rebuild the
	 * local projection from the reloaded session. Concurrent callers share one
	 * recovery attempt; the next dispatch after a failed recovery surfaces the
	 * retry's error instead of the cryptic pre-send rejection.
	 */
	async #recoverConnection(): Promise<void> {
		this.#recoveryPromise ??= (async () => {
			logger.warn("Isolated session RPC transport is down; restarting agent worker", {
				sessionId: this.#projection.identity.sessionId,
			});
			await this.#client.ensureStarted();
			await this.#client.setSubagentSubscription("events").catch(error => {
				logger.warn("Failed to restore subagent subscription after RPC restart", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
			if (this.#extensionUiContext) {
				await this.#client.initializeExtensions().catch(error => {
					logger.warn("Failed to re-initialize extensions after RPC restart", {
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}
			await this.#port.requestSnapshot();
		})().finally(() => {
			this.#recoveryPromise = undefined;
		});
		return this.#recoveryPromise;
	}

	#replaceMessages(messages: AgentMessage[]): void {
		this.#projection = { ...this.#projection, messages };
		this.#state = this.#buildAgentState();
	}

	#buildAgentState(): AgentState {
		return {
			model: this.#projection.model,
			thinkingLevel: this.#projection.thinkingLevel,
			isStreaming: this.#projection.busy.isStreaming,
			messages: [...this.#projection.messages],
			systemPrompt: [],
			tools: this.#projection.tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})) as AgentTool[],
			streamMessage: this.#streamMessage,
			requestStartedAt: this.#requestStartedAt,
			firstByteAt: this.#firstByteAt,
			pendingToolCalls: new Set<string>(),
		} as unknown as AgentState;
	}
}
