/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import { isPromise } from "node:util/types";
import type { AgentEvent, AgentMessage, AgentToolResult, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { BashResult } from "../../exec/bash-executor";
import type { AgentSessionEvent, SessionStats } from "../../session/agent-session";
import type { AsyncJobSnapshot } from "../../session/agent-session-types";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type { TodoPhase } from "../../tools/todo";
import type {
	ApplyWorkspaceRestoreRequest,
	WorkspaceCheckpointRecord,
	WorkspaceRestorePlan,
	WorkspaceRestoreResult,
	WorkspaceRestoreScope,
} from "../../workspace-checkpoints/types";
import { ChildProcessRpcTransport } from "./child-process-rpc-transport";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameDecoder, type RpcProtocolVersion } from "./rpc-frame";
import {
	RPC_MESSAGES_PAGE_BUSY_ERROR,
	RPC_MESSAGES_PAGE_STALE_ERROR,
	type RpcMessagesPage,
	type RpcMessagesPageOptions,
} from "./rpc-messages";
import type { RpcTransport } from "./rpc-transport";
import type {
	RpcAvailableCommandsUpdateFrame,
	RpcAvailableSlashCommand,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHandoffResult,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcKeybindingsCatalog,
	RpcKeybindingsSnapshot,
	RpcMcpServerConfigInput,
	RpcMcpServerInfo,
	RpcNavigateTreeOptions,
	RpcNavigateTreeResult,
	RpcPluginInfo,
	RpcResponse,
	RpcSessionState,
	RpcSettingPath,
	RpcSettingsCatalog,
	RpcSettingsLocale,
	RpcSettingsSnapshot,
	RpcSettingValue,
	RpcSubagentEventFrame,
	RpcSubagentLifecycleFrame,
	RpcSubagentMessagesResult,
	RpcSubagentProgressFrame,
	RpcSubagentSnapshot,
	RpcSubagentSubscriptionLevel,
	RpcWorkspaceCheckpointCreateRequest,
	RpcWorkspaceCheckpointListRequest,
	RpcWorkspaceRestorePreviewRequest,
} from "./rpc-types";

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcClientOptions {
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
	/** Full executable argv prefix; defaults to ["bun", cliPath] */
	command?: string[];
	/** RPC transport mode; rpc-ui enables bidirectional extension UI */
	mode?: "rpc" | "rpc-ui";
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Session directory for the agent */
	sessionDir?: string;
	/** Additional CLI arguments */
	args?: string[];
	/** Custom tools owned by the embedding host and exposed over the RPC transport */
	customTools?: RpcClientCustomTool[];
	/** Physical transport override; defaults to a child coding-agent process. */
	transport?: RpcTransport;
}

export type ModelInfo = Pick<Model, "provider" | "id" | "contextWindow" | "reasoning" | "thinking">;

export type RpcEventListener = (event: AgentEvent) => void;
export type RpcSessionEventListener = (event: AgentSessionEvent) => void;
export type RpcSubagentLifecycleListener = (payload: RpcSubagentLifecycleFrame["payload"]) => void;
export type RpcSubagentProgressListener = (payload: RpcSubagentProgressFrame["payload"]) => void;
export type RpcSubagentEventListener = (payload: RpcSubagentEventFrame["payload"]) => void;
export type RpcAvailableCommandsUpdateListener = (commands: RpcAvailableSlashCommand[]) => void;
export type RpcExtensionUIListener = (request: RpcExtensionUIRequest) => void;

export interface RpcClientToolContext<TDetails = unknown> {
	toolCallId: string;
	signal: AbortSignal;
	sendUpdate(partialResult: RpcClientToolResult<TDetails>): void;
}

export type RpcClientToolResult<TDetails = unknown> = AgentToolResult<TDetails> | string;

export interface RpcClientCustomTool<
	TParams extends Record<string, unknown> = Record<string, unknown>,
	TDetails = unknown,
> extends Omit<RpcHostToolDefinition, "parameters"> {
	parameters: Record<string, unknown>;
	execute(
		params: TParams,
		context: RpcClientToolContext<TDetails>,
	): Promise<RpcClientToolResult<TDetails>> | RpcClientToolResult<TDetails>;
}

export function defineRpcClientTool<
	TParams extends Record<string, unknown> = Record<string, unknown>,
	TDetails = unknown,
>(tool: RpcClientCustomTool<TParams, TDetails>): RpcClientCustomTool<TParams, TDetails> {
	return tool;
}

const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

const sessionEventTypes = new Set<AgentSessionEvent["type"]>([
	...agentEventTypes,
	"memory_operation_start",
	"memory_operation_end",
	"auto_compaction_start",
	"auto_compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"retry_fallback_applied",
	"retry_fallback_succeeded",
	"retry_fallback_restored",
	"ttsr_triggered",
	"todo_reminder",
	"todo_auto_clear",
	"irc_message",
	"notice",
	"thinking_level_changed",
	"model_changed",
	"goal_updated",
]);

function isRpcResponse(value: unknown): value is RpcResponse {
	if (!isRecord(value)) return false;
	if (value.type !== "response") return false;
	if (typeof value.command !== "string") return false;
	if (typeof value.success !== "boolean") return false;
	if (value.id !== undefined && typeof value.id !== "string") return false;
	if (value.success === false) {
		return typeof value.error === "string";
	}
	return true;
}

