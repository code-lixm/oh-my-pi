import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import Daemon from "../../src/commands/daemon";
import {
	OMP_DAEMON_PROTOCOL_NAME,
	OMP_DAEMON_PROTOCOL_VERSION,
	OMP_DAEMON_SCHEMA_REVISION,
} from "../../src/daemon/protocol";
import { defaultDaemonSocketPath } from "../../src/daemon/socket";
import { OmpDaemonSupervisor } from "../../src/daemon/supervisor";

type CommandResult = {
	stdout: string;
	stderr: string;
	exitCode: typeof process.exitCode;
};

const activeSupervisors = new Set<OmpDaemonSupervisor>();
const activeServers = new Set<RecordingDaemonServer>();
const activeChildren = new Set<Bun.Subprocess>();
const cleanupRoots: string[] = [];
const commandConfig = { bin: "omp", version: "test", commands: new Map() };

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

function text(chunk: string | Uint8Array): string {
	return typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
}

/** Execute the public command class while preserving process-global terminal state. */
async function runDaemon(argv: string[]): Promise<CommandResult> {
	const originalStdout = process.stdout.write;
	const originalStderr = process.stderr.write;
	const originalExitCode = process.exitCode;
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdout += text(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr += text(chunk);
		return true;
	}) as typeof process.stderr.write;
	process.exitCode = 0;
	try {
		await new Daemon(argv, commandConfig).run();
		return { stdout, stderr, exitCode: process.exitCode === 0 ? undefined : process.exitCode };
	} finally {
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
		process.exitCode = originalExitCode ?? 0;
	}
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.lstat(target);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return buffer;
			if (!value) continue;
			buffer += decoder.decode(value, { stream: true });
			const newline = buffer.indexOf("\n");
			if (newline >= 0) return buffer.slice(0, newline);
		}
	} finally {
		reader.releaseLock();
	}
}

async function stopChild(proc: Bun.Subprocess): Promise<void> {
	try {
		proc.kill("SIGKILL");
	} catch {
		// The helper may already have exited after binding its test socket.
	}
	try {
		await within(proc.exited, "stale socket listener exit");
	} catch {
		// A teardown failure must not retain the temporary root or mask the test body.
	}
}

async function spawnStaleSocketListener(root: string, socketPath: string): Promise<Bun.Subprocess> {
	const scriptPath = path.join(root, "stale-socket-listener.ts");
	await fs.writeFile(
		scriptPath,
		[
			"const socketPath = process.argv[2];",
			'if (!socketPath) throw new Error("missing socket path");',
			"Bun.listen({ unix: socketPath, socket: { open() {}, data() {}, close() {}, error() {} } });",
			'process.stdout.write("ready\\n");',
			"setInterval(() => {}, 60_000);",
		].join("\n"),
		"utf8",
	);
	const proc = Bun.spawn([process.execPath, scriptPath, socketPath], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
	});
	activeChildren.add(proc);
	const ready = await within(readFirstLine(proc.stdout), "stale socket listener readiness", 4_000);
	if (ready !== "ready") throw new Error(`stale socket listener failed to start: ${ready}`);
	return proc;
}

/** Minimal real daemon endpoint used to observe the command's JSONL protocol. */
class RecordingDaemonServer {
	readonly #server: net.Server;
	readonly #sockets = new Set<net.Socket>();
	readonly #commands: string[] = [];
	#records: Record<string, unknown>[] = [];
	readonly #promptDisconnected = Promise.withResolvers<void>();
	readonly #stopped = Promise.withResolvers<void>();
	#stopping = false;
	readonly #capabilities: readonly string[];

	private constructor(capabilities: readonly string[]) {
		this.#capabilities = capabilities;
		this.#server = net.createServer(socket => this.#handleConnection(socket));
	}

