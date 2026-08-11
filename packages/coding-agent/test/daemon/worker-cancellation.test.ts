import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OmpDaemonWorker } from "../../src/daemon/worker";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";

type WireRecord = Record<string, unknown>;
type RecordMatcher = (record: WireRecord) => boolean;

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

/** Minimal real Unix-socket peer for exercising the worker's JSONL wire. */
class WorkerWireServer {
	readonly #listener: Bun.UnixSocketListener<undefined>;
	#socket: Bun.Socket<undefined> | undefined;
	#buffer = "";
	#closed = false;
	#records: WireRecord[] = [];
	#waiters: Array<{
		matcher: RecordMatcher;
		resolve: (record: WireRecord) => void;
		reject: (error: Error) => void;
	}> = [];
	readonly #closedPromise: Promise<void>;
	readonly #resolveClosed: () => void;

	constructor(socketPath: string, token: string, activeSessionId: string) {
		const closed = Promise.withResolvers<void>();
		this.#closedPromise = closed.promise;
		this.#resolveClosed = closed.resolve;
		this.#listener = Bun.listen({
			unix: socketPath,
			socket: {
				open: socket => {
					this.#socket = socket;
				},
				data: (_socket, data) => this.#receive(data, token, activeSessionId),
				close: () => this.#markClosed(),
				error: (_socket, error) => this.#markClosed(new Error(error.message)),
			},
		});
	}

	send(record: WireRecord): void {
		if (this.#closed || !this.#socket) throw new Error("Worker wire server is closed");
		if (this.#socket.write(`${JSON.stringify(record)}\n`) < 0) {
			throw new Error("Worker wire server write failed");
		}
	}

	waitFor(matcher: RecordMatcher, label: string): Promise<WireRecord> {
		const existing = this.#records.find(matcher);
		if (existing) return Promise.resolve(existing);
		if (this.#closed) return Promise.reject(new Error(`Worker wire closed before ${label}`));
		const { promise, resolve, reject } = Promise.withResolvers<WireRecord>();
		this.#waiters.push({ matcher, resolve, reject });
		return within(promise, label);
	}

	waitClosed(label: string): Promise<void> {
		return within(this.#closedPromise, label);
	}

	stop(): void {
		this.#markClosed();
		try {
			this.#socket?.terminate();
		} catch {
			// The worker may already have ended its side of the connection.
		}
		this.#socket = undefined;
		try {
			this.#listener.stop(true);
		} catch {
			// The listener may already have been stopped by a test failure.
		}
	}

	#receive(data: Uint8Array, token: string, activeSessionId: string): void {
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
			for (const waiter of [...this.#waiters]) {
				if (!waiter.matcher(record)) continue;
				this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
				waiter.resolve(record);
			}
			if (
				record.type === "worker_auth" &&
				typeof record.id === "string" &&
				record.token === token &&
				record.activeSessionId === activeSessionId
			) {
				this.send({ id: record.id, ok: true });
			}
		}
	}

	#markClosed(error?: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#resolveClosed();
		for (const waiter of this.#waiters.splice(0)) waiter.reject(error ?? new Error("Worker wire closed"));
	}
}

interface WorkerFixture {
	root: string;
	agentDir: string;
	socketPath: string;
	token: string;
	activeSessionId: string;
}

const activeWorkers = new Set<OmpDaemonWorker>();
const activeServers = new Set<WorkerWireServer>();
const cleanupRoots: string[] = [];

async function makeFixture(prefix: string): Promise<WorkerFixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanupRoots.push(root);
	const agentDir = path.join(root, "agent");
	await fs.mkdir(agentDir, { recursive: true });
	return {
		root,
		agentDir,
		socketPath: path.join(agentDir, "worker.sock"),
		token: "worker-test-token",
		activeSessionId: "worker-test-session",
	};
}

interface HangingSession {
	session: AgentSession;
	promptStarted: Promise<void>;
	abortStarted: Promise<void>;
	finishPrompt: (result?: boolean) => void;
	promptSettled: () => boolean;
	events: string[];
}

