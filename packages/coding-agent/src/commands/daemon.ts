/**
 * Daemon control plane: start/stop the local session supervisor, list
 * sessions, and drive a session through the JSONL Unix-socket protocol.
 * The supervisor and its workers run as detached subprocesses so sessions
 * outlive the launching terminal.
 */

import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { Command, Flags } from "../cli/command-runtime";
import { type DaemonClientRequestOptions, sendDaemonCommand, sendDaemonPrompt } from "../daemon/client";
import type { OmpDaemonEvent } from "../daemon/protocol";
import {
	acquireDaemonSocketPathLease,
	cleanupDaemonSocketPath,
	type DaemonSocketIdentity,
	defaultDaemonSocketPath,
	getDaemonSocketIdentity,
	getDaemonSocketStatus,
	prepareDaemonSocketPath,
} from "../daemon/socket";
import {
	OMP_DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	OMP_DAEMON_WORKER_AGENT_DIR_ENV,
	OMP_DAEMON_WORKER_CWD_ENV,
	OMP_DAEMON_WORKER_ROLE_ENV,
	OMP_DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
	OMP_DAEMON_WORKER_TOKEN_ENV,
} from "../daemon/worker";
import type { AgentSessionEvent } from "../session/agent-session-events";
import { resolveWorkerSpawnCmd } from "../subprocess/worker-client";

const SUPERVISOR_ARG = "__omp_worker_daemon_supervisor";

function daemonHelpText(): string {
	return "Manage the background session daemon (start, status, stop, create, list, prompt, cancel)";
}

async function clearStaleDaemonSocket(socketPath: string): Promise<"live" | "missing"> {
	const lease = await acquireDaemonSocketPathLease(socketPath);
	try {
		const status = await getDaemonSocketStatus(socketPath);
		if (status === "live" || status === "missing") return status;
		if (status === "not_socket") throw new Error(`Daemon socket path exists and is not a socket: ${socketPath}`);
		try {
			await prepareDaemonSocketPath(socketPath, lease);
		} catch (error) {
			const afterFailure = await getDaemonSocketStatus(socketPath);
			if (afterFailure === "live" || afterFailure === "missing") return afterFailure;
			if (afterFailure === "not_socket") {
				throw new Error(`Daemon socket path exists and is not a socket: ${socketPath}`);
			}
			throw error;
		}
		const afterCleanup = await getDaemonSocketStatus(socketPath);
		if (afterCleanup === "live" || afterCleanup === "missing") return afterCleanup;
		if (afterCleanup === "not_socket")
			throw new Error(`Daemon socket path exists and is not a socket: ${socketPath}`);
		throw new Error(`Unable to remove stale daemon socket: ${socketPath}`);
	} finally {
		await lease?.release();
	}
}

async function spawnSupervisor(agentDir: string, socketPath: string): Promise<void> {
	// Re-enter the CLI host entry exactly like a worker, with a dedicated
	// selector so the supervisor survives compiled-binary builds.
	const { cmd, cwd } = resolveWorkerSpawnCmd(SUPERVISOR_ARG);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		[OMP_DAEMON_WORKER_ROLE_ENV]: "1",
		[OMP_DAEMON_WORKER_SUPERVISOR_SOCKET_ENV]: socketPath,
		[OMP_DAEMON_WORKER_AGENT_DIR_ENV]: agentDir,
		[OMP_DAEMON_WORKER_TOKEN_ENV]: "supervisor",
		[OMP_DAEMON_WORKER_ACTIVE_SESSION_ID_ENV]: "supervisor",
		[OMP_DAEMON_WORKER_CWD_ENV]: process.cwd(),
	};
	const proc = Bun.spawn(cmd, {
		cwd,
		env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		detached: true,
	});
	proc.unref();
	let startupFailure: Error | undefined;
	void proc.exited.then(
		exitCode => {
			startupFailure = new Error(`Daemon supervisor exited before opening its socket (code ${exitCode})`);
		},
		error => {
			startupFailure = new Error(
				`Daemon supervisor failed before opening its socket: ${error instanceof Error ? error.message : String(error)}`,
			);
		},
	);
	try {
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			if ((await getDaemonSocketStatus(socketPath)) === "live") return;
			if (startupFailure) throw startupFailure;
			await Bun.sleep(100);
		}
		throw new Error("Daemon supervisor did not accept connections within 15s");
	} catch (error) {
		let socketIdentity: DaemonSocketIdentity | undefined;
		try {
			socketIdentity = getDaemonSocketIdentity(socketPath);
		} catch {
			// No socket was bound, or another daemon already removed it.
		}
		try {
			proc.kill("SIGKILL");
		} catch {
			// The supervisor may have exited while startup failure was handled.
		}
		try {
			await proc.exited;
		} catch {
			// Kill has already made the detached child ineligible to outlive this command.
		}
		if (socketIdentity) cleanupDaemonSocketPath(socketPath, socketIdentity, undefined);
		throw error;
	}
}

