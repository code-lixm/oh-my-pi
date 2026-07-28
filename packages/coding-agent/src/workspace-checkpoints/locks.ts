import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

const CHECKPOINTS_LAYOUT_VERSION = "v1";
const DEFAULT_LOCKS_DIRNAME = "omp-workspace-locks";
const LEASE_FILENAME = "lease.json";

const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_HEARTBEAT_MS = 30_000;
const STALE_NO_INFO_MS = 60_000;
const ACQUIRE_RETRY_DELAY_MS = 50;
const ACQUIRE_MAX_ATTEMPTS = 200;

interface LeaseRecord {
	pid: number;
	token: string;
	createdAt: string;
	heartbeatAt: string;
	ownerLabel: string;
	rootPath: string;
	workspaceId: string;
	canonicalRoot: string;
}

type LeaseHolderSnapshot = {
	pid: number;
	token?: string;
	heartbeatAt?: string;
	workspaceId?: string;
	rootPath?: string;
};

export interface WorkspaceLockHandleOptions {
	heartbeatIntervalMs?: number;
	staleHeartbeatMs?: number;
	staleNoInfoMs?: number;
	retryDelayMs?: number;
	maxAttempts?: number;
	signal?: AbortSignal;
}

export interface WorkspaceLockAcquireOptions extends WorkspaceLockHandleOptions {
	ownerLabel?: string;
}

export interface WorkspaceLockRequest {
	rootPath: string;
	workspaceId: string;
	lockBaseDir?: string;
	options?: WorkspaceLockAcquireOptions;
}

export interface WorkspaceLockHandle {
	readonly rootPath: string;
	readonly workspaceId: string;
	readonly lockPath: string;
	readonly token: string;
	readonly ownerPid: number;
	readonly acquiredAt: string;
	readonly heartbeatIntervalMs: number;
	readonly staleHeartbeatMs: number;
	readonly staleNoInfoMs: number;
	readonly isReleased: boolean;
	release(): Promise<void>;
	renew(): Promise<void>;
	getLockPath(): string;
}

export class WorkspaceLockUnavailableError extends Error {
	readonly lockPath: string;
	readonly reason: "held" | "aborted" | "missing" | "io";
	readonly heldBy: LeaseHolderSnapshot | undefined;
	readonly attempts: number;

	constructor(
		message: string,
		details: {
			lockPath: string;
			reason: "held" | "aborted" | "missing" | "io";
			heldBy?: LeaseHolderSnapshot;
			attempts: number;
		},
	) {
		super(message);
		this.name = "WorkspaceLockUnavailableError";
		this.lockPath = details.lockPath;
		this.reason = details.reason;
		this.heldBy = details.heldBy;
		this.attempts = details.attempts;
	}
}

interface NormalizedAcquireOptions {
	heartbeatIntervalMs: number;
	staleHeartbeatMs: number;
	staleNoInfoMs: number;
	retryDelayMs: number;
	maxAttempts: number;
	ownerLabel: string;
	signal: AbortSignal | undefined;
}

interface ResolvedWorkspaceLockRequest {
	rootPath: string;
	workspaceId: string;
	canonicalRoot: string;
	lockBaseDir: string;
	lockPath: string;
	options: NormalizedAcquireOptions;
}

const inProcessGates = new Map<string, Promise<void>>();

function codeOf(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	if (!("code" in error)) return undefined;
	return String((error as Record<string, unknown>).code);
}

function nowIso(): string {
	return new Date().toISOString();
}

function normalizeAcquireOptions(options: WorkspaceLockAcquireOptions | undefined): NormalizedAcquireOptions {
	return {
		heartbeatIntervalMs: options?.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
		staleHeartbeatMs: options?.staleHeartbeatMs ?? STALE_HEARTBEAT_MS,
		staleNoInfoMs: options?.staleNoInfoMs ?? STALE_NO_INFO_MS,
		retryDelayMs: options?.retryDelayMs ?? ACQUIRE_RETRY_DELAY_MS,
		maxAttempts: options?.maxAttempts ?? ACQUIRE_MAX_ATTEMPTS,
		ownerLabel: options?.ownerLabel ?? "omp-workspace-checkpoint",
		signal: options?.signal,
	};
}

