import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import type { RpcCommand, RpcResponse, RpcSessionState } from "../rpc/rpc-types";
import type {
	InteractiveSessionConnectionListener,
	InteractiveSessionPort,
	InteractiveSessionReliableListener,
	InteractiveSessionViewListener,
} from "./port";
import type {
	InteractiveSessionProjection,
	InteractiveSessionProjectionPatch,
	InteractiveSessionSnapshot,
} from "./types";

function localState(session: AgentSession): RpcSessionState {
	const roleOrder = session.settings.get("cycleOrder");
	const roleModelCycle = session.getRoleModelCycle(roleOrder);
	return {
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		configuredThinkingLevel: session.configuredThinkingLevel(),
		isStreaming: session.isStreaming,
		isBashRunning: session.isBashRunning,
		isEvalRunning: session.isEvalRunning,
		isCompacting: session.isCompacting,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		interruptMode: session.interruptMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		autoCompactionEnabled: session.autoCompactionEnabled,
		fastModeEnabled: session.isFastModeEnabled(),
		fastModeActive: session.isFastModeActive(),
		tokensPerSecond: null,
		messageCount: session.messages.length,
		queuedMessageCount: session.queuedMessageCount,
		queuedMessages: session.getQueuedMessages(),
		todoPhases: session.getTodoPhases(),
		systemPrompt: session.systemPrompt,
		dumpTools: session.agent.state.tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			parameters: toolWireSchema(tool),
			examples: tool.examples,
		})),
		contextUsage: session.getContextUsage(),
		asyncJobs: session.getAsyncJobSnapshot({ recentLimit: 5 }),
		activity: session.getActivityState(),
		advisorStats: session.getAdvisorStats(),
		scopedModels: [...session.scopedModels],
		...(roleModelCycle ? { roleModelCycle: { roleOrder: [...roleOrder], cycle: roleModelCycle } } : {}),
		planMode: session.getPlanModeState(),
		goalMode: session.getGoalModeState(),
		vibeMode: session.getVibeModeState(),
	};
}

function localProjection(session: AgentSession): InteractiveSessionProjection {
	const state = localState(session);
	const agentId = session.getAgentId();
	return {
		identity: {
			sessionId: state.sessionId,
			...(agentId ? { agentId, agentKind: "main" as const } : {}),
		},
		cwd: session.sessionManager.getCwd(),
		...(state.sessionFile ? { path: state.sessionFile } : {}),
		...(state.sessionName ? { name: state.sessionName } : {}),
		...(state.model ? { model: state.model } : {}),
		thinkingLevel: state.thinkingLevel,
		configuredThinkingLevel: state.configuredThinkingLevel,
		busy: {
			isStreaming: state.isStreaming,
			isBashRunning: state.isBashRunning ?? false,
			isEvalRunning: state.isEvalRunning ?? false,
			isCompacting: state.isCompacting,
		},
		activity: state.activity,
		advisorStats: state.advisorStats,
		scopedModels: state.scopedModels ?? [],
		...(state.roleModelCycle ? { roleModelCycle: state.roleModelCycle } : {}),
		todo: state.todoPhases,
		queue: state.queuedMessages ?? { steering: [], followUp: [] },
		modes: {
			steering: state.steeringMode,
			followUp: state.followUpMode,
			interrupt: state.interruptMode,
			autoCompactionEnabled: state.autoCompactionEnabled,
			fastModeEnabled: state.fastModeEnabled,
			fastModeActive: state.fastModeActive,
			...(state.planMode ? { plan: state.planMode } : {}),
			...(state.goalMode ? { goal: state.goalMode } : {}),
			...(state.vibeMode ? { vibe: state.vibeMode } : {}),
		},
		context: state.contextUsage,
		jobs: state.asyncJobs ?? null,
		subagents: [],
		commands: [],
		tools: (state.dumpTools ?? []).map(tool => ({ ...tool, enabled: true })),
		messages: session.messages,
	};
}

function success(command: RpcCommand, data?: unknown): RpcResponse {
	return {
		id: command.id,
		type: "response",
		command: command.type,
		success: true,
		...(data === undefined ? {} : { data }),
	} as RpcResponse;
}

function failure(command: RpcCommand, error: string): RpcResponse {
	return {
		id: command.id,
		type: "response",
		command: command.type,
		success: false,
		error,
		code: "UNSUPPORTED_COMMAND",
	} as RpcResponse;
}

function replaceMessage(messages: readonly AgentMessage[], message: AgentMessage): AgentMessage[] {
	for (let index = messages.length - 1; index >= 0; index--) {
		const candidate = messages[index];
		if (candidate?.role !== message.role) continue;
		if (
			candidate.timestamp !== undefined &&
			message.timestamp !== undefined &&
			candidate.timestamp !== message.timestamp
		)
			continue;
		const next = [...messages];
		next[index] = message;
		return next;
	}
	return [...messages, message];
}

