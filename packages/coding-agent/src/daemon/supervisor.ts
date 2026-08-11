import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveWorkerSpawnCmd, SMOKE_TEST_TIMEOUT_MS } from "../subprocess/worker-client";
import { sendDaemonCommand } from "./client";
import type {
	OmpDaemonCommand,
	OmpDaemonEvent,
	OmpDaemonEventCursor,
	OmpDaemonResponse,
	OmpDaemonServerCapability,
	OmpSessionSnapshot,
	OmpSessionSummary,
} from "./protocol";
import {
	encodeOmpDaemonRecord,
	OMP_DAEMON_PROTOCOL_NAME,
	OMP_DAEMON_PROTOCOL_VERSION,
	OMP_DAEMON_SCHEMA_REVISION,
	OmpDaemonJsonlDecoder,
} from "./protocol";
import { DaemonRecoveryManager } from "./recovery";
import {
	acquireDaemonSocketPathLease,
	cleanupDaemonSocketPath,
	type DaemonSocketIdentity,
	type DaemonSocketPathLease,
	defaultDaemonSocketPath,
	getDaemonSocketIdentity,
	getDaemonSocketStatus,
	prepareDaemonSocketPath,
	restrictDaemonSocketPath,
} from "./socket";
import {
	isOmpDaemonCommand,
	isOmpDaemonResponse,
	isOmpDaemonWorkerAuthentication,
	isOmpDaemonWorkerReady,
	OMP_DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	OMP_DAEMON_WORKER_AGENT_DIR_ENV,
	OMP_DAEMON_WORKER_CWD_ENV,
	OMP_DAEMON_WORKER_RECOVER_ENV,
	OMP_DAEMON_WORKER_RECOVERY_JOURNAL_ENV,
	OMP_DAEMON_WORKER_ROLE_ENV,
	OMP_DAEMON_WORKER_SESSION_PATH_ENV,
	OMP_DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
	OMP_DAEMON_WORKER_TOKEN_ENV,
	type OmpDaemonWorkerAuthentication,
	type OmpDaemonWorkerCommand,
} from "./worker";

/** Worker-host selector registered in cli.ts; the CLI entry dispatches it. */
const DAEMON_WORKER_ARG = "__omp_worker_daemon";
const DAEMON_SUPERVISOR_ARG = "__omp_worker_daemon_supervisor";
const WORKER_REQUEST_TIMEOUT_MS = 30_000;
/** Open-ended agent turns (prompt/steer/agent message) can run for minutes; a
 * socket close still fails them fast, so the wall-clock bound is a backstop. */
const WORKER_TURN_TIMEOUT_MS = 60 * 60 * 1000;
const WORKER_START_TIMEOUT_MS = 15_000;
/** How long shutdown waits for a worker to archive gracefully before forcing a kill. */
const WORKER_STOP_GRACE_MS = 2_000;
const MAX_WORKER_RECOVERY_ATTEMPTS = 3;
const MAX_REPLAY_EVENTS = 1024;

const SERVER_CAPABILITIES: readonly OmpDaemonServerCapability[] = [
	"attach_snapshot",
	"event_sequence",
	"agent_messaging",
	"model_catalog",
	"prompt_cancellation",
];

export interface OmpDaemonSupervisorStartOptions {
	agentDir: string;
	socketPath: string;
	/** Optional startup bound for embedding and deterministic integration probes. */
	workerStartTimeoutMs?: number;
	/** Durable recovery journal shared with workers for this daemon identity. */
	recoveryJournalPath?: string;
}

interface ConnectionState {
	id: string;
	socket: Bun.Socket<undefined>;
	decoder: OmpDaemonJsonlDecoder;
	queue: Promise<void>;
	initializingSessionIds: Set<string>;
	attachedSessionIds: Set<string>;
	activeSessionId: string | undefined;
	worker: WorkerRecord | undefined;
	closed: boolean;
}

interface PendingWorkerRequest {
	resolve: (response: OmpDaemonResponse) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
}

interface WorkerReadyGate {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
}

interface BufferedSessionEvent {
	cursor: OmpDaemonEventCursor;
	event: Extract<OmpDaemonEvent, { type: "session_event" }>;
}

interface WorkerRecord {
	activeSessionId: string;
	cwd: string;
	sessionId: string | undefined;
	sessionPath: string | undefined;
	token: string;
	process: Bun.Subprocess | undefined;
	socket: Bun.Socket<undefined> | undefined;
	status: NonNullable<OmpSessionSummary["status"]>;
	pending: Map<string, PendingWorkerRequest>;
	ready: WorkerReadyGate;
	generation: string;
	sequence: number;
	events: BufferedSessionEvent[];
	resident: boolean;
	recoveryAttempts: number;
	recoveryJournaled: boolean;
	recoveryInFlight: boolean;
	stopRequested: boolean;
}

