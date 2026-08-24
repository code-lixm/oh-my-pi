import type {
	Agent,
	AgentMessage,
	AgentState,
	AgentTool,
	AgentToolContext,
	ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type {
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
import { logger } from "@oh-my-pi/pi-utils";
import type { AdvisorConfig } from "../../advisor";
import type { WorkspaceCheckpointAccessResult } from "../../commands/workspace-checkpoint-support";
import type { ModelRegistry } from "../../config/model-registry";
import { formatModelString } from "../../config/model-resolver";
import type { PromptTemplate } from "../../config/prompt-templates";
import type { Settings } from "../../config/settings";
import type { ExtensionUIContext } from "../../extensibility/extensions/types";
import type { Skill } from "../../extensibility/skills";
import type { FileSlashCommand } from "../../extensibility/slash-commands";
import type { AgentActivityState } from "../../registry/agent-activity";
import type { AgentSession } from "../../session/agent-session";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import type {
	AsyncJobSnapshot,
	ResolvedRoleModel,
	RoleModelCycle,
	RoleModelCycleResult,
} from "../../session/agent-session-types";
import type { AdvisorStats } from "../../session/session-advisors";
import type { SessionContext } from "../../session/session-context";
import type { SessionManager } from "../../session/session-manager";
import {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../../task/types";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type { TodoPhase } from "../../tools/todo";
import type { EventBus } from "../../utils/event-bus";
import type { InspectImageMode } from "../../utils/inspect-image-mode";
import type { WorkspaceRestoreResult, WorkspaceRestoreScope } from "../../workspace-checkpoints";
import type { RpcClient } from "../rpc/rpc-client";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcNavigateTreeOptions,
	RpcNavigateTreeResult,
	RpcResponse,
} from "../rpc/rpc-types";
import type { InteractiveSessionPort, InteractiveSessionSettingsCapabilities } from "./port";
import { RpcInteractiveSessionPort } from "./rpc-session-port";
import type { InteractiveSessionProjection } from "./types";

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
		clearAccounting: (): void => {},
		onThreadResumed: async (): Promise<undefined> => undefined,
	};
	readonly #client: RpcClient;
	readonly #port: InteractiveSessionPort;
	readonly #eventListeners = new Set<(event: AgentSessionEvent) => void>();
	readonly #commandMetadataListeners = new Set<() => void>();
	readonly #unsubscribers: Array<() => void> = [];
	#extensionUiContext: ExtensionUIContext | undefined;
	#pendingExtensionUiRequests: RpcExtensionUIRequest[] = [];
	#projection: InteractiveSessionProjection;
	#state: AgentState;
	#disposed = false;
	#mountedToolNames: string[] = [];

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
			}),
			this.#port.onView(frame => {
				this.#projection = { ...this.#projection, ...frame.patch };
				this.#state = this.#buildAgentState();
			}),
			this.#client.onSessionEvent(event => {
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
		void this.#handleExtensionUiRequest(uiContext, request);
	}

	#cancelExtensionUiRequest(request: RpcExtensionUIRequest): void {
		if (request.method === "select" || request.method === "input" || request.method === "editor") {
			this.#client.respondToExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
		} else if (request.method === "confirm") {
			this.#client.respondToExtensionUi({ type: "extension_ui_response", id: request.id, confirmed: false });
		}
	}

	async #handleExtensionUiRequest(uiContext: ExtensionUIContext, request: RpcExtensionUIRequest): Promise<void> {
		try {
			switch (request.method) {
				case "select": {
					const value = await uiContext.select(request.title, request.options, { timeout: request.timeout });
					this.#client.respondToExtensionUi(
						value === undefined
							? { type: "extension_ui_response", id: request.id, cancelled: true }
							: { type: "extension_ui_response", id: request.id, value },
					);
					return;
				}
				case "confirm": {
					const confirmed = await uiContext.confirm(request.title, request.message, { timeout: request.timeout });
					this.#client.respondToExtensionUi({ type: "extension_ui_response", id: request.id, confirmed });
					return;
				}
				case "input": {
					const value = await uiContext.input(request.title, request.placeholder, { timeout: request.timeout });
					this.#client.respondToExtensionUi(
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
					this.#client.respondToExtensionUi(
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
		} catch {
			if (request.method === "select" || request.method === "input" || request.method === "editor") {
				this.#client.respondToExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
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
	/** Number of running background jobs reported by the isolated session. */
	get runningAsyncJobCount(): number {
		return this.#projection.jobs?.running.length ?? 0;
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
		void this.#client.abortBranchSummary();
	}

	resumeAfterAskReanswer(): void {
		void this.#client.resumeAfterAskReanswer();
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

	async setModel(model: Model): Promise<void> {
		await this.#client.setModel(model.provider, model.id);
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
		void this.#client.setThinkingLevel(level);
	}

	cycleThinkingLevel() {
		return this.#client.cycleThinkingLevel();
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		void this.#client.setSteeringMode(mode);
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		void this.#client.setFollowUpMode(mode);
	}

	setInterruptMode(mode: "immediate" | "wait"): void {
		void this.#client.setInterruptMode(mode);
	}

	setTodoPhases(phases: TodoPhase[]): void {
		this.#projection = { ...this.#projection, todo: phases };
		this.#state = this.#buildAgentState();
		void this.#client.setTodos(phases);
	}

	setAutoCompactionEnabled(enabled: boolean): void {
		void this.#client.setAutoCompaction(enabled);
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
			void this.#refreshProjection();
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
			void this.#refreshProjection();
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

	runIdleCompaction(): Promise<void> {
		return this.#client.runIdleCompaction();
	}

	abortCompaction(): void {
		void this.#client.abort();
	}

	abortRetry(): void {
		void this.#client.abortRetry();
	}

	abortBash(): void {
		void this.#client.abortBash();
	}

	executeBash(command: string) {
		return this.#client.bash(command);
	}

	getSessionStats() {
		return this.#client.getSessionStats();
	}

	setSessionName(name: string): void {
		void this.#client.setSessionName(name);
	}

	maybeStartTitleGeneration(firstMessage: string): void {
		void this.#client.maybeStartTitleGeneration(firstMessage);
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

	async setActiveToolPresentation(toolNames: string[], mountedToolNames: string[]): Promise<void> {
		const result = await this.#client.setActiveToolPresentation(toolNames, mountedToolNames);
		this.#applyActiveTools(result.activeToolNames, result.mountedToolNames);
	}

	beginDispose(): void {}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#extensionUiContext = undefined;
		for (const request of this.#pendingExtensionUiRequests.splice(0)) this.#cancelExtensionUiRequest(request);
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

	async #refreshProjection(reloadSessionManager = false): Promise<void> {
		const snapshot = await this.#port.requestSnapshot();
		this.#projection = snapshot.projection;
		this.#state = this.#buildAgentState();
		const sessionFile = this.#projection.path;
		if (sessionFile && (reloadSessionManager || sessionFile !== this.sessionManager.getSessionFile())) {
			await this.sessionManager.setSessionFile(sessionFile);
		}
	}

	async #dispatch(command: RpcCommand): Promise<RpcResponse> {
		const response = await this.#port.dispatch(command);
		const error = responseError(response);
		if (error) throw error;
		return response;
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
			streamMessage: null,
			pendingToolCalls: new Set<string>(),
		} as unknown as AgentState;
	}
}