/** In-process reference implementation of the interactive session boundary. */
export class LocalInteractiveSessionPort implements InteractiveSessionPort {
	readonly #session: AgentSession;
	readonly #generation = crypto.randomUUID();
	readonly #reliableListeners = new Set<InteractiveSessionReliableListener>();
	readonly #viewListeners = new Set<InteractiveSessionViewListener>();
	readonly #connectionListeners = new Set<InteractiveSessionConnectionListener>();
	readonly #unsubscribe: () => void;
	#projection: InteractiveSessionProjection;
	#sequence = 0;
	#revision = 0;
	#disposed = false;

	constructor(session: AgentSession) {
		this.#session = session;
		this.#projection = localProjection(session);
		this.#unsubscribe = session.subscribe(event => this.#handleEvent(event));
	}

	get projection(): InteractiveSessionProjection {
		return this.#projection;
	}

	get cursor(): InteractiveSessionSnapshot["cursor"] {
		return { generation: this.#generation, sequence: this.#sequence };
	}

	async dispatch(command: RpcCommand): Promise<RpcResponse> {
		switch (command.type) {
			case "prompt":
				void this.#session
					.prompt(command.message, { images: command.images, streamingBehavior: command.streamingBehavior })
					.catch(error => logger.error("Local session prompt failed", { error: String(error) }));
				return success(command);
			case "steer":
				await this.#session.steer(command.message, command.images);
				return success(command);
			case "follow_up":
				await this.#session.followUp(command.message, command.images);
				return success(command);
			case "abort":
				await this.#session.abort();
				return success(command);
			case "abort_and_prompt":
				await this.#session.abort();
				void this.#session
					.prompt(command.message, { images: command.images })
					.catch(error => logger.error("Local session prompt failed", { error: String(error) }));
				return success(command);
			case "get_state":
				return success(command, localState(this.#session));
			case "get_messages":
				return success(command, { messages: this.#session.messages });
			case "get_async_jobs":
				return success(command, {
					asyncJobs: this.#session.getAsyncJobSnapshot({ recentLimit: command.recentLimit }),
				});
			case "cancel_async_jobs":
				return success(command, { cancelled: this.#session.cancelAsyncJobs() });
			case "set_todos":
				this.#session.setTodoPhases(command.phases);
				return success(command, { todoPhases: this.#session.getTodoPhases() });
			case "set_active_tools":
				await this.#session.setActiveToolsByName(command.toolNames);
				return success(command, {
					activeToolNames: this.#session.getActiveToolNames(),
					mountedToolNames: this.#session.getMountedXdevToolNames(),
				});
			case "set_active_tool_presentation":
				await this.#session.setActiveToolPresentation(command.toolNames, command.mountedToolNames);
				return success(command, {
					activeToolNames: this.#session.getActiveToolNames(),
					mountedToolNames: this.#session.getMountedXdevToolNames(),
				});
			case "set_fast_mode": {
				const supported = this.#session.setFastMode(command.enabled);
				if (command.enabled && !supported)
					return failure(command, "Fast mode is unavailable for the current model.");
				return success(command, {
					enabled: this.#session.isFastModeEnabled(),
					active: this.#session.isFastModeActive(),
				});
			}
			case "clear_queue":
				return success(command, this.#session.clearQueue({ forInterrupt: command.forInterrupt }));
			case "set_think_tool":
				return success(command, { enabled: await this.#session.setThinkToolEnabled(command.enabled) });
			case "apply_inspect_image_mode":
				return success(command, { enabled: await this.#session.applyInspectImageModeChange() });
			case "apply_memory_backend":
				await this.#session.applyMemoryBackend();
				return success(command);
			case "refresh_base_system_prompt":
				await this.#session.refreshBaseSystemPrompt();
				return success(command);
			case "set_advisor_enabled":
				return success(command, { active: this.#session.setAdvisorEnabled(command.enabled) });
			case "apply_advisor_configs":
				return success(command, {
					count: this.#session.applyAdvisorConfigs(command.advisors, command.sharedInstructions),
				});
			case "get_advisor_available_tools":
				return success(command, { toolNames: this.#session.getAdvisorAvailableToolNames() });
			case "fetch_usage_reports":
				return success(command, { reports: await this.#session.fetchUsageReports() });
			case "list_reset_credits":
				return success(command, { statuses: await this.#session.listResetCredits() });
			case "redeem_reset_credit":
				return success(command, { outcome: await this.#session.redeemResetCredit(command.target) });
			case "get_usage_reporting_model_selectors":
				return success(command, {
					selectors: this.#session.getUsageReportingModelSelectors(command.reports),
				});
			case "format_advisor_history": {
				const options = command.compact === undefined ? undefined : { compact: command.compact };
				return success(command, { history: this.#session.formatAdvisorHistoryAsText(options) });
			}
			case "set_model":
			case "set_model_temporary": {
				await this.#session.modelRegistry.awaitBackgroundRefresh();
				const model = this.#session
					.getAvailableModels()
					.find(candidate => candidate.provider === command.provider && candidate.id === command.modelId);
				if (!model) return failure(command, `Model not found: ${command.provider}/${command.modelId}`);
				if (command.type === "set_model") await this.#session.setModel(model);
				else {
					const thinkingLevel = command.thinkingLevel ?? this.#session.resolveTemporaryModelThinkingLevel(model);
					await this.#session.setModelTemporary(model, thinkingLevel);
				}
				return success(command, model);
			}
			case "apply_role_model": {
				const entry = this.#session.getRoleModelCycle([command.role])?.models[0];
				if (!entry) return failure(command, `Role model not found: ${command.role}`);
				await this.#session.applyRoleModel(entry);
				return success(command, { model: entry.model, thinkingLevel: entry.thinkingLevel, role: entry.role });
			}
			case "cycle_role_models":
				return success(
					command,
					(await this.#session.cycleRoleModels(command.roleOrder, command.direction)) ?? null,
				);
			case "cycle_model":
				return success(command, (await this.#session.cycleModel()) ?? null);
			case "get_available_models":
				await this.#session.modelRegistry.awaitBackgroundRefresh();
				return success(command, { models: this.#session.getAvailableModels() });
			case "set_thinking_level":
				this.#session.setThinkingLevel(command.level);
				return success(command);
			case "cycle_thinking_level":
				return success(command, this.#session.cycleThinkingLevel() ?? null);
			case "set_steering_mode":
				this.#session.setSteeringMode(command.mode);
				return success(command);
			case "set_follow_up_mode":
				this.#session.setFollowUpMode(command.mode);
				return success(command);
			case "set_interrupt_mode":
				this.#session.setInterruptMode(command.mode);
				return success(command);
			case "compact":
				return success(command, await this.#session.compact(command.customInstructions));
			case "run_idle_compaction":
				await this.#session.runIdleCompaction();
				return success(command);
			case "set_auto_compaction":
				this.#session.setAutoCompactionEnabled(command.enabled);
				return success(command);
			case "set_auto_retry":
				this.#session.setAutoRetryEnabled(command.enabled);
				return success(command);
			case "abort_retry":
				this.#session.abortRetry();
				return success(command);
			case "bash":
				return success(command, await this.#session.executeBash(command.command));
			case "abort_bash":
				this.#session.abortBash();
				return success(command);
			case "get_session_stats":
				return success(command, this.#session.getSessionStats());
			case "set_session_name":
				this.#session.setSessionName(command.name);
				return success(command);
			default:
				return failure(command, `Unsupported local interactive session command: ${command.type}`);
		}
	}

	async requestSnapshot(): Promise<InteractiveSessionSnapshot> {
		this.#projection = localProjection(this.#session);
		return { cursor: this.cursor, projection: this.#projection };
	}

	onReliable(listener: InteractiveSessionReliableListener): () => void {
		this.#reliableListeners.add(listener);
		return () => this.#reliableListeners.delete(listener);
	}

	onView(listener: InteractiveSessionViewListener): () => void {
		this.#viewListeners.add(listener);
		return () => this.#viewListeners.delete(listener);
	}

	onConnection(listener: InteractiveSessionConnectionListener): () => void {
		this.#connectionListeners.add(listener);
		listener({ status: "connected" });
		return () => this.#connectionListeners.delete(listener);
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe();
		for (const listener of this.#connectionListeners) listener({ status: "disconnected" });
	}

	#handleEvent(event: AgentSessionEvent): void {
		if (event.type === "message_update") {
			const messages = replaceMessage(this.#projection.messages, event.message);
			this.#projection = { ...this.#projection, messages };
			this.#revision++;
			for (const listener of this.#viewListeners) {
				listener({
					generation: this.#generation,
					key: "assistant-message",
					revision: this.#revision,
					baseReliableSequence: this.#sequence,
					patch: { messages },
				});
			}
			return;
		}
		const next = localProjection(this.#session);
		this.#emitReliable(
			next,
			event.type === "message_end" || event.type === "agent_end" ? "assistant-message" : undefined,
		);
	}

	#emitReliable(patch: InteractiveSessionProjectionPatch, finalViewKey?: string): void {
		this.#sequence++;
		this.#projection = { ...this.#projection, ...patch };
		for (const listener of this.#reliableListeners) {
			listener({
				generation: this.#generation,
				sequence: this.#sequence,
				patch,
				...(finalViewKey ? { finalViewKey } : {}),
			});
		}
	}
}