function createReadyGate(): WorkerReadyGate {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	return { promise, resolve, reject: error => reject(error) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isSessionEvent(value: unknown): value is Extract<OmpDaemonEvent, { type: "session_event" }> {
	return (
		isRecord(value) &&
		value.type === "session_event" &&
		typeof value.activeSessionId === "string" &&
		isRecord(value.event)
	);
}

function isDaemonError(value: unknown): value is Extract<OmpDaemonEvent, { type: "error" }> {
	return isRecord(value) && value.type === "error" && typeof value.message === "string";
}

function isSnapshot(value: unknown): value is OmpSessionSnapshot {
	return isRecord(value);
}

function isSessionSummary(value: unknown): value is OmpSessionSummary {
	return (
		isRecord(value) &&
		typeof value.activeSessionId === "string" &&
		(value.sessionId === undefined || typeof value.sessionId === "string") &&
		(value.cwd === undefined || typeof value.cwd === "string") &&
		(value.sessionPath === undefined || typeof value.sessionPath === "string")
	);
}

function responseError(response: OmpDaemonResponse): string | undefined {
	return response.ok ? undefined : response.error;
}

function workerToken(): string {
	return randomBytes(32).toString("base64url");
}

function tokensMatch(expected: string, supplied: string): boolean {
	const expectedBytes = Buffer.from(expected);
	const suppliedBytes = Buffer.from(supplied);
	return expectedBytes.byteLength === suppliedBytes.byteLength && timingSafeEqual(expectedBytes, suppliedBytes);
}

/**
 * The daemon control plane. It owns Unix-socket clients, process-backed workers,
 * lease admission, and all routing; each worker remains the sole owner of its
 * AgentSession created through sdk.ts.
 */
export class OmpDaemonSupervisor {
	readonly #agentDir: string;
	readonly #socketPath: string;
	readonly #workerStartTimeoutMs: number;
	readonly #recoveryJournalPath: string;
	readonly #recoveryManager: DaemonRecoveryManager;
	readonly #connections = new Map<Bun.Socket<undefined>, ConnectionState>();
	readonly #workers = new Map<string, WorkerRecord>();
	readonly #leaseOwners = new Map<string, string>();
	#listener: Bun.UnixSocketListener<undefined> | undefined;
	#socketLease: DaemonSocketPathLease | undefined;
	#socketIdentity: DaemonSocketIdentity | undefined;
	#stopping = false;
	#stopTask: Promise<void> | undefined;
	#workerRequestSequence = 0;

	constructor(options: OmpDaemonSupervisorStartOptions) {
		this.#agentDir = options.agentDir;
		this.#socketPath = options.socketPath;
		this.#workerStartTimeoutMs = options.workerStartTimeoutMs ?? WORKER_START_TIMEOUT_MS;
		this.#recoveryJournalPath = options.recoveryJournalPath ?? path.join(options.agentDir, "daemon-recovery.jsonl");
		this.#recoveryManager = new DaemonRecoveryManager({ journalPath: this.#recoveryJournalPath });
	}

	static async start(options: OmpDaemonSupervisorStartOptions): Promise<void> {
		const supervisor = new OmpDaemonSupervisor(options);
		await supervisor.start();
	}

	async start(): Promise<void> {
		if (this.#listener) return;
		if (this.#stopping) throw new Error("Daemon supervisor has stopped");

		const lease = await acquireDaemonSocketPathLease(this.#socketPath);
		if (!lease) throw new Error(`Daemon socket path is already leased: ${this.#socketPath}`);
		this.#socketLease = lease;
		try {
			await prepareDaemonSocketPath(this.#socketPath, lease);
			this.#listener = Bun.listen({
				unix: this.#socketPath,
				socket: {
					open: socket => this.#openConnection(socket),
					data: (socket, data) => this.#receive(socket, data),
					close: socket => this.#closeConnection(socket),
					error: socket => this.#closeConnection(socket),
				},
			});
			restrictDaemonSocketPath(this.#socketPath);
			this.#socketIdentity = getDaemonSocketIdentity(this.#socketPath);
		} catch (error) {
			this.#listener?.stop(true);
			this.#listener = undefined;
			cleanupDaemonSocketPath(this.#socketPath, this.#socketIdentity, lease);
			await lease.release();
			this.#socketLease = undefined;
			this.#socketIdentity = undefined;
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.#stopTask) return await this.#stopTask;
		this.#stopTask = this.#stop();
		return await this.#stopTask;
	}

	async #stop(): Promise<void> {
		if (this.#stopping) return;
		this.#stopping = true;
		await Promise.all([...this.#workers.values()].map(worker => this.#stopWorker(worker)));
		this.#listener?.stop(true);
		this.#listener = undefined;
		for (const connection of [...this.#connections.values()]) {
			connection.socket.terminate();
		}
		this.#connections.clear();
		const lease = this.#socketLease;
		cleanupDaemonSocketPath(this.#socketPath, this.#socketIdentity, lease);
		this.#socketIdentity = undefined;
		this.#socketLease = undefined;
		await lease?.release();
	}

	#openConnection(socket: Bun.Socket<undefined>): void {
		this.#connections.set(socket, {
			id: randomUUID(),
			socket,
			decoder: new OmpDaemonJsonlDecoder(),
			queue: Promise.resolve(),
			attachedSessionIds: new Set(),
			initializingSessionIds: new Set(),
			activeSessionId: undefined,
			worker: undefined,
			closed: false,
		});
	}

	#receive(socket: Bun.Socket<undefined>, chunk: Uint8Array): void {
		const connection = this.#connections.get(socket);
		if (!connection || connection.closed) return;
		let lines: string[];
		try {
			lines = connection.decoder.push(chunk);
		} catch (error) {
			this.#write(connection, { type: "error", message: errorMessage(error) });
			socket.terminate();
			return;
		}
		for (const line of lines) {
			if (!line.trim()) continue;
			connection.queue = connection.queue.then(
				() => this.#handleLine(connection, line),
				() => this.#handleLine(connection, line),
			);
		}
	}

	async #handleLine(connection: ConnectionState, line: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.#write(connection, { type: "error", message: "Invalid daemon JSONL record" });
			return;
		}

		if (connection.worker) {
			await this.#handleWorkerMessage(connection, parsed);
			return;
		}
		if (isOmpDaemonWorkerAuthentication(parsed)) {
			this.#authenticateWorker(connection, parsed);
			return;
		}
		if (!isOmpDaemonCommand(parsed)) {
			this.#write(connection, { type: "error", message: "Invalid daemon command" });
			return;
		}
		await this.#handleClientCommand(connection, parsed);
	}

	#authenticateWorker(connection: ConnectionState, authentication: OmpDaemonWorkerAuthentication): void {
		const worker = this.#workers.get(authentication.activeSessionId);
		if (!worker || worker.stopRequested || !tokensMatch(worker.token, authentication.token) || worker.socket) {
			this.#writeResponse(connection, authentication.id, false, undefined, "Daemon worker authentication failed");
			connection.socket.terminate();
			return;
		}
		connection.worker = worker;
		worker.socket = connection.socket;
		this.#writeResponse(connection, authentication.id, true);
	}

	async #handleWorkerMessage(connection: ConnectionState, parsed: unknown): Promise<void> {
		const worker = connection.worker;
		if (!worker) return;

		if (isOmpDaemonResponse(parsed)) {
			const pending = worker.pending.get(parsed.id);
			if (!pending) return;
			clearTimeout(pending.timeout);
			worker.pending.delete(parsed.id);
			pending.resolve(parsed);
			return;
		}
		if (isOmpDaemonWorkerReady(parsed)) {
			if (parsed.activeSessionId !== worker.activeSessionId) {
				this.#write(connection, { type: "error", message: "Worker announced an unexpected active session" });
				connection.socket.terminate();
				return;
			}
			worker.sessionId = parsed.summary.sessionId ?? worker.sessionId;
			worker.cwd = parsed.summary.cwd ?? worker.cwd;
			worker.sessionPath = parsed.summary.sessionPath ?? worker.sessionPath;
			worker.status = worker.resident ? "resident" : (parsed.summary.status ?? "ready");
			worker.recoveryJournaled = false;
			worker.ready.resolve();
			return;
		}
		if (isSessionEvent(parsed)) {
			if (parsed.activeSessionId !== worker.activeSessionId) return;
			this.#routeSessionEvent(worker, parsed);
			return;
		}
		if (isDaemonError(parsed)) {
			this.#publishError(worker, parsed.message);
			return;
		}
		this.#write(connection, { type: "error", message: "Invalid daemon worker record" });
	}

	async #handleClientCommand(connection: ConnectionState, command: OmpDaemonCommand): Promise<void> {
		if (connection.closed) return;
		try {
			switch (command.type) {
				case "hello":
					this.#write(connection, {
						type: "daemon_hello",
						capabilities: SERVER_CAPABILITIES,
						name: OMP_DAEMON_PROTOCOL_NAME,
						version: OMP_DAEMON_PROTOCOL_VERSION,
						schemaRevision: OMP_DAEMON_SCHEMA_REVISION,
					});
					this.#writeResponse(connection, command.id, true, { capabilities: SERVER_CAPABILITIES });
					return;
				case "create": {
					const worker = await this.#createWorker(command.cwd, command.sessionPath);
					if (connection.closed) {
						await this.#discardWorker(worker);
						return;
					}
					connection.activeSessionId = worker.activeSessionId;
					connection.attachedSessionIds.add(worker.activeSessionId);
					this.#leaseOwners.set(worker.activeSessionId, connection.id);
					this.#writeResponse(connection, command.id, true, this.#summary(worker));
					return;
				}
				case "attach":
					await this.#attachClient(connection, command.id, command.activeSessionId, command.resumeCursor);
					return;
				case "detach":
					await this.#detachClient(connection, connection.activeSessionId);
					this.#writeResponse(connection, command.id, true);
					return;
				case "list_sessions": {
					const sessions = [...this.#workers.values()].map(worker => this.#summary(worker));
					this.#write(connection, { type: "session_list", sessions });
					this.#writeResponse(connection, command.id, true, sessions);
					return;
				}
				case "stop_session": {
					const worker = this.#workers.get(command.activeSessionId);
					if (!worker) throw new Error(`Unknown active session: ${command.activeSessionId}`);
					await this.#stopWorker(worker);
					this.#writeResponse(connection, command.id, true);
					return;
				}
				case "shutdown":
					this.#writeResponse(connection, command.id, true);
					queueMicrotask(() => void this.stop());
					return;
				case "agent_message_send":
					await this.#routeAgentMessage(connection, command);
					return;
				case "prompt":
				case "steer":
					// Open-ended turns run off the client's queue so a same-connection
					// cancel is never queued behind the awaited turn response.
					void this.#routeSessionTurn(connection, command);
					return;
				case "cancel":
					await this.#routeCancel(connection, command);
					return;
				case "set_model":
					await this.#routeSessionCommand(connection, command);
					return;
				case "heartbeat_set":
				case "heartbeat_clear":
				case "heartbeat_status":
				case "cron_add":
				case "cron_cancel":
				case "cron_list":
					throw new Error("Daemon scheduling is not configured");
			}
		} catch (error) {
			this.#writeResponse(connection, command.id, false, undefined, errorMessage(error));
		}
	}

	async #createWorker(cwd: string, sessionPath: string | undefined): Promise<WorkerRecord> {
		const activeSessionId = randomUUID();
		const worker: WorkerRecord = {
			activeSessionId,
			cwd,
			sessionId: undefined,
			sessionPath,
			token: workerToken(),
			process: undefined,
			socket: undefined,
			status: "starting",
			resident: false,
			pending: new Map(),
			ready: createReadyGate(),
			generation: randomUUID(),
			sequence: 0,
			events: [],
			recoveryAttempts: 0,
			recoveryJournaled: false,
			recoveryInFlight: false,
			stopRequested: false,
		};
		this.#workers.set(activeSessionId, worker);
		try {
			await this.#spawnWorker(worker);
			return worker;
		} catch (error) {
			try {
				await this.#discardWorker(worker);
			} catch {
				// Preserve the startup failure after best-effort worker cleanup.
			}
			throw error;
		}
	}

	async #discardWorker(worker: WorkerRecord): Promise<void> {
		try {
			await this.#stopWorker(worker);
		} finally {
			this.#workers.delete(worker.activeSessionId);
		}
	}

	async #spawnWorker(worker: WorkerRecord): Promise<void> {
		worker.token = workerToken();
		worker.socket = undefined;
		worker.status = worker.recoveryAttempts > 0 ? "recovering" : "starting";
		worker.ready = createReadyGate();
		const environment: NodeJS.ProcessEnv = {
			...process.env,
			[OMP_DAEMON_WORKER_ROLE_ENV]: "1",
			[OMP_DAEMON_WORKER_TOKEN_ENV]: worker.token,
			[OMP_DAEMON_WORKER_ACTIVE_SESSION_ID_ENV]: worker.activeSessionId,
			[OMP_DAEMON_WORKER_SUPERVISOR_SOCKET_ENV]: this.#socketPath,
			[OMP_DAEMON_WORKER_AGENT_DIR_ENV]: this.#agentDir,
			[OMP_DAEMON_WORKER_CWD_ENV]: worker.cwd,
			[OMP_DAEMON_WORKER_RECOVERY_JOURNAL_ENV]: this.#recoveryJournalPath,
		};
		if (worker.sessionPath) environment[OMP_DAEMON_WORKER_SESSION_PATH_ENV] = worker.sessionPath;
		if (worker.recoveryAttempts > 0) {
			if (!worker.sessionPath) {
				throw new Error(`Daemon worker recovery has no persisted session path: ${worker.activeSessionId}`);
			}
			environment[OMP_DAEMON_WORKER_RECOVER_ENV] = "1";
		}

		// Re-enter the CLI host entry (compiled binary, source bundle, or the
		// package cli.ts fallback) so the worker survives compiled-binary
		// builds. The selector is dispatched by cli.ts's worker-host table.
		const { cmd, cwd: hostCwd } = resolveWorkerSpawnCmd(DAEMON_WORKER_ARG);
		const processRef = Bun.spawn(cmd, {
			cwd: hostCwd ?? worker.cwd,
			env: environment,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
		});
		worker.process = processRef;
		processRef.unref();
		void processRef.exited.then(
			exitCode => this.#workerExited(worker, processRef, exitCode),
			error => this.#workerExited(worker, processRef, undefined, errorMessage(error)),
		);
		try {
			await this.#waitForWorkerReady(worker);
		} catch (error) {
			if (worker.process === processRef) {
				worker.process = undefined;
				worker.socket = undefined;
				try {
					processRef.kill("SIGKILL");
					await processRef.exited;
				} catch {
					// The failed worker may already have exited while its startup gate rejected.
				}
			}
			throw error;
		}
	}

	async #waitForWorkerReady(worker: WorkerRecord): Promise<void> {
		const { promise: timedOut, reject: rejectTimedOut } = Promise.withResolvers<never>();
		const handle = setTimeout(
			() => rejectTimedOut(new Error(`Timed out starting daemon worker ${worker.activeSessionId}`)),
			this.#workerStartTimeoutMs,
		);
		try {
			await Promise.race([worker.ready.promise, timedOut]);
		} finally {
			clearTimeout(handle);
		}
	}

	async #workerExited(
		worker: WorkerRecord,
		processRef: Bun.Subprocess,
		exitCode: number | undefined,
		error?: string,
	): Promise<void> {
		if (worker.process !== processRef) return;
		worker.process = undefined;
		worker.socket = undefined;
		this.#rejectPendingWorkerRequests(
			worker,
			new Error(error ?? `Daemon worker exited with code ${exitCode ?? "unknown"}`),
		);
		if (worker.stopRequested || this.#stopping) {
			worker.status = "stopped";
			return;
		}

		worker.status = "failed";
		const failure = error ?? `Daemon worker exited with code ${exitCode ?? "unknown"}`;
		worker.ready.reject(new Error(failure));
		this.#publishError(worker, failure);
		if (worker.recoveryAttempts >= MAX_WORKER_RECOVERY_ATTEMPTS) return;
		if (worker.recoveryInFlight) return;
		worker.recoveryInFlight = true;
		worker.recoveryAttempts++;
		worker.status = "recovering";
		void this.#recoverWorker(worker);
	}

	async #recoverWorker(worker: WorkerRecord): Promise<void> {
		try {
			const recoveryEntries = await this.#recoveryManager.readRecoveryJournal();
			const recoveryEntry = recoveryEntries
				.reverse()
				.find(entry => entry.activeSessionId === worker.activeSessionId && entry.event !== "crashed");
			if (!recoveryEntry) {
				worker.status = "failed";
				this.#publishError(
					worker,
					`Daemon worker recovery has no durable session lineage: ${worker.activeSessionId}`,
				);
				return;
			}
			if (
				(worker.sessionId !== undefined && worker.sessionId !== recoveryEntry.sessionId) ||
				(worker.sessionPath !== undefined && worker.sessionPath !== recoveryEntry.sessionPath)
			) {
				worker.status = "failed";
				this.#publishError(worker, `Daemon worker recovery lineage changed: ${worker.activeSessionId}`);
				return;
			}
			worker.sessionId = recoveryEntry.sessionId;
			worker.sessionPath = recoveryEntry.sessionPath;
			worker.cwd = recoveryEntry.cwd;
			if (!worker.recoveryJournaled) {
				await this.#recoveryManager.writeRecoveryEntry({
					event: "crashed",
					activeSessionId: worker.activeSessionId,
					sessionId: recoveryEntry.sessionId,
					sessionPath: recoveryEntry.sessionPath,
					cwd: recoveryEntry.cwd,
				});
				worker.recoveryJournaled = true;
			}
			for (;;) {
				await Bun.sleep(100 * worker.recoveryAttempts);
				if (this.#stopping || worker.stopRequested || this.#workers.get(worker.activeSessionId) !== worker) return;
				try {
					await this.#spawnWorker(worker);
					return;
				} catch (error) {
					worker.status = "failed";
					this.#publishError(worker, `Daemon worker recovery failed: ${errorMessage(error)}`);
					if (worker.recoveryAttempts >= MAX_WORKER_RECOVERY_ATTEMPTS) return;
					worker.recoveryAttempts++;
					worker.status = "recovering";
				}
			}
		} catch (error) {
			worker.status = "failed";
			this.#publishError(worker, `Daemon worker recovery failed: ${errorMessage(error)}`);
		} finally {
			worker.recoveryInFlight = false;
		}
	}

	async #stopWorker(worker: WorkerRecord): Promise<void> {
		if (worker.stopRequested) return;
		worker.stopRequested = true;
		this.#leaseOwners.delete(worker.activeSessionId);
		const socket = worker.socket;
		if (socket) {
			// Retain the bounded graceful archive window before forcing the detached
			// process down; a resident session can otherwise strand shutdown forever.
			const archive = this.#requestWorker(worker, { type: "worker_archive_and_shutdown" }).catch(() => {});
			await Promise.race([archive, Bun.sleep(WORKER_STOP_GRACE_MS)]);
		}
		this.#rejectPendingWorkerRequests(worker, new Error("Daemon worker stopped"));
		if (worker.socket === socket) worker.socket = undefined;
		try {
			socket?.terminate();
		} catch {
			// The worker can close its own socket after acknowledging archival.
		}
		try {
			worker.process?.kill("SIGKILL");
		} catch {
			// A worker may exit between its response and the forced termination.
		}
		worker.status = "stopped";
	}

	async #attachClient(
		connection: ConnectionState,
		commandId: string | undefined,
		requestedSessionId: string | undefined,
		resumeCursor: OmpDaemonEventCursor | undefined,
	): Promise<void> {
		if (connection.closed) return;
		const worker = this.#findWorkerForAttach(requestedSessionId);
		const wasAttached = connection.attachedSessionIds.has(worker.activeSessionId);
		const hadLease = this.#leaseOwners.get(worker.activeSessionId) === connection.id;
		if (!this.#acquireLease(worker.activeSessionId, connection.id)) {
			throw new Error(`Session ${worker.activeSessionId} is leased by another client`);
		}

		let completed = false;
		try {
			if (connection.closed) return;
			const previousSessionId = connection.activeSessionId;
			if (previousSessionId && previousSessionId !== worker.activeSessionId) {
				await this.#detachClient(connection, previousSessionId);
				if (connection.closed) return;
			}
			connection.activeSessionId = worker.activeSessionId;
			connection.attachedSessionIds.add(worker.activeSessionId);
			connection.initializingSessionIds.add(worker.activeSessionId);
			const subscription = await this.#requestWorker(worker, {
				type: "worker_subscribe",
				activeSessionId: worker.activeSessionId,
			});
			if (connection.closed) return;
			if (!subscription.ok) throw new Error(subscription.error);
			const subscriptionSummary = isSessionSummary(subscription.data) ? subscription.data : undefined;
			if (subscriptionSummary) {
				worker.sessionId = subscriptionSummary.sessionId ?? worker.sessionId;
				worker.cwd = subscriptionSummary.cwd ?? worker.cwd;
				worker.sessionPath = subscriptionSummary.sessionPath ?? worker.sessionPath;
			}
			const snapshotResponse = await this.#requestWorker(worker, {
				type: "worker_snapshot",
				...(resumeCursor === undefined ? {} : { resumeCursor }),
			});
			if (connection.closed) return;
			if (!snapshotResponse.ok) throw new Error(snapshotResponse.error);
			if (!isSnapshot(snapshotResponse.data)) throw new Error("Daemon worker returned an invalid session snapshot");
			worker.resident = false;
			worker.status = subscriptionSummary?.status ?? (worker.status === "resident" ? "ready" : worker.status);

			const cursor = this.#cursor(worker);
			this.#write(connection, {
				type: "snapshot",
				activeSessionId: worker.activeSessionId,
				state: snapshotResponse.data,
				cursor,
			});
			if (resumeCursor?.generation === worker.generation) {
				for (const event of worker.events) {
					if (event.cursor.sequence > resumeCursor.sequence) this.#write(connection, event.event);
				}
			}
			connection.initializingSessionIds.delete(worker.activeSessionId);
			this.#write(connection, { type: "replay_complete", activeSessionId: worker.activeSessionId, cursor });
			this.#writeResponse(connection, commandId, true, this.#summary(worker));
			completed = true;
		} finally {
			connection.initializingSessionIds.delete(worker.activeSessionId);
			if (!completed && !wasAttached) {
				connection.attachedSessionIds.delete(worker.activeSessionId);
				if (connection.activeSessionId === worker.activeSessionId) connection.activeSessionId = undefined;
				if (!hadLease && this.#leaseOwners.get(worker.activeSessionId) === connection.id) {
					this.#leaseOwners.delete(worker.activeSessionId);
				}
			}
		}
	}

	async #detachClient(connection: ConnectionState, activeSessionId: string | undefined): Promise<void> {
		const targets = activeSessionId ? [activeSessionId] : [...connection.attachedSessionIds];
		for (const sessionId of targets) {
			connection.attachedSessionIds.delete(sessionId);
			connection.initializingSessionIds.delete(sessionId);
			if (connection.activeSessionId === sessionId) connection.activeSessionId = undefined;
			if (this.#leaseOwners.get(sessionId) === connection.id) this.#leaseOwners.delete(sessionId);
			const worker = this.#workers.get(sessionId);
			if (!worker) continue;
			const hasAttachedClient = [...this.#connections.values()].some(
				candidate => !candidate.worker && !candidate.closed && candidate.attachedSessionIds.has(sessionId),
			);
			if (!hasAttachedClient) {
				worker.resident = true;
				if (worker.status === "ready" || worker.status === "running") worker.status = "resident";
			}
			if (!worker.socket) continue;
			try {
				await this.#requestWorker(worker, { type: "worker_unsubscribe", activeSessionId: sessionId });
			} catch {
				// A detached client must not retain a lease because its worker is unavailable.
			}
		}
	}

	#findWorkerForAttach(activeSessionId: string | undefined): WorkerRecord {
		if (activeSessionId) {
			const worker = this.#workers.get(activeSessionId);
			if (!worker || worker.status === "stopped") throw new Error(`Unknown active session: ${activeSessionId}`);
			return worker;
		}
		const liveWorkers = [...this.#workers.values()].filter(worker => worker.status !== "stopped");
		if (liveWorkers.length !== 1)
			throw new Error("Attach requires activeSessionId when the daemon has zero or multiple sessions");
		return liveWorkers[0]!;
	}

	async #routeSessionCommand(
		connection: ConnectionState,
		command: Extract<OmpDaemonCommand, { type: "set_model" }>,
	): Promise<void> {
		const worker = this.#activeWorkerForClient(connection);
		this.#assertLease(worker.activeSessionId, connection.id);
		const response = await this.#requestWorker(worker, command);
		this.#writeResponse(
			connection,
			command.id,
			response.ok,
			response.ok ? response.data : undefined,
			responseError(response),
		);
	}

	/**
	 * Route an open-ended turn (prompt/steer) to the worker without occupying the
	 * client's command queue. The turn may run for minutes; a cancel sent on the
	 * same or another connection must still be processed immediately.
	 */
	async #routeSessionTurn(
		connection: ConnectionState,
		command: Extract<OmpDaemonCommand, { type: "prompt" | "steer" }>,
	): Promise<void> {
		try {
			const worker = this.#activeWorkerForClient(connection);
			this.#assertLease(worker.activeSessionId, connection.id);
			const response = await this.#requestWorker(worker, command, WORKER_TURN_TIMEOUT_MS);
			if (connection.closed) return;
			this.#writeResponse(
				connection,
				command.id,
				response.ok,
				response.ok ? response.data : undefined,
				responseError(response),
			);
		} catch (error) {
			if (connection.closed) return;
			this.#writeResponse(connection, command.id, false, undefined, errorMessage(error));
		}
	}

	/**
	 * Route a cancel to a worker. When `activeSessionId` names the target it
	 * deliberately bypasses the lease: interrupting a running turn is a control
	 * operation, so a second client must be able to cancel a turn started by
	 * another client's prompt.
	 */
	async #routeCancel(
		connection: ConnectionState,
		command: Extract<OmpDaemonCommand, { type: "cancel" }>,
	): Promise<void> {
		const worker =
			command.activeSessionId === undefined
				? this.#activeWorkerForClient(connection)
				: this.#workers.get(command.activeSessionId);
		if (!worker || worker.status === "stopped") {
			throw new Error(`Unknown active session: ${command.activeSessionId ?? "current"}`);
		}
		const response = await this.#requestWorker(worker, { type: "cancel" });
		if (connection.closed) return;
		this.#writeResponse(
			connection,
			command.id,
			response.ok,
			response.ok ? response.data : undefined,
			responseError(response),
		);
	}

	async #routeAgentMessage(
		connection: ConnectionState,
		command: Extract<OmpDaemonCommand, { type: "agent_message_send" }>,
	): Promise<void> {
		const source = this.#activeWorkerForClient(connection);
		this.#assertLease(source.activeSessionId, connection.id);
		const target = this.#workers.get(command.target);
		if (!target || target.status === "stopped") throw new Error(`Unknown agent message target: ${command.target}`);
		const response = await this.#requestWorker(
			target,
			{
				type: "worker_deliver_message",
				message: command.message,
				sender: source.activeSessionId,
			},
			WORKER_TURN_TIMEOUT_MS,
		);
		this.#writeResponse(
			connection,
			command.id,
			response.ok,
			response.ok ? response.data : undefined,
			responseError(response),
		);
	}

	#activeWorkerForClient(connection: ConnectionState): WorkerRecord {
		const activeSessionId = connection.activeSessionId;
		if (!activeSessionId) throw new Error("Client is not attached to a daemon session");
		const worker = this.#workers.get(activeSessionId);
		if (!worker || worker.status === "stopped") throw new Error(`Unknown active session: ${activeSessionId}`);
		return worker;
	}

	#acquireLease(activeSessionId: string, clientId: string): boolean {
		const owner = this.#leaseOwners.get(activeSessionId);
		if (owner && owner !== clientId) return false;
		this.#leaseOwners.set(activeSessionId, clientId);
		return true;
	}

	#assertLease(activeSessionId: string, clientId: string): void {
		if (!this.#acquireLease(activeSessionId, clientId)) {
			throw new Error(`Session ${activeSessionId} is leased by another client`);
		}
	}

	async #requestWorker(
		worker: WorkerRecord,
		command: OmpDaemonWorkerCommand,
		timeoutMs: number = WORKER_REQUEST_TIMEOUT_MS,
	): Promise<OmpDaemonResponse> {
		const socket = worker.socket;
		if (!socket) throw new Error(`Daemon worker is not connected: ${worker.activeSessionId}`);
		const id = `supervisor:${++this.#workerRequestSequence}`;
		const outgoing = { ...command, id } as OmpDaemonWorkerCommand;
		const { promise: response, resolve, reject } = Promise.withResolvers<OmpDaemonResponse>();
		const timeout = setTimeout(() => {
			worker.pending.delete(id);
			reject(new Error(`Timed out waiting for daemon worker ${command.type}`));
		}, timeoutMs);
		worker.pending.set(id, { resolve, reject, timeout });
		if (!this.#writeSocket(socket, outgoing)) {
			const pending = worker.pending.get(id);
			if (pending) {
				clearTimeout(pending.timeout);
				worker.pending.delete(id);
				pending.reject(new Error(`Daemon worker socket is unavailable: ${worker.activeSessionId}`));
			}
		}
		return await response;
	}

	#routeSessionEvent(worker: WorkerRecord, event: Extract<OmpDaemonEvent, { type: "session_event" }>): void {
		const cursor: OmpDaemonEventCursor = {
			generation: worker.generation,
			sequence: worker.sequence + 1,
		};
		const withCursor: Extract<OmpDaemonEvent, { type: "session_event" }> = { ...event, cursor };
		// A worker record can fit before the supervisor adds its replay cursor. Check
		// the relayed record itself so clients never receive an oversized JSONL frame.
		if (!encodeOmpDaemonRecord(withCursor)) {
			this.#publishError(worker, "Daemon session event exceeds the JSONL size limit");
			return;
		}
		worker.sequence = cursor.sequence;
		worker.events.push({ cursor, event: withCursor });
		if (worker.events.length > MAX_REPLAY_EVENTS) worker.events.shift();
		if (!worker.resident && worker.status === "ready") worker.status = "running";
		for (const connection of this.#connections.values()) {
			if (
				!connection.worker &&
				connection.attachedSessionIds.has(worker.activeSessionId) &&
				!connection.initializingSessionIds.has(worker.activeSessionId)
			) {
				this.#write(connection, withCursor);
			}
		}
	}

	#publishError(worker: WorkerRecord, message: string): void {
		for (const connection of this.#connections.values()) {
			if (!connection.worker && connection.attachedSessionIds.has(worker.activeSessionId)) {
				this.#write(connection, { type: "error", message });
			}
		}
	}

	#cursor(worker: WorkerRecord): OmpDaemonEventCursor {
		return { generation: worker.generation, sequence: worker.sequence };
	}

	#summary(worker: WorkerRecord): OmpSessionSummary {
		return {
			activeSessionId: worker.activeSessionId,
			...(worker.sessionId === undefined ? {} : { sessionId: worker.sessionId }),
			cwd: worker.cwd,
			...(worker.sessionPath === undefined ? {} : { sessionPath: worker.sessionPath }),
			status: worker.status,
		};
	}

	#writeResponse(
		connection: ConnectionState,
		id: string | undefined,
		ok: boolean,
		data?: unknown,
		error?: string,
	): void {
		if (!id) return;
		if (ok) {
			this.#write(connection, data === undefined ? { id, ok: true } : { id, ok: true, data });
			return;
		}
		this.#write(connection, { id, ok: false, error: error ?? "Daemon command failed" });
	}

	#write(connection: ConnectionState, record: unknown): boolean {
		return this.#writeSocket(connection.socket, record);
	}

	#writeSocket(socket: Bun.Socket<undefined>, record: unknown): boolean {
		const encoded = encodeOmpDaemonRecord(record);
		if (!encoded) return false;
		try {
			return socket.write(encoded) >= 0;
		} catch {
			return false;
		}
	}

	#closeConnection(socket: Bun.Socket<undefined>): void {
		const connection = this.#connections.get(socket);
		if (!connection || connection.closed) return;
		connection.closed = true;
		this.#connections.delete(socket);
		if (connection.worker) {
			const worker = connection.worker;
			if (worker.socket === socket) {
				worker.socket = undefined;
				this.#rejectPendingWorkerRequests(worker, new Error("Daemon worker socket closed"));
			}
			return;
		}
		void this.#detachClient(connection, undefined);
	}

	#rejectPendingWorkerRequests(worker: WorkerRecord, error: Error): void {
		for (const [id, pending] of worker.pending) {
			clearTimeout(pending.timeout);
			worker.pending.delete(id);
			pending.reject(error);
		}
	}
}

