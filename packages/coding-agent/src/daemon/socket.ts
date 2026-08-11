import type { Stats } from "node:fs";
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdir, open, unlink } from "node:fs/promises";
import type { Socket } from "node:net";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Mode applied to the Unix-domain socket after its server starts listening. */
export const OMP_DAEMON_SOCKET_MODE = 0o600;

/** Mode applied to the directory that contains a daemon Unix-domain socket. */
export const OMP_DAEMON_SOCKET_DIR_MODE = 0o700;

const DAEMON_SOCKET_LOCK_STALE_MS = 5_000;
const DAEMON_SOCKET_LOCK_UPDATE_MS = 1_000;
const DAEMON_SOCKET_LOCK_RETRY_COUNT = 600;
const DAEMON_SOCKET_LOCK_RETRY_MS = 25;
const DAEMON_SOCKET_RELEASE_GRACE_MS = 1_000;
const DAEMON_SOCKET_RELEASE_POLL_MS = 25;

/** Filesystem identity used to avoid unlinking a socket another daemon replaced. */
export interface DaemonSocketIdentity {
	dev: number;
	ino: number;
}

interface DaemonSocketLock {
	file: FileHandle;
	identity: DaemonSocketIdentity;
}

interface SyncDaemonSocketLock {
	descriptor: number;
	identity: DaemonSocketIdentity;
}

/**
 * Exclusive ownership of a daemon socket path. Keep the lease through bind and
 * shutdown so competing supervisors cannot remove or claim the same path.
 */
export class DaemonSocketPathLease {
	#released = false;
	#refreshTimer: NodeJS.Timeout | undefined;
	readonly #lockPath: string;
	readonly #lock: DaemonSocketLock;

	constructor(
		readonly socketPath: string,
		lockPath: string,
		lock: DaemonSocketLock,
	) {
		this.#lockPath = lockPath;
		this.#lock = lock;
		this.#refreshTimer = setInterval(() => {
			void this.#refresh();
		}, DAEMON_SOCKET_LOCK_UPDATE_MS);
		this.#refreshTimer.unref();
	}

	get released(): boolean {
		return this.#released;
	}

	async release(): Promise<void> {
		if (this.#released) {
			return;
		}
		this.#released = true;
		if (this.#refreshTimer) {
			clearInterval(this.#refreshTimer);
			this.#refreshTimer = undefined;
		}

		try {
			await this.#lock.file.close();
		} finally {
			await unlinkLockIfOwned(this.#lockPath, this.#lock.identity);
		}
	}

	async #refresh(): Promise<void> {
		if (this.#released) {
			return;
		}
		try {
			const now = new Date();
			await this.#lock.file.utimes(now, now);
		} catch {
			// A failed heartbeat only makes this lease eligible for stale recovery.
		}
	}
}

/** Default endpoint, isolated under an explicit agent directory when supplied. */
export function defaultDaemonSocketPath(agentDir?: string): string {
	return agentDir ? join(resolve(agentDir), "daemon.sock") : join(homedir(), ".omp", "daemon.sock");
}

/**
 * Acquire a renewable lock for a Unix socket path. The lock is an atomically
 * created sibling file and stale locks become recoverable after five seconds.
 */
export async function acquireDaemonSocketPathLease(socketPath: string): Promise<DaemonSocketPathLease | undefined> {
	await ensureDaemonSocketDirectory(socketPath);
	if (process.platform === "win32") {
		return undefined;
	}

	const lockPath = daemonSocketLockPath(socketPath);
	for (let attempt = 0; attempt < DAEMON_SOCKET_LOCK_RETRY_COUNT; attempt += 1) {
		const lock = await tryAcquireDaemonSocketLock(lockPath);
		if (lock) {
			return new DaemonSocketPathLease(socketPath, lockPath, lock);
		}
		if (!(await removeStaleDaemonSocketLock(lockPath))) {
			await Bun.sleep(DAEMON_SOCKET_LOCK_RETRY_MS);
		}
	}

	throw new Error(`Timed out acquiring daemon socket lease: ${socketPath}`);
}

/**
 * Secure the socket directory and remove a stale Unix-domain socket. A caller
 * that will bind the path should hold its lease from prepare through cleanup.
 */
