import { logger } from "@oh-my-pi/pi-utils";
import { getModelMatchPreferences, resolveModelFromString } from "../config/model-resolver";
import type { RpcCommand, RpcExtensionUIResponse } from "../modes/rpc/rpc-types";
import { LocalInteractiveSessionPort } from "../modes/session-port/local-session-port";
import type { InteractiveSessionPort } from "../modes/session-port/port";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import { SessionManager } from "../session/session-manager";
import type {
	OmpDaemonCommand,
	OmpDaemonEvent,
	OmpDaemonEventCursor,
	OmpDaemonResponse,
	OmpSessionSnapshot,
	OmpSessionSummary,
} from "./protocol";
import { boundOmpSessionSnapshot, encodeOmpDaemonRecord, OmpDaemonJsonlDecoder } from "./protocol";
import { DaemonRecoveryManager } from "./recovery";

/** Marks a subprocess as a daemon session worker rather than an interactive CLI. */
export const OMP_DAEMON_WORKER_ROLE_ENV = "OMP_DAEMON_WORKER_ROLE";
export const OMP_DAEMON_WORKER_TOKEN_ENV = "OMP_DAEMON_WORKER_TOKEN";
export const OMP_DAEMON_WORKER_ACTIVE_SESSION_ID_ENV = "OMP_DAEMON_WORKER_ACTIVE_SESSION_ID";
export const OMP_DAEMON_WORKER_SUPERVISOR_SOCKET_ENV = "OMP_DAEMON_WORKER_SUPERVISOR_SOCKET";
export const OMP_DAEMON_WORKER_AGENT_DIR_ENV = "OMP_DAEMON_WORKER_AGENT_DIR";
export const OMP_DAEMON_WORKER_SESSION_PATH_ENV = "OMP_DAEMON_WORKER_SESSION_PATH";
export const OMP_DAEMON_WORKER_CWD_ENV = "OMP_DAEMON_WORKER_CWD";
export const OMP_DAEMON_WORKER_RECOVERY_JOURNAL_ENV = "OMP_DAEMON_WORKER_RECOVERY_JOURNAL";
export const OMP_DAEMON_WORKER_RECOVER_ENV = "OMP_DAEMON_WORKER_RECOVER";

const WORKER_REQUEST_TIMEOUT_MS = 5_000;

export interface OmpDaemonWorkerStartOptions {
	agentDir: string;
	supervisorSocket: string;
	token: string;
	activeSessionId: string;
	/** Session working directory; the worker chdirs here before opening the session. */
	cwd: string;
	sessionPath?: string;
	recoveryJournalPath?: string;
	recover?: boolean;
}

/** Supervisor-only commands, kept separate from the public daemon protocol. */
export type OmpDaemonWorkerCommand =
	| OmpDaemonCommand
	| { id?: string; type: "worker_subscribe"; activeSessionId: string }
	| { id?: string; type: "worker_unsubscribe"; activeSessionId: string }
	| { id?: string; type: "worker_snapshot"; resumeCursor?: OmpDaemonEventCursor }
	| { id?: string; type: "worker_projection_snapshot"; activeSessionId: string }
	| { id?: string; type: "worker_ui_owner_acquire"; activeSessionId: string; ownerEpoch: number }
	| { id?: string; type: "worker_ui_owner_release"; activeSessionId: string; ownerEpoch: number }
	| { id?: string; type: "worker_deliver_message"; message: string; sender?: string }
	| { id?: string; type: "worker_archive_and_shutdown" };

/** First record written by a worker. The secret never crosses a client connection. */
export interface OmpDaemonWorkerAuthentication {
	id: string;
	type: "worker_auth";
	token: string;
	activeSessionId: string;
}

/** Emitted only after the worker has authenticated and constructed its session. */
export interface OmpDaemonWorkerReady {
	type: "worker_ready";
	activeSessionId: string;
	summary: OmpSessionSummary;
}

export type OmpDaemonWorkerWireMessage =
	| OmpDaemonWorkerCommand
	| OmpDaemonWorkerAuthentication
	| OmpDaemonWorkerReady
	| OmpDaemonEvent
	| OmpDaemonResponse;

interface WorkerRuntime {
	session: AgentSession;
	sessionManager: SessionManager;
	port: InteractiveSessionPort;
	unsubscribe: () => void;
	unsubscribeProjection: () => void;
}

interface InFlightPrompt {
	id: string | undefined;
	cancelRequested: boolean;
}