function createHangingSession(
	options: { settlePromptAfterAbort?: boolean; requireSettledBeforeDispose?: boolean } = {},
): HangingSession {
	const promptStarted = Promise.withResolvers<void>();
	const abortStarted = Promise.withResolvers<void>();
	const promptResult = Promise.withResolvers<boolean>();
	const events: string[] = [];
	let didSettlePrompt = false;

	const finishPrompt = (result = true): void => promptResult.resolve(result);
	const session = {
		isStreaming: true,
		messages: [],
		subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
		prompt: async (_message: string) => {
			events.push("prompt-start");
			promptStarted.resolve();
			const result = await promptResult.promise;
			didSettlePrompt = true;
			events.push("prompt-settled");
			return result;
		},
		abort: () => {
			const aborted = Promise.withResolvers<void>();
			queueMicrotask(() => {
				events.push("abort");
				abortStarted.resolve();
				aborted.resolve();
				if (options.settlePromptAfterAbort) {
					// Resolve only after the worker's await abort continuation has been queued.
					queueMicrotask(() => finishPrompt());
				}
			});
			return aborted.promise;
		},
		dispose: async () => {
			events.push("dispose");
			if (options.requireSettledBeforeDispose && !didSettlePrompt) {
				throw new Error("session disposed before prompt settled");
			}
		},
	};
	return {
		session: session as unknown as AgentSession,
		promptStarted: promptStarted.promise,
		abortStarted: abortStarted.promise,
		finishPrompt,
		promptSettled: () => didSettlePrompt,
		events,
	};
}

async function startWorker(fixture: WorkerFixture, server: WorkerWireServer): Promise<OmpDaemonWorker> {
	const worker = new OmpDaemonWorker({
		agentDir: fixture.agentDir,
		supervisorSocket: fixture.socketPath,
		token: fixture.token,
		activeSessionId: fixture.activeSessionId,
		cwd: fixture.root,
	});
	activeWorkers.add(worker);
	await worker.start();
	await server.waitFor(record => record.type === "worker_ready", "worker ready");
	return worker;
}

afterEach(async () => {
	for (const worker of [...activeWorkers]) {
		try {
			await worker.stop();
		} catch {
			// Teardown is best effort; assertions own the wire contract.
		}
	}
	activeWorkers.clear();
	for (const server of [...activeServers]) server.stop();
	activeServers.clear();
	vi.restoreAllMocks();
	for (const root of cleanupRoots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe("daemon worker cancellation wire contract", () => {
	it("reports a cancelled prompt as ok:false even when prompt resolves after abort", async () => {
		const fixture = await makeFixture("omp-daemon-worker-cancel-");
		const session = createHangingSession();
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session: session.session } as never);
		const server = new WorkerWireServer(fixture.socketPath, fixture.token, fixture.activeSessionId);
		activeServers.add(server);
		await startWorker(fixture, server);

		server.send({ id: "prompt-1", type: "prompt", message: "hold this turn" });
		await within(session.promptStarted, "prompt start");
		server.send({ id: "cancel-1", type: "cancel" });
		await within(session.abortStarted, "abort while prompt is pending");
		expect(session.promptSettled()).toBe(false);

		// The fake provider resolves normally after abort; cancellation must still
		// change the worker's externally visible prompt outcome.
		session.finishPrompt(true);
		await expect(server.waitFor(record => record.id === "cancel-1", "cancel response")).resolves.toMatchObject({
			id: "cancel-1",
			ok: true,
		});
		await expect(server.waitFor(record => record.id === "prompt-1", "cancelled prompt response")).resolves.toEqual({
			id: "prompt-1",
			ok: false,
			error: "Daemon prompt cancelled",
		});
	});
});

async function assertDrainBeforeDispose(commandType: "shutdown" | "worker_archive_and_shutdown"): Promise<void> {
	const fixture = await makeFixture(`omp-daemon-worker-${commandType}-`);
	const session = createHangingSession({ settlePromptAfterAbort: true, requireSettledBeforeDispose: true });
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session: session.session } as never);
	const server = new WorkerWireServer(fixture.socketPath, fixture.token, fixture.activeSessionId);
	activeServers.add(server);
	await startWorker(fixture, server);

	server.send({ id: "prompt-1", type: "prompt", message: "hold this turn" });
	await within(session.promptStarted, "prompt start");
	server.send({ id: "lifecycle-1", type: commandType });
	await within(session.abortStarted, `${commandType} abort`);

	await expect(server.waitFor(record => record.id === "prompt-1", "drained prompt response")).resolves.toEqual({
		id: "prompt-1",
		ok: false,
		error: "Daemon prompt cancelled",
	});
	await expect(server.waitFor(record => record.id === "lifecycle-1", `${commandType} response`)).resolves.toEqual({
		id: "lifecycle-1",
		ok: true,
	});
	await within(server.waitClosed(`${commandType} socket close`), `${commandType} socket close`);

	const settledIndex = session.events.indexOf("prompt-settled");
	const disposedIndex = session.events.indexOf("dispose");
	expect(settledIndex).toBeGreaterThanOrEqual(0);
	expect(disposedIndex).toBeGreaterThan(settledIndex);
}

for (const commandType of ["shutdown", "worker_archive_and_shutdown"] as const) {
	it(`${commandType} waits for the active turn before disposing and ending`, async () => {
		await assertDrainBeforeDispose(commandType);
	});
}