export async function prepareDaemonSocketPath(socketPath: string, lease?: DaemonSocketPathLease): Promise<void> {
	await ensureDaemonSocketDirectory(socketPath);
	if (process.platform === "win32") {
		return;
	}

	if (lease) {
		assertSocketLease(socketPath, lease);
		await prepareUnixDaemonSocketPath(socketPath);
		return;
	}

	const ownedLease = await acquireDaemonSocketPathLease(socketPath);
	try {
		await prepareUnixDaemonSocketPath(socketPath);
	} finally {
		await ownedLease?.release();
	}
}

/** Apply the private socket mode after a server has successfully bound the path. */
export function restrictDaemonSocketPath(socketPath: string): void {
	if (process.platform === "win32") {
		return;
	}
	chmodSync(socketPath, OMP_DAEMON_SOCKET_MODE);
}

/** Return the current filesystem identity of a Unix socket path. */
export function getDaemonSocketIdentity(socketPath: string): DaemonSocketIdentity | undefined {
	if (process.platform === "win32") {
		return undefined;
	}
	return toSocketIdentity(lstatSync(socketPath));
}
/** Liveness state distinguishes a connectable daemon from stale filesystem residue. */
export type DaemonSocketStatus = "live" | "missing" | "stale" | "not_socket";

/** Probe a daemon endpoint by connecting, not merely by inspecting its inode. */
export async function getDaemonSocketStatus(socketPath: string): Promise<DaemonSocketStatus> {
	let stat: Stats;
	try {
		stat = await lstat(socketPath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return "missing";
		throw error;
	}
	if (!stat.isSocket()) return "not_socket";
	return (await canConnectToUnixSocket(socketPath)) ? "live" : "stale";
}

/**
 * Best-effort socket cleanup. An expected identity prevents an old daemon from
 * unlinking a replacement socket; a supplied lease avoids a second lock.
 */
export function cleanupDaemonSocketPath(
	socketPath: string,
	expectedIdentity?: DaemonSocketIdentity,
	lease?: DaemonSocketPathLease,
): void {
	if (process.platform === "win32") {
		return;
	}

	if (lease) {
		assertSocketLease(socketPath, lease);
		try {
			cleanupUnixDaemonSocketPath(socketPath, expectedIdentity);
		} catch {
			// Shutdown must not be blocked by a best-effort stale socket cleanup.
		}
		return;
	}

	let lock: SyncDaemonSocketLock | undefined;
	try {
		ensureDaemonSocketDirectorySync(socketPath);
		lock = tryAcquireDaemonSocketLockSync(daemonSocketLockPath(socketPath));
		if (!lock) {
			return;
		}
		cleanupUnixDaemonSocketPath(socketPath, expectedIdentity);
	} catch {
		// Shutdown must not be blocked by a best-effort stale socket cleanup.
	} finally {
		if (lock) {
			releaseDaemonSocketLockSync(daemonSocketLockPath(socketPath), lock);
		}
	}
}

async function prepareUnixDaemonSocketPath(socketPath: string): Promise<void> {
	let stat: Stats;
	try {
		stat = await lstat(socketPath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return;
		}
		throw error;
	}

	if (!stat.isSocket()) {
		throw new Error(`Daemon socket path exists and is not a socket: ${socketPath}`);
	}

	const staleIdentity = toSocketIdentity(stat);
	if (await canConnectToUnixSocket(socketPath)) {
		throw new Error(`Daemon socket already in use: ${socketPath}`);
	}

	const releaseDeadline = Date.now() + DAEMON_SOCKET_RELEASE_GRACE_MS;
	for (;;) {
		await Bun.sleep(DAEMON_SOCKET_RELEASE_POLL_MS);

		let currentStat: Stats;
		try {
			currentStat = await lstat(socketPath);
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return;
			throw error;
		}
		if (!currentStat.isSocket() || !sameSocketIdentity(toSocketIdentity(currentStat), staleIdentity)) {
			throw new Error(`Daemon socket changed ownership while waiting for cleanup: ${socketPath}`);
		}
		if (await canConnectToUnixSocket(socketPath)) {
			throw new Error(`Daemon socket already in use: ${socketPath}`);
		}
		if (Date.now() >= releaseDeadline) break;
	}

	cleanupUnixDaemonSocketPath(socketPath, staleIdentity);
}

function cleanupUnixDaemonSocketPath(socketPath: string, expectedIdentity?: DaemonSocketIdentity): void {
	let stat: Stats;
	try {
		stat = lstatSync(socketPath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return;
		}
		throw error;
	}
	if (!stat.isSocket()) {
		return;
	}
	const identity = expectedIdentity ?? toSocketIdentity(stat);
	if (expectedIdentity && !sameSocketIdentity(toSocketIdentity(stat), expectedIdentity)) {
		return;
	}

	// A stale probe and cleanup can race a newly-bound daemon. Re-read the
	// pathname immediately before unlinking so an old cleanup never removes its
	// replacement.
	try {
		stat = lstatSync(socketPath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return;
		throw error;
	}
	if (!stat.isSocket() || !sameSocketIdentity(toSocketIdentity(stat), identity)) return;
	unlinkSync(socketPath);
}

async function ensureDaemonSocketDirectory(socketPath: string): Promise<void> {
	const socketDir = dirname(socketPath);
	await mkdir(socketDir, { recursive: true, mode: OMP_DAEMON_SOCKET_DIR_MODE });
	const stat = await lstat(socketDir);
	if (!stat.isDirectory()) {
		throw new Error(`Daemon socket directory is not a directory: ${socketDir}`);
	}
	assertCurrentUserOwnsDirectory(socketDir, stat.uid);
	await chmod(socketDir, OMP_DAEMON_SOCKET_DIR_MODE);
}

function ensureDaemonSocketDirectorySync(socketPath: string): void {
	const socketDir = dirname(socketPath);
	mkdirSync(socketDir, { recursive: true, mode: OMP_DAEMON_SOCKET_DIR_MODE });
	const stat = lstatSync(socketDir);
	if (!stat.isDirectory()) {
		throw new Error(`Daemon socket directory is not a directory: ${socketDir}`);
	}
	assertCurrentUserOwnsDirectory(socketDir, stat.uid);
	chmodSync(socketDir, OMP_DAEMON_SOCKET_DIR_MODE);
}

function assertCurrentUserOwnsDirectory(socketDir: string, ownerUid: number): void {
	if (typeof process.getuid === "function" && ownerUid !== process.getuid()) {
		throw new Error(`Daemon socket directory is not owned by the current user: ${socketDir}`);
	}
}

async function tryAcquireDaemonSocketLock(lockPath: string): Promise<DaemonSocketLock | undefined> {
	let file: FileHandle | undefined;
	let identity: DaemonSocketIdentity | undefined;
	try {
		file = await open(lockPath, "wx", OMP_DAEMON_SOCKET_MODE);
		await file.chmod(OMP_DAEMON_SOCKET_MODE);
		identity = toSocketIdentity(await file.stat());
		return { file, identity };
	} catch (error) {
		if (file) {
			try {
				await file.close();
			} finally {
				if (identity) {
					await unlinkLockIfOwned(lockPath, identity);
				}
			}
		}
		if (hasErrorCode(error, "EEXIST")) {
			return undefined;
		}
		throw error;
	}
}

async function removeStaleDaemonSocketLock(lockPath: string): Promise<boolean> {
	let stat: Stats;
	try {
		stat = await lstat(lockPath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return true;
		}
		throw error;
	}
	if (!stat.isFile()) {
		throw new Error(`Daemon socket lock is not a regular file: ${lockPath}`);
	}
	if (Date.now() - stat.mtimeMs <= DAEMON_SOCKET_LOCK_STALE_MS) {
		return false;
	}
	try {
		return await unlinkStaleLockIfOwned(lockPath, toSocketIdentity(stat));
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return true;
		}
		throw error;
	}
}

async function unlinkStaleLockIfOwned(lockPath: string, expectedIdentity: DaemonSocketIdentity): Promise<boolean> {
	let stat: Stats;
	try {
		stat = await lstat(lockPath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return true;
		throw error;
	}
	if (
		!stat.isFile() ||
		!sameSocketIdentity(toSocketIdentity(stat), expectedIdentity) ||
		Date.now() - stat.mtimeMs <= DAEMON_SOCKET_LOCK_STALE_MS
	) {
		return false;
	}
	try {
		stat = await lstat(lockPath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return true;
		throw error;
	}
	if (
		!stat.isFile() ||
		!sameSocketIdentity(toSocketIdentity(stat), expectedIdentity) ||
		Date.now() - stat.mtimeMs <= DAEMON_SOCKET_LOCK_STALE_MS
	) {
		return false;
	}
	await unlink(lockPath);
	return true;
}

async function unlinkLockIfOwned(lockPath: string, expectedIdentity: DaemonSocketIdentity): Promise<boolean> {
	let stat: Stats;
	try {
		stat = await lstat(lockPath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}
	if (!stat.isFile() || !sameSocketIdentity(toSocketIdentity(stat), expectedIdentity)) return false;
	try {
		stat = await lstat(lockPath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}
	if (!stat.isFile() || !sameSocketIdentity(toSocketIdentity(stat), expectedIdentity)) return false;
	await unlink(lockPath);
	return true;
}

function tryAcquireDaemonSocketLockSync(lockPath: string): SyncDaemonSocketLock | undefined {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		let descriptor: number | undefined;
		try {
			descriptor = openSync(lockPath, "wx", OMP_DAEMON_SOCKET_MODE);
			chmodSync(lockPath, OMP_DAEMON_SOCKET_MODE);
			return { descriptor, identity: toSocketIdentity(fstatSync(descriptor)) };
		} catch (error) {
			if (descriptor !== undefined) {
				closeSync(descriptor);
			}
			if (!hasErrorCode(error, "EEXIST")) {
				throw error;
			}
			if (!removeStaleDaemonSocketLockSync(lockPath)) {
				return undefined;
			}
		}
	}
	return undefined;
}

function removeStaleDaemonSocketLockSync(lockPath: string): boolean {
	let stat: Stats;
	try {
		stat = lstatSync(lockPath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return true;
		}
		throw error;
	}
	if (!stat.isFile()) {
		return false;
	}
	if (Date.now() - stat.mtimeMs <= DAEMON_SOCKET_LOCK_STALE_MS) {
		return false;
	}
	try {
		return unlinkStaleLockIfOwnedSync(lockPath, toSocketIdentity(stat));
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return true;
		}
		throw error;
	}
}

function unlinkStaleLockIfOwnedSync(lockPath: string, expectedIdentity: DaemonSocketIdentity): boolean {
	let stat: Stats;
	try {
		stat = lstatSync(lockPath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return true;
		throw error;
	}
	if (
		!stat.isFile() ||
		!sameSocketIdentity(toSocketIdentity(stat), expectedIdentity) ||
		Date.now() - stat.mtimeMs <= DAEMON_SOCKET_LOCK_STALE_MS
	) {
		return false;
	}
	try {
		stat = lstatSync(lockPath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return true;
		throw error;
	}
	if (
		!stat.isFile() ||
		!sameSocketIdentity(toSocketIdentity(stat), expectedIdentity) ||
		Date.now() - stat.mtimeMs <= DAEMON_SOCKET_LOCK_STALE_MS
	) {
		return false;
	}
	unlinkSync(lockPath);
	return true;
}

function unlinkLockIfOwnedSync(lockPath: string, expectedIdentity: DaemonSocketIdentity): boolean {
	let stat: Stats;
	try {
		stat = lstatSync(lockPath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}
	if (!stat.isFile() || !sameSocketIdentity(toSocketIdentity(stat), expectedIdentity)) return false;
	try {
		stat = lstatSync(lockPath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}
	if (!stat.isFile() || !sameSocketIdentity(toSocketIdentity(stat), expectedIdentity)) return false;
	unlinkSync(lockPath);
	return true;
}

function releaseDaemonSocketLockSync(lockPath: string, lock: SyncDaemonSocketLock): void {
	try {
		closeSync(lock.descriptor);
	} finally {
		try {
			unlinkLockIfOwnedSync(lockPath, lock.identity);
		} catch {
			// The lock can safely age out if a concurrent cleanup replaced it.
		}
	}
}

function daemonSocketLockPath(socketPath: string): string {
	return `${socketPath}.lock`;
}

function toSocketIdentity(stat: { dev: number; ino: number }): DaemonSocketIdentity {
	return { dev: stat.dev, ino: stat.ino };
}

function sameSocketIdentity(left: DaemonSocketIdentity, right: DaemonSocketIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function assertSocketLease(socketPath: string, lease: DaemonSocketPathLease): void {
	if (lease.socketPath !== socketPath) {
		throw new Error(`Daemon socket lease does not match ${socketPath}`);
	}
	if (lease.released) {
		throw new Error(`Daemon socket lease has already been released: ${socketPath}`);
	}
}

function canConnectToUnixSocket(socketPath: string): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	let socket: Socket | undefined;
	let settled = false;
	let timeout: NodeJS.Timeout | undefined;
	const finish = (connected: boolean): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		socket?.removeAllListeners();
		socket?.destroy();
		resolve(connected);
	};

	try {
		socket = createConnection(socketPath);
	} catch {
		finish(false);
		return promise;
	}

	timeout = setTimeout(() => finish(false), 250);
	socket.once("connect", () => finish(true));
	socket.once("error", () => finish(false));
	return promise;
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
