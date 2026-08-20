import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { resolveWorkerSpawnCmd } from "../subprocess/worker-client";
import {
	acquireDaemonSocketPathLease,
	cleanupDaemonSocketPath,
	type DaemonSocketIdentity,
	type DaemonSocketPathLease,
	defaultDaemonSocketPath,
	getDaemonSocketIdentity,
	getDaemonSocketStatus,
	prepareDaemonSocketPath,
} from "./socket";
import {
	OMP_DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	OMP_DAEMON_WORKER_AGENT_DIR_ENV,
	OMP_DAEMON_WORKER_CWD_ENV,
	OMP_DAEMON_WORKER_ROLE_ENV,
	OMP_DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
	OMP_DAEMON_WORKER_TOKEN_ENV,
} from "./worker";

const SUPERVISOR_ARG = "__omp_worker_daemon_supervisor";

export type EnsureDaemonSupervisorOptions = {
	agentDir?: string;
	socketPath?: string;
};

export type EnsuredDaemonSupervisor = {
	agentDir: string;
	socketPath: string;
	started: boolean;
};

function daemonSocketPathNotSocketError(socketPath: string): Error {
	return new Error(`Daemon socket path exists and is not a socket: ${socketPath}`);
}

/** Remove a stale socket while coordinating with competing daemon commands. */
export async function clearStaleDaemonSocket(socketPath: string): Promise<"live" | "missing"> {
	const lease = await acquireDaemonSocketPathLease(socketPath);
	try {
		return await clearStaleDaemonSocketWithLease(socketPath, lease);
	} finally {
		await lease?.release();
	}
}

async function clearStaleDaemonSocketWithLease(
	socketPath: string,
	lease?: DaemonSocketPathLease,
): Promise<"live" | "missing"> {
	const status = await getDaemonSocketStatus(socketPath);
	if (status === "live" || status === "missing") return status;
	if (status === "not_socket") throw daemonSocketPathNotSocketError(socketPath);
	try {
		await prepareDaemonSocketPath(socketPath, lease);
	} catch (error) {
		const afterFailure = await getDaemonSocketStatus(socketPath);
		if (afterFailure === "live" || afterFailure === "missing") return afterFailure;
		if (afterFailure === "not_socket") throw daemonSocketPathNotSocketError(socketPath);
		throw error;
	}
	const afterCleanup = await getDaemonSocketStatus(socketPath);
	if (afterCleanup === "live" || afterCleanup === "missing") return afterCleanup;
	if (afterCleanup === "not_socket") throw daemonSocketPathNotSocketError(socketPath);
	throw new Error(`Unable to remove stale daemon socket: ${socketPath}`);
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

/** Ensure the agent-directory-scoped supervisor is reachable. */
export async function ensureDaemonSupervisor(
	options: EnsureDaemonSupervisorOptions = {},
): Promise<EnsuredDaemonSupervisor> {
	const agentDir = path.resolve(options.agentDir ?? getAgentDir());
	const socketPath = options.socketPath ?? defaultDaemonSocketPath(agentDir);
	let lease = await acquireDaemonSocketPathLease(socketPath);
	try {
		const status = await clearStaleDaemonSocketWithLease(socketPath, lease);
		if (status === "live") return { agentDir, socketPath, started: false };
		// The child supervisor must acquire this lease before it can bind the socket.
		// Holding it while polling the child deadlocks first-time `daemon start`.
		await lease?.release();
		lease = undefined;
		await spawnSupervisor(agentDir, socketPath);
		return { agentDir, socketPath, started: true };
	} finally {
		await lease?.release();
	}
}
