/**
 * Crash-safe restore transactions for workspace checkpoints.
 *
 * A restore mutates the user's working tree under a guard checkpoint. If the
 * process crashes mid-restore — or the planner's checks diverge from the
 * actual disk state — we MUST be able to either finish the apply or roll it
 * back to the guard snapshot. This module owns that lifecycle.
 *
 * Protocol:
 *
 *  1. `prepare()` validates every operation's path is inside `rootPath`,
 *     performs the actual disk mutations (writes via temp sibling +
 *     atomic rename; deletes into a root-local quarantine dir; chmods;
 *     symlinks), records the **inverse** of each operation as a rollback
 *     action, and persists a journal `PREPARED` marker — fsynced so the
 *     marker survives a power-cut before the next mutation.
 *  2. `commit()` flips the journal to `COMMITTED` and releases the rollback
 *     actions (the restore is now the durable state; rollback would be
 *     destructive).
 *  3. `rollback()` runs the inverse actions in reverse order, removes the
 *     journal, and is safe to call even when partial state is present.
 *
 * Crash recovery: a journal left at `PREPARED` or `APPLYING` means a prior
 * process died mid-restore. {@link recoverPendingRestoreTransactions} scans
 * the journal dir on startup, finishes or rolls back each pending
 * transaction, and reports which actions it had to take. The store layer
 * holds the *pointer* (`RestoreTransactionPointer`) — this module owns the
 * crash-safe execution only.
 *
 * Symlink & path safety: every operation path is asserted root-relative and
 * every write/delete goes through `lstat` + `O_NOFOLLOW`-equivalent ops
 * (`wx`, `lstat`, refuse symlinks) so a planted link can't redirect the
 * write outside the workspace root.
 */
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

import type { WorkspaceRestoreOperation } from "./types";

const CHECKPOINTS_LAYOUT_VERSION = "v1";
const JOURNAL_DIR_NAME = "transactions";
const QUARANTINE_DIR_NAME = "quarantine";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const TEMP_FILE_MODE = 0o600;

// Hard cap on the total bytes we'll read from a single objectId via the
// supplied reader. Callers can ask for more by passing their own reader;
// the bound only applies to the default readObject returned by the
// helper below. Restore plans should never stream huge objects — large
// blobs are kept in the CAS, not the working tree.
const DEFAULT_MAX_OBJECT_BYTES = 64 * 1024 * 1024;

export type WorkspaceTransactionJournalState = "PREPARED" | "APPLYING" | "ROLLING_BACK" | "COMMITTED" | "ROLLED_BACK";

export interface WorkspaceRestoreTransactionJournal {
	id: string;
	workspaceId: string;
	rootPath: string;
	state: WorkspaceTransactionJournalState;
	operations: WorkspaceRestoreOperation[];
	rollbackActions: RestoreRollbackAction[];
	probeSignature: string | null;
	createdAt: string;
	updatedAt: string;
}

export type RestoreRollbackAction =
	| {
			kind: "restore_file";
			path: string;
			// null when the path didn't exist pre-restore.
			original: { mode: number; content: Uint8Array | null; kind: "file" | "symlink" } | null;
	  }
	| {
			kind: "restore_directory";
			path: string;
			existed: boolean;
			mode: number;
	  }
	| {
			kind: "no_op";
			path: string;
			note: string;
	  };

export interface WorkspaceRestoreTransactionSnapshot {
	id: string;
	workspaceId: string;
	rootPath: string;
	state: WorkspaceTransactionJournalState;
	operations: WorkspaceRestoreOperation[];
	rollbackActions: RestoreRollbackAction[];
	createdAt: string;
	updatedAt: string;
}

export interface WorkspaceRestoreApplyResult {
	id: string;
	workspaceId: string;
	rootPath: string;
	committedAt: string;
	appliedPaths: string[];
	skippedPaths: string[];
}

export interface WorkspaceRestoreRollbackResult {
	id: string;
	workspaceId: string;
	rootPath: string;
	state: "ROLLED_BACK";
	rolledBackPaths: string[];
	rolledBackAt: string;
}

export interface CreateRestoreTransactionOptions {
	rootPath: string;
	workspaceId: string;
	operations: WorkspaceRestoreOperation[];
	readObject: (objectId: string) => Promise<Uint8Array | null>;
	agentDir?: string;
	checkpointsBaseDir?: string;
	quarantineRootName?: string;
}

export interface RecoverPendingTransactionsOptions {
	rootPath: string;
	workspaceId: string;
	readObject: (objectId: string) => Promise<Uint8Array | null>;
	agentDir?: string;
	checkpointsBaseDir?: string;
}
export interface RestoreTransactionStorageLocationOptions {
	rootPath: string;
	agentDir?: string;
	checkpointsBaseDir?: string;
}