interface PendingResponse {
	resolve: (response: OmpDaemonResponse) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOptionalId(value: Record<string, unknown>): value is Record<string, unknown> & { id?: string } {
	return value.id === undefined || typeof value.id === "string";
}

function hasString(value: Record<string, unknown>, key: string): boolean {
	return typeof value[key] === "string";
}

function isCursor(value: unknown): value is OmpDaemonEventCursor {
	return isRecord(value) && typeof value.generation === "string" && typeof value.sequence === "number";
}

function isOwnerEpoch(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRpcCommandPayload(value: unknown): value is RpcCommand {
	return isRecord(value) && hasString(value, "type") && hasOptionalId(value);
}

function isRpcExtensionUiResponse(value: unknown): value is RpcExtensionUIResponse {
	if (!isRecord(value) || value.type !== "extension_ui_response" || typeof value.id !== "string") return false;
	if (typeof value.value === "string" || typeof value.confirmed === "boolean") return true;
	return value.cancelled === true && (value.timedOut === undefined || typeof value.timedOut === "boolean");
}

/** Validates public client commands before a supervisor or worker acts on them. */
export function isOmpDaemonCommand(value: unknown): value is OmpDaemonCommand {
	if (!isRecord(value) || !hasString(value, "type") || !hasOptionalId(value)) return false;

	switch (value.type) {
		case "hello":
			return value.capabilities === undefined || Array.isArray(value.capabilities);
		case "create":
			return hasString(value, "cwd") && (value.sessionPath === undefined || typeof value.sessionPath === "string");
		case "attach":
			return (
				(value.activeSessionId === undefined || typeof value.activeSessionId === "string") &&
				(value.resumeCursor === undefined || isCursor(value.resumeCursor))
			);
		case "detach":
		case "heartbeat_clear":
		case "heartbeat_status":
		case "cron_list":
		case "list_sessions":
		case "shutdown":
			return true;
		case "cancel":
			return value.activeSessionId === undefined || typeof value.activeSessionId === "string";
		case "prompt":
			return hasString(value, "message") && (value.images === undefined || Array.isArray(value.images));
		case "steer":
		case "set_model":
			return hasString(value, value.type === "steer" ? "message" : "model");
		case "heartbeat_set":
			return hasString(value, "prompt") && hasString(value, "interval");
		case "cron_add":
			return hasString(value, "schedule") && hasString(value, "prompt");
		case "cron_cancel":
			return hasString(value, "jobId");
		case "agent_message_send":
			return hasString(value, "target") && hasString(value, "message");
		case "stop_session":
			return hasString(value, "activeSessionId");
		case "session_command":
			return hasString(value, "activeSessionId") && isRpcCommandPayload(value.payload);
		case "ui_owner_acquire":
		case "ui_owner_release":
			return hasString(value, "activeSessionId");
		case "extension_ui_response":
			return (
				hasString(value, "activeSessionId") &&
				isOwnerEpoch(value.ownerEpoch) &&
				isRpcExtensionUiResponse(value.payload)
			);
		default:
			return false;
	}
}

export function isOmpDaemonResponse(value: unknown): value is OmpDaemonResponse {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.ok !== "boolean") return false;
	return value.ok ? true : typeof value.error === "string";
}

export function isOmpDaemonWorkerAuthentication(value: unknown): value is OmpDaemonWorkerAuthentication {
	return (
		isRecord(value) &&
		value.type === "worker_auth" &&
		typeof value.id === "string" &&
		typeof value.token === "string" &&
		typeof value.activeSessionId === "string"
	);
}

export function isOmpDaemonWorkerReady(value: unknown): value is OmpDaemonWorkerReady {
	return (
		isRecord(value) &&
		value.type === "worker_ready" &&
		typeof value.activeSessionId === "string" &&
		isRecord(value.summary) &&
		typeof value.summary.activeSessionId === "string"
	);
}

export function isOmpDaemonWorkerCommand(value: unknown): value is OmpDaemonWorkerCommand {
	if (isOmpDaemonCommand(value)) return true;
	if (!isRecord(value) || !hasString(value, "type") || !hasOptionalId(value)) return false;

	switch (value.type) {
		case "worker_subscribe":
		case "worker_unsubscribe":
			return hasString(value, "activeSessionId");
		case "worker_snapshot":
			return value.resumeCursor === undefined || isCursor(value.resumeCursor);
		case "worker_deliver_message":
			return hasString(value, "message") && (value.sender === undefined || typeof value.sender === "string");
		case "worker_projection_snapshot":
			return hasString(value, "activeSessionId");
		case "worker_ui_owner_acquire":
		case "worker_ui_owner_release":
			return hasString(value, "activeSessionId") && isOwnerEpoch(value.ownerEpoch);
		case "worker_archive_and_shutdown":
			return true;
		default:
			return false;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function modelName(session: AgentSession): string | undefined {
	const model = session.model;
	return model ? `${model.provider}/${model.id}` : undefined;
}

function thinkingLevelName(session: AgentSession): string | undefined {
	const level = session.thinkingLevel;
	return level === undefined ? undefined : String(level);
}

/**
 * Per-session worker process. It intentionally owns no AgentSession implementation:
 * the existing SDK factory builds the normal session stack and this class only bridges
 * its commands and events over the supervisor socket.
 */
export class OmpDaemonWorker {
	readonly #options: OmpDaemonWorkerStartOptions;
	readonly #pending = new Map<string, PendingResponse>();
	readonly #recoveryManager: DaemonRecoveryManager | undefined;
	#socket: Bun.Socket<undefined> | undefined;
	#runtime: WorkerRuntime | undefined;
	#decoder = new OmpDaemonJsonlDecoder();
	#queue: Promise<void> = Promise.resolve();
	#requestSequence = 0;
	#stopping = false;
	/** The prompt turn currently owning the exclusive turn slot, if any. */
	#turnInFlight: InFlightPrompt | undefined;
	/** Settle promises of background turns (prompt/steer/agent message) for archive draining. */
	#backgroundTurns = new Set<Promise<void>>();
	/** Last supervisor-issued UI owner epoch; stale extension responses must never cross this fence. */
	#uiOwnerEpoch = 0;

	constructor(options: OmpDaemonWorkerStartOptions) {
		this.#options = options;
		this.#recoveryManager = options.recoveryJournalPath
			? new DaemonRecoveryManager({
					journalPath: options.recoveryJournalPath,
					// createAgentSession already owns this runtime; recovery only awaits and
					// retains that same instance instead of creating a duplicate dispatcher.
					createCronRuntime: session => session.getScheduleRuntime(),
				})
			: undefined;
	}

	static async start(options: OmpDaemonWorkerStartOptions): Promise<void> {
		const worker = new OmpDaemonWorker(options);
		await worker.start();
	}

	async start(): Promise<void> {
		await this.#connect();
		const authentication = await this.#authenticate();
		if (!authentication.ok) throw new Error(authentication.error);

		await this.#createRuntime();
		this.#write({
			type: "worker_ready",
			activeSessionId: this.#options.activeSessionId,
			summary: this.#summary(),
		});
	}

	async stop(): Promise<void> {
		if (this.#stopping) return;
		this.#stopping = true;
		await this.#disposeRuntime();
		this.#rejectPending(new Error("Daemon worker stopped"));
		this.#socket?.end();
		this.#socket = undefined;
	}

	async #connect(): Promise<void> {
		await Bun.connect({
			unix: this.#options.supervisorSocket,
			socket: {
				open: socket => {
					this.#socket = socket;
				},
				data: (_socket, data) => this.#enqueueData(data),
				close: () => {
					void this.#handleTransportClosed("Supervisor socket closed");
				},
				error: (_socket, error) => {
					void this.#handleTransportClosed(error.message);
				},
				connectError: (_socket, error) => {
					void this.#handleTransportClosed(error.message);
				},
			},
		});
		if (!this.#socket) throw new Error("Connected daemon worker socket was not opened");
	}

	async #authenticate(): Promise<OmpDaemonResponse> {
		const id = this.#nextRequestId("auth");
		return await this.#request({
			id,
			type: "worker_auth",
			token: this.#options.token,
			activeSessionId: this.#options.activeSessionId,
		});
	}

	async #createRuntime(): Promise<void> {
		const cwd = this.#options.cwd;
		let session: AgentSession;
		let sessionManager: SessionManager;
		if (this.#options.recover) {
			const sessionPath = this.#options.sessionPath;
			const recoveryManager = this.#recoveryManager;
			if (!sessionPath || !recoveryManager) {
				throw new Error("Daemon worker recovery requires a persisted session and recovery journal");
			}
			session = await recoveryManager.recoverSession(sessionPath, {
				activeSessionId: this.#options.activeSessionId,
				cwd,
				createOptions: { agentDir: this.#options.agentDir, hasUI: false },
			});
			const recovered = recoveryManager.getRecoveredSession(this.#options.activeSessionId);
			if (!recovered) {
				await session.dispose();
				throw new Error(`Daemon recovery did not retain session ${this.#options.activeSessionId}`);
			}
			sessionManager = recovered.sessionManager;
		} else {
			sessionManager = this.#options.sessionPath
				? await SessionManager.open(this.#options.sessionPath, undefined, undefined, { initialCwd: cwd })
				: SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, this.#options.agentDir));
			({ session } = await createAgentSession({
				cwd: sessionManager.getCwd(),
				agentDir: this.#options.agentDir,
				sessionManager,
				hasUI: false,
			}));
			await this.#writeRecoveryEntry("create", sessionManager);
		}
		const unsubscribe = session.subscribe(event => this.#forwardSessionEvent(event));
		const port = new LocalInteractiveSessionPort(session);
		const unsubscribeReliable = port.onReliable(frame => {
			this.#write({ type: "reliable", activeSessionId: this.#options.activeSessionId, frame });
		});
		const unsubscribeView = port.onView(frame => {
			this.#write({ type: "view", activeSessionId: this.#options.activeSessionId, frame });
		});
		this.#runtime = {
			session,
			sessionManager,
			port,
			unsubscribe,
			unsubscribeProjection: () => {
				unsubscribeReliable();
				unsubscribeView();
			},
		};
		await this.#writeRecoveryEntry("ready", sessionManager);
	}

	#enqueueData(chunk: Uint8Array): void {
		let lines: string[];
		try {
			lines = this.#decoder.push(chunk);
		} catch (error) {
			void this.#handleTransportClosed(errorMessage(error));
			this.#socket?.terminate();
			return;
		}
		for (const line of lines) {
			if (!line.trim()) continue;
			this.#queue = this.#queue.then(
				() => this.#handleLine(line),
				() => this.#handleLine(line),
			);
		}
	}

	async #handleLine(line: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.#write({ type: "error", message: "Invalid JSONL record from daemon supervisor" });
			return;
		}

		if (isOmpDaemonResponse(parsed)) {
			const pending = this.#pending.get(parsed.id);
			if (!pending) return;
			clearTimeout(pending.timeout);
			this.#pending.delete(parsed.id);
			pending.resolve(parsed);
			return;
		}
		if (!isOmpDaemonWorkerCommand(parsed)) {
			this.#write({ type: "error", message: "Invalid daemon worker command" });
			return;
		}
		await this.#dispatch(parsed);
	}

	async #dispatch(command: OmpDaemonWorkerCommand): Promise<void> {
		try {
			switch (command.type) {
				case "worker_subscribe":
					this.#assertActiveSession(command.activeSessionId);
					this.#respond(command.id, true, this.#summary());
					return;
				case "worker_unsubscribe":
					this.#assertActiveSession(command.activeSessionId);
					this.#respond(command.id, true);
					return;
				case "worker_snapshot":
					this.#respond(command.id, true, this.#snapshot());
					return;
				case "worker_projection_snapshot": {
					this.#assertActiveSession(command.activeSessionId);
					const snapshot = await this.#runtimeOrThrow().port.requestSnapshot();
					this.#respond(command.id, true, snapshot);
					return;
				}
				case "worker_ui_owner_acquire":
					this.#assertActiveSession(command.activeSessionId);
					if (command.ownerEpoch <= this.#uiOwnerEpoch) {
						throw new Error(`Stale UI owner epoch: ${command.ownerEpoch}`);
					}
					this.#uiOwnerEpoch = command.ownerEpoch;
					this.#respond(command.id, true, { ownerEpoch: this.#uiOwnerEpoch });
					return;
				case "worker_ui_owner_release":
					this.#assertActiveSession(command.activeSessionId);
					if (command.ownerEpoch <= this.#uiOwnerEpoch) {
						throw new Error(`Stale UI owner epoch: ${command.ownerEpoch}`);
					}
					this.#uiOwnerEpoch = command.ownerEpoch;
					this.#respond(command.id, true, { ownerEpoch: this.#uiOwnerEpoch });
					return;
				case "worker_deliver_message": {
					const runtime = this.#runtimeOrThrow();
					// Run the triggered turn in the background so a later cancel is
					// never queued behind an open-ended agent message turn.
					void this.#trackTurn(command.id, () =>
						runtime.session.sendCustomMessage(
							{
								customType: "daemon-agent-message",
								content: command.message,
								display: true,
								attribution: "agent",
							},
							{ triggerTurn: true },
						),
					);
					return;
				}
				case "worker_archive_and_shutdown":
					await this.#drainTurns();
					await this.#disposeRuntime();
					this.#respond(command.id, true);
					this.#stopping = true;
					this.#socket?.end();
					return;
				case "create":
					this.#respond(command.id, true, this.#summary());
					return;
				case "prompt": {
					const runtime = this.#runtimeOrThrow();
					if (this.#turnInFlight) {
						this.#respond(command.id, false, undefined, "Daemon worker is already running a turn");
						return;
					}
					// Keep the open-ended turn off the command queue so a cancel
					// arriving mid-turn is processed immediately instead of queued
					// behind the awaited prompt.
					const inFlight: InFlightPrompt = { id: command.id, cancelRequested: false };
					this.#turnInFlight = inFlight;
					void this.#trackTurn(
						command.id,
						async () => {
							await runtime.session.prompt(command.message, {
								...(command.images === undefined ? {} : { images: [...command.images] }),
							});
							try {
								await this.#writeRecoveryEntry("ready", runtime.sessionManager);
							} catch {
								// A journal write failure must not mask a completed turn.
							}
						},
						inFlight,
					);
					return;
				}
				case "cancel": {
					const inFlight = this.#turnInFlight;
					if (inFlight) inFlight.cancelRequested = true;
					await this.#runtimeOrThrow().session.abort();
					this.#respond(command.id, true, { status: inFlight ? "signalled" : "idle" });
					return;
				}
				case "steer": {
					const runtime = this.#runtimeOrThrow();
					// Steer inserts into a running turn; run it in the background so a
					// cancel is never queued behind it.
					void this.#trackTurn(command.id, () => runtime.session.steer(command.message));
					return;
				}
				case "set_model": {
					const session = this.#runtimeOrThrow().session;
					const model = resolveModelFromString(
						command.model,
						session.modelRegistry.getAvailable(),
						getModelMatchPreferences(session.settings),
					);
					if (!model) throw new Error(`Unknown model: ${command.model}`);
					await session.setModel(model);
					this.#respond(command.id, true, { model: modelName(session) });
					return;
				}
				case "session_command": {
					this.#assertActiveSession(command.activeSessionId);
					const response = await this.#runtimeOrThrow().port.dispatch(command.payload);
					this.#respond(command.id, true, response);
					return;
				}
				case "extension_ui_response":
					this.#assertActiveSession(command.activeSessionId);
					if (command.ownerEpoch !== this.#uiOwnerEpoch) {
						this.#respond(command.id, false, undefined, "Stale UI owner epoch");
						return;
					}
					this.#respond(command.id, false, undefined, "interactive session controller unavailable");
					return;
				case "ui_owner_acquire":
				case "ui_owner_release":
					this.#assertActiveSession(command.activeSessionId);
					this.#respond(command.id, false, undefined, "UI owner changes must be routed by daemon supervisor");
					return;
				case "attach":
					this.#respond(command.id, true, this.#snapshot());
					return;
				case "detach":
				case "hello":
				case "list_sessions":
					this.#respond(command.id, true, this.#summary());
					return;
				case "heartbeat_set":
				case "heartbeat_clear":
				case "heartbeat_status":
				case "cron_add":
				case "cron_cancel":
				case "cron_list":
					throw new Error("Daemon scheduler is not configured for this worker");
				case "agent_message_send":
					throw new Error("Agent messages must be routed by the daemon supervisor");
				case "stop_session":
					throw new Error("Session shutdown must be routed by the daemon supervisor");
				case "shutdown":
					await this.#drainTurns();
					await this.#disposeRuntime();
					this.#respond(command.id, true);
					this.#stopping = true;
					this.#socket?.end();
					return;
			}
		} catch (error) {
			this.#respond(command.id, false, undefined, errorMessage(error));
		}
	}

	#assertActiveSession(activeSessionId: string): void {
		if (activeSessionId !== this.#options.activeSessionId) {
			throw new Error(`Unknown active session: ${activeSessionId}`);
		}
	}

	#runtimeOrThrow(): WorkerRuntime {
		if (!this.#runtime) throw new Error("Daemon worker session has not started");
		return this.#runtime;
	}

	#summary(): OmpSessionSummary {
		const runtime = this.#runtimeOrThrow();
		const sessionPath = runtime.sessionManager.getSessionFile();
		return {
			activeSessionId: this.#options.activeSessionId,
			sessionId: runtime.sessionManager.getSessionId(),
			cwd: runtime.sessionManager.getCwd(),
			...(sessionPath === undefined ? {} : { sessionPath }),
			status: runtime.session.isStreaming ? "running" : "ready",
		};
	}

	#snapshot(): OmpSessionSnapshot {
		const session = this.#runtimeOrThrow().session;
		return boundOmpSessionSnapshot({
			messages: session.messages,
			...(modelName(session) === undefined ? {} : { model: modelName(session) }),
			...(thinkingLevelName(session) === undefined ? {} : { thinkingLevel: thinkingLevelName(session) }),
			activeTools: session.getActiveToolNames(),
		});
	}

	#forwardSessionEvent(event: AgentSessionEvent): void {
		this.#write({
			type: "session_event",
			activeSessionId: this.#options.activeSessionId,
			event,
		});
	}

	#respond(id: string | undefined, ok: boolean, data?: unknown, error?: string): void {
		if (!id) return;
		if (ok) {
			this.#write(data === undefined ? { id, ok: true } : { id, ok: true, data });
			return;
		}
		this.#write({ id, ok: false, error: error ?? "Daemon worker command failed" });
	}

	/**
	 * Run a turn command in the background so the command queue stays free for a
	 * cancel to arrive mid-turn. The turn's response is written once it settles,
	 * and the exclusive turn slot (if owned by this command) is released.
	 */
	#trackTurn(id: string | undefined, run: () => Promise<unknown>, inFlightPrompt?: InFlightPrompt): Promise<void> {
		let turn: Promise<void> | undefined;
		const tracked = (async () => {
			try {
				await run();
				if (inFlightPrompt?.cancelRequested) {
					this.#respond(id, false, undefined, "Daemon prompt cancelled");
				} else {
					this.#respond(id, true);
				}
			} catch (error) {
				const message = inFlightPrompt?.cancelRequested ? "Daemon prompt cancelled" : errorMessage(error);
				this.#respond(id, false, undefined, message);
			} finally {
				if (this.#turnInFlight === inFlightPrompt) this.#turnInFlight = undefined;
				if (turn) this.#backgroundTurns.delete(turn);
			}
		})();
		turn = tracked;
		this.#backgroundTurns.add(tracked);
		return tracked;
	}

	/**
	 * Settle any in-flight turn before archive/shutdown disposes the runtime.
	 * Aborts the active prompt (if any), then awaits every tracked background
	 * turn so its final response and recovery journal write complete before the
	 * socket closes — an interrupted turn is never treated as a clean archive.
	 */
	async #drainTurns(): Promise<void> {
		const inFlight = this.#turnInFlight;
		if (inFlight) {
			inFlight.cancelRequested = true;
			try {
				await this.#runtimeOrThrow().session.abort();
			} catch {
				// Best effort; the settle wait below still bounds the archive.
			}
		}
		await Promise.allSettled([...this.#backgroundTurns]);
	}

	async #request(record: OmpDaemonWorkerAuthentication): Promise<OmpDaemonResponse> {
		const { promise: response, resolve, reject } = Promise.withResolvers<OmpDaemonResponse>();
		const timeout = setTimeout(() => {
			this.#pending.delete(record.id);
			reject(new Error(`Timed out waiting for daemon worker ${record.type} response`));
		}, WORKER_REQUEST_TIMEOUT_MS);
		this.#pending.set(record.id, { resolve, reject, timeout });
		if (!this.#write(record)) {
			const pending = this.#pending.get(record.id);
			if (pending) {
				clearTimeout(pending.timeout);
				this.#pending.delete(record.id);
				pending.reject(new Error("Daemon worker socket is unavailable"));
			}
		}
		return await response;
	}

	#nextRequestId(prefix: string): string {
		this.#requestSequence++;
		return `${prefix}:${this.#requestSequence}`;
	}

	#write(record: OmpDaemonWorkerWireMessage): boolean {
		const socket = this.#socket;
		if (!socket) return false;
		const encoded = encodeOmpDaemonRecord(record);
		if (!encoded) {
			this.#reportUnencodableRecord(socket, record);
			return false;
		}
		try {
			return socket.write(encoded) >= 0;
		} catch (error) {
			logger.warn("Daemon worker socket write failed", { error: errorMessage(error) });
			return false;
		}
	}

	#reportUnencodableRecord(socket: Bun.Socket<undefined>, record: OmpDaemonWorkerWireMessage): void {
		const message =
			"Daemon worker refused an outbound JSONL record that exceeds the 1 MiB limit or cannot be encoded";
		const recordType = "type" in record && typeof record.type === "string" ? record.type : "unknown";
		const responseId = "id" in record && typeof record.id === "string" ? record.id : undefined;
		logger.error("Daemon worker outbound JSONL record rejected", { type: recordType, id: responseId });
		const failure = responseId
			? { id: responseId, ok: false as const, error: message }
			: { type: "error" as const, message };
		const encodedFailure = encodeOmpDaemonRecord(failure);
		if (encodedFailure) {
			try {
				socket.write(encodedFailure);
			} catch {
				// The peer has already become unavailable; close the worker below.
			}
		}
		try {
			socket.end();
		} catch {
			try {
				socket.terminate();
			} catch {
				// Closing an already-closed worker transport is safe.
			}
		}
	}

	async #writeRecoveryEntry(event: "create" | "ready", sessionManager: SessionManager): Promise<void> {
		const sessionPath = sessionManager.getSessionFile();
		if (!sessionPath || !this.#recoveryManager) return;
		await this.#recoveryManager.writeRecoveryEntry({
			event,
			activeSessionId: this.#options.activeSessionId,
			sessionId: sessionManager.getSessionId(),
			sessionPath,
			cwd: sessionManager.getCwd(),
		});
	}

	async #disposeRuntime(): Promise<void> {
		const runtime = this.#runtime;
		if (!runtime) return;
		this.#runtime = undefined;
		runtime.unsubscribe();
		runtime.unsubscribeProjection();
		await runtime.port.dispose();
		try {
			await runtime.session.dispose();
		} finally {
			this.#recoveryManager?.disposeRecoveredSession(this.#options.activeSessionId);
		}
	}

	async #handleTransportClosed(message: string): Promise<void> {
		if (this.#stopping) return;
		this.#stopping = true;
		this.#socket = undefined;
		this.#rejectPending(new Error(message));
		await this.#disposeRuntime();
		process.exitCode = 1;
	}

	#rejectPending(error: Error): void {
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timeout);
			this.#pending.delete(id);
			pending.reject(error);
		}
	}
}

