/**
 * Hook runner - executes hooks and manages their lifecycle.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../config/model-registry";
import type { SessionManager } from "../../session/session-manager";
import { createNoOpUIContext } from "../utils";
import type {
	AppendEntryHandler,
	BranchHandler,
	LoadedHook,
	NavigateTreeHandler,
	NewSessionHandler,
	SendMessageHandler,
} from "./loader";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ContextEvent,
	ContextEventResult,
	HookCommandContext,
	HookContext,
	HookError,
	HookEvent,
	HookMessageRenderer,
	HookUIContext,
	RegisteredCommand,
	SessionBeforeCompactResult,
	SessionBeforeTreeResult,
	SessionCompactingResult,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEventResult,
	WorkspaceCheckpointBeforeEvent,
	WorkspaceCheckpointBeforeResult,
	WorkspaceCheckpointCreatedEvent,
	WorkspaceCheckpointFailedEvent,
	WorkspaceRestoreBeforeEvent,
	WorkspaceRestoreBeforeResult,
	WorkspaceRestoreCompletedEvent,
	WorkspaceRestoreFailedEvent,
} from "./types";

/**
 * Listener for hook errors.
 */
export type HookErrorListener = (error: HookError) => void;

// Re-export execCommand for backward compatibility
export { execCommand } from "../../exec/exec";

/**
 * HookRunner executes hooks and manages event emission.
 */
export class HookRunner {
	#uiContext: HookUIContext;
	#hasUI: boolean;
	#errorListeners: Set<HookErrorListener> = new Set();
	#getModel: () => Model | undefined = () => undefined;
	#isIdleFn: () => boolean = () => true;
	#waitForIdleFn: () => Promise<void> = async () => {};
	#abortFn: () => void = () => {};
	#hasQueuedMessagesFn: () => boolean = () => false;
	#newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	#branchHandler: BranchHandler = async () => ({ cancelled: false });
	#navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	/** Re-entrant counter: depth tracks nested restore transactions. */
	#workspaceRestoreLockDepth = 0;

	constructor(
		private readonly hooks: LoadedHook[],
		private readonly cwd: string,
		private readonly sessionManager: SessionManager,
		private readonly modelRegistry: ModelRegistry,
	) {
		this.#uiContext = createNoOpUIContext();
		this.#hasUI = false;
	}

	/**
	 * Initialize HookRunner with all required context.
	 * Modes call this once the agent session is fully set up.
	 */
	initialize(options: {
		/** Function to get the current model */
		getModel: () => Model | undefined;
		/** Handler for hooks to send messages */
		sendMessageHandler: SendMessageHandler;
		/** Handler for hooks to append entries */
		appendEntryHandler: AppendEntryHandler;
		/** Handler for creating new sessions (for HookCommandContext) */
		newSessionHandler?: NewSessionHandler;
		/** Handler for branching sessions (for HookCommandContext) */
		branchHandler?: BranchHandler;
		/** Handler for navigating session tree (for HookCommandContext) */
		navigateTreeHandler?: NavigateTreeHandler;
		/** Function to check if agent is idle */
		isIdle?: () => boolean;
		/** Function to wait for agent to be idle */
		waitForIdle?: () => Promise<void>;
		/** Function to abort current operation (fire-and-forget) */
		abort?: () => void;
		/** Function to check if there are queued messages */
		hasQueuedMessages?: () => boolean;
		/** UI context for interactive prompts */
		uiContext?: HookUIContext;
		/** Whether UI is available */
		hasUI?: boolean;
	}): void {
		this.#getModel = options.getModel;
		this.#isIdleFn = options.isIdle ?? (() => true);
		this.#waitForIdleFn = options.waitForIdle ?? (async () => {});
		this.#abortFn = options.abort ?? (() => {});
		this.#hasQueuedMessagesFn = options.hasQueuedMessages ?? (() => false);
		// Store session handlers for HookCommandContext
		if (options.newSessionHandler) {
			this.#newSessionHandler = options.newSessionHandler;
		}
		if (options.branchHandler) {
			this.#branchHandler = options.branchHandler;
		}
		if (options.navigateTreeHandler) {
			this.#navigateTreeHandler = options.navigateTreeHandler;
		}
		// Set per-hook handlers for pi.sendMessage() and pi.appendEntry()
		for (const hook of this.hooks) {
			hook.setSendMessageHandler(options.sendMessageHandler);
			hook.setAppendEntryHandler(options.appendEntryHandler);
		}
		this.#uiContext = options.uiContext ?? createNoOpUIContext();
		this.#hasUI = options.hasUI ?? false;
	}

	/**
	 * Get the UI context (set by mode).
	 */
	getUIContext(): HookUIContext | null {
		return this.#uiContext;
	}

	/**
	 * Get whether UI is available.
	 */
	getHasUI(): boolean {
		return this.#hasUI;
	}