async function runWithInProcessGate<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = inProcessGates.get(key);
	const gate = Promise.withResolvers<void>();
	inProcessGates.set(key, gate.promise);
	try {
		if (previous) await previous.catch(() => undefined);
		return await fn();
	} finally {
		gate.resolve();
		if (inProcessGates.get(key) === gate.promise) inProcessGates.delete(key);
	}
}

async function lstatIfPresent(target: string): Promise<Stats | null> {
	try {
		return await fs.lstat(target);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function canonicalizeRoot(rootPath: string): Promise<string> {
	const resolved = path.resolve(rootPath);
	try {
		return await fs.realpath(resolved);
	} catch (error) {
		if (isEnoent(error)) return resolved;
		throw error;
	}
}

function rootHash(canonicalRoot: string): string {
	return new Bun.CryptoHasher("sha256").update(canonicalRoot).digest("hex");
}

function defaultLockBaseDir(): string {
	return path.join(os.tmpdir(), DEFAULT_LOCKS_DIRNAME, CHECKPOINTS_LAYOUT_VERSION);
}

function assertPathWithinBase(baseDir: string, target: string): void {
	const relative = path.relative(baseDir, target);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Lock path escapes base dir: ${target}`);
	}
}

async function ensureDirectory(dirPath: string): Promise<void> {
	const stat = await lstatIfPresent(dirPath);
	if (stat?.isSymbolicLink()) {
		throw new WorkspaceLockUnavailableError(`Lock base dir is a symlink: ${dirPath}`, {
			lockPath: dirPath,
			reason: "io",
			attempts: 0,
		});
	}
	if (stat !== null && !stat.isDirectory()) {
		throw new WorkspaceLockUnavailableError(`Lock base dir is not a directory: ${dirPath}`, {
			lockPath: dirPath,
			reason: "io",
			attempts: 0,
		});
	}
	await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
}

async function fsyncDirBestEffort(dirPath: string): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(dirPath, "r");
		await handle.datasync().catch(() => undefined);
		await handle.sync().catch(() => undefined);
	} catch {
		// Best-effort only.
	} finally {
		if (handle) await handle.close().catch(() => undefined);
	}
}

function parseLeaseRecord(raw: string): LeaseRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	if (
		typeof record.pid !== "number" ||
		typeof record.token !== "string" ||
		typeof record.createdAt !== "string" ||
		typeof record.heartbeatAt !== "string" ||
		typeof record.ownerLabel !== "string" ||
		typeof record.rootPath !== "string" ||
		typeof record.workspaceId !== "string" ||
		typeof record.canonicalRoot !== "string"
	) {
		return null;
	}
	return {
		pid: record.pid,
		token: record.token,
		createdAt: record.createdAt,
		heartbeatAt: record.heartbeatAt,
		ownerLabel: record.ownerLabel,
		rootPath: record.rootPath,
		workspaceId: record.workspaceId,
		canonicalRoot: record.canonicalRoot,
	};
}

function processAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	if (process.platform === "win32") return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return codeOf(error) === "EPERM";
	}
}

async function writeLeaseRecord(recordPath: string, record: LeaseRecord): Promise<void> {
	const tmpPath = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(tmpPath, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(record)}\n`);
		await handle.sync().catch(() => undefined);
		await handle.close();
		handle = undefined;
		await fs.rename(tmpPath, recordPath);
	} catch (error) {
		if (handle) await handle.close().catch(() => undefined);
		try {
			await fs.unlink(tmpPath);
		} catch (cleanupError) {
			if (!isEnoent(cleanupError)) throw cleanupError;
		}
		throw error;
	}
}