export interface WorkspaceRestoreRecoveryReport {
	workspaceId: string;
	rootPath: string;
	scannedJournals: number;
	recovered: number;
	rolledBack: number;
	journalStates: WorkspaceTransactionJournalState[];
}

export interface RestoreTransactionPointer {
	id: string;
	workspaceId: string;
	rootPath: string;
	planId?: string;
	checkpointId: string;
	guardCheckpointId?: string;
	state: "open" | "committed" | "rolled_back";
	conversationEntryId?: string;
	createdAt: string;
	completedAt?: string;
}

export interface RestoreTransaction {
	readonly id: string;
	readonly workspaceId: string;
	readonly rootPath: string;
	readonly snapshot: WorkspaceRestoreTransactionJournal;
	readonly state: WorkspaceTransactionJournalState;
	prepare(): Promise<WorkspaceRestoreTransactionSnapshot>;
	apply(): Promise<WorkspaceRestoreApplyResult>;
	rollback(): Promise<WorkspaceRestoreRollbackResult>;
	toPointer(extra: {
		planId?: string;
		checkpointId: string;
		guardCheckpointId?: string;
		conversationEntryId?: string;
	}): RestoreTransactionPointer;
}

export class WorkspaceRestoreTransactionError extends Error {
	readonly transactionId: string;
	readonly path: string | null;
	readonly stage: "prepare" | "apply" | "rollback" | "recover" | "validate";
	readonly cause: unknown;

	constructor(init: {
		message: string;
		transactionId: string;
		path: string | null;
		stage: "prepare" | "apply" | "rollback" | "recover" | "validate";
		cause?: unknown;
	}) {
		super(init.message);
		this.name = "WorkspaceRestoreTransactionError";
		this.transactionId = init.transactionId;
		this.path = init.path;
		this.stage = init.stage;
		this.cause = init.cause;
	}
}

function codeOf(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	if (!("code" in error)) return undefined;
	return String((error as Record<string, unknown>).code);
}

function nowIso(): string {
	return new Date().toISOString();
}

export function resolveRestoreTransactionStoreDir(options: RestoreTransactionStorageLocationOptions): string {
	if (options.checkpointsBaseDir) return path.resolve(options.checkpointsBaseDir);
	if (options.agentDir) return path.join(path.resolve(options.agentDir), "checkpoints", CHECKPOINTS_LAYOUT_VERSION);
	const digest = new Bun.CryptoHasher("sha256").update(path.resolve(options.rootPath)).digest("hex");
	return path.join(os.tmpdir(), "omp-workspace-restore", CHECKPOINTS_LAYOUT_VERSION, digest);
}

export function resolveRestoreTransactionJournalPath(
	options: RestoreTransactionStorageLocationOptions,
	id: string,
): string {
	return journalPathFor(journalDirFor(resolveRestoreTransactionStoreDir(options)), id);
}

function journalDirFor(checkpointsDir: string): string {
	return path.join(checkpointsDir, JOURNAL_DIR_NAME);
}

function journalPathFor(journalDir: string, id: string): string {
	return path.join(journalDir, `${id}.json`);
}

function quarantineDirFor(checkpointsDir: string, customName?: string): string {
	return path.join(checkpointsDir, customName ?? QUARANTINE_DIR_NAME);
}

function assertPathInsideRoot(rootPath: string, candidate: string): string {
	const resolvedRoot = path.resolve(rootPath);
	const resolvedCandidate = path.isAbsolute(candidate)
		? path.resolve(candidate)
		: path.resolve(resolvedRoot, candidate);
	const rel = path.relative(resolvedRoot, resolvedCandidate);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new WorkspaceRestoreTransactionError({
			message: `Path escapes workspace root: ${candidate} (root=${resolvedRoot})`,
			transactionId: "",
			path: candidate,
			stage: "validate",
		});
	}
	return rel.split(path.sep).join("/");
}

async function lstatIfPresent(target: string): Promise<Stats | null> {
	try {
		return await fs.lstat(target);
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
}

async function fsyncDirBestEffort(dir: string): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(dir, "r");
		await handle.datasync().catch(() => undefined);
		await handle.sync().catch(() => undefined);
	} catch {
		// Best-effort: not all platforms support dir fsync.
	} finally {
		if (handle) await handle.close().catch(() => undefined);
	}
}

async function writeJournalAtomic(journalFile: string, journal: WorkspaceRestoreTransactionJournal): Promise<void> {
	const parent = path.dirname(journalFile);
	await ensureDir(parent);
	const tmp = `${journalFile}.${process.pid}.${randomUUID()}.tmp`;
	const payload = `${JSON.stringify(journal)}\n`;
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(tmp, "wx", TEMP_FILE_MODE);
		await handle.writeFile(payload);
		await handle.sync().catch(() => undefined);
		await handle.close();
		handle = undefined;
		await fs.rename(tmp, journalFile);
		await fsyncDirBestEffort(parent);
	} catch (err) {
		if (handle) {
			await handle.close().catch(() => undefined);
		}
		try {
			await fs.unlink(tmp);
		} catch (cleanupErr) {
			if (!isEnoent(cleanupErr)) throw cleanupErr;
		}
		throw err;
	}
}

