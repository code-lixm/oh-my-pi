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
import { clearStaleDaemonSocket, ensureDaemonSupervisor } from "../daemon/ensure";
import type { OmpDaemonEvent } from "../daemon/protocol";
import {
	cleanupDaemonSocketPath,
	type DaemonSocketIdentity,
	defaultDaemonSocketPath,
	getDaemonSocketIdentity,
	getDaemonSocketStatus,
} from "../daemon/socket";
import type { AgentSessionEvent } from "../session/agent-session-events";

function daemonHelpText(): string {
	return "Manage the background session daemon (start, status, stop, create, list, prompt, cancel)";
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
				try {
					const { started } = await ensureDaemonSupervisor({ agentDir, socketPath });
					process.stdout.write(started ? "daemon: started\n" : "daemon: already running\n");
				} catch (error) {
					if (
						error instanceof Error &&
						error.message === `Daemon socket path exists and is not a socket: ${socketPath}`
					) {
						process.stderr.write(`daemon: socket path is not a socket: ${socketPath}\n`);
						process.exitCode = 1;
						return;
					}
					throw error;
				}
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