async function readLeaseRecord(recordPath: string): Promise<LeaseRecord | null> {
	try {
		const raw = await Bun.file(recordPath).text();
		return parseLeaseRecord(raw);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function recordIsStale(record: LeaseRecord, staleHeartbeatMs: number): Promise<boolean> {
	if (!processAlive(record.pid)) return true;
	const heartbeatAt = Date.parse(record.heartbeatAt);
	if (Number.isFinite(heartbeatAt)) return Date.now() - heartbeatAt > staleHeartbeatMs;
	const createdAt = Date.parse(record.createdAt);
	return Number.isFinite(createdAt) && Date.now() - createdAt > staleHeartbeatMs * 4;
}

async function dirIsStaleWithoutRecord(lockDir: string, staleNoInfoMs: number): Promise<boolean> {
	const stat = await lstatIfPresent(lockDir);
	if (stat === null) return false;
	return Date.now() - stat.mtimeMs > staleNoInfoMs;
}

async function reapLease(lockDir: string): Promise<void> {
	try {
		await fs.rm(lockDir, { recursive: true, force: true });
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
}

async function tryClaimLease(lockDir: string, record: LeaseRecord): Promise<boolean> {
	const planted = await lstatIfPresent(lockDir);
	if (planted?.isSymbolicLink()) {
		throw new WorkspaceLockUnavailableError(`Lock path is a symlink: ${lockDir}`, {
			lockPath: lockDir,
			reason: "io",
			attempts: 0,
		});
	}
	if (planted !== null && !planted.isDirectory()) {
		throw new WorkspaceLockUnavailableError(`Lock path is not a directory: ${lockDir}`, {
			lockPath: lockDir,
			reason: "io",
			attempts: 0,
		});
	}

	try {
		await fs.mkdir(lockDir, { mode: 0o700 });
	} catch (error) {
		if (codeOf(error) === "EEXIST") return false;
		if (codeOf(error) === "ELOOP" || codeOf(error) === "EMLINK") {
			throw new WorkspaceLockUnavailableError(`Lock path is a symlink: ${lockDir}`, {
				lockPath: lockDir,
				reason: "io",
				attempts: 0,
			});
		}
		throw error;
	}

	try {
		await fsyncDirBestEffort(path.dirname(lockDir));
		const recordPath = path.join(lockDir, LEASE_FILENAME);
		await writeLeaseRecord(recordPath, record);
		await fsyncDirBestEffort(lockDir);
		return true;
	} catch (error) {
		await reapLease(lockDir).catch(() => undefined);
		throw error;
	}
}

async function resolveWorkspaceLockRequest(
	first: string | WorkspaceLockRequest,
	workspaceId?: string,
	legacyOptions?: WorkspaceLockAcquireOptions,
): Promise<ResolvedWorkspaceLockRequest> {
	const request: WorkspaceLockRequest =
		typeof first === "string"
			? {
					rootPath: first,
					workspaceId: workspaceId ?? "",
					options: legacyOptions,
				}
			: first;
	if (!request.rootPath) {
		throw new WorkspaceLockUnavailableError("Workspace lock requires rootPath", {
			lockPath: "",
			reason: "io",
			attempts: 0,
		});
	}
	if (!request.workspaceId) {
		throw new WorkspaceLockUnavailableError("Workspace lock requires workspaceId", {
			lockPath: "",
			reason: "io",
			attempts: 0,
		});
	}

	const canonicalRoot = await canonicalizeRoot(request.rootPath);
	const resolvedBaseDir = path.resolve(request.lockBaseDir ?? defaultLockBaseDir());
	const lockPath = path.join(resolvedBaseDir, rootHash(canonicalRoot));
	assertPathWithinBase(resolvedBaseDir, lockPath);
	return {
		rootPath: path.resolve(request.rootPath),
		workspaceId: request.workspaceId,
		canonicalRoot,
		lockBaseDir: resolvedBaseDir,
		lockPath,
		options: normalizeAcquireOptions(request.options ?? legacyOptions),
	};
}

class AcquiredLock implements WorkspaceLockHandle {
	readonly rootPath: string;
	readonly workspaceId: string;
	readonly lockPath: string;
	readonly token: string;
	readonly ownerPid: number;
	readonly acquiredAt: string;
	readonly heartbeatIntervalMs: number;
	readonly staleHeartbeatMs: number;
	readonly staleNoInfoMs: number;
	#released = false;
	#lockDir: string;
	#recordPath: string;
	#signal: AbortSignal | undefined;
	#abortHandler: (() => void) | undefined;
	#timer: NodeJS.Timeout | undefined;

	constructor(init: {
		rootPath: string;
		workspaceId: string;
		lockDir: string;
		record: LeaseRecord;
		options: NormalizedAcquireOptions;
	}) {
		this.rootPath = init.rootPath;
		this.workspaceId = init.workspaceId;
		this.lockPath = init.lockDir;
		this.token = init.record.token;
		this.ownerPid = init.record.pid;
		this.acquiredAt = init.record.createdAt;
		this.heartbeatIntervalMs = init.options.heartbeatIntervalMs;
		this.staleHeartbeatMs = init.options.staleHeartbeatMs;
		this.staleNoInfoMs = init.options.staleNoInfoMs;
		this.#lockDir = init.lockDir;
		this.#recordPath = path.join(init.lockDir, LEASE_FILENAME);
		this.#signal = init.options.signal;
		if (this.#signal) {
			const abortHandler = (): void => {
				void this.release();
			};
			this.#abortHandler = abortHandler;
			if (this.#signal.aborted) abortHandler();
			else this.#signal.addEventListener("abort", abortHandler, { once: true });
		}
		this.#timer = setInterval(() => {
			void this.renew().catch(() => undefined);
		}, this.heartbeatIntervalMs);
		this.#timer.unref?.();
	}

	get isReleased(): boolean {
		return this.#released;
	}

	getLockPath(): string {
		return this.lockPath;
	}

	async renew(): Promise<void> {
		if (this.#released) return;
		const observed = await readLeaseRecord(this.#recordPath);
		if (observed === null) {
			throw new WorkspaceLockUnavailableError(`Lock missing during renew: ${this.lockPath}`, {
				lockPath: this.lockPath,
				reason: "missing",
				attempts: 0,
			});
		}
		if (observed.token !== this.token) {
			throw new WorkspaceLockUnavailableError(`Lock ownership changed during renew: ${this.lockPath}`, {
				lockPath: this.lockPath,
				reason: "held",
				heldBy: {
					pid: observed.pid,
					token: observed.token,
					heartbeatAt: observed.heartbeatAt,
					workspaceId: observed.workspaceId,
					rootPath: observed.rootPath,
				},
				attempts: 0,
			});
		}
		await writeLeaseRecord(this.#recordPath, { ...observed, heartbeatAt: nowIso() });
	}

	async release(): Promise<void> {
		if (this.#released) return;
		this.#released = true;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		if (this.#signal && this.#abortHandler) {
			this.#signal.removeEventListener("abort", this.#abortHandler);
			this.#abortHandler = undefined;
		}
		const observed = await readLeaseRecord(this.#recordPath);
		if (observed === null) return;
		if (observed.token !== this.token) return;
		await reapLease(this.#lockDir);
	}
}

/** Object-style acquisition API; preferred. */
export async function acquireWorkspaceLock(request: WorkspaceLockRequest): Promise<WorkspaceLockHandle>;
/** Legacy positional acquisition API kept until service/coordinator finish migrating. */
export async function acquireWorkspaceLock(
	rootPath: string,
	workspaceId: string,
	options?: WorkspaceLockAcquireOptions,
): Promise<WorkspaceLockHandle>;
export async function acquireWorkspaceLock(
	first: string | WorkspaceLockRequest,
	workspaceId?: string,
	legacyOptions?: WorkspaceLockAcquireOptions,
): Promise<WorkspaceLockHandle> {
	const request = await resolveWorkspaceLockRequest(first, workspaceId, legacyOptions);
	return acquireResolvedWorkspaceLock(request);
}

/** Object-style scoped helper; preferred. */
export async function withWorkspaceLock<T>(
	request: WorkspaceLockRequest,
	fn: (lock: WorkspaceLockHandle) => Promise<T>,
): Promise<T>;
/** Legacy positional scoped helper kept until service/coordinator finish migrating. */
export async function withWorkspaceLock<T>(
	rootPath: string,
	workspaceId: string,
	fn: (lock: WorkspaceLockHandle) => Promise<T>,
	options?: WorkspaceLockAcquireOptions,
): Promise<T>;
export async function withWorkspaceLock<T>(
	first: string | WorkspaceLockRequest,
	workspaceIdOrFn: string | ((lock: WorkspaceLockHandle) => Promise<T>),
	fnOrOptions?: ((lock: WorkspaceLockHandle) => Promise<T>) | WorkspaceLockAcquireOptions,
	options?: WorkspaceLockAcquireOptions,
): Promise<T> {
	const request = await resolveWorkspaceLockRequest(
		typeof first === "string" ? { rootPath: first, workspaceId: workspaceIdOrFn as string, options } : first,
	);
	const fn =
		typeof first === "string"
			? (fnOrOptions as (lock: WorkspaceLockHandle) => Promise<T>)
			: (workspaceIdOrFn as (lock: WorkspaceLockHandle) => Promise<T>);
	return runWithInProcessGate(request.lockPath, async () => {
		const lock = await acquireResolvedWorkspaceLock(request);
		try {
			return await fn(lock);
		} finally {
			await lock.release();
		}
	});
}

async function acquireResolvedWorkspaceLock(request: ResolvedWorkspaceLockRequest): Promise<WorkspaceLockHandle> {
	const recordPath = path.join(request.lockPath, LEASE_FILENAME);
	await ensureDirectory(request.lockBaseDir);
	for (let attempt = 0; attempt < request.options.maxAttempts; attempt += 1) {
		if (request.options.signal?.aborted) {
			throw new WorkspaceLockUnavailableError(`Lock acquisition aborted for ${request.lockPath}`, {
				lockPath: request.lockPath,
				reason: "aborted",
				attempts: attempt,
			});
		}

		const existing = await readLeaseRecord(recordPath);
		if (existing !== null) {
			if (!(await recordIsStale(existing, request.options.staleHeartbeatMs))) {
				await Bun.sleep(request.options.retryDelayMs);
				continue;
			}
			await reapLease(request.lockPath);
			continue;
		}

		const existingDir = await lstatIfPresent(request.lockPath);
		if (existingDir !== null) {
			if (existingDir.isSymbolicLink()) {
				throw new WorkspaceLockUnavailableError(`Lock path is a symlink: ${request.lockPath}`, {
					lockPath: request.lockPath,
					reason: "io",
					attempts: attempt,
				});
			}
			if (!existingDir.isDirectory()) {
				throw new WorkspaceLockUnavailableError(`Lock path is not a directory: ${request.lockPath}`, {
					lockPath: request.lockPath,
					reason: "io",
					attempts: attempt,
				});
			}
			if (!(await dirIsStaleWithoutRecord(request.lockPath, request.options.staleNoInfoMs))) {
				await Bun.sleep(request.options.retryDelayMs);
				continue;
			}
			await reapLease(request.lockPath);
			continue;
		}

		const record: LeaseRecord = {
			pid: process.pid,
			token: randomUUID(),
			createdAt: nowIso(),
			heartbeatAt: nowIso(),
			ownerLabel: request.options.ownerLabel,
			rootPath: request.rootPath,
			workspaceId: request.workspaceId,
			canonicalRoot: request.canonicalRoot,
		};
		if (await tryClaimLease(request.lockPath, record)) {
			return new AcquiredLock({
				rootPath: request.rootPath,
				workspaceId: request.workspaceId,
				lockDir: request.lockPath,
				record,
				options: request.options,
			});
		}
		await Bun.sleep(request.options.retryDelayMs);
	}

	const heldBy = await readLeaseRecord(recordPath);
	throw new WorkspaceLockUnavailableError(
		`Failed to acquire workspace lock ${request.lockPath} after ${request.options.maxAttempts} attempts`,
		{
			lockPath: request.lockPath,
			reason: "held",
			heldBy:
				heldBy === null
					? undefined
					: {
							pid: heldBy.pid,
							token: heldBy.token,
							heartbeatAt: heldBy.heartbeatAt,
							workspaceId: heldBy.workspaceId,
							rootPath: heldBy.rootPath,
						},
			attempts: request.options.maxAttempts,
		},
	);
}