function workerOptionsFromEnvironment(environment: NodeJS.ProcessEnv): OmpDaemonWorkerStartOptions {
	const agentDir = environment[OMP_DAEMON_WORKER_AGENT_DIR_ENV];
	const supervisorSocket = environment[OMP_DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
	const token = environment[OMP_DAEMON_WORKER_TOKEN_ENV];
	const activeSessionId = environment[OMP_DAEMON_WORKER_ACTIVE_SESSION_ID_ENV];
	const cwd = environment[OMP_DAEMON_WORKER_CWD_ENV];
	if (!agentDir || !supervisorSocket || !token || !activeSessionId || !cwd) {
		throw new Error("Daemon worker is missing required startup environment");
	}
	const sessionPath = environment[OMP_DAEMON_WORKER_SESSION_PATH_ENV];
	const recoveryJournalPath = environment[OMP_DAEMON_WORKER_RECOVERY_JOURNAL_ENV];
	const recover = environment[OMP_DAEMON_WORKER_RECOVER_ENV] === "1";
	return {
		agentDir,
		supervisorSocket,
		token,
		activeSessionId,
		cwd,
		...(sessionPath === undefined ? {} : { sessionPath }),
		...(recoveryJournalPath === undefined ? {} : { recoveryJournalPath }),
		...(recover ? { recover: true } : {}),
	};
}

/**
 * Worker entrypoint invoked by the CLI worker-host dispatch
 * (`__omp_worker_daemon`) and by the direct-module fallback. Reads its
 * startup identity from the supervisor-injected environment.
 */
export async function startDaemonWorkerFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
	await OmpDaemonWorker.start(workerOptionsFromEnvironment(environment));
}

if (import.meta.main && process.env[OMP_DAEMON_WORKER_ROLE_ENV] === "1") {
	startDaemonWorkerFromEnvironment().catch(error => {
		logger.error("Daemon worker failed", { error: errorMessage(error) });
		process.exitCode = 1;
	});
}