	/**
	 * Get the paths of all loaded hooks.
	 */
	getHookPaths(): string[] {
		return this.hooks.map(h => h.path);
	}

	/**
	 * Subscribe to hook errors.
	 * @returns Unsubscribe function
	 */
	onError(listener: HookErrorListener): () => void {
		this.#errorListeners.add(listener);
		return () => this.#errorListeners.delete(listener);
	}

	/**
	 * Emit an error to all listeners.
	 */
	/**
	 * Emit an error to all error listeners.
	 */
	emitError(error: HookError): void {
		for (const listener of this.#errorListeners) {
			listener(error);
		}
	}

	/**
	 * Check if any hooks have handlers for the given event type.
	 */
	hasHandlers(eventType: string): boolean {
		for (const hook of this.hooks) {
			const handlers = hook.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Get a message renderer for the given customType.
	 * Returns the first renderer found across all hooks, or undefined if none.
	 */
	getMessageRenderer(customType: string): HookMessageRenderer | undefined {
		for (const hook of this.hooks) {
			const renderer = hook.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	/**
	 * Get all registered commands from all hooks.
	 */
	getRegisteredCommands(): RegisteredCommand[] {
		const commands: RegisteredCommand[] = [];
		for (const hook of this.hooks) {
			for (const command of hook.commands.values()) {
				commands.push(command);
			}
		}
		return commands;
	}

	/**
	 * Get a registered command by name.
	 * Returns the first command found across all hooks, or undefined if none.
	 */
	getCommand(name: string): RegisteredCommand | undefined {
		for (const hook of this.hooks) {
			const command = hook.commands.get(name);
			if (command) {
				return command;
			}
		}
		return undefined;
	}

	/**
	 * Create the event context for handlers.
	 */
	#createContext(): HookContext {
		return {
			ui: this.#uiContext,
			hasUI: this.#hasUI,
			cwd: this.cwd,
			sessionManager: this.sessionManager,
			modelRegistry: this.modelRegistry,
			model: this.#getModel(),
			isIdle: () => this.#isIdleFn(),
			abort: () => this.#abortFn(),
			hasQueuedMessages: () => this.#hasQueuedMessagesFn(),
			workspaceRestoreLockHeld: () => this.#workspaceRestoreLockDepth > 0,
		};
	}

	/**
	 * Create the command context for slash command handlers.
	 * Extends HookContext with session control methods that are only safe in commands.
	 */
	createCommandContext(): HookCommandContext {
		return {
			...this.#createContext(),
			waitForIdle: () => this.#waitForIdleFn(),
			newSession: options => this.#newSessionHandler(options),
			branch: entryId => this.#branchHandler(entryId),
			navigateTree: (targetId, options) => this.#navigateTreeHandler(targetId, options),
		};
	}

	/**
	 * Check if an event type can return `{ cancel?: boolean }`.
	 */
	#isCancelableEvent(
		type: string,
	): type is
		| "session_before_switch"
		| "session_before_branch"
		| "session_before_compact"
		| "session_before_tree"
		| "workspace_checkpoint_before"
		| "workspace_restore_before" {
		return (
			type === "session_before_switch" ||
			type === "session_before_branch" ||
			type === "session_before_compact" ||
			type === "session_before_tree" ||
			type === "workspace_checkpoint_before" ||
			type === "workspace_restore_before"
		);
	}

	/**
	 * Emit an event to all hooks.
	 * Returns the result from cancelable before-events, `session.compacting`, or
	 * `tool_result` handlers (if any handler returns one).
	 */
	async emit(
		event: HookEvent,
	): Promise<
		| SessionBeforeCompactResult
		| SessionBeforeTreeResult
		| SessionCompactingResult
		| ToolResultEventResult
		| WorkspaceCheckpointBeforeResult
		| WorkspaceRestoreBeforeResult
		| undefined
	> {
		const ctx = this.#createContext();
		let result:
			| SessionBeforeCompactResult
			| SessionBeforeTreeResult
			| SessionCompactingResult
			| ToolResultEventResult
			| WorkspaceCheckpointBeforeResult
			| WorkspaceRestoreBeforeResult
			| undefined;

		for (const hook of this.hooks) {
			const handlers = hook.handlers.get(event.type);
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = await handler(event, ctx);

					// For cancelable before-events, capture the result and stop on cancel.
					if (this.#isCancelableEvent(event.type) && handlerResult) {
						result = handlerResult as
							| SessionBeforeCompactResult
							| SessionBeforeTreeResult
							| WorkspaceCheckpointBeforeResult
							| WorkspaceRestoreBeforeResult;
						if (result.cancel) {
							return result;
						}
					}

					// For tool_result events, capture the result
					if (event.type === "tool_result" && handlerResult) {
						result = handlerResult as ToolResultEventResult;
					}
					if (event.type === "session.compacting" && handlerResult) {
						result = handlerResult as SessionCompactingResult;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					this.emitError({
						hookPath: hook.path,
						event: event.type,
						error: message,
					});
				}
			}
		}

		return result;
	}

	/**
	 * Emit a tool_call event to all hooks.
	 * No timeout - user prompts can take as long as needed.
	 * Errors are thrown (not swallowed) so caller can block on failure.
	 */
	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		const ctx = this.#createContext();
		let result: ToolCallEventResult | undefined;

		for (const hook of this.hooks) {
			const handlers = hook.handlers.get("tool_call");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				// No timeout - let user take their time
				const handlerResult = await handler(event, ctx);

				if (handlerResult) {
					result = handlerResult as ToolCallEventResult;
					// If blocked, stop processing further hooks
					if (result.block) {
						return result;
					}
				}
			}
		}

