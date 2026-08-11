import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sendDaemonCommand } from "../../src/daemon/client";
import { OMP_DAEMON_SCHEMA_REVISION } from "../../src/daemon/protocol";
import { getDaemonSocketStatus } from "../../src/daemon/socket";
import { OmpDaemonSupervisor } from "../../src/daemon/supervisor";
import {
	OMP_DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	OMP_DAEMON_WORKER_RECOVER_ENV,
	OMP_DAEMON_WORKER_RECOVERY_JOURNAL_ENV,
	OMP_DAEMON_WORKER_TOKEN_ENV,
} from "../../src/daemon/worker";

type WireRecord = Record<string, unknown>;
type RecordMatcher = (record: WireRecord) => boolean;

const activeSupervisors = new Set<OmpDaemonSupervisor>();
const activePeers = new Set<JsonlPeer>();
const cleanupRoots: string[] = [];

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** A real Unix-socket peer with deterministic JSONL response matching. */
class JsonlPeer {
	#socket: Bun.Socket<undefined> | undefined;
	#buffer = "";
	#closed = false;
	#records: WireRecord[] = [];
	#listeners = new Set<(record: WireRecord) => void>();
	#waiters: Array<{
		matcher: RecordMatcher;
		resolve: (record: WireRecord) => void;
		reject: (error: Error) => void;
	}> = [];
	readonly #closedPromise: Promise<void>;
	readonly #resolveClosed: () => void;

	private constructor() {
		const closed = Promise.withResolvers<void>();
		this.#closedPromise = closed.promise;
		this.#resolveClosed = closed.resolve;
	}

	static async connect(socketPath: string): Promise<JsonlPeer> {
		const peer = new JsonlPeer();
		const opened = await Bun.connect({
			unix: socketPath,
			socket: {
				open: socket => {
					peer.#socket = socket;
				},
				data: (_socket, data) => peer.#receive(data),
				close: () => peer.#markClosed(),
				error: (_socket, error) => peer.#markClosed(new Error(error.message)),
				connectError: (_socket, error) => peer.#markClosed(new Error(error.message)),
			},
		});
		peer.#socket ??= opened;
		return peer;
	}

	onRecord(listener: (record: WireRecord) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	send(record: WireRecord): void {
		if (this.#closed || !this.#socket) throw new Error("JSONL peer is closed");
		const encoded = `${JSON.stringify(record)}\n`;
		if (this.#socket.write(encoded) < 0) throw new Error("JSONL peer write failed");
	}

	waitFor(matcher: RecordMatcher, label: string): Promise<WireRecord> {
		const existing = this.#records.find(matcher);
		if (existing) return Promise.resolve(existing);
		if (this.#closed) return Promise.reject(new Error(`JSONL peer closed before ${label}`));
		const { promise, resolve, reject } = Promise.withResolvers<WireRecord>();
		this.#waiters.push({ matcher, resolve, reject });
		return within(promise, label);
	}

	waitClosed(label: string): Promise<void> {
		return within(this.#closedPromise, label);
	}

	close(): void {
		this.#markClosed();
		try {
			this.#socket?.terminate();
		} catch {
			// The peer may already have been closed by the remote endpoint.
		}
		this.#socket = undefined;
	}

	#receive(data: Uint8Array): void {
		this.#buffer += new TextDecoder().decode(data);
		for (;;) {
			const newline = this.#buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.#buffer.slice(0, newline);
			this.#buffer = this.#buffer.slice(newline + 1);
			if (!line.trim()) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			const record = parsed as WireRecord;
			this.#records.push(record);
			for (const listener of this.#listeners) {
				try {
					listener(record);
				} catch (error) {
					this.#markClosed(error instanceof Error ? error : new Error(String(error)));
				}
			}
			for (let index = 0; index < this.#waiters.length; ) {
				const waiter = this.#waiters[index]!;
				if (!waiter.matcher(record)) {
					index++;
					continue;
				}
				this.#waiters.splice(index, 1);
				waiter.resolve(record);
			}
		}
	}

	#markClosed(error?: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#resolveClosed();
		for (const waiter of this.#waiters.splice(0)) {
			waiter.reject(error ?? new Error("JSONL peer closed"));
		}
	}
}

async function waitForNextRecord(peer: JsonlPeer, matcher: RecordMatcher, label: string): Promise<WireRecord> {
	const next = Promise.withResolvers<WireRecord>();
	let unsubscribe = (): void => {};
	unsubscribe = peer.onRecord(record => {
		if (!matcher(record)) return;
		unsubscribe();
		next.resolve(record);
	});
	try {
		return await within(next.promise, label);
	} finally {
		unsubscribe();
	}
}

interface ControlledSubprocess {
	process: Bun.Subprocess;
	killSignals: Array<string | number | undefined>;
	exited: Promise<number>;
	crash(exitCode?: number): void;
}

function controlledSubprocess(): ControlledSubprocess {
	const exit = Promise.withResolvers<number>();
	const killSignals: Array<string | number | undefined> = [];
	let exited = false;
	const finish = (exitCode: number): void => {
		if (exited) return;
		exited = true;
		exit.resolve(exitCode);
	};
	const processRef = {
		pid: 42_424,
		exited: exit.promise,
		unref: () => {},
		kill: (signal?: string | number) => {
			killSignals.push(signal);
			finish(0);
			return true;
		},
	} as unknown as Bun.Subprocess;
	return { process: processRef, killSignals, exited: exit.promise, crash: (exitCode = 1) => finish(exitCode) };
}

interface ConnectedWorker {
	peer: JsonlPeer;
	activeSessionId: string;
}

interface ConnectWorkerOptions {
	onSnapshot?: (peer: JsonlPeer, requestId: string, activeSessionId: string) => void;
	onPrompt?: (peer: JsonlPeer, requestId: string, message: string) => void;
	summary?: Partial<WireRecord>;
	recoveryLineage?: { sessionId: string; sessionPath: string; cwd?: string };
}

async function connectWorker(
	socketPath: string,
	environment: NodeJS.ProcessEnv,
	cwd: string,
	options: ConnectWorkerOptions = {},
): Promise<ConnectedWorker> {
	const token = environment[OMP_DAEMON_WORKER_TOKEN_ENV];
	const activeSessionId = environment[OMP_DAEMON_WORKER_ACTIVE_SESSION_ID_ENV];
	if (!token || !activeSessionId) throw new Error("Supervisor did not provide worker identity");
	const peer = await JsonlPeer.connect(socketPath);
	activePeers.add(peer);
	peer.onRecord(record => {
		const id = typeof record.id === "string" ? record.id : undefined;
		const type = typeof record.type === "string" ? record.type : undefined;
		if (!id || !type) return;
		if (type === "worker_subscribe" || type === "worker_unsubscribe") {
			peer.send({ id, ok: true, data: { activeSessionId } });
			return;
		}
		if (type === "worker_snapshot") {
			if (options.onSnapshot) {
				options.onSnapshot(peer, id, activeSessionId);
			} else {
				peer.send({ id, ok: true, data: { messages: [], activeTools: [] } });
			}
			return;
		}
		if (type === "prompt" && options.onPrompt) {
			options.onPrompt(peer, id, typeof record.message === "string" ? record.message : "");
			return;
		}
		if (type === "worker_archive_and_shutdown") {
			peer.send({ id, ok: true });
		}
	});
	peer.send({ id: "worker-auth", type: "worker_auth", token, activeSessionId });
	await peer.waitFor(record => record.id === "worker-auth" && record.ok === true, "worker authentication");
	const lineage = options.recoveryLineage;
	const journalPath = environment[OMP_DAEMON_WORKER_RECOVERY_JOURNAL_ENV];
	if (lineage && journalPath) {
		await fs.appendFile(
			journalPath,
			`${JSON.stringify({
				version: 1,
				event: "ready",
				activeSessionId,
				sessionId: lineage.sessionId,
				sessionPath: lineage.sessionPath,
				cwd: lineage.cwd ?? cwd,
				recordedAt: "2026-01-01T00:00:00.000Z",
			})}\n`,
			"utf8",
		);
	}
	peer.send({
		type: "worker_ready",
		activeSessionId,
		summary: { activeSessionId, cwd, status: "ready", ...options.summary },
	});
	return { peer, activeSessionId };
}

async function makeRoot(prefix: string): Promise<{ root: string; agentDir: string; socketPath: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanupRoots.push(root);
	const agentDir = path.join(root, "agent");
	await fs.mkdir(agentDir, { recursive: true });
	return { root, agentDir, socketPath: path.join(agentDir, "daemon.sock") };
}

afterEach(async () => {
	for (const supervisor of [...activeSupervisors]) {
		try {
			await supervisor.stop();
		} catch {
			// Teardown is best effort; the assertions own the contract.
		}
	}
	activeSupervisors.clear();
	for (const peer of [...activePeers]) peer.close();
	activePeers.clear();
	vi.restoreAllMocks();
	for (const root of cleanupRoots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe("daemon supervisor lifecycle", () => {
	it("advertises prompt_cancellation with the current schema revision on hello", async () => {
		const { agentDir, socketPath } = await makeRoot("omp-daemon-hello-");
		const supervisor = new OmpDaemonSupervisor({ agentDir, socketPath, workerStartTimeoutMs: 2_000 });
		activeSupervisors.add(supervisor);
		await supervisor.start();

		const client = await JsonlPeer.connect(socketPath);
		activePeers.add(client);
		client.send({ id: "hello-1", type: "hello", capabilities: [] });
		const hello = await client.waitFor(record => record.type === "daemon_hello", "daemon hello event");
		expect(hello).toMatchObject({
			name: "omp.daemon",
			version: 1,
			schemaRevision: OMP_DAEMON_SCHEMA_REVISION,
		});
		expect(hello.capabilities as string[]).toContain("prompt_cancellation");
		const response = await client.waitFor(record => record.id === "hello-1", "hello response");
		expect(response.ok).toBe(true);
		if (response.ok) {
			expect((response.data as { capabilities: string[] }).capabilities).toContain("prompt_cancellation");
		}
	});
	it("releases a session lease when its attached client disconnects", async () => {
		const { root, agentDir, socketPath } = await makeRoot("omp-daemon-lease-");
		const supervisor = new OmpDaemonSupervisor({ agentDir, socketPath, workerStartTimeoutMs: 2_000 });
		activeSupervisors.add(supervisor);
		await supervisor.start();

		const child = controlledSubprocess();
		const spawnGate = Promise.withResolvers<NodeJS.ProcessEnv>();
		vi.spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
			const options = args[1] as { env?: NodeJS.ProcessEnv } | undefined;
			if (!options?.env) throw new Error("missing worker environment");
			spawnGate.resolve(options.env);
			return child.process;
		}) as typeof Bun.spawn);

		const clientA = await JsonlPeer.connect(socketPath);
		activePeers.add(clientA);
		clientA.send({ id: "create-1", type: "create", cwd: root });
		const workerEnvironment = await within(spawnGate.promise, "worker spawn");
		const baselineMessages = [{ role: "assistant", content: "resident transcript" }];
		const worker = await connectWorker(socketPath, workerEnvironment, root, {
			onSnapshot: (peer, requestId) => peer.send({ id: requestId, ok: true, data: { messages: baselineMessages } }),
		});
		const created = await clientA.waitFor(record => record.id === "create-1", "session creation");
		expect(created.ok).toBe(true);
		const activeSessionId =
			created.data && typeof created.data === "object" ? (created.data as WireRecord).activeSessionId : undefined;
		if (typeof activeSessionId !== "string") throw new Error("create response omitted activeSessionId");
		expect(activeSessionId).toBe(worker.activeSessionId);

		const competing = await sendDaemonCommand(socketPath, {
			id: "attach-blocked",
			type: "attach",
			activeSessionId,
		});
		expect(competing.ok).toBe(false);
		if (competing.ok) throw new Error("a second client unexpectedly acquired the lease");
		expect(competing.error).toContain("leased by another client");

		clientA.close();
		await clientA.waitClosed("disconnected client");
		await worker.peer.waitFor(record => record.type === "worker_unsubscribe", "lease release");
		const residentSessions = await sendDaemonCommand(socketPath, { id: "list-resident", type: "list_sessions" });
		expect(residentSessions).toMatchObject({ id: "list-resident", ok: true });
		if (!residentSessions.ok || !Array.isArray(residentSessions.data)) throw new Error("session list unavailable");
		expect(residentSessions.data).toContainEqual(expect.objectContaining({ activeSessionId, status: "resident" }));

		const clientB = await JsonlPeer.connect(socketPath);
		activePeers.add(clientB);
		clientB.send({ id: "attach-after-disconnect", type: "attach", activeSessionId });
		const snapshot = await clientB.waitFor(
			record => record.type === "snapshot" && record.activeSessionId === activeSessionId,
			"resident session snapshot",
		);
		expect(snapshot).toMatchObject({ state: { messages: baselineMessages } });
		await clientB.waitFor(
			record => record.type === "replay_complete" && record.activeSessionId === activeSessionId,
			"resident replay completion",
		);
		const reattached = await clientB.waitFor(record => record.id === "attach-after-disconnect", "reattach response");
		expect(reattached).toMatchObject({ id: "attach-after-disconnect", ok: true });
		if (!reattached.ok || !reattached.data || typeof reattached.data !== "object") {
			throw new Error("reattach response omitted session summary");
		}
		expect(reattached.data).toMatchObject({ activeSessionId, status: "ready" });

		await supervisor.stop();
		expect(await getDaemonSocketStatus(socketPath)).toBe("missing");
	});
	it("maps a worker prompt exception to an ok:false daemon response", async () => {
		const { root, agentDir, socketPath } = await makeRoot("omp-daemon-prompt-error-");
		const supervisor = new OmpDaemonSupervisor({ agentDir, socketPath, workerStartTimeoutMs: 2_000 });
		activeSupervisors.add(supervisor);
		await supervisor.start();

		const child = controlledSubprocess();
		const spawnGate = Promise.withResolvers<NodeJS.ProcessEnv>();
		vi.spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
			const options = args[1] as { env?: NodeJS.ProcessEnv } | undefined;
			if (!options?.env) throw new Error("missing worker environment");
			spawnGate.resolve(options.env);
			return child.process;
		}) as typeof Bun.spawn);

		const client = await JsonlPeer.connect(socketPath);
		activePeers.add(client);
		client.send({ id: "create-prompt-error", type: "create", cwd: root });
		const workerEnvironment = await within(spawnGate.promise, "prompt worker spawn");
		const worker = await connectWorker(socketPath, workerEnvironment, root, {
			onPrompt: (peer, requestId) => peer.send({ id: requestId, ok: false, error: "provider rejected prompt" }),
		});
		const created = await client.waitFor(
			record => record.id === "create-prompt-error",
			"prompt error session creation",
		);
		if (!created.ok || !created.data || typeof created.data !== "object") throw new Error("session creation failed");
		const activeSessionId = (created.data as WireRecord).activeSessionId;
		if (typeof activeSessionId !== "string" || activeSessionId !== worker.activeSessionId) {
			throw new Error("session creation omitted activeSessionId");
		}

		client.send({ id: "prompt-error", type: "prompt", message: "this must fail" });
		await expect(client.waitFor(record => record.id === "prompt-error", "prompt error response")).resolves.toEqual({
			id: "prompt-error",
			ok: false,
			error: "provider rejected prompt",
		});
	});

	it("sends the attach baseline and completion before live events arriving during the snapshot", async () => {
		const { root, agentDir, socketPath } = await makeRoot("omp-daemon-attach-order-");
		const supervisor = new OmpDaemonSupervisor({ agentDir, socketPath, workerStartTimeoutMs: 2_000 });
		activeSupervisors.add(supervisor);
		await supervisor.start();

		const child = controlledSubprocess();
		const spawnGate = Promise.withResolvers<NodeJS.ProcessEnv>();
		vi.spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
			const options = args[1] as { env?: NodeJS.ProcessEnv } | undefined;
			if (!options?.env) throw new Error("missing worker environment");
			spawnGate.resolve(options.env);
			return child.process;
		}) as typeof Bun.spawn);

		const baselineMessages = [{ role: "assistant", content: "state after the concurrent update" }];
		const clientA = await JsonlPeer.connect(socketPath);
		activePeers.add(clientA);
		clientA.send({ id: "create-order", type: "create", cwd: root });
		const workerEnvironment = await within(spawnGate.promise, "worker spawn");
		const worker = await connectWorker(socketPath, workerEnvironment, root, {
			onSnapshot: (peer, requestId, activeSessionId) => {
				peer.send({
					type: "session_event",
					activeSessionId,
					event: { type: "message_updated", marker: "during-attach" },
				});
				peer.send({ id: requestId, ok: true, data: { messages: baselineMessages, activeTools: [] } });
			},
		});
		const created = await clientA.waitFor(record => record.id === "create-order", "session creation");
		if (!created.ok || !created.data || typeof created.data !== "object") {
			throw new Error("create response omitted activeSessionId");
		}
		const activeSessionId = (created.data as WireRecord).activeSessionId;
		if (typeof activeSessionId !== "string") throw new Error("create response omitted activeSessionId");

		clientA.close();
		await worker.peer.waitFor(record => record.type === "worker_unsubscribe", "lease release");

		const clientB = await JsonlPeer.connect(socketPath);
		activePeers.add(clientB);
		const attachmentRecords: WireRecord[] = [];
		clientB.onRecord(record => attachmentRecords.push(record));
		clientB.send({ id: "attach-order", type: "attach", activeSessionId });
		await clientB.waitFor(
			record => record.type === "replay_complete" && record.activeSessionId === activeSessionId,
			"attach replay completion",
		);
		const attached = await clientB.waitFor(record => record.id === "attach-order", "attach response");
		expect(attached).toMatchObject({ id: "attach-order", ok: true });

		const transfer = attachmentRecords.filter(
			record => record.type === "snapshot" || record.type === "replay_complete" || record.type === "session_event",
		);
		expect(transfer.map(record => record.type)).toEqual(["snapshot", "replay_complete"]);
		expect(transfer[0]).toMatchObject({
			type: "snapshot",
			activeSessionId,
			state: { messages: baselineMessages },
		});
		expect(transfer[1]).toMatchObject({ type: "replay_complete", activeSessionId });
	});

	it("keeps ready-then-crash recovery bounded across successful restarts", async () => {
		const { root, agentDir, socketPath } = await makeRoot("omp-daemon-recovery-bound-");
		const supervisor = new OmpDaemonSupervisor({ agentDir, socketPath, workerStartTimeoutMs: 2_000 });
		activeSupervisors.add(supervisor);
		await supervisor.start();

		type SpawnedWorker = { child: ControlledSubprocess; environment: NodeJS.ProcessEnv };
		const spawned: SpawnedWorker[] = [];
		let spawnGate = Promise.withResolvers<SpawnedWorker>();
		vi.spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
			const options = args[1] as { env?: NodeJS.ProcessEnv } | undefined;
			if (!options?.env) throw new Error("missing worker environment");
			const worker = { child: controlledSubprocess(), environment: options.env };
			spawned.push(worker);
			spawnGate.resolve(worker);
			return worker.child.process;
		}) as typeof Bun.spawn);
		const waitForSpawn = async (label: string): Promise<SpawnedWorker> => {
			const gate = spawnGate;
			const worker = await within(gate.promise, label);
			spawnGate = Promise.withResolvers<SpawnedWorker>();
			return worker;
		};

		const client = await JsonlPeer.connect(socketPath);
		activePeers.add(client);
		const sessionPath = path.join(root, "persisted-session.jsonl");
		const lineage = { sessionId: "persisted-session-id", sessionPath, cwd: root };
		client.send({ id: "create-recovery", type: "create", cwd: root, sessionPath });
		let spawnedWorker = await waitForSpawn("initial worker spawn");
		expect(spawnedWorker.environment[OMP_DAEMON_WORKER_RECOVER_ENV]).toBeUndefined();
		let worker = await connectWorker(socketPath, spawnedWorker.environment, root, {
			summary: { sessionId: lineage.sessionId, sessionPath: lineage.sessionPath },
			recoveryLineage: lineage,
		});
		const created = await client.waitFor(record => record.id === "create-recovery", "session creation");
		if (!created.ok || !created.data || typeof created.data !== "object") {
			throw new Error("create response omitted activeSessionId");
		}
		const activeSessionId = (created.data as WireRecord).activeSessionId;
		if (typeof activeSessionId !== "string") throw new Error("create response omitted activeSessionId");

		const confirmReady = async (candidate: ConnectedWorker, marker: string): Promise<void> => {
			const routed = waitForNextRecord(
				client,
				record =>
					record.type === "session_event" &&
					record.activeSessionId === activeSessionId &&
					(record.event as WireRecord | undefined)?.marker === marker,
				`ready worker event ${marker}`,
			);
			candidate.peer.send({
				type: "session_event",
				activeSessionId,
				event: { type: "message_updated", marker },
			});
			expect(await routed).toMatchObject({
				type: "session_event",
				activeSessionId,
				event: { marker },
			});
		};
		const crashWorker = async (candidate: ConnectedWorker, child: ControlledSubprocess): Promise<void> => {
			const failure = waitForNextRecord(
				client,
				record => record.type === "error" && record.message === "Daemon worker exited with code 1",
				"worker crash notification",
			);
			candidate.peer.close();
			child.crash(1);
			expect(await failure).toMatchObject({ type: "error", message: "Daemon worker exited with code 1" });
		};

		await confirmReady(worker, "initial");
		for (let recovery = 1; recovery <= 3; recovery++) {
			await crashWorker(worker, spawnedWorker.child);
			spawnedWorker = await waitForSpawn(`recovery worker ${recovery} spawn`);
			worker = await connectWorker(socketPath, spawnedWorker.environment, root);
			await confirmReady(worker, `recovery-${recovery}`);
		}

		await crashWorker(worker, spawnedWorker.child);
		const sessions = await sendDaemonCommand(socketPath, { id: "list-after-crashes", type: "list_sessions" });
		if (!sessions.ok || !Array.isArray(sessions.data))
			throw new Error("list_sessions did not return session summaries");
		expect(sessions.data).toContainEqual(expect.objectContaining({ activeSessionId, status: "failed" }));
		expect(spawned).toHaveLength(4);
	});

	it("kills a worker that misses the startup-ready deadline before failing create", async () => {
		const { agentDir, socketPath } = await makeRoot("omp-daemon-start-timeout-");
		const supervisor = new OmpDaemonSupervisor({ agentDir, socketPath, workerStartTimeoutMs: 20 });
		activeSupervisors.add(supervisor);
		await supervisor.start();

		const child = controlledSubprocess();
		vi.spyOn(Bun, "spawn").mockReturnValue(child.process);

		const response = await sendDaemonCommand(
			socketPath,
			{ id: "create-timeout", type: "create", cwd: agentDir },
			{ timeoutMs: 2_000 },
		);
		expect(response.ok).toBe(false);
		if (response.ok) throw new Error("timed-out worker creation unexpectedly succeeded");
		expect(response.error).toContain("Timed out starting daemon worker");
		expect(child.killSignals).toContain("SIGKILL");
		await within(child.exited, "timed-out worker reaping");

		await supervisor.stop();
		expect(await getDaemonSocketStatus(socketPath)).toBe("missing");
	});
	it("processes a same-connection cancel while a prompt turn is in flight", async () => {
		const { root, agentDir, socketPath } = await makeRoot("omp-daemon-cancel-same-");
		const supervisor = new OmpDaemonSupervisor({ agentDir, socketPath, workerStartTimeoutMs: 2_000 });
		activeSupervisors.add(supervisor);
		await supervisor.start();

		const child = controlledSubprocess();
		const spawnGate = Promise.withResolvers<NodeJS.ProcessEnv>();
		vi.spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
			const options = args[1] as { env?: NodeJS.ProcessEnv } | undefined;
			if (!options?.env) throw new Error("missing worker environment");
			spawnGate.resolve(options.env);
			return child.process;
		}) as typeof Bun.spawn);

		const client = await JsonlPeer.connect(socketPath);
		activePeers.add(client);
		client.send({ id: "create-cancel-same", type: "create", cwd: root });
		const workerEnvironment = await within(spawnGate.promise, "worker spawn");
		// Hold the prompt response so the turn is genuinely in flight; the open-ended
		// turn must not occupy the client's command queue.
		const worker = await connectWorker(socketPath, workerEnvironment, root, { onPrompt: () => {} });
		worker.peer.onRecord(record => {
			if (record.type === "cancel" && typeof record.id === "string") {
				worker.peer.send({ id: record.id, ok: true });
			}
		});
		const created = await client.waitFor(
			record => record.id === "create-cancel-same",
			"cancel-same session creation",
		);
		if (!created.ok || !created.data || typeof created.data !== "object") {
			throw new Error("create response omitted activeSessionId");
		}
		const activeSessionId = (created.data as WireRecord).activeSessionId;
		if (typeof activeSessionId !== "string") throw new Error("create response omitted activeSessionId");

		client.send({ id: "prompt-cancel-same", type: "prompt", message: "long turn" });
		await worker.peer.waitFor(record => record.type === "prompt", "worker prompt receipt");

		client.send({ id: "cancel-same", type: "cancel" });
		await worker.peer.waitFor(record => record.type === "cancel", "worker cancel receipt");
		const cancelResponse = await client.waitFor(record => record.id === "cancel-same", "cancel response");
		expect(cancelResponse).toEqual({ id: "cancel-same", ok: true });
	});
	it("routes a targeted cancel to a leased session from a second connection", async () => {
		const { root, agentDir, socketPath } = await makeRoot("omp-daemon-cancel-targeted-");
		const supervisor = new OmpDaemonSupervisor({ agentDir, socketPath, workerStartTimeoutMs: 2_000 });
		activeSupervisors.add(supervisor);
		await supervisor.start();

		const child = controlledSubprocess();
		const spawnGate = Promise.withResolvers<NodeJS.ProcessEnv>();
		vi.spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
			const options = args[1] as { env?: NodeJS.ProcessEnv } | undefined;
			if (!options?.env) throw new Error("missing worker environment");
			spawnGate.resolve(options.env);
			return child.process;
		}) as typeof Bun.spawn);

		const clientA = await JsonlPeer.connect(socketPath);
		activePeers.add(clientA);
		clientA.send({ id: "create-cancel-targeted", type: "create", cwd: root });
		const workerEnvironment = await within(spawnGate.promise, "worker spawn");
		const worker = await connectWorker(socketPath, workerEnvironment, root, { onPrompt: () => {} });
		worker.peer.onRecord(record => {
			if (record.type === "cancel" && typeof record.id === "string") {
				worker.peer.send({ id: record.id, ok: true });
			}
		});
		const created = await clientA.waitFor(
			record => record.id === "create-cancel-targeted",
			"targeted session creation",
		);
		if (!created.ok || !created.data || typeof created.data !== "object") {
			throw new Error("create response omitted activeSessionId");
		}
		const activeSessionId = (created.data as WireRecord).activeSessionId;
		if (typeof activeSessionId !== "string") throw new Error("create response omitted activeSessionId");

		// clientA holds the lease with an in-flight prompt turn.
		clientA.send({ id: "prompt-cancel-targeted", type: "prompt", message: "long turn" });
		await worker.peer.waitFor(record => record.type === "prompt", "worker prompt receipt");

		// A second client names the session explicitly; interrupting a running turn
		// is a control operation and must bypass the lease held by clientA.
		const clientB = await JsonlPeer.connect(socketPath);
		activePeers.add(clientB);
		clientB.send({ id: "cancel-targeted", type: "cancel", activeSessionId });
		await worker.peer.waitFor(record => record.type === "cancel", "targeted worker cancel receipt");
		const cancelResponse = await clientB.waitFor(
			record => record.id === "cancel-targeted",
			"targeted cancel response",
		);
		expect(cancelResponse).toEqual({ id: "cancel-targeted", ok: true });
	});
	it("surfaces an interrupted prompt as ok:false after a targeted cancel", async () => {
		const { root, agentDir, socketPath } = await makeRoot("omp-daemon-cancel-outcome-");
		const supervisor = new OmpDaemonSupervisor({ agentDir, socketPath, workerStartTimeoutMs: 2_000 });
		activeSupervisors.add(supervisor);
		await supervisor.start();

		const child = controlledSubprocess();
		const spawnGate = Promise.withResolvers<NodeJS.ProcessEnv>();
		vi.spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
			const options = args[1] as { env?: NodeJS.ProcessEnv } | undefined;
			if (!options?.env) throw new Error("missing worker environment");
			spawnGate.resolve(options.env);
			return child.process;
		}) as typeof Bun.spawn);

		const clientA = await JsonlPeer.connect(socketPath);
		activePeers.add(clientA);
		clientA.send({ id: "create-cancel-outcome", type: "create", cwd: root });
		const workerEnvironment = await within(spawnGate.promise, "worker spawn");
		let promptId: string | undefined;
		const worker = await connectWorker(socketPath, workerEnvironment, root, {
			// Hold the prompt until the cancel arrives, then settle it as the abort
			// outcome so the supervisor relays both responses in order.
			onPrompt: (_peer, requestId) => {
				promptId = requestId;
			},
		});
		worker.peer.onRecord(record => {
			if (record.type === "cancel" && typeof record.id === "string") {
				worker.peer.send({ id: record.id, ok: true });
				if (promptId) {
					worker.peer.send({ id: promptId, ok: false, error: "Agent turn aborted" });
				}
			}
		});
		const created = await clientA.waitFor(
			record => record.id === "create-cancel-outcome",
			"cancel-outcome session creation",
		);
		if (!created.ok || !created.data || typeof created.data !== "object") {
			throw new Error("create response omitted activeSessionId");
		}
		const activeSessionId = (created.data as WireRecord).activeSessionId;
		if (typeof activeSessionId !== "string") throw new Error("create response omitted activeSessionId");

		clientA.send({ id: "prompt-cancel-outcome", type: "prompt", message: "long turn" });
		await worker.peer.waitFor(record => record.type === "prompt", "worker prompt receipt");

		const clientB = await JsonlPeer.connect(socketPath);
		activePeers.add(clientB);
		clientB.send({ id: "cancel-outcome", type: "cancel", activeSessionId });
		const cancelResponse = await clientB.waitFor(record => record.id === "cancel-outcome", "cancel-outcome response");
		expect(cancelResponse).toEqual({ id: "cancel-outcome", ok: true });
		// The interrupted turn's failure is still surfaced to the prompting client.
		const promptOutcome = await clientA.waitFor(
			record => record.id === "prompt-cancel-outcome",
			"interrupted prompt response",
		);
		expect(promptOutcome).toEqual({ id: "prompt-cancel-outcome", ok: false, error: "Agent turn aborted" });
	});
});