/** Attach, acknowledge the prompt, then detach without retaining a client lease. */
async function runDaemonPrompt(
	socketPath: string,
	activeSessionId: string,
	message: string,
	options: DaemonClientRequestOptions = {},
): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> {
	try {
		return await sendDaemonPrompt(socketPath, activeSessionId, message, options);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** One short progress line for a session event, or undefined to stay quiet. */
function formatDaemonProgress(event: AgentSessionEvent): string | undefined {
	switch (event.type) {
		case "agent_start":
			return "agent started";
		case "agent_end":
			return "agent finished";
		case "turn_start":
			return "turn started";
		case "turn_end":
			return "turn finished";
		case "message_start":
			return `${event.message.role} message added`;
		case "message_update":
			return undefined;
		case "message_end":
			return `${event.message.role} message complete`;
		case "tool_execution_start":
			return `tool ${event.toolName} started`;
		case "tool_execution_update":
			return `tool ${event.toolName} running`;
		case "tool_execution_end":
			return `tool ${event.toolName} ${event.isError ? "failed" : "finished"}`;
		default:
			return undefined;
	}
}

/** Surface a daemon event as a CLI progress line when it carries turn progress. */
function writeDaemonProgress(event: OmpDaemonEvent): void {
	if (event.type !== "session_event") return;
	const line = formatDaemonProgress(event.event);
	if (line) process.stdout.write(`daemon: ${line}\n`);
}

export default class Daemon extends Command {
	static description = daemonHelpText();
	static flags = {
		"agent-dir": Flags.string({ description: "Agent directory to use" }),
		session: Flags.string({ description: "Active session id to target (prompt subcommand)" }),
		message: Flags.string({ description: "Prompt message body (prompt subcommand)" }),
	};

	static args = {
		subcommand: Flags.string({ description: "start | status | stop | create | prompt | cancel | list" }),
	};

	async run(): Promise<void> {
		const { flags, args } = await this.parse(Daemon);
		const subcommand = args.subcommand ?? "status";
		const agentDir = path.resolve(flags["agent-dir"] ?? getAgentDir());
		const socketPath = defaultDaemonSocketPath(agentDir);

		switch (subcommand) {
			case "start": {
				const status = await getDaemonSocketStatus(socketPath);
				if (status === "live") {
					process.stdout.write("daemon: already running\n");
					return;
				}
				if (status === "not_socket") {
					process.stderr.write(`daemon: socket path is not a socket: ${socketPath}\n`);
					process.exitCode = 1;
					return;
				}
				if (status === "stale" && (await clearStaleDaemonSocket(socketPath)) === "live") {
					process.stdout.write("daemon: already running\n");
					return;
				}
				await spawnSupervisor(agentDir, socketPath);
				process.stdout.write("daemon: started\n");
				return;
			}
			case "status": {
				const status = await getDaemonSocketStatus(socketPath);
				if (status === "live") {
					process.stdout.write("daemon: running\n");
					return;
				}
				if (status === "not_socket") {
					process.stderr.write(`daemon: socket path is not a socket: ${socketPath}\n`);
					process.exitCode = 1;
					return;
				}
				if (status === "stale") {
					const afterCleanup = await clearStaleDaemonSocket(socketPath);
					process.stdout.write(
						afterCleanup === "live" ? "daemon: running\n" : "daemon: not running (stale socket cleaned)\n",
					);
					return;
				}
				process.stdout.write("daemon: not running\n");
				return;
			}
			case "stop": {
				const status = await getDaemonSocketStatus(socketPath);
				if (status === "not_socket") {
					process.stderr.write(`daemon: socket path is not a socket: ${socketPath}\n`);
					process.exitCode = 1;
					return;
				}
				if (status === "stale") {
					const afterCleanup = await clearStaleDaemonSocket(socketPath);
					if (afterCleanup === "live") {
						process.stderr.write("daemon: daemon became reachable while clearing its stale socket; retry stop\n");
						process.exitCode = 1;
						return;
					}
					process.stdout.write("daemon: not running (stale socket cleaned)\n");
					return;
				}
				if (status === "missing") {
					process.stdout.write("daemon: not running\n");
					return;
				}
				let socketIdentity: DaemonSocketIdentity | undefined;
				try {
					socketIdentity = getDaemonSocketIdentity(socketPath);
				} catch {
					// The live endpoint may disappear before its shutdown command is sent.
				}
				try {
					await sendDaemonCommand(socketPath, { id: "stop-1", type: "shutdown" });
				} catch {
					// The supervisor may have already exited; fall through to identity-safe cleanup.
				}
				if (socketIdentity) cleanupDaemonSocketPath(socketPath, socketIdentity, undefined);
				process.stdout.write("daemon: stopped\n");
				return;
			}
			case "create": {
				const cwd = process.cwd();
				const response = await sendDaemonCommand(socketPath, { id: "create-1", type: "create", cwd });
				if (!response.ok) {
					process.stderr.write(`daemon: ${response.error}\n`);
					process.exitCode = 1;
					return;
				}
				const data = response.data as { activeSessionId: string; sessionPath: string; status: string };
				process.stdout.write(`daemon: created ${data.activeSessionId} (${data.status}) at ${data.sessionPath}\n`);
				return;
			}
			case "list": {
				const response = await sendDaemonCommand(socketPath, { id: "list-1", type: "list_sessions" });
				if (!response.ok) {
					process.stderr.write(`daemon: ${response.error}\n`);
					process.exitCode = 1;
					return;
				}
				const data = response.data as Array<{ activeSessionId: string; cwd: string; status: string }>;
				for (const session of data) {
					process.stdout.write(`${session.activeSessionId}  ${session.status}  ${session.cwd}\n`);
				}
				return;
			}
			case "prompt": {
				const message = flags.message;
				if (!message) {
					process.stderr.write("daemon: prompt requires --message <text>\n");
					process.exitCode = 1;
					return;
				}
				let activeSessionId = flags.session;
				if (!activeSessionId) {
					const response = await sendDaemonCommand(socketPath, { id: "list-1", type: "list_sessions" });
					if (!response.ok) {
						process.stderr.write(`daemon: ${response.error}\n`);
						process.exitCode = 1;
						return;
					}
					const sessions = response.data as Array<{ activeSessionId: string; status: string }>;
					const live = sessions.filter(session => session.status !== "stopped");
					if (live.length !== 1) {
						process.stderr.write(
							live.length === 0
								? "daemon: no running sessions; create one first\n"
								: "daemon: multiple sessions; pass --session <id>\n",
						);
						process.exitCode = 1;
						return;
					}
					activeSessionId = live[0]!.activeSessionId;
				}
				// A one-shot CLI subcommand owns SIGINT while the prompt is active:
				// temporarily replace postmortem's exit(130) handler, then restore all
				// prior listeners so in-process command callers are not polluted.
				const previousSigintListeners = process.listeners("SIGINT");
				process.removeAllListeners("SIGINT");
				const abort = new AbortController();
				const onSigint = (): void => abort.abort();
				process.once("SIGINT", onSigint);
				let result: { ok: boolean; error?: string; cancelled?: boolean };
				try {
					result = await runDaemonPrompt(socketPath, activeSessionId, message, {
						signal: abort.signal,
						onEvent: writeDaemonProgress,
					});
				} finally {
					process.removeListener("SIGINT", onSigint);
					for (const listener of previousSigintListeners) process.on("SIGINT", listener);
				}
				if (result.cancelled) {
					process.stdout.write(`daemon: prompt cancelled for ${activeSessionId}\n`);
					return;
				}
				if (!result.ok) {
					process.stderr.write(`daemon: ${result.error}\n`);
					process.exitCode = 1;
					return;
				}
				process.stdout.write(`daemon: prompt sent to ${activeSessionId}\n`);
				return;
			}
			case "cancel": {
				let activeSessionId = flags.session;
				if (!activeSessionId) {
					const response = await sendDaemonCommand(socketPath, { id: "list-1", type: "list_sessions" });
					if (!response.ok) {
						process.stderr.write(`daemon: ${response.error}\n`);
						process.exitCode = 1;
						return;
					}
					const sessions = response.data as Array<{ activeSessionId: string; status: string }>;
					const live = sessions.filter(session => session.status !== "stopped");
					if (live.length !== 1) {
						process.stderr.write(
							live.length === 0
								? "daemon: no running sessions; create one first\n"
								: "daemon: multiple sessions; pass --session <id>\n",
						);
						process.exitCode = 1;
						return;
					}
					activeSessionId = live[0]!.activeSessionId;
				}
				const response = await sendDaemonCommand(socketPath, {
					id: "cancel-1",
					type: "cancel",
					activeSessionId,
				});
				if (!response.ok) {
					process.stderr.write(`daemon: ${response.error}\n`);
					process.exitCode = 1;
					return;
				}
				process.stdout.write(`daemon: cancel sent to ${activeSessionId}\n`);
				return;
			}
			default:
				process.stderr.write(`daemon: unknown subcommand ${subcommand}\n`);
				process.exitCode = 1;
		}
	}
}