/** Exercise detached supervisor and worker selectors through the CLI smoke path. */
export async function smokeTestDaemonSupervisor(timeoutMs = SMOKE_TEST_TIMEOUT_MS): Promise<void> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-smoke-"));
	const socketPath = defaultDaemonSocketPath(agentDir);
	const { cmd, cwd } = resolveWorkerSpawnCmd(DAEMON_SUPERVISOR_ARG);
	let proc: Bun.Subprocess | undefined;
	let socketIdentity: DaemonSocketIdentity | undefined;
	try {
		const supervisor = Bun.spawn(cmd, {
			cwd,
			env: {
				...process.env,
				[OMP_DAEMON_WORKER_ROLE_ENV]: "1",
				[OMP_DAEMON_WORKER_SUPERVISOR_SOCKET_ENV]: socketPath,
				[OMP_DAEMON_WORKER_AGENT_DIR_ENV]: agentDir,
				[OMP_DAEMON_WORKER_TOKEN_ENV]: "supervisor",
				[OMP_DAEMON_WORKER_ACTIVE_SESSION_ID_ENV]: "supervisor",
				[OMP_DAEMON_WORKER_CWD_ENV]: process.cwd(),
			},
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
		});
		proc = supervisor;
		supervisor.unref();

		const startupDeadline = Date.now() + timeoutMs;
		let listening = false;
		while (Date.now() < startupDeadline) {
			if (supervisor.exitCode !== null) {
				throw new Error(`Daemon supervisor smoke failed: process exited with code ${supervisor.exitCode}`);
			}
			const status = await getDaemonSocketStatus(socketPath);
			if (status === "live") {
				listening = true;
				socketIdentity = getDaemonSocketIdentity(socketPath);
				break;
			}
			if (status === "not_socket")
				throw new Error(`Daemon supervisor smoke found a non-socket endpoint: ${socketPath}`);
			await Bun.sleep(50);
		}
		if (!listening) throw new Error(`Daemon supervisor smoke timed out after ${timeoutMs}ms`);

		const create = await sendDaemonCommand(
			socketPath,
			{ id: "smoke-create", type: "create", cwd: process.cwd() },
			{ timeoutMs },
		);
		if (!create.ok) throw new Error(`Daemon worker smoke failed: ${create.error}`);
		const shutdown = await sendDaemonCommand(socketPath, { id: "smoke-shutdown", type: "shutdown" }, { timeoutMs });
		if (!shutdown.ok) throw new Error(`Daemon supervisor smoke shutdown failed: ${shutdown.error}`);

		const shutdownDeadline = Date.now() + timeoutMs;
		while (Date.now() < shutdownDeadline) {
			if (supervisor.exitCode !== null) return;
			await Bun.sleep(50);
		}
		throw new Error(`Daemon supervisor smoke did not exit within ${timeoutMs}ms`);
	} finally {
		if (proc) {
			if (proc.exitCode === null) {
				try {
					proc.kill("SIGKILL");
				} catch {
					// The supervisor can exit while the smoke cleanup starts.
				}
			}
			await proc.exited.catch(() => {});
		}
		if (!socketIdentity) {
			try {
				socketIdentity = getDaemonSocketIdentity(socketPath);
			} catch {
				// The supervisor may have cleaned its endpoint before this fallback check.
			}
		}
		if (socketIdentity) cleanupDaemonSocketPath(socketPath, socketIdentity, undefined);
		try {
			await fs.rm(agentDir, { recursive: true, force: true });
		} catch {
			// Smoke cleanup must not hide the startup or protocol failure being diagnosed.
		}
	}
}

/**
 * Supervisor entrypoint invoked by the CLI worker-host dispatch
 * (`__omp_worker_daemon_supervisor`). Reads its socket/agent identity from
 * the supervisor-injected environment.
 */
export async function startDaemonSupervisorFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const socketPath = environment[OMP_DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
	const agentDir = environment[OMP_DAEMON_WORKER_AGENT_DIR_ENV];
	if (!socketPath || !agentDir) {
		throw new Error("Daemon supervisor is missing required startup environment");
	}
	await OmpDaemonSupervisor.start({ agentDir, socketPath });
}
