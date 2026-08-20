import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import type { RpcClient } from "../rpc/rpc-client";
import type { RpcAvailableSlashCommand, RpcCommand, RpcSessionState, RpcSubagentSnapshot } from "../rpc/rpc-types";
import type {
	InteractiveSessionConnectionListener,
	InteractiveSessionConnectionState,
	InteractiveSessionPort,
	InteractiveSessionReliableListener,
	InteractiveSessionViewListener,
} from "./port";
import type {
	InteractiveSessionProjection,
	InteractiveSessionProjectionPatch,
	InteractiveSessionSnapshot,
} from "./types";

export interface RpcInteractiveSessionPortOptions {
	readonly client: RpcClient;
	readonly cwd: string;
	readonly agentId?: string;
	readonly ownsClient?: boolean;
}

function commandProjection(
	command: RpcAvailableSlashCommand,
): InteractiveSessionProjection["commands"][number] | undefined {
	const source =
		command.source === "skill"
			? "skill"
			: command.source === "custom"
				? "extension"
				: command.source === "file" || command.source === "mcp_prompt"
					? "prompt"
					: undefined;
	if (!source) return undefined;
	return {
		name: command.name,
		...(command.description ? { description: command.description } : {}),
		source,
	};
}

function buildProjection(
	state: RpcSessionState,
	messages: readonly AgentMessage[],
	commands: readonly RpcAvailableSlashCommand[],
	subagents: readonly RpcSubagentSnapshot[],
	options: Pick<RpcInteractiveSessionPortOptions, "cwd" | "agentId">,
): InteractiveSessionProjection {
	return {
		identity: {
			sessionId: state.sessionId,
			...(options.agentId ? { agentId: options.agentId, agentKind: "main" as const } : {}),
		},
		cwd: options.cwd,
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
		...(state.activity ? { activity: state.activity } : {}),
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
		...(state.contextUsage ? { context: state.contextUsage } : {}),
		jobs: state.asyncJobs ?? null,
		subagents,
		commands: commands.flatMap(command => {
			const projected = commandProjection(command);
			return projected ? [projected] : [];
		}),
		tools: (state.dumpTools ?? []).map(tool => ({ ...tool, enabled: true })),
		messages,
	};
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

/** Direct-child RPC implementation of the interactive session projection boundary. */
export class RpcInteractiveSessionPort implements InteractiveSessionPort {
	readonly #client: RpcClient;
	readonly #cwd: string;
	readonly #agentId: string | undefined;
	readonly #ownsClient: boolean;
	readonly #generation = crypto.randomUUID();
	readonly #reliableListeners = new Set<InteractiveSessionReliableListener>();
	readonly #viewListeners = new Set<InteractiveSessionViewListener>();
	readonly #connectionListeners = new Set<InteractiveSessionConnectionListener>();
	readonly #unsubscribers: Array<() => void> = [];
	#projection: InteractiveSessionProjection;
	#sequence = 0;
	#viewRevision = 0;
	#connection: InteractiveSessionConnectionState = { status: "connected" };
	#refreshPromise: Promise<void> | undefined;
	#refreshAgain = false;
	#disposed = false;

	private constructor(options: RpcInteractiveSessionPortOptions, projection: InteractiveSessionProjection) {
		this.#client = options.client;
		this.#cwd = options.cwd;
		this.#agentId = options.agentId;
		this.#ownsClient = options.ownsClient ?? true;
		this.#projection = projection;
		this.#unsubscribers.push(
			this.#client.onSessionEvent(event => this.#handleSessionEvent(event)),
			this.#client.onAvailableCommandsUpdate(commands => {
				this.#emitReliable({
					commands: commands.flatMap(command => {
						const projected = commandProjection(command);
						return projected ? [projected] : [];
					}),
				});
			}),
			this.#client.onSubagentLifecycle(() => void this.#scheduleRefresh()),
		);
	}

	static async connect(options: RpcInteractiveSessionPortOptions): Promise<RpcInteractiveSessionPort> {
		const [state, messages, commands, subagents] = await Promise.all([
			options.client.getState(),
			options.client.getMessages(),
			options.client.getAvailableCommands(),
			options.client.getSubagents(),
		]);
		return new RpcInteractiveSessionPort(options, buildProjection(state, messages, commands, subagents, options));
	}

	get projection(): InteractiveSessionProjection {
		return this.#projection;
	}

	get cursor(): InteractiveSessionSnapshot["cursor"] {
		return { generation: this.#generation, sequence: this.#sequence };
	}

	dispatch(command: RpcCommand) {
		return this.#client.dispatch(command);
	}

	async requestSnapshot(): Promise<InteractiveSessionSnapshot> {
		await this.#refreshProjection();
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
		listener(this.#connection);
		return () => this.#connectionListeners.delete(listener);
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		this.#setConnection({ status: "disconnected" });
		if (this.#ownsClient) await this.#client.stop();
	}

	#handleSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_update": {
				const messages = replaceMessage(this.#projection.messages, event.message);
				this.#projection = { ...this.#projection, messages };
				this.#viewRevision++;
				const frame = {
					generation: this.#generation,
					key: "assistant-message",
					revision: this.#viewRevision,
					baseReliableSequence: this.#sequence,
					patch: { messages },
				};
				for (const listener of this.#viewListeners) listener(frame);
				return;
			}
			case "message_start":
			case "message_end": {
				const messages = replaceMessage(this.#projection.messages, event.message);
				this.#emitReliable({ messages }, event.type === "message_end" ? "assistant-message" : undefined);
				return;
			}
			case "agent_start":
				this.#emitReliable({ busy: { ...this.#projection.busy, isStreaming: true } });
				return;
			case "agent_end":
				this.#emitReliable(
					{ messages: event.messages, busy: { ...this.#projection.busy, isStreaming: false } },
					"assistant-message",
				);
				void this.#scheduleRefresh();
				return;
			case "auto_compaction_start":
				this.#emitReliable({ busy: { ...this.#projection.busy, isCompacting: true } });
				return;
			case "auto_compaction_end":
				this.#emitReliable({ busy: { ...this.#projection.busy, isCompacting: false } });
				void this.#scheduleRefresh();
				return;
			case "model_changed":
			case "thinking_level_changed":
			case "goal_updated":
			case "todo_auto_clear":
				void this.#scheduleRefresh();
				return;
			default:
				return;
		}
	}

	#emitReliable(patch: InteractiveSessionProjectionPatch, finalViewKey?: string): void {
		this.#sequence++;
		this.#projection = { ...this.#projection, ...patch };
		const frame = {
			generation: this.#generation,
			sequence: this.#sequence,
			patch,
			...(finalViewKey ? { finalViewKey } : {}),
		};
		for (const listener of this.#reliableListeners) listener(frame);
	}

	async #scheduleRefresh(): Promise<void> {
		if (this.#refreshPromise) {
			this.#refreshAgain = true;
			return this.#refreshPromise;
		}
		this.#refreshPromise = (async () => {
			do {
				this.#refreshAgain = false;
				await this.#refreshProjection();
			} while (this.#refreshAgain && !this.#disposed);
		})().finally(() => {
			this.#refreshPromise = undefined;
		});
		return this.#refreshPromise;
	}

	async #refreshProjection(): Promise<void> {
		if (this.#disposed) return;
		try {
			const [state, messages, commands, subagents] = await Promise.all([
				this.#client.getState(),
				this.#client.getMessages(),
				this.#client.getAvailableCommands(),
				this.#client.getSubagents(),
			]);
			const projection = buildProjection(state, messages, commands, subagents, {
				cwd: this.#cwd,
				agentId: this.#agentId,
			});
			this.#emitReliable(projection);
		} catch (error) {
			this.#setConnection({
				status: "disconnected",
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	#setConnection(state: InteractiveSessionConnectionState): void {
		this.#connection = state;
		for (const listener of this.#connectionListeners) listener(state);
	}
}