		return result;
	}

	/**
	 * Emit a context event to all hooks.
	 * Handlers are chained - each gets the previous handler's output (if any).
	 * Returns the final modified messages, or the original if no modifications.
	 *
	 * Note: Messages are already deep-copied by the caller (pi-ai preprocessor).
	 */
	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		const ctx = this.#createContext();
		let currentMessages = messages;

		for (const hook of this.hooks) {
			const handlers = hook.handlers.get("context");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: ContextEvent = { type: "context", messages: currentMessages };
					const handlerResult = await handler(event, ctx);

					if (handlerResult && (handlerResult as ContextEventResult).messages) {
						currentMessages = (handlerResult as ContextEventResult).messages!;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					this.emitError({
						hookPath: hook.path,
						event: "context",
						error: message,
					});
				}
			}
		}

		return currentMessages;
	}

	/**
	 * Emit before_agent_start event to all hooks.
	 * Returns the first message to inject (if any handler returns one).
	 */
	async emitBeforeAgentStart(
		prompt: string,
		images?: import("@oh-my-pi/pi-ai").ImageContent[],
	): Promise<BeforeAgentStartEventResult | undefined> {
		const ctx = this.#createContext();
		let result: BeforeAgentStartEventResult | undefined;

		for (const hook of this.hooks) {
			const handlers = hook.handlers.get("before_agent_start");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: BeforeAgentStartEvent = { type: "before_agent_start", prompt, images };
					const handlerResult = await handler(event, ctx);

					if (handlerResult && (handlerResult as BeforeAgentStartEventResult).message && !result) {
						result = handlerResult as BeforeAgentStartEventResult;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					this.emitError({
						hookPath: hook.path,
						event: "before_agent_start",
						error: message,
					});
				}
			}
		}

		return result;
	}

	async emitWorkspaceCheckpointBefore(
		event: WorkspaceCheckpointBeforeEvent,
	): Promise<WorkspaceCheckpointBeforeResult | undefined> {
		const result = await this.emit(event);
		return result as WorkspaceCheckpointBeforeResult | undefined;
	}

	async emitWorkspaceCheckpointCreated(event: WorkspaceCheckpointCreatedEvent): Promise<void> {
		await this.emit(event);
	}

	async emitWorkspaceCheckpointFailed(event: WorkspaceCheckpointFailedEvent): Promise<void> {
		await this.emit(event);
	}

	async emitWorkspaceRestoreBefore(
		event: WorkspaceRestoreBeforeEvent,
	): Promise<WorkspaceRestoreBeforeResult | undefined> {
		const result = await this.emit(event);
		return result as WorkspaceRestoreBeforeResult | undefined;
	}

	async emitWorkspaceRestoreCompleted(event: WorkspaceRestoreCompletedEvent): Promise<void> {
		await this.emit(event);
	}

	async emitWorkspaceRestoreFailed(event: WorkspaceRestoreFailedEvent): Promise<void> {
		await this.emit(event);
	}

	/**
	 * Acquire the workspace restore lock for the duration of `body`. While the
	 * lock is held, `HookContext.workspaceRestoreLockHeld()` returns `true` for
	 * any hook event dispatched on this runner so handlers can refuse to mutate
	 * the on-disk tree. Re-entrant; nested calls increment a depth counter.
	 *
	 * Modes (interactive, RPC) invoke this from the workspace checkpoint service
	 * wrapper around the `restore` / `undo` / `redo` apply path. Hooks that fire
	 * during the transaction (`workspace_restore_before` / `workspace_restore_*`)
	 * are dispatched through the same `emit()` path and observe `true`.
	 */
	async withWorkspaceRestoreLock<T>(body: () => Promise<T>): Promise<T> {
		this.#workspaceRestoreLockDepth++;
		try {
			return await body();
		} finally {
			this.#workspaceRestoreLockDepth--;
		}
	}

	/**
	 * Snapshot whether the workspace restore lock is currently held. Exposed for
	 * mode implementations that need to gate external work without taking the
	 * lock themselves.
	 */
	isWorkspaceRestoreLockHeld(): boolean {
		return this.#workspaceRestoreLockDepth > 0;
	}
}