	static async start(
		socketPath: string,
		capabilities: readonly string[] = ["prompt_cancellation"],
	): Promise<RecordingDaemonServer> {
		const fixture = new RecordingDaemonServer(capabilities);
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				fixture.#server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				fixture.#server.off("error", onError);
				resolve();
			};
			fixture.#server.once("error", onError);
			fixture.#server.once("listening", onListening);
			fixture.#server.listen(socketPath);
		});
		return fixture;
	}

	get commands(): readonly string[] {
		return this.#commands;
	}

	get records(): readonly Record<string, unknown>[] {
		return this.#records;
	}

	waitForPromptDisconnect(): Promise<void> {
		return within(this.#promptDisconnected.promise, "prompt client disconnect");
	}

	waitForStop(): Promise<void> {
		return within(this.#stopped.promise, "daemon fixture stop");
	}

	async stop(): Promise<void> {
		for (const socket of this.#sockets) socket.destroy();
		this.#stopListening();
		await this.waitForStop();
	}

	#handleConnection(socket: net.Socket): void {
		this.#sockets.add(socket);
		socket.setEncoding("utf8");
		socket.on("error", () => {});
		let buffer = "";
		let sawDetach = false;
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				let record: unknown;
				try {
					record = JSON.parse(line);
				} catch {
					continue;
				}
				if (
					record === null ||
					typeof record !== "object" ||
					Array.isArray(record) ||
					!("id" in record) ||
					!("type" in record)
				)
					continue;
				const id = typeof record.id === "string" ? record.id : undefined;
				const type = typeof record.type === "string" ? record.type : undefined;
				if (!id || !type) continue;
				this.#commands.push(type);
				this.#records.push(record as Record<string, unknown>);
				if (type === "detach") sawDetach = true;
				if (type === "hello") {
					const hello = {
						type: "daemon_hello",
						capabilities: this.#capabilities,
						name: OMP_DAEMON_PROTOCOL_NAME,
						version: OMP_DAEMON_PROTOCOL_VERSION,
						schemaRevision: OMP_DAEMON_SCHEMA_REVISION,
					};
					const response = { id, ok: true, data: { capabilities: this.#capabilities } };
					socket.write(`${JSON.stringify(hello)}\n${JSON.stringify(response)}\n`);
					continue;
				}
				const response = `${JSON.stringify({ id, ok: true })}\n`;
				if (type !== "shutdown") {
					socket.write(response);
					continue;
				}
				socket.write(response, () => {
					socket.end();
					this.#stopListening();
				});
			}
		});
		socket.once("close", () => {
			this.#sockets.delete(socket);
			if (sawDetach) this.#promptDisconnected.resolve();
		});
	}

	#stopListening(): void {
		if (this.#stopping) return;
		this.#stopping = true;
		this.#server.close(error => {
			if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
				this.#stopped.reject(error);
				return;
			}
			this.#stopped.resolve();
		});
	}
}

async function makeRoot(prefix: string): Promise<{ root: string; agentDir: string; socketPath: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanupRoots.push(root);
	const agentDir = path.join(root, "agent");
	await fs.mkdir(agentDir, { recursive: true });
	return { root, agentDir, socketPath: defaultDaemonSocketPath(agentDir) };
}