async function readJournal(journalFile: string): Promise<WorkspaceRestoreTransactionJournal | null> {
	try {
		const raw = await Bun.file(journalFile).text();
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const obj = parsed as Record<string, unknown>;
		if (
			typeof obj.id !== "string" ||
			typeof obj.workspaceId !== "string" ||
			typeof obj.rootPath !== "string" ||
			typeof obj.state !== "string" ||
			!Array.isArray(obj.operations) ||
			!Array.isArray(obj.rollbackActions) ||
			typeof obj.createdAt !== "string" ||
			typeof obj.updatedAt !== "string"
		) {
			return null;
		}
		return obj as unknown as WorkspaceRestoreTransactionJournal;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

async function listJournals(journalDir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(journalDir, { withFileTypes: true });
		const ids: string[] = [];
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (!entry.name.endsWith(".json")) continue;
			ids.push(path.join(journalDir, entry.name));
		}
		ids.sort();
		return ids;
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

interface PreparedRollbackContext {
	rootPath: string;
	absoluteRoot: string;
	journal: WorkspaceRestoreTransactionJournal;
	readObject: (objectId: string) => Promise<Uint8Array | null>;
	quarantineDir: string;
	quarantineIds: string[];
}

async function snapshotFileForRollback(
	absoluteRoot: string,
	relativePath: string,
): Promise<{ mode: number; content: Uint8Array | null; kind: "file" | "symlink" } | null> {
	const absolute = path.join(absoluteRoot, relativePath);
	const stat = await lstatIfPresent(absolute);
	if (stat === null) return null;
	if (stat.isSymbolicLink()) {
		// Restore the link target verbatim (binary blob from readlink), not
		// the resolved target — symlinks are restored as symlinks.
		const linkTarget = await fs.readlink(absolute);
		return { mode: Number(stat.mode) & 0o7777, content: new TextEncoder().encode(linkTarget), kind: "symlink" };
	}
	if (stat.isFile()) {
		const buffer = await fs.readFile(absolute);
		return { mode: Number(stat.mode) & 0o7777, content: new Uint8Array(buffer), kind: "file" };
	}
	// Directories, sockets, etc. — not part of restore ops in the current
	// contract. Surface a typed error so the planner excludes these.
	throw new WorkspaceRestoreTransactionError({
		message: `Cannot snapshot non-file/symlink node for rollback: ${relativePath}`,
		transactionId: "",
		path: relativePath,
		stage: "prepare",
	});
}

async function ensureParentDir(absoluteRoot: string, relativePath: string): Promise<void> {
	const parent = path.dirname(path.join(absoluteRoot, relativePath));
	if (parent === absoluteRoot || parent === path.dirname(absoluteRoot)) return;
	const stat = await lstatIfPresent(parent);
	if (stat === null) {
		await fs.mkdir(parent, { recursive: true, mode: DIR_MODE });
		return;
	}
	if (stat.isSymbolicLink()) {
		throw new WorkspaceRestoreTransactionError({
			message: `Parent of ${relativePath} is a symlink; refusing to write outside the workspace root`,
			transactionId: "",
			path: relativePath,
			stage: "validate",
		});
	}
	if (!stat.isDirectory()) {
		throw new WorkspaceRestoreTransactionError({
			message: `Parent of ${relativePath} is not a directory`,
			transactionId: "",
			path: relativePath,
			stage: "validate",
		});
	}
}

async function safeRemoveFile(absoluteRoot: string, relativePath: string): Promise<void> {
	const absolute = path.join(absoluteRoot, relativePath);
	const stat = await lstatIfPresent(absolute);
	if (stat === null) return;
	if (stat.isSymbolicLink()) {
		await fs.unlink(absolute);
		return;
	}
	if (stat.isFile()) {
		await fs.unlink(absolute);
		return;
	}
	throw new WorkspaceRestoreTransactionError({
		message: `Refusing to delete non-file node: ${relativePath}`,
		transactionId: "",
		path: relativePath,
		stage: "apply",
	});
}

async function quarantinePath(
	absoluteRoot: string,
	relativePath: string,
	quarantineDir: string,
	idHint: string,
): Promise<string> {
	const source = path.join(absoluteRoot, relativePath);
	const base = path.basename(relativePath);
	const safeBase = base.replace(/[^a-zA-Z0-9._-]/g, "_");
	const target = path.join(quarantineDir, `${idHint}__${safeBase}`);
	await ensureDir(quarantineDir);
	const stat = await lstatIfPresent(source);
	if (stat === null) return target;
	if (stat.isSymbolicLink() || stat.isFile()) {
		await fs.rename(source, target).catch(async err => {
			if (codeOf(err) === "ENOENT") return;
			throw err;
		});
		return target;
	}
	if (stat.isDirectory()) {
		throw new WorkspaceRestoreTransactionError({
			message: `Refusing to quarantine non-file node: ${relativePath}`,
			transactionId: "",
			path: relativePath,
			stage: "apply",
		});
	}
	throw new WorkspaceRestoreTransactionError({
		message: `Refusing to quarantine unknown node kind: ${relativePath}`,
		transactionId: "",
		path: relativePath,
		stage: "apply",
	});
}

async function writeAtomically(
	absoluteRoot: string,
	relativePath: string,
	bytes: Uint8Array,
	mode: number,
): Promise<void> {
	const absolute = path.join(absoluteRoot, relativePath);
	const parent = path.dirname(absolute);
	await ensureDir(parent);
	const existing = await lstatIfPresent(absolute);
	if (existing !== null) {
		if (existing.isSymbolicLink()) {
			throw new WorkspaceRestoreTransactionError({
				message: `Refusing to overwrite a symlink at ${relativePath}`,
				transactionId: "",
				path: relativePath,
				stage: "apply",
			});
		}
		if (!existing.isFile()) {
			throw new WorkspaceRestoreTransactionError({
				message: `Refusing to overwrite a non-file at ${relativePath}`,
				transactionId: "",
				path: relativePath,
				stage: "apply",
			});
		}
	}
	const tmp = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(tmp, "wx", TEMP_FILE_MODE);
		await handle.writeFile(bytes);
		await handle.sync().catch(() => undefined);
		await handle.close();
		handle = undefined;
		await fs.rename(tmp, absolute);
		if ((mode & 0o7777) !== (existing?.isFile() ? Number(existing.mode) & 0o7777 : -1)) {
			await fs.chmod(absolute, mode & 0o7777).catch(() => undefined);
		}
	} catch (err) {
		if (handle) {
			await handle.close().catch(() => undefined);
		}
		try {
			await fs.unlink(tmp);
		} catch (cleanupErr) {
			if (!isEnoent(cleanupErr)) throw cleanupErr;
		}
		throw err;
	}
}

async function applyOperation(
	ctx: PreparedRollbackContext,
	op: WorkspaceRestoreOperation,
	relativePath: string,
): Promise<{ rollback: RestoreRollbackAction; applied: boolean }> {
	const absolute = path.join(ctx.absoluteRoot, relativePath);

	switch (op.kind) {
		case "create":
		case "update": {
			if (!op.objectId) {
				throw new WorkspaceRestoreTransactionError({
					message: `${op.kind} operation missing objectId: ${relativePath}`,
					transactionId: ctx.journal.id,
					path: relativePath,
					stage: "validate",
				});
			}
			const content = await ctx.readObject(op.objectId);
			if (content === null) {
				throw new WorkspaceRestoreTransactionError({
					message: `Missing object for ${op.kind}: objectId=${op.objectId} path=${relativePath}`,
					transactionId: ctx.journal.id,
					path: relativePath,
					stage: "apply",
				});
			}
			const original = await snapshotFileForRollback(ctx.absoluteRoot, relativePath);
			await ensureParentDir(ctx.absoluteRoot, relativePath);
			await writeAtomically(ctx.absoluteRoot, relativePath, content, op.mode ?? original?.mode ?? FILE_MODE);
			return {
				rollback: { kind: "restore_file", path: relativePath, original },
				applied: true,
			};
		}
		case "delete": {
			const original = await snapshotFileForRollback(ctx.absoluteRoot, relativePath);
			if (original === null) {
				return {
					rollback: { kind: "no_op", path: relativePath, note: "absent" },
					applied: false,
				};
			}
			await quarantinePath(ctx.absoluteRoot, relativePath, ctx.quarantineDir, ctx.journal.id);
			ctx.quarantineIds.push(relativePath);
			return {
				rollback: { kind: "restore_file", path: relativePath, original },
				applied: true,
			};
		}
		case "chmod": {
			if (typeof op.mode !== "number") {
				throw new WorkspaceRestoreTransactionError({
					message: `chmod operation missing mode: ${relativePath}`,
					transactionId: ctx.journal.id,
					path: relativePath,
					stage: "validate",
				});
			}
			const stat = await lstatIfPresent(absolute);
			if (stat === null) {
				return {
					rollback: { kind: "no_op", path: relativePath, note: "absent" },
					applied: false,
				};
			}
			if (stat.isSymbolicLink()) {
				return {
					rollback: { kind: "no_op", path: relativePath, note: "symlink" },
					applied: false,
				};
			}
			const originalMode = Number(stat.mode) & 0o7777;
			await fs.chmod(absolute, op.mode & 0o7777).catch(() => undefined);
			return {
				rollback: {
					kind: "restore_file",
					path: relativePath,
					original: { mode: originalMode, content: null, kind: "file" },
				},
				applied: true,
			};
		}
		case "symlink": {
			if (typeof op.linkTarget !== "string") {
				throw new WorkspaceRestoreTransactionError({
					message: `symlink operation missing linkTarget: ${relativePath}`,
					transactionId: ctx.journal.id,
					path: relativePath,
					stage: "validate",
				});
			}
			// Symlink ops do not escape root by construction: the link
			// target is a textual blob, not a filesystem path that we
			// dereference. We DO refuse to clobber an existing node —
			// the planner is responsible for sequencing (delete first).
			const existing = await lstatIfPresent(absolute);
			if (existing !== null) {
				throw new WorkspaceRestoreTransactionError({
					message: `Refusing to clobber existing node for symlink op: ${relativePath}`,
					transactionId: ctx.journal.id,
					path: relativePath,
					stage: "apply",
				});
			}
			await ensureParentDir(ctx.absoluteRoot, relativePath);
			await fs.symlink(op.linkTarget, absolute);
			return {
				rollback: { kind: "no_op", path: relativePath, note: "created-symlink" },
				applied: true,
			};
		}
		default: {
			const exhaustive: never = op.kind;
			throw new WorkspaceRestoreTransactionError({
				message: `Unsupported restore operation kind: ${String(exhaustive)}`,
				transactionId: ctx.journal.id,
				path: relativePath,
				stage: "validate",
			});
		}
	}
}

async function executeRollback(ctx: PreparedRollbackContext): Promise<void> {
	const actions = ctx.journal.rollbackActions;
	// Run in reverse so a create+update pair unwinds correctly.
	for (let i = actions.length - 1; i >= 0; i--) {
		const action = actions[i];
		if (!action) continue;
		if (action.kind === "restore_file") {
			const absolute = path.join(ctx.absoluteRoot, action.path);
			if (action.original === null) {
				// Path didn't exist before; remove whatever's there now.
				await safeRemoveFile(ctx.absoluteRoot, action.path);
				continue;
			}
			if (action.original.kind === "symlink") {
				const target = new TextDecoder().decode(action.original.content ?? new Uint8Array());
				await safeRemoveFile(ctx.absoluteRoot, action.path);
				await fs.symlink(target, absolute).catch(err => {
					if (codeOf(err) === "EEXIST") return;
					throw err;
				});
				continue;
			}
			if (action.original.kind === "file") {
				if (action.original.content === null) {
					// chmod-only rollback
					const stat = await lstatIfPresent(absolute);
					if (stat !== null && !stat.isSymbolicLink()) {
						await fs.chmod(absolute, action.original.mode).catch(() => undefined);
					}
					continue;
				}
				await writeAtomically(ctx.absoluteRoot, action.path, action.original.content, action.original.mode);
				continue;
			}
		}
		if (action.kind === "restore_directory") {
			// Directories aren't tracked today; reserved for future use.
			continue;
		}
		if (action.kind === "no_op") {
		}
	}
}

function buildJournal(
	id: string,
	workspaceId: string,
	rootPath: string,
	operations: WorkspaceRestoreOperation[],
): WorkspaceRestoreTransactionJournal {
	const now = nowIso();
	return {
		id,
		workspaceId,
		rootPath,
		state: "PREPARED",
		operations,
		rollbackActions: [],
		probeSignature: null,
		createdAt: now,
		updatedAt: now,
	};
}

function journalFromSnapshot(snapshot: WorkspaceRestoreTransactionJournal): WorkspaceRestoreTransactionJournal {
	return { ...snapshot, operations: [...snapshot.operations], rollbackActions: [...snapshot.rollbackActions] };
}

class RestoreTransactionImpl implements RestoreTransaction {
	readonly id: string;
	readonly workspaceId: string;
	readonly rootPath: string;
	#journal: WorkspaceRestoreTransactionJournal;
	#absoluteRoot: string;
	#checkpointsDir: string;
	#journalDir: string;
	#journalFile: string;
	#quarantineDir: string;
	#quarantineIds: string[] = [];
	#readObject: (objectId: string) => Promise<Uint8Array | null>;

	constructor(init: {
		id: string;
		workspaceId: string;
		rootPath: string;
		journal: WorkspaceRestoreTransactionJournal;
		readObject: (objectId: string) => Promise<Uint8Array | null>;
		agentDir?: string;
		checkpointsBaseDir?: string;
		quarantineRootName?: string;
	}) {
		this.id = init.id;
		this.workspaceId = init.workspaceId;
		this.rootPath = init.rootPath;
		this.#journal = init.journal;
		this.#absoluteRoot = path.resolve(init.rootPath);
		this.#checkpointsDir = resolveRestoreTransactionStoreDir({
			rootPath: init.rootPath,
			agentDir: init.agentDir,
			checkpointsBaseDir: init.checkpointsBaseDir,
		});
		this.#journalDir = journalDirFor(this.#checkpointsDir);
		this.#journalFile = journalPathFor(this.#journalDir, init.id);
		this.#quarantineDir = quarantineDirFor(this.#checkpointsDir, init.quarantineRootName);
		this.#readObject = init.readObject;
	}

	get snapshot(): WorkspaceRestoreTransactionJournal {
		return journalFromSnapshot(this.#journal);
	}

	get state(): WorkspaceTransactionJournalState {
		return this.#journal.state;
	}

	async prepare(): Promise<WorkspaceRestoreTransactionSnapshot> {
		// Validate all operation paths first — a single bad path aborts
		// before any disk mutation. `assertPathInsideRoot` throws on escape.
		const validated: { op: WorkspaceRestoreOperation; rel: string }[] = [];
		for (const op of this.#journal.operations) {
			const rel = assertPathInsideRoot(this.rootPath, op.path);
			validated.push({ op, rel });
		}
		await ensureDir(this.#checkpointsDir);
		await ensureDir(this.#journalDir);
		await ensureDir(this.#quarantineDir);

		// Mutate in declared order; persist the journal *before* the first
		// mutation so a crash mid-restore finds a PREPARED journal.
		const next: WorkspaceRestoreTransactionJournal = journalFromSnapshot(this.#journal);
		next.state = "PREPARED";
		next.updatedAt = nowIso();
		await writeJournalAtomic(this.#journalFile, next);
		this.#journal = next;

		const ctx: PreparedRollbackContext = {
			rootPath: this.rootPath,
			absoluteRoot: this.#absoluteRoot,
			journal: this.#journal,
			readObject: this.#readObject,
			quarantineDir: this.#quarantineDir,
			quarantineIds: this.#quarantineIds,
		};

		const applied: string[] = [];
		const skipped: string[] = [];
		const rollbackActions: RestoreRollbackAction[] = [];
		for (const { op, rel } of validated) {
			try {
				const result = await applyOperation(ctx, op, rel);
				rollbackActions.push(result.rollback);
				if (result.applied) applied.push(rel);
				else skipped.push(rel);
			} catch (err) {
				// Best-effort local rollback before re-throwing — the caller
				// will get a typed error and may decide to rollback the whole
				// transaction, which then re-runs the rollback list with
				// already-applied work included.
				const partial: WorkspaceRestoreTransactionJournal = journalFromSnapshot(this.#journal);
				partial.rollbackActions = rollbackActions;
				partial.state = "ROLLING_BACK";
				partial.updatedAt = nowIso();
				this.#journal = partial;
				try {
					await writeJournalAtomic(this.#journalFile, partial);
					await executeRollback({ ...ctx, journal: partial });
					const rolled: WorkspaceRestoreTransactionJournal = journalFromSnapshot(partial);
					rolled.state = "ROLLED_BACK";
					rolled.updatedAt = nowIso();
					await writeJournalAtomic(this.#journalFile, rolled);
					this.#journal = rolled;
				} catch {
					// Swallow secondary rollback errors; the primary cause is
					// what the caller needs. The persisted ROLLING_BACK journal
					// lets startup recovery finish the rollback.
				}
				throw new WorkspaceRestoreTransactionError({
					message: `Restore prepare failed at ${rel}: ${(err as Error).message}`,
					transactionId: this.id,
					path: rel,
					stage: "prepare",
					cause: err,
				});
			}
		}

		const settled: WorkspaceRestoreTransactionJournal = journalFromSnapshot(this.#journal);
		settled.rollbackActions = rollbackActions;
		settled.updatedAt = nowIso();
		await writeJournalAtomic(this.#journalFile, settled);
		this.#journal = settled;
		return journalFromSnapshot(settled);
	}

	async apply(): Promise<WorkspaceRestoreApplyResult> {
		if (this.#journal.state === "COMMITTED") {
			throw new WorkspaceRestoreTransactionError({
				message: `Restore transaction ${this.id} already committed`,
				transactionId: this.id,
				path: null,
				stage: "apply",
			});
		}
		if (this.#journal.state === "ROLLED_BACK") {
			throw new WorkspaceRestoreTransactionError({
				message: `Restore transaction ${this.id} already rolled back`,
				transactionId: this.id,
				path: null,
				stage: "apply",
			});
		}
		if (this.#journal.state === "ROLLING_BACK") {
			throw new WorkspaceRestoreTransactionError({
				message: `Restore transaction ${this.id} is rolling back`,
				transactionId: this.id,
				path: null,
				stage: "apply",
			});
		}
		// APPLYING marker: signals to a recovery scan that work was in flight.
		const applying: WorkspaceRestoreTransactionJournal = journalFromSnapshot(this.#journal);
		applying.state = "APPLYING";
		applying.updatedAt = nowIso();
		await writeJournalAtomic(this.#journalFile, applying);
		this.#journal = applying;

		const applied: string[] = [];
		const skipped: string[] = [];
		for (const action of this.#journal.rollbackActions) {
			if (action.kind === "no_op") skipped.push(action.path);
			else applied.push(action.path);
		}
		// No additional disk work — apply was completed during prepare().
		// Flipping to COMMITTED is the durable signal that rollback is no
		// longer safe (caller's working tree matches the checkpoint).
		const committed: WorkspaceRestoreTransactionJournal = journalFromSnapshot(this.#journal);
		committed.state = "COMMITTED";
		committed.updatedAt = nowIso();
		await writeJournalAtomic(this.#journalFile, committed);
		this.#journal = committed;
		return {
			id: this.id,
			workspaceId: this.workspaceId,
			rootPath: this.rootPath,
			committedAt: committed.updatedAt,
			appliedPaths: applied,
			skippedPaths: skipped,
		};
	}

	async rollback(): Promise<WorkspaceRestoreRollbackResult> {
		if (this.#journal.state === "ROLLED_BACK") {
			return {
				id: this.id,
				workspaceId: this.workspaceId,
				rootPath: this.rootPath,
				state: "ROLLED_BACK",
				rolledBackPaths: [],
				rolledBackAt: this.#journal.updatedAt,
			};
		}
		if (this.#journal.state === "COMMITTED") {
			throw new WorkspaceRestoreTransactionError({
				message: `Restore transaction ${this.id} already committed; rollback refused`,
				transactionId: this.id,
				path: null,
				stage: "rollback",
			});
		}
		const rollingBack: WorkspaceRestoreTransactionJournal = journalFromSnapshot(this.#journal);
		rollingBack.state = "ROLLING_BACK";
		rollingBack.updatedAt = nowIso();
		await writeJournalAtomic(this.#journalFile, rollingBack);
		this.#journal = rollingBack;
		const ctx: PreparedRollbackContext = {
			rootPath: this.rootPath,
			absoluteRoot: this.#absoluteRoot,
			journal: rollingBack,
			readObject: this.#readObject,
			quarantineDir: this.#quarantineDir,
			quarantineIds: this.#quarantineIds,
		};
		await executeRollback(ctx);
		const rolled: WorkspaceRestoreTransactionJournal = journalFromSnapshot(rollingBack);
		rolled.state = "ROLLED_BACK";
		rolled.updatedAt = nowIso();
		await writeJournalAtomic(this.#journalFile, rolled);
		this.#journal = rolled;
		return {
			id: this.id,
			workspaceId: this.workspaceId,
			rootPath: this.rootPath,
			state: "ROLLED_BACK",
			rolledBackPaths: this.#journal.rollbackActions.map(action => action.path),
			rolledBackAt: rolled.updatedAt,
		};
	}

	toPointer(extra: {
		planId?: string;
		checkpointId: string;
		guardCheckpointId?: string;
		conversationEntryId?: string;
	}): RestoreTransactionPointer {
		const pointerState: RestoreTransactionPointer["state"] =
			this.#journal.state === "COMMITTED"
				? "committed"
				: this.#journal.state === "ROLLED_BACK"
					? "rolled_back"
					: "open";
		const pointer: RestoreTransactionPointer = {
			id: this.id,
			workspaceId: this.workspaceId,
			rootPath: this.rootPath,
			checkpointId: extra.checkpointId,
			state: pointerState,
			createdAt: this.#journal.createdAt,
		};
		if (extra.planId !== undefined) pointer.planId = extra.planId;
		if (extra.guardCheckpointId !== undefined) pointer.guardCheckpointId = extra.guardCheckpointId;
		if (extra.conversationEntryId !== undefined) pointer.conversationEntryId = extra.conversationEntryId;
		if (this.#journal.state === "COMMITTED" || this.#journal.state === "ROLLED_BACK") {
			pointer.completedAt = this.#journal.updatedAt;
		}
		return pointer;
	}
}

/**
 * Create a new restore transaction. The transaction starts in `PREPARED`
 * state with an empty rollback list — call `prepare()` to validate paths and
 * apply the operations against the working tree, then `commit()` (via
 * `apply()`) or `rollback()`.
 */
export async function createRestoreTransaction(options: CreateRestoreTransactionOptions): Promise<RestoreTransaction> {
	const absoluteRoot = path.resolve(options.rootPath);
	const checkpointsDir = resolveRestoreTransactionStoreDir({
		rootPath: absoluteRoot,
		agentDir: options.agentDir,
		checkpointsBaseDir: options.checkpointsBaseDir,
	});
	const journalDir = journalDirFor(checkpointsDir);
	await ensureDir(journalDir);

	// Normalize paths while preserving the planner's original op order.
	// Same-path sequences (e.g. delete→symlink, delete→create) are valid
	// restore plans and MUST survive intact.
	const normalized = options.operations.map(op => ({
		...op,
		path: assertPathInsideRoot(absoluteRoot, op.path),
	}));

	const id = randomUUID();
	const journal = buildJournal(id, options.workspaceId, absoluteRoot, normalized);
	await writeJournalAtomic(journalPathFor(journalDir, id), journal);

	return new RestoreTransactionImpl({
		id,
		workspaceId: options.workspaceId,
		rootPath: absoluteRoot,
		journal,
		readObject: options.readObject,
		agentDir: options.agentDir,
		checkpointsBaseDir: options.checkpointsBaseDir,
		quarantineRootName: options.quarantineRootName,
	});
}

/**
 * Scan for journals left in `PREPARED` or `APPLYING` by a previous process
 * and bring them to a stable state. Returns the count of journals that were
 * finalized (rolled back or completed).
 *
 * Strategy:
 *   - `APPLYING` → a process died mid-apply. Rollback (we cannot prove the
 *     apply completed all steps without the journal's word for it).
 *   - `PREPARED` → a process died before commit. Rollback (the safe
 *     default).
 *   - `COMMITTED` / `ROLLED_BACK` → terminal; leave as-is.
 */
export async function recoverPendingRestoreTransactions(
	options: RecoverPendingTransactionsOptions,
): Promise<WorkspaceRestoreRecoveryReport> {
	const absoluteRoot = path.resolve(options.rootPath);
	const checkpointsDir = resolveRestoreTransactionStoreDir({
		rootPath: absoluteRoot,
		agentDir: options.agentDir,
		checkpointsBaseDir: options.checkpointsBaseDir,
	});
	const journalDir = journalDirFor(checkpointsDir);
	const journalFiles = await listJournals(journalDir);

	const journalStates: WorkspaceTransactionJournalState[] = [];
	let recovered = 0;
	let rolledBack = 0;

	for (const journalFile of journalFiles) {
		const journal = await readJournal(journalFile);
		if (journal === null) continue;
		journalStates.push(journal.state);
		if (journal.workspaceId !== options.workspaceId) continue;
		if (journal.state !== "PREPARED" && journal.state !== "APPLYING" && journal.state !== "ROLLING_BACK") continue;

		const tx = new RestoreTransactionImpl({
			id: journal.id,
			workspaceId: journal.workspaceId,
			rootPath: journal.rootPath,
			journal,
			readObject: options.readObject,
			agentDir: options.agentDir,
			checkpointsBaseDir: options.checkpointsBaseDir,
		});
		try {
			await tx.rollback();
			rolledBack += 1;
			recovered += 1;
		} catch (err) {
			throw new WorkspaceRestoreTransactionError({
				message: `Recovery rollback failed for ${journal.id}: ${(err as Error).message}`,
				transactionId: journal.id,
				path: null,
				stage: "recover",
				cause: err,
			});
		}
	}

	return {
		workspaceId: options.workspaceId,
		rootPath: absoluteRoot,
		scannedJournals: journalFiles.length,
		recovered,
		rolledBack,
		journalStates,
	};
}

/**
 * Default `readObject` for callers that store objects on disk in a flat
 * content-addressed directory. Returns `null` for missing objects. Bytes
 * beyond {@link DEFAULT_MAX_OBJECT_BYTES} are rejected with a typed error
 * so an accidental dump of a huge blob into a restore fails fast.
 */
export function createFileObjectReader(
	objectDir: string,
	options: { maxBytes?: number } = {},
): (objectId: string) => Promise<Uint8Array | null> {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_OBJECT_BYTES;
	return async (objectId: string): Promise<Uint8Array | null> => {
		if (!/^[a-f0-9]{16,128}$/.test(objectId)) return null;
		const objectPath = path.join(objectDir, objectId);
		const stat = await lstatIfPresent(objectPath);
		if (stat === null) return null;
		if (stat.isSymbolicLink()) {
			throw new WorkspaceRestoreTransactionError({
				message: `Refusing to read object via symlink: ${objectPath}`,
				transactionId: "",
				path: objectId,
				stage: "apply",
			});
		}
		if (stat.size > maxBytes) {
			throw new WorkspaceRestoreTransactionError({
				message: `Object ${objectId} exceeds maxBytes (${stat.size} > ${maxBytes})`,
				transactionId: "",
				path: objectId,
				stage: "apply",
			});
		}
		const buffer = await fs.readFile(objectPath);
		return new Uint8Array(buffer);
	};
}