function supportsRpcProtocolV2(value: Record<string, unknown>): boolean {
	return (
		value.type === "ready" &&
		Array.isArray(value.supportedProtocolVersions) &&
		value.supportedProtocolVersions.includes(2) &&
		value.maxFrameBytes === MAX_RPC_FRAME_BYTES &&
		value.maxReassembledFrameBytes === MAX_RPC_REASSEMBLED_BYTES
	);
}

function isAgentEvent(value: unknown): value is AgentEvent {
	if (!isRecord(value)) return false;
	const type = value.type;
	if (typeof type !== "string") return false;
	return agentEventTypes.has(type as AgentEvent["type"]);
}

function isAgentSessionEvent(value: unknown): value is AgentSessionEvent {
	if (!isRecord(value)) return false;
	const type = value.type;
	if (typeof type !== "string") return false;
	return sessionEventTypes.has(type as AgentSessionEvent["type"]);
}

function isRpcSubagentLifecycleFrame(value: unknown): value is RpcSubagentLifecycleFrame {
	if (!isRecord(value)) return false;
	return value.type === "subagent_lifecycle" && isRecord(value.payload);
}

function isRpcSubagentProgressFrame(value: unknown): value is RpcSubagentProgressFrame {
	if (!isRecord(value)) return false;
	return value.type === "subagent_progress" && isRecord(value.payload);
}

function isRpcSubagentEventFrame(value: unknown): value is RpcSubagentEventFrame {
	if (!isRecord(value)) return false;
	return value.type === "subagent_event" && isRecord(value.payload);
}

function isRpcAvailableCommandsUpdateFrame(value: unknown): value is RpcAvailableCommandsUpdateFrame {
	if (!isRecord(value)) return false;
	return value.type === "available_commands_update" && Array.isArray(value.commands);
}

function isRpcHostToolCallRequest(value: unknown): value is RpcHostToolCallRequest {
	if (!isRecord(value)) return false;
	return (
		value.type === "host_tool_call" &&
		typeof value.id === "string" &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		isRecord(value.arguments)
	);
}

function isRpcHostToolCancelRequest(value: unknown): value is RpcHostToolCancelRequest {
	if (!isRecord(value)) return false;
	return value.type === "host_tool_cancel" && typeof value.id === "string" && typeof value.targetId === "string";
}

function isRpcExtensionUiRequest(value: unknown): value is RpcExtensionUIRequest {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_request" && typeof value.id === "string" && typeof value.method === "string";
}

function normalizeToolResult<TDetails>(result: RpcClientToolResult<TDetails>): AgentToolResult<TDetails> {
	if (typeof result === "string") {
		return {
			content: [{ type: "text", text: result }],
		};
	}
	return result;
}

/** Failed RPC command; `code` mirrors the server's machine-readable error code when present. */
export class RpcCommandError extends Error {
	constructor(
		message: string,
		readonly command: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "RpcCommandError";
	}
}