afterEach(async () => {
	for (const supervisor of [...activeSupervisors]) {
		try {
			await supervisor.stop();
		} catch {
			// The test assertions cover lifecycle behavior; teardown is best effort.
		}
	}
	activeSupervisors.clear();
	for (const server of [...activeServers]) {
		try {
			await server.stop();
		} catch {
			// The listener may already have stopped after a shutdown request.
		}
	}
	activeServers.clear();
	for (const child of [...activeChildren]) await stopChild(child);
	activeChildren.clear();
	for (const root of cleanupRoots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe("daemon command lifecycle", () => {
	it("keeps explicitly selected agent directories isolated", async () => {
		const first = await makeRoot("omp-daemon-agent-a-");
		const second = await makeRoot("omp-daemon-agent-b-");
		const supervisorA = new OmpDaemonSupervisor({ agentDir: first.agentDir, socketPath: first.socketPath });
		activeSupervisors.add(supervisorA);
		await supervisorA.start();

		const firstStatus = await runDaemon(["status", "--agent-dir", first.agentDir]);
		const secondStatusBeforeStart = await runDaemon(["status", "--agent-dir", second.agentDir]);
		expect(firstStatus).toEqual({ stdout: "daemon: running\n", stderr: "", exitCode: undefined });
		expect(secondStatusBeforeStart).toEqual({ stdout: "daemon: not running\n", stderr: "", exitCode: undefined });

		const supervisorB = new OmpDaemonSupervisor({ agentDir: second.agentDir, socketPath: second.socketPath });
		activeSupervisors.add(supervisorB);
		await supervisorB.start();
		await supervisorA.stop();

		const secondStatusAfterFirstStops = await runDaemon(["status", "--agent-dir", second.agentDir]);
		expect(secondStatusAfterFirstStops).toEqual({ stdout: "daemon: running\n", stderr: "", exitCode: undefined });
	});

	it("cleans a dead daemon socket before reporting status", async () => {
		const { root, agentDir, socketPath } = await makeRoot("omp-daemon-stale-");
		const child = await spawnStaleSocketListener(root, socketPath);
		await stopChild(child);
		activeChildren.delete(child);
		expect(await pathExists(socketPath)).toBe(true);

		const result = await runDaemon(["status", "--agent-dir", agentDir]);
		expect(result).toEqual({
			stdout: "daemon: not running (stale socket cleaned)\n",
			stderr: "",
			exitCode: undefined,
		});
		expect(await pathExists(socketPath)).toBe(false);
	});

	it("detaches a prompted session and leaves no socket after stop", async () => {
		const { agentDir, socketPath } = await makeRoot("omp-daemon-prompt-stop-");
		const server = await RecordingDaemonServer.start(socketPath);
		activeServers.add(server);
		const sigintListenersBefore = process.listeners("SIGINT");

		const prompt = await runDaemon([
			"prompt",
			"--agent-dir",
			agentDir,
			"--session",
			"session-1",
			"--message",
			"continue from the detached terminal",
		]);
		expect(prompt).toEqual({ stdout: "daemon: prompt sent to session-1\n", stderr: "", exitCode: undefined });
		expect(process.listeners("SIGINT")).toEqual(sigintListenersBefore);
		await server.waitForPromptDisconnect();

		const stop = await runDaemon(["stop", "--agent-dir", agentDir]);
		expect(stop).toEqual({ stdout: "daemon: stopped\n", stderr: "", exitCode: undefined });
		await server.waitForStop();
		expect(server.commands).toEqual(["hello", "attach", "prompt", "detach", "shutdown"]);
		expect(await pathExists(socketPath)).toBe(false);
	});

	it("rejects prompt when the daemon lacks prompt_cancellation capability", async () => {
		const { agentDir, socketPath } = await makeRoot("omp-daemon-prompt-capability-");
		const server = await RecordingDaemonServer.start(socketPath, []);
		activeServers.add(server);

		const prompt = await runDaemon([
			"prompt",
			"--agent-dir",
			agentDir,
			"--session",
			"session-1",
			"--message",
			"this prompt must not be admitted",
		]);
		expect(prompt).toEqual({
			stdout: "",
			stderr: "daemon: Daemon does not support prompt_cancellation; restart it with the current OMP version\n",
			exitCode: 1,
		});
		expect(server.commands).toEqual(["hello"]);
	});

	it("sends a targeted cancel for the selected session", async () => {
		const { agentDir, socketPath } = await makeRoot("omp-daemon-cancel-cmd-");
		const server = await RecordingDaemonServer.start(socketPath);
		activeServers.add(server);

		const result = await runDaemon(["cancel", "--agent-dir", agentDir, "--session", "session-1"]);
		expect(result).toEqual({ stdout: "daemon: cancel sent to session-1\n", stderr: "", exitCode: undefined });
		expect(server.commands).toEqual(["cancel"]);
		expect(server.records).toContainEqual({ id: "cancel-1", type: "cancel", activeSessionId: "session-1" });
	});
});