/** True when a high-level `getMessages()` drain should discard partial pages and fall back to `get_messages`. */
function isPageFallbackError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error instanceof RpcCommandError && (error.code === "session_busy" || error.code === "stale_cursor"))
		return true;
	return error.message === RPC_MESSAGES_PAGE_BUSY_ERROR || error.message === RPC_MESSAGES_PAGE_STALE_ERROR;
}

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
	#activeTransport: RpcTransport | null = null;
	#stopping: Promise<void> | null = null;
	#transport: RpcTransport;
	#transportUnsubscribes: (() => void)[] = [];
	#eventListeners: RpcEventListener[] = [];
	#sessionEventListeners: RpcSessionEventListener[] = [];
	#subagentLifecycleListeners = new Set<RpcSubagentLifecycleListener>();
	#subagentProgressListeners = new Set<RpcSubagentProgressListener>();
	#subagentEventListeners = new Set<RpcSubagentEventListener>();
	#availableCommandsUpdateListeners = new Set<RpcAvailableCommandsUpdateListener>();
	#pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	#customTools: RpcClientCustomTool[] = [];
	#pendingHostToolCalls = new Map<string, { controller: AbortController }>();
	#requestId = 0;
	#protocolVersion: RpcProtocolVersion = 1;
	#extensionUiListeners: Set<(req: RpcExtensionUIRequest) => void> = new Set();
	#pendingExtensionUiRequests: RpcExtensionUIRequest[] = [];
	#abortController = new AbortController();
	#startFailure: ((error: Error) => void) | null = null;

	constructor(options: RpcClientOptions = {}) {
		this.#transport = options.transport ?? new ChildProcessRpcTransport(options);
		this.#customTools = [...(options.customTools ?? [])];
	}

	/**
	 * Start the RPC agent process.
	 *
	 * Safe to call again after {@link stop} on the same instance: a fresh
	 * {@link AbortController} is minted for each start, and any failure after
	 * the child spawn kills the child and clears internal state so callers may
	 * retry without leaking processes.
	 */
	async start(): Promise<void> {
		await this.#stopping;
		if (this.#activeTransport) {
			throw new Error("Client already started");
		}

		// Mint a fresh controller so a previous stop()'s abort does not
		// short-circuit the new transport reader (issue #4079).
		this.#abortController = new AbortController();
		this.#protocolVersion = 1;
		const transport = this.#transport;
		const abortController = this.#abortController;
		const isCurrentTransport = (): boolean =>
			this.#activeTransport === transport && this.#abortController === abortController;
		const { promise: readyPromise, resolve: readyResolve, reject: readyReject } = Promise.withResolvers<void>();
		let readySettled = false;
		let protocolV2Supported = false;
		let protocolV2Enabled = false;
		const frameDecoder = new RpcFrameDecoder();

		const rejectReady = (error: Error): void => {
			if (readySettled) return;
			readySettled = true;
			readyReject(error);
		};
		const failTransport = async (error: Error): Promise<void> => {
			if (!isCurrentTransport()) return;
			rejectReady(error);
			await this.#stopTransport(transport, error, { rejectPendingAfterStop: true });
		};
		const handleTransportFailure = (error: Error): void => {
			if (!isCurrentTransport()) return;
			rejectReady(error);
			void failTransport(error);
		};

		this.#startFailure = rejectReady;
		this.#activeTransport = transport;
		const unsubscribeError = transport.onError(handleTransportFailure);
		const unsubscribeClose = transport.onClose(() => {
			handleTransportFailure(
				new Error(
					readySettled
						? `Agent transport closed. Stderr: ${transport.getStderr()}`
						: `Agent process exited before ready. Stderr: ${transport.getStderr()}`,
				),
			);
		});
		if (isCurrentTransport()) {
			this.#transportUnsubscribes = [unsubscribeError, unsubscribeClose];
		} else {
			unsubscribeError();
			unsubscribeClose();
		}

		const readyTimeout = this.#startTimeout(30000, () => {
			handleTransportFailure(
				new Error(`Timeout waiting for agent to become ready. Stderr: ${transport.getStderr()}`),
			);
		});

		try {
			await transport.start();
			if (!isCurrentTransport()) {
				await readyPromise;
				return;
			}

			// Process parsed JSONL records in the background. Physical frame
			// decoding remains here so every transport shares the same protocol.
			void (async () => {
				try {
					for await (const line of transport.read(abortController.signal)) {
						if (!isCurrentTransport()) return;
						if (!readySettled && isRecord(line) && line.type === "ready") {
							protocolV2Supported = supportsRpcProtocolV2(line);
							readySettled = true;
							readyResolve();
							continue;
						}
						if (isRecord(line) && line.type === "rpc_chunk" && !protocolV2Enabled) {
							throw new Error("RPC chunk received before protocol negotiation");
						}
						const decoded = frameDecoder.push(line);
						if (decoded) this.#handleLine(decoded);
					}

					const closeError = await transport.waitForClose?.(1_000);
					if (!isCurrentTransport()) return;
					if (closeError) {
						await failTransport(closeError);
						return;
					}
					await failTransport(
						new Error(
							readySettled
								? `Agent output stream ended unexpectedly. Stderr: ${transport.getStderr()}`
								: `Agent output stream ended before ready. Stderr: ${transport.getStderr()}`,
						),
					);
				} catch (cause) {
					if (!isCurrentTransport()) return;
					const error = cause instanceof Error ? cause : new Error(String(cause));
					if (!readySettled) {
						await failTransport(error);
						return;
					}
					await failTransport(new Error(`Agent output reader failed: ${error.message}`, { cause: error }));
				}
			})();

			await readyPromise;
			if (protocolV2Supported) {
				protocolV2Enabled = true;
				const response = await this.#send({ type: "negotiate_protocol", protocolVersion: 2 });
				if (
					!response.success ||
					response.command !== "negotiate_protocol" ||
					!isRecord(response.data) ||
					response.data.protocolVersion !== 2
				)
					throw new Error("RPC protocol v2 negotiation failed");
				this.#protocolVersion = 2;
			}
			if (this.#customTools.length > 0) {
				await this.setCustomTools(this.#customTools);
			}
		} catch (cause) {
			// Startup failed after opening the transport. Reap it before returning
			// so a retry cannot inherit a live worker or its session lock.
			const error = cause instanceof Error ? cause : new Error(String(cause));
			await failTransport(error);
			await this.#stopping;
			throw cause;
		} finally {
			clearTimeout(readyTimeout);
			if (this.#startFailure === rejectReady) this.#startFailure = null;
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	stop(): Promise<void> {
		const transport = this.#activeTransport;
		if (!transport) return this.#stopping ?? Promise.resolve();
		return this.#stopTransport(transport, new Error("Client stopped"));
	}

	/**
	 * Stop the RPC agent process and clean up resources.
	 */
	[Symbol.dispose](): void {
		void this.stop();
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.#eventListeners.push(listener);
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to all top-level session events, including non-core session state events.
	 */
	onSessionEvent(listener: RpcSessionEventListener): () => void {
		this.#sessionEventListeners.push(listener);
		return () => {
			const index = this.#sessionEventListeners.indexOf(listener);
			if (index !== -1) {
				this.#sessionEventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to subagent lifecycle frames after setSubagentSubscription("progress" | "events").
	 */
	onSubagentLifecycle(listener: RpcSubagentLifecycleListener): () => void {
		this.#subagentLifecycleListeners.add(listener);
		return () => this.#subagentLifecycleListeners.delete(listener);
	}

	/**
	 * Subscribe to aggregated subagent progress frames after setSubagentSubscription("progress" | "events").
	 */
	onSubagentProgress(listener: RpcSubagentProgressListener): () => void {
		this.#subagentProgressListeners.add(listener);
		return () => this.#subagentProgressListeners.delete(listener);
	}

	/**
	 * Subscribe to raw subagent session events. Call setSubagentSubscription(\"events\") to enable them server-side.
	 */
	onSubagentEvent(listener: RpcSubagentEventListener): () => void {
		this.#subagentEventListeners.add(listener);
		return () => this.#subagentEventListeners.delete(listener);
	}

	/**
	 * Subscribe to slash-command availability updates emitted by the RPC server.
	 */
	onAvailableCommandsUpdate(listener: RpcAvailableCommandsUpdateListener): () => void {
		this.#availableCommandsUpdateListeners.add(listener);
		return () => this.#availableCommandsUpdateListeners.delete(listener);
	}

	/** Subscribe to extension UI requests emitted by rpc-ui sessions. */
	onExtensionUiRequest(listener: RpcExtensionUIListener): () => void {
		this.#extensionUiListeners.add(listener);
		for (const request of this.#pendingExtensionUiRequests.splice(0)) listener(request);
		return () => this.#extensionUiListeners.delete(listener);
	}

	/** Resolve one pending extension UI request. */
	respondToExtensionUi(response: RpcExtensionUIResponse): void {
		this.#writeFrame(response);
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.#transport.getStderr();
	}

	#startTimeout(timeoutMs: number, onTimeout: () => void): NodeJS.Timeout {
		const timer = setTimeout(onTimeout, timeoutMs);
		timer.unref();
		return timer;
	}

	#stopTransport(
		transport: RpcTransport,
		error: Error,
		options: { rejectPendingAfterStop?: boolean } = {},
	): Promise<void> {
		if (this.#activeTransport !== transport) return this.#stopping ?? Promise.resolve();

		this.#activeTransport = null;
		this.#startFailure?.(error);
		this.#abortController.abort(error);
		this.#clearTransportSubscriptions();
		const pendingRequests = Array.from(this.#pendingRequests.values());
		this.#pendingRequests.clear();
		for (const pendingCall of this.#pendingHostToolCalls.values()) {
			pendingCall.controller.abort(error);
		}
		this.#pendingHostToolCalls.clear();
		this.#pendingExtensionUiRequests = [];

		let stopPromise: Promise<void>;
		try {
			stopPromise = transport.stop();
		} catch {
			stopPromise = Promise.resolve();
		}
		const stopping = stopPromise.catch(() => undefined);
		this.#stopping = stopping;
		if (options.rejectPendingAfterStop) {
			void stopping.then(() => {
				for (const request of pendingRequests) request.reject(error);
			});
		} else {
			for (const request of pendingRequests) request.reject(error);
		}
		void stopping.then(() => {
			if (this.#stopping === stopping) this.#stopping = null;
		});
		return stopping;
	}

	#clearTransportSubscriptions(): void {
		for (const unsubscribe of this.#transportUnsubscribes.splice(0)) unsubscribe();
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/** Send one typed RPC command through the active transport. */
	dispatch(command: RpcCommand): Promise<RpcResponse> {
		const { id: _id, ...body } = command;
		return this.#send(body as RpcCommandBody);
	}

	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "prompt", message, images });
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "steer", message, images });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "follow_up", message, images });
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.#send({ type: "abort" });
	}

	/**
	 * Abort current operation and immediately start a new turn with the given message.
	 */
	async abortAndPrompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "abort_and_prompt", message, images });
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "new_session", parentSession });
		return this.#getData(response);
	}

	/** Initialize extensions after the foreground RPC UI can receive their requests. */
	async initializeExtensions(): Promise<void> {
		await this.#send({ type: "initialize_extensions" });
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.#send({ type: "get_state" });
		const state = this.#getData<RpcSessionState>(response);
		return {
			...state,
			fastModeEnabled: state.fastModeEnabled === true,
			fastModeActive: state.fastModeActive === true,
			tokensPerSecond:
				typeof state.tokensPerSecond === "number" && Number.isFinite(state.tokensPerSecond)
					? state.tokensPerSecond
					: null,
		};
	}

	/** Return the current session-scoped asynchronous job snapshot. */
	async getAsyncJobs(recentLimit?: number): Promise<AsyncJobSnapshot | null> {
		const response = await this.#send({ type: "get_async_jobs", recentLimit });
		return this.#getData<{ asyncJobs: AsyncJobSnapshot | null }>(response).asyncJobs;
	}

	/** Get the canonical OMP settings catalog for the active session scope. */
	async getSettingsCatalog(locale?: RpcSettingsLocale): Promise<RpcSettingsCatalog> {
		const response = await this.#send({ type: "get_settings_catalog", locale });
		return this.#getData<RpcSettingsCatalog>(response);
	}

	/** Get effective canonical OMP settings without exposing credential values. */
	async getSettings(): Promise<RpcSettingsSnapshot> {
		const response = await this.#send({ type: "get_settings" });
		return this.#getData<RpcSettingsSnapshot>(response);
	}

	/** Persist one canonical OMP setting and return the refreshed effective snapshot. */
	async updateSetting(path: RpcSettingPath, value: RpcSettingValue): Promise<RpcSettingsSnapshot> {
		const response = await this.#send({ type: "update_settings", path, value });
		return this.#getData<RpcSettingsSnapshot>(response);
	}

	/** Get the current OMP keybinding registry and localized labels. */
	async getKeybindingsCatalog(locale?: RpcSettingsLocale): Promise<RpcKeybindingsCatalog> {
		const response = await this.#send({ type: "get_keybindings_catalog", locale });
		return this.#getData<RpcKeybindingsCatalog>(response);
	}

	/** Get effective OMP keybindings, including defaults and persisted overrides. */
	async getKeybindings(): Promise<RpcKeybindingsSnapshot> {
		const response = await this.#send({ type: "get_keybindings" });
		return this.#getData<RpcKeybindingsSnapshot>(response);
	}

	/** Persist one OMP keybinding override. */
	async updateKeybinding(keybinding: string, keys: string[]): Promise<RpcKeybindingsSnapshot> {
		const response = await this.#send({ type: "update_keybinding", keybinding, keys });
		return this.#getData<RpcKeybindingsSnapshot>(response);
	}

	/** Remove every OMP keybinding override and restore current defaults. */
	async resetKeybindings(): Promise<RpcKeybindingsSnapshot> {
		const response = await this.#send({ type: "reset_keybindings" });
		return this.#getData<RpcKeybindingsSnapshot>(response);
	}

	/** List canonical OMP plugins from npm and marketplace registries. */
	async getPlugins(): Promise<RpcPluginInfo[]> {
		const response = await this.#send({ type: "get_plugins" });
		return this.#getData<{ plugins: RpcPluginInfo[] }>(response).plugins;
	}

	/** Enable or disable one canonical OMP plugin. */
	async setPluginEnabled(plugin: RpcPluginInfo, enabled: boolean): Promise<RpcPluginInfo[]> {
		const response = await this.#send({
			type: "set_plugin_enabled",
			plugin: { id: plugin.id, kind: plugin.kind, scope: plugin.scope },
			enabled,
		});
		return this.#getData<{ plugins: RpcPluginInfo[] }>(response).plugins;
	}

	/** Select the enabled feature set for one npm plugin. */
	async setPluginFeatures(name: string, features: string[]): Promise<RpcPluginInfo[]> {
		const response = await this.#send({ type: "set_plugin_features", name, features });
		return this.#getData<{ plugins: RpcPluginInfo[] }>(response).plugins;
	}

	/** Persist one validated npm plugin setting. */
	async setPluginSetting(name: string, key: string, value: RpcSettingValue): Promise<RpcPluginInfo[]> {
		const response = await this.#send({ type: "set_plugin_setting", name, key, value });
		return this.#getData<{ plugins: RpcPluginInfo[] }>(response).plugins;
	}

	/** List canonical OMP MCP servers without exposing credentials. */
	async getMcpServers(): Promise<RpcMcpServerInfo[]> {
		const response = await this.#send({ type: "get_mcp_servers" });
		return this.#getData<{ servers: RpcMcpServerInfo[] }>(response).servers;
	}

	/** Persist and apply one MCP enablement change. */
	async setMcpServerEnabled(name: string, enabled: boolean): Promise<RpcMcpServerInfo[]> {
		const response = await this.#send({ type: "set_mcp_server_enabled", name, enabled });
		return this.#getData<{ servers: RpcMcpServerInfo[] }>(response).servers;
	}

	/** Add an OMP-owned user or project MCP server. */
	async addMcpServer(
		name: string,
		scope: "user" | "project",
		config: RpcMcpServerConfigInput,
	): Promise<RpcMcpServerInfo[]> {
		const response = await this.#send({ type: "add_mcp_server", name, scope, config });
		return this.#getData<{ servers: RpcMcpServerInfo[] }>(response).servers;
	}

	/** Remove an OMP-owned user or project MCP server. */
	async removeMcpServer(name: string, scope: "user" | "project"): Promise<RpcMcpServerInfo[]> {
		const response = await this.#send({ type: "remove_mcp_server", name, scope });
		return this.#getData<{ servers: RpcMcpServerInfo[] }>(response).servers;
	}

	/**
	 * Enable or disable fast mode for the active model family.
	 */
	async setFastMode(enabled: boolean): Promise<{ enabled: boolean; active: boolean }> {
		const response = await this.#send({ type: "set_fast_mode", enabled });
		return this.#getData(response);
	}

	/**
	 * Configure subagent frames emitted by the RPC server. Servers default to "off".
	 * "progress" emits lifecycle/progress frames; "events" additionally emits raw subagent session events.
	 */
	async setSubagentSubscription(level: RpcSubagentSubscriptionLevel): Promise<RpcSubagentSubscriptionLevel> {
		const response = await this.#send({ type: "set_subagent_subscription", level });
		return this.#getData<{ level: RpcSubagentSubscriptionLevel }>(response).level;
	}

	/**
	 * Return the RPC server's current subagent snapshot.
	 */
	async getSubagents(): Promise<RpcSubagentSnapshot[]> {
		const response = await this.#send({ type: "get_subagents" });
		return this.#getData<{ subagents: RpcSubagentSnapshot[] }>(response).subagents;
	}

	/**
	 * Read persisted transcript entries for a tracked subagent session.
	 */
	async getSubagentMessages(selector: {
		subagentId?: string;
		sessionFile?: string;
		fromByte?: number;
	}): Promise<RpcSubagentMessagesResult> {
		const response = await this.#send({
			type: "get_subagent_messages",
			subagentId: selector.subagentId,
			sessionFile: selector.sessionFile,
			fromByte: selector.fromByte,
		});
		return this.#getData<RpcSubagentMessagesResult>(response);
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.#send({ type: "set_model", provider, modelId });
		return this.#getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel | undefined;
		isScoped: boolean;
	} | null> {
		const response = await this.#send({ type: "cycle_model" });
		return this.#getData(response);
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.#send({ type: "get_available_models" });
		return this.#getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * Get list of available slash commands.
	 */
	async getAvailableCommands(): Promise<RpcAvailableSlashCommand[]> {
		const response = await this.#send({ type: "get_available_commands" });
		return this.#getData<{ commands: RpcAvailableSlashCommand[] }>(response).commands;
	}

	/** Replace the session's current todo phases. */
	async setTodos(phases: TodoPhase[]): Promise<TodoPhase[]> {
		const response = await this.#send({ type: "set_todos", phases });
		return this.#getData<{ todoPhases: TodoPhase[] }>(response).todoPhases;
	}

	async setActiveTools(toolNames: string[]): Promise<{ activeToolNames: string[]; mountedToolNames: string[] }> {
		const response = await this.#send({ type: "set_active_tools", toolNames });
		return this.#getData(response);
	}

	async setActiveToolPresentation(
		toolNames: string[],
		mountedToolNames: string[],
	): Promise<{ activeToolNames: string[]; mountedToolNames: string[] }> {
		const response = await this.#send({ type: "set_active_tool_presentation", toolNames, mountedToolNames });
		return this.#getData(response);
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ConfiguredThinkingLevel): Promise<void> {
		await this.#send({ type: "set_thinking_level", level });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ConfiguredThinkingLevel } | null> {
		const response = await this.#send({ type: "cycle_thinking_level" });
		return this.#getData(response);
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_follow_up_mode", mode });
	}

	/** Set whether interruption applies immediately or waits for a safe boundary. */
	async setInterruptMode(mode: "immediate" | "wait"): Promise<void> {
		await this.#send({ type: "set_interrupt_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.#send({ type: "compact", customInstructions });
		return this.#getData(response);
	}

	/** Run automatic compaction triggered by an idle session. */
	async runIdleCompaction(): Promise<void> {
		await this.#send({ type: "run_idle_compaction" });
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.#send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.#send({ type: "bash", command });
		return this.#getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.#send({ type: "abort_bash" });
	}

	/** Create a manual workspace checkpoint. */
	async createWorkspaceCheckpoint(
		request: RpcWorkspaceCheckpointCreateRequest = {},
	): Promise<WorkspaceCheckpointRecord> {
		const response = await this.#send({ type: "workspace_checkpoint_create", request });
		return this.#getData<{ record: WorkspaceCheckpointRecord }>(response).record;
	}

	/** List workspace checkpoints visible to the active session. */
	async listWorkspaceCheckpoints(
		request: RpcWorkspaceCheckpointListRequest = {},
	): Promise<WorkspaceCheckpointRecord[]> {
		const response = await this.#send({ type: "workspace_checkpoint_list", ...request });
		return this.#getData<{ records: WorkspaceCheckpointRecord[] }>(response).records;
	}

	/** Build a workspace restore plan without applying it. */
	async previewWorkspaceRestore(request: RpcWorkspaceRestorePreviewRequest): Promise<WorkspaceRestorePlan> {
		const response = await this.#send({ type: "workspace_restore_preview", request });
		return this.#getData<{ plan: WorkspaceRestorePlan }>(response).plan;
	}

	/** Apply a previously previewed workspace restore plan. */
	async applyWorkspaceRestore(request: ApplyWorkspaceRestoreRequest): Promise<WorkspaceRestoreResult> {
		const response = await this.#send({ type: "workspace_restore_apply", request });
		return this.#getData<{ result: WorkspaceRestoreResult }>(response).result;
	}

	/** Undo the latest workspace restore in the selected scope. */
	async undoWorkspace(scope?: WorkspaceRestoreScope): Promise<WorkspaceRestoreResult> {
		const response = await this.#send({ type: "workspace_undo", scope });
		return this.#getData<{ result: WorkspaceRestoreResult }>(response).result;
	}

	/** Redo the workspace restore that was most recently undone. */
	async redoWorkspace(): Promise<WorkspaceRestoreResult> {
		const response = await this.#send({ type: "workspace_redo" });
		return this.#getData<{ result: WorkspaceRestoreResult }>(response).result;
	}

	/** Cancel session-owned background work and return the number of running jobs signalled. */
	async cancelAsyncJobs(): Promise<number> {
		const response = await this.#send({ type: "cancel_async_jobs" });
		return this.#getData<{ cancelled: number }>(response).cancelled;
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.#send({ type: "get_session_stats" });
		return this.#getData(response);
	}

	/** Set the current session's display name. */
	async setSessionName(name: string): Promise<void> {
		await this.#send({ type: "set_session_name", name });
	}

	/** Ask the agent process to generate a title when this is the first eligible user message. */
	async maybeStartTitleGeneration(firstMessage: string): Promise<void> {
		await this.#send({ type: "maybe_start_title_generation", firstMessage });
	}

	/**
	 * Hand off session context to a new session.
	 */
	async handoff(customInstructions?: string): Promise<RpcHandoffResult | null> {
		const response = await this.#send({ type: "handoff", customInstructions });
		return this.#getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.#send({ type: "export_html", outputPath });
		return this.#getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "switch_session", sessionPath });
		return this.#getData(response);
	}

	/**
	 * Branch from a specific message.
	 * @returns Selected user text and image attachments, plus cancellation status.
	 */
	async branch(entryId: string): Promise<{ text: string; images: ImageContent[]; cancelled: boolean }> {
		const response = await this.#send({ type: "branch", entryId });
		return this.#getData(response);
	}

	/** Navigate the active session tree and return the foreground editor state. */
	async navigateTree(entryId: string, options?: RpcNavigateTreeOptions): Promise<RpcNavigateTreeResult> {
		const response = await this.#send({ type: "navigate_tree", entryId, ...(options ? { options } : {}) });
		return this.#getData(response);
	}

	/** Cancel in-progress tree branch summarization. */
	async abortBranchSummary(): Promise<void> {
		await this.#send({ type: "abort_branch_summary" });
	}

	/** Resume the child agent after a committed tree ask re-answer. */
	async resumeAfterAskReanswer(): Promise<void> {
		await this.#send({ type: "resume_after_ask_reanswer" });
	}

	/**
	 * Get messages available for branching.
	 */
	async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.#send({ type: "get_branch_messages" });
		return this.#getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.#send({ type: "get_last_assistant_text" });
		return this.#getData<{ text: string | null }>(response).text;
	}

	/**
	 * Get one stable, byte-bounded message page.
	 */
	async getMessagesPage(options: RpcMessagesPageOptions = {}): Promise<RpcMessagesPage> {
		const response = await this.#send({ type: "get_messages_page", ...options });
		return this.#getData<RpcMessagesPage>(response);
	}

	/** Get all messages, draining stable pages when protocol v2 is available. */
	async getMessages(): Promise<AgentMessage[]> {
		if (this.#protocolVersion === 2) {
			try {
				const messages: AgentMessage[] = [];
				const seenCursors = new Set<string>();
				let totalMessages: number | undefined;
				let cursor: string | undefined;
				do {
					const page = await this.getMessagesPage({ cursor, limit: 256 });
					if (
						!Number.isSafeInteger(page.totalMessages) ||
						page.totalMessages < 0 ||
						(totalMessages !== undefined && page.totalMessages !== totalMessages)
					)
						throw new Error("RPC message pagination returned an inconsistent total");
					totalMessages = page.totalMessages;
					messages.push(...page.messages);
					cursor = page.nextCursor;
					if (cursor && seenCursors.has(cursor)) throw new Error("RPC message pagination repeated a cursor");
					if (cursor) seenCursors.add(cursor);
				} while (cursor);
				if (messages.length !== totalMessages)
					throw new Error("RPC message pagination ended before the advertised total");
				return messages;
			} catch (error) {
				if (!isPageFallbackError(error)) throw error;
			}
		}
		const response = await this.#send({ type: "get_messages" });
		return this.#getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * Get list of OAuth providers available for login, with their current authentication status.
	 */
	async getLoginProviders(): Promise<Array<{ id: string; name: string; available: boolean; authenticated: boolean }>> {
		const response = await this.#send({ type: "get_login_providers" });
		return this.#getData<{
			providers: Array<{ id: string; name: string; available: boolean; authenticated: boolean }>;
		}>(response).providers;
	}

	/**
	 * Trigger OAuth login for the given provider.
	 * The server will emit an `open_url` extension_ui_request for the auth URL.
	 * Providers that require pasted-code completion may then emit an `input`
	 * extension_ui_request; pass `onManualCodeInput` to satisfy it.
	 * Resolves when login completes or rejects on failure.
	 *
	 * @param onOpenUrl Called when the server emits the auth URL. The host must
	 *   open `url` in a browser. When the flow's callback server hosts a
	 *   `/launch` redirect, `launchUrl` is a short loopback URL that 302s to
	 *   `url` — hosts SHOULD surface it as the truncation-safe copy target so
	 *   terminal viewport clipping cannot corrupt trailing OAuth query
	 *   parameters (e.g. `code_challenge_method=S256`).
	 */
	async login(
		providerId: string,
		options?: {
			onOpenUrl?: (url: string, instructions?: string, launchUrl?: string) => void;
			onManualCodeInput?: (prompt: { title: string; placeholder?: string }) => string | Promise<string>;
		},
	): Promise<{ providerId: string }> {
		const { onManualCodeInput, onOpenUrl } = options ?? {};
		const listener =
			onOpenUrl || onManualCodeInput
				? (req: RpcExtensionUIRequest) => {
						if (req.method === "open_url") {
							onOpenUrl?.(req.url, req.instructions, req.launchUrl);
							return;
						}
						if (req.method !== "input" || !onManualCodeInput) return;
						void Promise.resolve(onManualCodeInput({ title: req.title, placeholder: req.placeholder }))
							.then(value => {
								this.#writeFrame({
									type: "extension_ui_response",
									id: req.id,
									value,
								});
							})
							.catch(() => {
								this.#writeFrame({
									type: "extension_ui_response",
									id: req.id,
									cancelled: true,
								});
							});
					}
				: undefined;
		if (listener) this.#extensionUiListeners.add(listener);
		try {
			const response = await this.#send({ type: "login", providerId }, 600_000);
			return this.#getData<{ providerId: string }>(response);
		} finally {
			if (listener) this.#extensionUiListeners.delete(listener);
		}
	}

	/**
	 * Replace the host-owned custom tools exposed to the RPC session.
	 * Changes take effect before the next model call.
	 */
	async setCustomTools(tools: RpcClientCustomTool[]): Promise<string[]> {
		this.#customTools = [...tools];
		if (!this.#activeTransport) {
			return this.#customTools.map(tool => tool.name);
		}
		const definitions: RpcHostToolDefinition[] = this.#customTools.map(tool => ({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			hidden: tool.hidden,
			loadMode: tool.loadMode,
		}));
		const response = await this.#send({ type: "set_host_tools", tools: definitions });
		return this.#getData<{ toolNames: string[] }>(response).toolNames;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_end event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let settled = false;
		const unsubscribe = this.onEvent(event => {
			if (event.type === "agent_end") {
				settled = true;
				unsubscribe();
				clearTimeout(timeoutId);
				resolve();
			}
		});

		const timeoutId = this.#startTimeout(timeout, () => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.#transport.getStderr()}`));
		});
		return promise;
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<AgentEvent[]> {
		const { promise, resolve, reject } = Promise.withResolvers<AgentEvent[]>();
		const events: AgentEvent[] = [];
		let settled = false;
		const unsubscribe = this.onEvent(event => {
			events.push(event);
			if (event.type === "agent_end") {
				settled = true;
				unsubscribe();
				clearTimeout(timeoutId);
				resolve(events);
			}
		});

		const timeoutId = this.#startTimeout(timeout, () => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(new Error(`Timeout collecting events. Stderr: ${this.#transport.getStderr()}`));
		});
		return promise;
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	// =========================================================================
	// Internal
	// =========================================================================

	#handleLine(data: unknown): void {
		// Check if it's a response to a pending request
		if (isRpcResponse(data)) {
			const id = data.id;
			if (id && this.#pendingRequests.has(id)) {
				const pending = this.#pendingRequests.get(id)!;
				this.#pendingRequests.delete(id);
				pending.resolve(data);
				return;
			}
		}

		if (isRpcHostToolCallRequest(data)) {
			void this.#handleHostToolCall(data);
			return;
		}

		if (isRpcExtensionUiRequest(data)) {
			if (this.#extensionUiListeners.size === 0) {
				this.#pendingExtensionUiRequests.push(data);
				return;
			}
			for (const listener of this.#extensionUiListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcHostToolCancelRequest(data)) {
			this.#pendingHostToolCalls.get(data.targetId)?.controller.abort();
			return;
		}

		if (isRpcSubagentLifecycleFrame(data)) {
			for (const listener of this.#subagentLifecycleListeners) {
				listener(data.payload);
			}
			return;
		}

		if (isRpcSubagentProgressFrame(data)) {
			for (const listener of this.#subagentProgressListeners) {
				listener(data.payload);
			}
			return;
		}

		if (isRpcSubagentEventFrame(data)) {
			for (const listener of this.#subagentEventListeners) {
				listener(data.payload);
			}
			return;
		}

		if (isRpcAvailableCommandsUpdateFrame(data)) {
			for (const listener of this.#availableCommandsUpdateListeners) {
				listener(data.commands);
			}
			return;
		}

		if (!isAgentSessionEvent(data)) return;

		for (const listener of this.#sessionEventListeners) {
			listener(data);
		}

		if (!isAgentEvent(data)) return;

		for (const listener of this.#eventListeners) {
			listener(data);
		}
	}

	#send(command: RpcCommandBody, timeoutMs = 30_000): Promise<RpcResponse> {
		if (!this.#activeTransport) {
			throw new Error("Client not started");
		}

		const id = `req_${++this.#requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
		let settled = false;
		const timeoutId = this.#startTimeout(timeoutMs, () => {
			if (settled) return;
			this.#pendingRequests.delete(id);
			settled = true;
			reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.#transport.getStderr()}`));
		});

		this.#pendingRequests.set(id, {
			resolve: response => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				resolve(response);
			},
			reject: error => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				reject(error);
			},
		});

		this.#writeFrame(fullCommand, err => {
			this.#pendingRequests.delete(id);
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			reject(err);
		});
		return promise;
	}

	async #handleHostToolCall(request: RpcHostToolCallRequest): Promise<void> {
		const tool = this.#customTools.find(candidate => candidate.name === request.toolName);
		if (!tool) {
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: {
					content: [{ type: "text", text: `Host tool "${request.toolName}" is not registered` }],
					details: {},
				},
				isError: true,
			} satisfies RpcHostToolResult);
			return;
		}

		const controller = new AbortController();
		this.#pendingHostToolCalls.set(request.id, { controller });

		const sendUpdate = (partialResult: RpcClientToolResult<unknown>): void => {
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_update",
				id: request.id,
				partialResult: normalizeToolResult(partialResult),
			} satisfies RpcHostToolUpdate);
		};

		try {
			const result = await tool.execute(request.arguments, {
				toolCallId: request.toolCallId,
				signal: controller.signal,
				sendUpdate,
			});
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: normalizeToolResult(result),
			} satisfies RpcHostToolResult);
		} catch (error) {
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: {},
				},
				isError: true,
			} satisfies RpcHostToolResult);
		} finally {
			this.#pendingHostToolCalls.delete(request.id);
		}
	}

	#writeFrame(
		frame: RpcCommand | RpcExtensionUIResponse | RpcHostToolResult | RpcHostToolUpdate,
		onError?: (error: Error) => void,
	): void {
		const transport = this.#activeTransport;
		if (!transport) {
			throw new Error("Client not started");
		}

		try {
			const writeResult = transport.write(frame);
			if (isPromise(writeResult)) {
				void writeResult.catch((cause: unknown) => {
					const error = cause instanceof Error ? cause : new Error(String(cause));
					onError?.(error);
				});
			}
		} catch (cause) {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			if (onError) {
				onError(error);
				return;
			}
			throw error;
		}
	}

	#getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new RpcCommandError(errorResponse.error, errorResponse.command, errorResponse.code);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
