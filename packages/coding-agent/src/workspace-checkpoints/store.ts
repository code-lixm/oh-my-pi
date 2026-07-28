/**
 * Checkpoint metadata + restore plan + transaction/undo/redo pointer store.
 *
 * Single source of truth across restarts. The CAS layer stores file blobs;
 * this store stores only pointers, plans, and graph edges. Concurrent opens
 * are safe — every mutating method runs inside a SQLite transaction with
 * WAL + busy_timeout + foreign_keys=ON, and the {@link CheckpointMetadataStore}
 * instance owns its `bun:sqlite` connection.
 *
 * Default storage directory: `<agentDir>/checkpoints/v1` (resolved via
 * `getAgentDir()` from `@oh-my-pi/pi-utils`). Tests inject an explicit
 * `storageDir` so they get a fresh per-run DB without touching the real
 * agent dir. The workspace id is derived from the absolute root path via
 * `Bun.hash`, so the same project always maps to the same id within a
 * given Bun runtime.
 *
 * Errors are NEVER swallowed: every helper that hits SQLite throws on
 * unexpected conditions; callers are expected to surface or log them.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";

import type {
	CreateWorkspaceCheckpointRequest,
	WorkspaceCheckpointCompleteness,
	WorkspaceCheckpointReason,
	WorkspaceCheckpointRecord,
	WorkspaceRestoreConflict,
	WorkspaceRestoreOperation,
	WorkspaceRestorePlanRecord,
	WorkspaceRestorePlanStatus,
	WorkspaceRestoreScope,
	WorkspaceRestoreStrategy,
} from "./types";

// Public type re-exports so downstream consumers (service, GC, tests) can
// import every checkpoint-shaped record from one place.
export type { WorkspaceCheckpointRecord } from "./types";

const SCHEMA_VERSION = 1;
const DATABASE_FILENAME = "metadata.db";
const BUSY_TIMEOUT_MS = 5_000;

// ─── Public types ───────────────────────────────────────────────────────

/** Persisted, per-root workspace pointer — undo/redo heads + restore sequence. */
export interface WorkspaceState {
	workspaceId: string;
	rootPath: string;
	undoHeadCheckpointId: string | null;
	redoHeadCheckpointId: string | null;
	restoreSequence: number;
	lastCheckpointId: string | null;
	updatedAt: string;
}

/** Input shape for {@link CheckpointMetadataStore.putWorkspaceState}. */
export interface WorkspaceStateInput {
	rootPath: string;
	undoHeadCheckpointId?: string | null;
	redoHeadCheckpointId?: string | null;
	restoreSequence?: number;
	lastCheckpointId?: string | null;
}

/** Filter for {@link CheckpointMetadataStore.listCheckpoints}. */
export interface CheckpointListFilter {
	rootPath?: string;
	sessionId?: string;
	reason?: WorkspaceCheckpointReason;
	pinnedOnly?: boolean;
	completeness?: WorkspaceCheckpointCompleteness;
	automaticOnly?: boolean;
	limit?: number;
}

/** Mutable patch for {@link CheckpointMetadataStore.updateCheckpoint}. */
export interface CheckpointPatch {
	label?: string | null;
	completeness?: WorkspaceCheckpointCompleteness;
	fileCount?: number;
	totalBytes?: number;
	manifestObjectId?: string;
	parentId?: string | null;
	pinned?: boolean;
	reason?: WorkspaceCheckpointReason;
}

/** Input shape for {@link CheckpointMetadataStore.createRestorePlan}. */
export interface RestorePlanInput {
	checkpointId: string;
	rootPath: string;
	scope: WorkspaceRestoreScope;
	strategy: WorkspaceRestoreStrategy;
	operations: WorkspaceRestoreOperation[];
	conflicts: WorkspaceRestoreConflict[];
	conversationEntryId?: string | null;
}
/** Mutable patch for {@link CheckpointMetadataStore.updateRestorePlan}. */
export interface RestorePlanPatch {
	operations?: WorkspaceRestoreOperation[];
	conflicts?: WorkspaceRestoreConflict[];
	conversationEntryId?: string | null;
	appliedAt?: string | null;
	failedReason?: string | null;
	status?: RestorePlanStatus;
}

export type RestorePlanStatus = WorkspaceRestorePlanStatus;

/** Persisted redo edge — the next state we can `redo` to after an undo. */
export interface RedoEdge {
	rootPath: string;
	targetCheckpointId: string;
	sourceCheckpointId: string | null;
	planId: string | null;
	createdAt: string;
}

/** Restore transaction pointer. */
export interface WorkspaceTransaction {
	id: string;
	workspaceId: string;
	rootPath: string;
	planId: string | null;
	checkpointId: string | null;
	guardCheckpointId: string | null;
	state: "open" | "committed" | "rolled_back";
	conversationEntryId: string | null;
	createdAt: string;
	completedAt: string | null;
}

export interface WorkspaceTransactionStartInput {
	rootPath: string;
	planId?: string | null;
	checkpointId?: string | null;
	guardCheckpointId?: string | null;
	conversationEntryId?: string | null;
}

/**
 * Full-pointer shape accepted by {@link CheckpointMetadataStore.recordTransactionStart}
 * when the caller already has a `RestoreTransactionPointer` (or any equivalent)
 * from the restore-transaction module. `id`, `workspaceId`, `rootPath`,
 * `state`, `createdAt`, and `completedAt` are taken verbatim from the pointer;
 * `planId`/`checkpointId`/`guardCheckpointId`/`conversationEntryId` may be
 * omitted on the pointer and will default to `null` in the stored row.
 */
export interface WorkspaceTransactionPointerInput {
	id: string;
	workspaceId: string;
	rootPath: string;
	planId?: string | null;
	checkpointId?: string | null;
	guardCheckpointId?: string | null;
	state?: WorkspaceTransaction["state"];
	conversationEntryId?: string | null;
	createdAt?: string;
	completedAt?: string | null;
}
export interface TransactionListFilter {
	rootPath?: string;
	state?: WorkspaceTransaction["state"];
	limit?: number;
}

/** Why a checkpoint must be kept during garbage collection. */
export type GcRootReason =
	| "pinned"
	| "named"
	| "guard"
	| "active_transaction"
	| "redo_edge"
	| "workspace_pointer"
	| "recent_restore";

export interface GcRoot {
	checkpointId: string;
	reasons: GcRootReason[];
}

/** Result of a GC sweep — caller hands `releasedObjectIds` to the CAS layer. */
export interface GcResult {
	removedCheckpointIds: string[];
	releasedObjectIds: string[];
	keptCheckpointIds: string[];
}

export interface CheckpointMetadataStoreOptions {
	storageDir?: string;
}

export interface CheckpointMetadataStore {
	readonly storageDir: string;
	readonly dbPath: string;
	init(): Promise<void>;
	close(): void;
	// workspace pointer
	getWorkspaceState(rootPath: string): Promise<WorkspaceState | null>;
	putWorkspaceState(state: WorkspaceStateInput): Promise<WorkspaceState>;
	listWorkspaces(): Promise<WorkspaceState[]>;
	deleteWorkspaceState(rootPath: string): Promise<boolean>;
	// checkpoint
	createCheckpoint(
		request: CreateWorkspaceCheckpointRequest & {
			manifestObjectId: string;
			fileCount?: number;
			totalBytes?: number;
			advanceLastCheckpoint?: boolean;
		},
	): Promise<WorkspaceCheckpointRecord>;
	getCheckpoint(id: string): Promise<WorkspaceCheckpointRecord | null>;
	listCheckpoints(filter?: CheckpointListFilter): Promise<WorkspaceCheckpointRecord[]>;
	updateCheckpoint(id: string, patch: CheckpointPatch): Promise<WorkspaceCheckpointRecord>;
	deleteCheckpoint(id: string): Promise<boolean>;
	pinCheckpoint(id: string, pinned: boolean): Promise<WorkspaceCheckpointRecord>;
	createRestorePlan(input: RestorePlanInput): Promise<WorkspaceRestorePlanRecord>;
	getRestorePlan(id: string): Promise<WorkspaceRestorePlanRecord | null>;
	updateRestorePlan(id: string, patch: RestorePlanPatch): Promise<WorkspaceRestorePlanRecord>;
	deleteRestorePlan(id: string): Promise<boolean>;
	listRestorePlans(filter?: {
		rootPath?: string;
		checkpointId?: string;
		status?: RestorePlanStatus;
		limit?: number;
	}): Promise<WorkspaceRestorePlanRecord[]>;
	// redo edge
	setRedoEdge(edge: RedoEdge): Promise<RedoEdge>;
	clearRedoEdge(rootPath: string): Promise<boolean>;
	getRedoEdge(rootPath: string): Promise<RedoEdge | null>;
	// transaction
	recordTransactionStart(input: WorkspaceTransactionStartInput): Promise<WorkspaceTransaction>;
	recordTransactionFromPointer(pointer: WorkspaceTransactionPointerInput): Promise<WorkspaceTransaction>;
	markTransactionStatus(txId: string, state: WorkspaceTransaction["state"]): Promise<WorkspaceTransaction>;
	getTransaction(txId: string): Promise<WorkspaceTransaction | null>;
	listIncompleteTransactions(rootPath?: string): Promise<WorkspaceTransaction[]>;
	listTransactions(filter?: TransactionListFilter): Promise<WorkspaceTransaction[]>;
	// gc roots
	listGcRoots(rootPath?: string): Promise<GcRoot[]>;
	/** Stable, fs-safe segment derived from an absolute root path. */
	workspaceIdForRoot(rootPath: string): string;
	/** Currently-registered SQLite schema version. */
	readonly schemaVersion: number;
}

// ─── Schema ─────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
	workspace_id TEXT PRIMARY KEY,
	root_path TEXT NOT NULL UNIQUE,
	undo_head_checkpoint_id TEXT,
	redo_head_checkpoint_id TEXT,
	restore_sequence INTEGER NOT NULL DEFAULT 0,
	last_checkpoint_id TEXT,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (undo_head_checkpoint_id) REFERENCES checkpoints(id) ON DELETE SET NULL,
	FOREIGN KEY (redo_head_checkpoint_id) REFERENCES checkpoints(id) ON DELETE SET NULL,
	FOREIGN KEY (last_checkpoint_id) REFERENCES checkpoints(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL,
	root_path TEXT NOT NULL,
	manifest_object_id TEXT NOT NULL,
	parent_id TEXT,
	session_id TEXT,
	session_entry_id TEXT,
	prompt_entry_id TEXT,
	label TEXT,
	reason TEXT NOT NULL,
	completeness TEXT NOT NULL DEFAULT 'complete',
	created_at TEXT NOT NULL,
	file_count INTEGER NOT NULL DEFAULT 0,
	total_bytes INTEGER NOT NULL DEFAULT 0,
	pinned INTEGER NOT NULL DEFAULT 0,
	FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
	FOREIGN KEY (parent_id) REFERENCES checkpoints(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS checkpoints_root_idx ON checkpoints(root_path, created_at DESC);
CREATE INDEX IF NOT EXISTS checkpoints_session_idx ON checkpoints(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS checkpoints_reason_idx ON checkpoints(reason, created_at DESC);

CREATE TABLE IF NOT EXISTS restore_plans (
	id TEXT PRIMARY KEY,
	checkpoint_id TEXT NOT NULL,
	root_path TEXT NOT NULL,
	scope TEXT NOT NULL,
	strategy TEXT NOT NULL,
	operations_json TEXT NOT NULL,
	conflicts_json TEXT NOT NULL,
	conversation_entry_id TEXT,
	created_at TEXT NOT NULL,
	applied_at TEXT,
	failed_reason TEXT,
	status TEXT NOT NULL DEFAULT 'pending',
	FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS restore_plans_root_idx ON restore_plans(root_path, created_at DESC);
CREATE INDEX IF NOT EXISTS restore_plans_checkpoint_idx ON restore_plans(checkpoint_id, created_at DESC);

CREATE TABLE IF NOT EXISTS redo_edges (
	root_path TEXT PRIMARY KEY,
	target_checkpoint_id TEXT NOT NULL,
	source_checkpoint_id TEXT,
	plan_id TEXT,
	created_at TEXT NOT NULL,
	FOREIGN KEY (target_checkpoint_id) REFERENCES checkpoints(id) ON DELETE CASCADE,
	FOREIGN KEY (plan_id) REFERENCES restore_plans(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS transactions (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL,
	root_path TEXT NOT NULL,
	plan_id TEXT,
	checkpoint_id TEXT,
	guard_checkpoint_id TEXT,
	state TEXT NOT NULL DEFAULT 'open',
	conversation_entry_id TEXT,
	created_at TEXT NOT NULL,
	completed_at TEXT,
	FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
	FOREIGN KEY (plan_id) REFERENCES restore_plans(id) ON DELETE SET NULL,
	FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(id) ON DELETE SET NULL,
	FOREIGN KEY (guard_checkpoint_id) REFERENCES checkpoints(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS transactions_root_state_idx ON transactions(root_path, state, created_at DESC);
CREATE INDEX IF NOT EXISTS transactions_workspace_idx ON transactions(workspace_id, state, created_at DESC);
`;

// ─── Row shapes ─────────────────────────────────────────────────────────

interface WorkspaceRow {
	workspace_id: string;
	root_path: string;
	undo_head_checkpoint_id: string | null;
	redo_head_checkpoint_id: string | null;
	restore_sequence: number;
	last_checkpoint_id: string | null;
	updated_at: string;
}

interface CheckpointRow {
	id: string;
	workspace_id: string;
	root_path: string;
	manifest_object_id: string;
	parent_id: string | null;
	session_id: string | null;
	session_entry_id: string | null;
	prompt_entry_id: string | null;
	label: string | null;
	reason: string;
	completeness: string;
	created_at: string;
	file_count: number;
	total_bytes: number;
	pinned: number;
}

interface RestorePlanRow {
	id: string;
	checkpoint_id: string;
	root_path: string;
	scope: string;
	strategy: string;
	operations_json: string;
	conflicts_json: string;
	conversation_entry_id: string | null;
	created_at: string;
	applied_at: string | null;
	failed_reason: string | null;
	status: string;
}

interface RedoEdgeRow {
	root_path: string;
	target_checkpoint_id: string;
	source_checkpoint_id: string | null;
	plan_id: string | null;
	created_at: string;
}

interface TransactionRow {
	id: string;
	workspace_id: string;
	root_path: string;
	plan_id: string | null;
	checkpoint_id: string | null;
	guard_checkpoint_id: string | null;
	state: string;
	conversation_entry_id: string | null;
	created_at: string;
	completed_at: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function nowIso(): string {
	return new Date().toISOString();
}

function normalizeRoot(rootPath: string): string {
	if (!rootPath || typeof rootPath !== "string") {
		throw new Error(`workspace-checkpoints: invalid rootPath ${JSON.stringify(rootPath)}`);
	}
	return path.resolve(rootPath);
}

/** Stable, fs-safe workspace id derived from an absolute root path. */
export function workspaceIdForRoot(rootPath: string): string {
	const resolved = normalizeRoot(rootPath);
	const digest = Bun.hash(resolved).toString(16).padStart(16, "0").slice(-16);
	return `ws-${digest}`;
}

/** Generate a UUIDv7-shaped id — monotonic-ish, collision-resistant across processes. */
function generateId(): string {
	if (typeof Bun !== "undefined" && typeof Bun.randomUUIDv7 === "function") {
		return Bun.randomUUIDv7();
	}
	// Fallback for non-Bun runtimes — should not happen in this package.
	const rand = crypto.randomUUID();
	return `${nowIso()
		.replace(/[^0-9]/g, "")
		.slice(0, 8)}-${rand}`;
}

function rowToCheckpoint(row: CheckpointRow): WorkspaceCheckpointRecord {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		rootPath: row.root_path,
		manifestObjectId: row.manifest_object_id,
		parentId: row.parent_id,
		sessionId: row.session_id,
		sessionEntryId: row.session_entry_id,
		promptEntryId: row.prompt_entry_id,
		label: row.label,
		reason: row.reason as WorkspaceCheckpointReason,
		completeness: row.completeness as WorkspaceCheckpointCompleteness,
		createdAt: row.created_at,
		fileCount: row.file_count,
		totalBytes: row.total_bytes,
		pinned: row.pinned === 1,
	};
}

function rowToPlan(row: RestorePlanRow): WorkspaceRestorePlanRecord {
	const status = row.status as WorkspaceRestorePlanStatus;
	if (status !== "pending" && status !== "applied" && status !== "rolled_back" && status !== "failed") {
		throw new Error(`workspace-checkpoints: invalid restore plan status '${row.status}' for plan ${row.id}`);
	}
	return {
		id: row.id,
		checkpointId: row.checkpoint_id,
		rootPath: row.root_path,
		workspaceId: workspaceIdForRoot(row.root_path),
		scope: row.scope as WorkspaceRestoreScope,
		strategy: row.strategy as WorkspaceRestoreStrategy,
		operations: parseJsonArray<WorkspaceRestoreOperation>(row.operations_json),
		conflicts: parseJsonArray<WorkspaceRestoreConflict>(row.conflicts_json),
		conversationEntryId: row.conversation_entry_id,
		createdAt: row.created_at,
		status,
		appliedAt: row.applied_at,
		failedReason: row.failed_reason ?? null,
	};
}

function rowToRedoEdge(row: RedoEdgeRow): RedoEdge {
	return {
		rootPath: row.root_path,
		targetCheckpointId: row.target_checkpoint_id,
		sourceCheckpointId: row.source_checkpoint_id,
		planId: row.plan_id,
		createdAt: row.created_at,
	};
}

function rowToTransaction(row: TransactionRow): WorkspaceTransaction {
	const state = row.state as WorkspaceTransaction["state"];
	if (state !== "open" && state !== "committed" && state !== "rolled_back") {
		throw new Error(`workspace-checkpoints: invalid transaction state '${row.state}' for tx ${row.id}`);
	}
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		rootPath: row.root_path,
		planId: row.plan_id,
		checkpointId: row.checkpoint_id,
		guardCheckpointId: row.guard_checkpoint_id,
		state,
		conversationEntryId: row.conversation_entry_id,
		createdAt: row.created_at,
		completedAt: row.completed_at,
	};
}

function rowToWorkspace(row: WorkspaceRow): WorkspaceState {
	return {
		workspaceId: row.workspace_id,
		rootPath: row.root_path,
		undoHeadCheckpointId: row.undo_head_checkpoint_id,
		redoHeadCheckpointId: row.redo_head_checkpoint_id,
		restoreSequence: row.restore_sequence,
		lastCheckpointId: row.last_checkpoint_id,
		updatedAt: row.updated_at,
	};
}

function parseJsonArray<T>(value: string): T[] {
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed)) {
		throw new Error(`workspace-checkpoints: expected JSON array, got ${typeof parsed}`);
	}
	return parsed as T[];
}

function intValue(value: number | bigint | null | undefined): number {
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "number") return value;
	return 0;
}

// ─── Store implementation ──────────────────────────────────────────────

class SqliteCheckpointMetadataStore implements CheckpointMetadataStore {
	readonly storageDir: string;
	readonly dbPath: string;
	readonly schemaVersion: number;
	#db: Database;
	#opened = false;

	constructor(options: CheckpointMetadataStoreOptions = {}) {
		this.storageDir = options.storageDir ?? path.join(getAgentDir(), "checkpoints", "v1");
		this.dbPath = path.join(this.storageDir, DATABASE_FILENAME);
		this.schemaVersion = SCHEMA_VERSION;
		fs.mkdirSync(this.storageDir, { recursive: true });
		this.#db = new Database(this.dbPath, { create: true });
		this.#db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		this.#db.run("PRAGMA journal_mode = WAL");
		this.#db.run("PRAGMA synchronous = NORMAL");
		this.#db.run("PRAGMA foreign_keys = ON");
	}

	async init(): Promise<void> {
		if (this.#opened) return;
		this.#db.run(SCHEMA_SQL);
		const existing = readSchemaVersion(this.#db);
		if (existing === null) {
			this.#db.run("INSERT INTO schema_meta(key, value) VALUES('version', ?)", [String(SCHEMA_VERSION)]);
		} else if (existing > SCHEMA_VERSION) {
			throw new Error(
				`workspace-checkpoints: metadata DB schema version ${existing} is newer than supported ${SCHEMA_VERSION}`,
			);
		} else if (existing < SCHEMA_VERSION) {
			// Future migrations land here. We intentionally leave the row
			// untouched at the new version after upgrade scripts run; for v1
			// there is nothing to migrate yet.
			this.#db.run("UPDATE schema_meta SET value = ? WHERE key = 'version'", [String(SCHEMA_VERSION)]);
		}
		const restorePlanColumns = this.#db.prepare<{ name: string }, []>("PRAGMA table_info(restore_plans)").all();
		const restorePlanColumnNames = new Set(restorePlanColumns.map(column => column.name));
		if (!restorePlanColumnNames.has("failed_reason")) {
			this.#db.run("ALTER TABLE restore_plans ADD COLUMN failed_reason TEXT");
		}
		this.#opened = true;
	}

	#findWorkspaceRow(rootPath: string): WorkspaceRow | null {
		return this.#db
			.prepare<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE root_path = ?")
			.get(normalizeRoot(rootPath));
	}

	#findCheckpointRow(id: string): CheckpointRow | null {
		return this.#db.prepare<CheckpointRow, [string]>("SELECT * FROM checkpoints WHERE id = ?").get(id);
	}

	#findRestorePlanRow(id: string): RestorePlanRow | null {
		return this.#db.prepare<RestorePlanRow, [string]>("SELECT * FROM restore_plans WHERE id = ?").get(id);
	}

	#findRedoEdgeRow(rootPath: string): RedoEdgeRow | null {
		return this.#db
			.prepare<RedoEdgeRow, [string]>("SELECT * FROM redo_edges WHERE root_path = ?")
			.get(normalizeRoot(rootPath));
	}

	#findTransactionRow(id: string): TransactionRow | null {
		return this.#db.prepare<TransactionRow, [string]>("SELECT * FROM transactions WHERE id = ?").get(id);
	}

	close(): void {
		if (!this.#opened) return;
		try {
			this.#db.close();
		} catch (err) {
			logger.warn("workspace-checkpoints: failed to close metadata DB", {
				error: err instanceof Error ? err.message : String(err),
				path: this.dbPath,
			});
		}
		this.#opened = false;
	}

	// ─── workspace pointer ────────────────────────────────────────────────

	getWorkspaceState(rootPath: string): Promise<WorkspaceState | null> {
		const row = this.#findWorkspaceRow(rootPath);
		return Promise.resolve(row ? rowToWorkspace(row) : null);
	}

	putWorkspaceState(state: WorkspaceStateInput): Promise<WorkspaceState> {
		const resolved = normalizeRoot(state.rootPath);
		const workspaceId = workspaceIdForRoot(resolved);
		const updatedAt = nowIso();
		const insertOrReplace = this.#db.transaction(() => {
			this.#db.run(
				`INSERT INTO workspaces (
					workspace_id, root_path, undo_head_checkpoint_id, redo_head_checkpoint_id,
					restore_sequence, last_checkpoint_id, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(root_path) DO UPDATE SET
					undo_head_checkpoint_id = excluded.undo_head_checkpoint_id,
					redo_head_checkpoint_id = excluded.redo_head_checkpoint_id,
					restore_sequence = excluded.restore_sequence,
					last_checkpoint_id = excluded.last_checkpoint_id,
					updated_at = excluded.updated_at`,
				[
					workspaceId,
					resolved,
					state.undoHeadCheckpointId ?? null,
					state.redoHeadCheckpointId ?? null,
					state.restoreSequence ?? 0,
					state.lastCheckpointId ?? null,
					updatedAt,
				],
			);
		});
		insertOrReplace();
		const persisted = this.#findWorkspaceRow(resolved);
		if (!persisted) {
			throw new Error(`workspace-checkpoints: failed to read back workspace state for ${resolved} after upsert`);
		}
		return Promise.resolve(rowToWorkspace(persisted));
	}

	listWorkspaces(): Promise<WorkspaceState[]> {
		const rows = this.#db.prepare<WorkspaceRow, []>("SELECT * FROM workspaces ORDER BY updated_at DESC").all();
		return Promise.resolve(rows.map(rowToWorkspace));
	}

	deleteWorkspaceState(rootPath: string): Promise<boolean> {
		const resolved = normalizeRoot(rootPath);
		const result = this.#db.prepare("DELETE FROM workspaces WHERE root_path = ?").run(resolved);
		return Promise.resolve(intValue(result.changes) > 0);
	}

	// ─── checkpoint ──────────────────────────────────────────────────────

	createCheckpoint(
		request: CreateWorkspaceCheckpointRequest & {
			manifestObjectId: string;
			fileCount?: number;
			totalBytes?: number;
			advanceLastCheckpoint?: boolean;
		},
	): Promise<WorkspaceCheckpointRecord> {
		const resolved = normalizeRoot(request.rootPath);
		const workspaceId = workspaceIdForRoot(resolved);
		const id = generateId();
		const createdAt = nowIso();
		const pinned = request.pinned === true ? 1 : 0;
		const tx = this.#db.transaction(() => {
			// Make sure the workspace row exists so the FK holds.
			this.#db.run(
				`INSERT INTO workspaces (workspace_id, root_path, restore_sequence, updated_at)
				 VALUES (?, ?, 0, ?)
				 ON CONFLICT(root_path) DO NOTHING`,
				[workspaceId, resolved, createdAt],
			);
			this.#db.run(
				`INSERT INTO checkpoints (
					id, workspace_id, root_path, manifest_object_id, parent_id,
					session_id, session_entry_id, prompt_entry_id, label,
					reason, completeness, created_at, file_count, total_bytes, pinned
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					workspaceId,
					resolved,
					request.manifestObjectId,
					request.parentId ?? null,
					request.sessionId ?? null,
					request.sessionEntryId ?? null,
					request.promptEntryId ?? null,
					request.label ?? null,
					request.reason,
					"complete" satisfies WorkspaceCheckpointCompleteness,
					createdAt,
					request.fileCount ?? 0,
					request.totalBytes ?? 0,
					pinned,
				],
			);
			if (request.advanceLastCheckpoint !== false) {
				this.#db.run("UPDATE workspaces SET last_checkpoint_id = ?, updated_at = ? WHERE workspace_id = ?", [
					id,
					createdAt,
					workspaceId,
				]);
			}
		});
		tx();
		const created = this.#findCheckpointRow(id);
		if (!created) {
			throw new Error(`workspace-checkpoints: failed to read back checkpoint ${id}`);
		}
		return Promise.resolve(rowToCheckpoint(created));
	}

	getCheckpoint(id: string): Promise<WorkspaceCheckpointRecord | null> {
		const row = this.#findCheckpointRow(id);
		return Promise.resolve(row ? rowToCheckpoint(row) : null);
	}

	listCheckpoints(filter: CheckpointListFilter = {}): Promise<WorkspaceCheckpointRecord[]> {
		const clauses: string[] = [];
		const params: (string | number)[] = [];
		if (filter.rootPath !== undefined) {
			clauses.push("root_path = ?");
			params.push(normalizeRoot(filter.rootPath));
		}
		if (filter.sessionId !== undefined) {
			clauses.push("session_id = ?");
			params.push(filter.sessionId);
		}
		if (filter.reason !== undefined) {
			clauses.push("reason = ?");
			params.push(filter.reason);
		}
		if (filter.completeness !== undefined) {
			clauses.push("completeness = ?");
			params.push(filter.completeness);
		}
		if (filter.pinnedOnly === true) {
			clauses.push("pinned = 1");
		}
		if (filter.automaticOnly === true) {
			// Only automatic, non-named, non-pinned checkpoints are eligible for
			// garbage collection. Named checkpoints are kept by definition.
			clauses.push("pinned = 0");
			clauses.push("(label IS NULL OR label = '')");
		}
		const limit = filter.limit !== undefined && filter.limit > 0 ? filter.limit : null;
		const sql = `SELECT * FROM checkpoints${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC${limit !== null ? ` LIMIT ${Math.floor(limit)}` : ""}`;
		const rows = this.#db.prepare<CheckpointRow, typeof params>(sql).all(...params);
		return Promise.resolve(rows.map(rowToCheckpoint));
	}

	updateCheckpoint(id: string, patch: CheckpointPatch): Promise<WorkspaceCheckpointRecord> {
		const sets: string[] = [];
		const params: (string | number | null)[] = [];
		if (patch.label !== undefined) {
			sets.push("label = ?");
			params.push(patch.label);
		}
		if (patch.completeness !== undefined) {
			sets.push("completeness = ?");
			params.push(patch.completeness);
		}
		if (patch.fileCount !== undefined) {
			sets.push("file_count = ?");
			params.push(patch.fileCount);
		}
		if (patch.totalBytes !== undefined) {
			sets.push("total_bytes = ?");
			params.push(patch.totalBytes);
		}
		if (patch.manifestObjectId !== undefined) {
			sets.push("manifest_object_id = ?");
			params.push(patch.manifestObjectId);
		}
		if (patch.parentId !== undefined) {
			sets.push("parent_id = ?");
			params.push(patch.parentId);
		}
		if (patch.pinned !== undefined) {
			sets.push("pinned = ?");
			params.push(patch.pinned ? 1 : 0);
		}
		if (patch.reason !== undefined) {
			sets.push("reason = ?");
			params.push(patch.reason);
		}
		if (sets.length === 0) {
			const existing = this.#findCheckpointRow(id);
			if (!existing) throw new Error(`workspace-checkpoints: checkpoint ${id} not found`);
			return Promise.resolve(rowToCheckpoint(existing));
		}
		params.push(id);
		const tx = this.#db.transaction(() => {
			const result = this.#db
				.prepare(`UPDATE checkpoints SET ${sets.join(", ")} WHERE id = ?`)
				.run(...(params as never[]));
			if (intValue(result.changes) === 0) {
				throw new Error(`workspace-checkpoints: checkpoint ${id} not found`);
			}
		});
		tx();
		const updated = this.#findCheckpointRow(id);
		if (!updated) throw new Error(`workspace-checkpoints: checkpoint ${id} disappeared after update`);
		return Promise.resolve(rowToCheckpoint(updated));
	}

	deleteCheckpoint(id: string): Promise<boolean> {
		const result = this.#db.prepare("DELETE FROM checkpoints WHERE id = ?").run(id);
		return Promise.resolve(intValue(result.changes) > 0);
	}

	pinCheckpoint(id: string, pinned: boolean): Promise<WorkspaceCheckpointRecord> {
		return this.updateCheckpoint(id, { pinned });
	}

	// ─── restore plan ────────────────────────────────────────────────────

	createRestorePlan(input: RestorePlanInput): Promise<WorkspaceRestorePlanRecord> {
		const rootPath = normalizeRoot(input.rootPath);
		const id = generateId();
		const createdAt = nowIso();
		const operationsJson = JSON.stringify(input.operations);
		const conflictsJson = JSON.stringify(input.conflicts);
		const tx = this.#db.transaction(() => {
			this.#db.run(
				`INSERT INTO restore_plans (
					id, checkpoint_id, root_path, scope, strategy,
					operations_json, conflicts_json, conversation_entry_id,
					created_at, status
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
				[
					id,
					input.checkpointId,
					rootPath,
					input.scope,
					input.strategy,
					operationsJson,
					conflictsJson,
					input.conversationEntryId ?? null,
					createdAt,
				],
			);
		});
		tx();
		const created = this.#findRestorePlanRow(id);
		if (!created) {
			throw new Error(`workspace-checkpoints: failed to read back restore plan ${id}`);
		}
		return Promise.resolve(rowToPlan(created));
	}

	getRestorePlan(id: string): Promise<WorkspaceRestorePlanRecord | null> {
		const row = this.#findRestorePlanRow(id);
		return Promise.resolve(row ? rowToPlan(row) : null);
	}

	updateRestorePlan(id: string, patch: RestorePlanPatch): Promise<WorkspaceRestorePlanRecord> {
		const sets: string[] = [];
		const params: (string | number | null)[] = [];
		if (patch.operations !== undefined) {
			sets.push("operations_json = ?");
			params.push(JSON.stringify(patch.operations));
		}
		if (patch.conflicts !== undefined) {
			sets.push("conflicts_json = ?");
			params.push(JSON.stringify(patch.conflicts));
		}
		if (patch.conversationEntryId !== undefined) {
			sets.push("conversation_entry_id = ?");
			params.push(patch.conversationEntryId);
		}
		if (patch.appliedAt !== undefined) {
			sets.push("applied_at = ?");
			params.push(patch.appliedAt);
		}
		if (patch.failedReason !== undefined) {
			sets.push("failed_reason = ?");
			params.push(patch.failedReason);
		}
		if (patch.status !== undefined) {
			sets.push("status = ?");
			params.push(patch.status);
		}
		if (sets.length === 0) {
			const existing = this.#findRestorePlanRow(id);
			if (!existing) throw new Error(`workspace-checkpoints: restore plan ${id} not found`);
			return Promise.resolve(rowToPlan(existing));
		}
		params.push(id);
		const tx = this.#db.transaction(() => {
			const result = this.#db
				.prepare(`UPDATE restore_plans SET ${sets.join(", ")} WHERE id = ?`)
				.run(...(params as never[]));
			if (intValue(result.changes) === 0) {
				throw new Error(`workspace-checkpoints: restore plan ${id} not found`);
			}
		});
		tx();
		const updated = this.#findRestorePlanRow(id);
		if (!updated) throw new Error(`workspace-checkpoints: restore plan ${id} disappeared after update`);
		return Promise.resolve(rowToPlan(updated));
	}

	deleteRestorePlan(id: string): Promise<boolean> {
		const result = this.#db.prepare("DELETE FROM restore_plans WHERE id = ?").run(id);
		return Promise.resolve(intValue(result.changes) > 0);
	}

	listRestorePlans(
		filter: { rootPath?: string; checkpointId?: string; status?: RestorePlanStatus; limit?: number } = {},
	): Promise<WorkspaceRestorePlanRecord[]> {
		const clauses: string[] = [];
		const params: (string | number)[] = [];
		if (filter.rootPath !== undefined) {
			clauses.push("root_path = ?");
			params.push(normalizeRoot(filter.rootPath));
		}
		if (filter.checkpointId !== undefined) {
			clauses.push("checkpoint_id = ?");
			params.push(filter.checkpointId);
		}
		if (filter.status !== undefined) {
			clauses.push("status = ?");
			params.push(filter.status);
		}
		const limit = filter.limit !== undefined && filter.limit > 0 ? filter.limit : null;
		const sql = `SELECT * FROM restore_plans${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC${limit !== null ? ` LIMIT ${Math.floor(limit)}` : ""}`;
		const rows = this.#db.prepare<RestorePlanRow, typeof params>(sql).all(...params);
		return Promise.resolve(rows.map(rowToPlan));
	}

	// ─── redo edge ───────────────────────────────────────────────────────

	setRedoEdge(edge: RedoEdge): Promise<RedoEdge> {
		const rootPath = normalizeRoot(edge.rootPath);
		const tx = this.#db.transaction(() => {
			this.#db.run(
				`INSERT INTO redo_edges (root_path, target_checkpoint_id, source_checkpoint_id, plan_id, created_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(root_path) DO UPDATE SET
					target_checkpoint_id = excluded.target_checkpoint_id,
					source_checkpoint_id = excluded.source_checkpoint_id,
					plan_id = excluded.plan_id,
					created_at = excluded.created_at`,
				[rootPath, edge.targetCheckpointId, edge.sourceCheckpointId, edge.planId, edge.createdAt],
			);
		});
		tx();
		const persisted = this.#findRedoEdgeRow(rootPath);
		if (!persisted) {
			throw new Error(`workspace-checkpoints: failed to read back redo edge for ${rootPath}`);
		}
		return Promise.resolve(rowToRedoEdge(persisted));
	}

	clearRedoEdge(rootPath: string): Promise<boolean> {
		const resolved = normalizeRoot(rootPath);
		const result = this.#db.prepare("DELETE FROM redo_edges WHERE root_path = ?").run(resolved);
		return Promise.resolve(intValue(result.changes) > 0);
	}

	getRedoEdge(rootPath: string): Promise<RedoEdge | null> {
		const row = this.#findRedoEdgeRow(rootPath);
		return Promise.resolve(row ? rowToRedoEdge(row) : null);
	}

	// ─── transaction ────────────────────────────────────────────────────

	recordTransactionStart(input: WorkspaceTransactionStartInput): Promise<WorkspaceTransaction> {
		const resolved = normalizeRoot(input.rootPath);
		const workspaceId = workspaceIdForRoot(resolved);
		const id = generateId();
		const createdAt = nowIso();
		const tx = this.#db.transaction(() => {
			this.#db.run(
				`INSERT INTO workspaces (workspace_id, root_path, restore_sequence, updated_at)
				 VALUES (?, ?, 0, ?)
				 ON CONFLICT(root_path) DO NOTHING`,
				[workspaceId, resolved, createdAt],
			);
			this.#db.run(
				`INSERT INTO transactions (
					id, workspace_id, root_path, plan_id, checkpoint_id,
					guard_checkpoint_id, state, conversation_entry_id,
					created_at
				) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
				[
					id,
					workspaceId,
					resolved,
					input.planId ?? null,
					input.checkpointId ?? null,
					input.guardCheckpointId ?? null,
					input.conversationEntryId ?? null,
					createdAt,
				],
			);
		});
		tx();
		const created = this.#findTransactionRow(id);
		if (!created) {
			throw new Error(`workspace-checkpoints: failed to read back transaction ${id}`);
		}
		return Promise.resolve(rowToTransaction(created));
	}

	/**
	 * Upsert a transaction row directly from a {@link RestoreTransactionPointer}
	 * (or any structurally-compatible shape from the restore-transaction
	 * module). Unlike {@link recordTransactionStart} this preserves the
	 * pointer's `id`, `workspaceId`, `state`, `createdAt`, and `completedAt`
	 * verbatim — useful when crash-recovery replays a journal and wants to
	 * mirror its state into the metadata store without remapping fields.
	 *
	 * State mapping: 'open' → 'open', 'committed'/'rolled_back' → the same.
	 * `completedAt` defaults to `createdAt` for terminal states when the
	 * pointer omits it, so {@link listIncompleteTransactions} correctly
	 * excludes recovered transactions.
	 */
	recordTransactionFromPointer(pointer: WorkspaceTransactionPointerInput): Promise<WorkspaceTransaction> {
		const resolved = normalizeRoot(pointer.rootPath);
		const workspaceId = pointer.workspaceId;
		if (workspaceId !== workspaceIdForRoot(resolved)) {
			throw new Error(
				`workspace-checkpoints: pointer workspaceId ${workspaceId} does not match derived ${workspaceIdForRoot(resolved)} for ${resolved}`,
			);
		}
		const createdAt = pointer.createdAt ?? nowIso();
		const state = pointer.state ?? "open";
		const completedAt = state === "open" ? (pointer.completedAt ?? null) : (pointer.completedAt ?? createdAt);
		const upsert = this.#db.transaction(() => {
			this.#db.run(
				`INSERT INTO workspaces (workspace_id, root_path, restore_sequence, updated_at)
				 VALUES (?, ?, 0, ?)
				 ON CONFLICT(root_path) DO NOTHING`,
				[workspaceId, resolved, createdAt],
			);
			this.#db.run(
				`INSERT INTO transactions (
					id, workspace_id, root_path, plan_id, checkpoint_id,
					guard_checkpoint_id, state, conversation_entry_id,
					created_at, completed_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					plan_id = excluded.plan_id,
					checkpoint_id = excluded.checkpoint_id,
					guard_checkpoint_id = excluded.guard_checkpoint_id,
					state = excluded.state,
					conversation_entry_id = excluded.conversation_entry_id,
					completed_at = excluded.completed_at`,
				[
					pointer.id,
					workspaceId,
					resolved,
					pointer.planId ?? null,
					pointer.checkpointId ?? null,
					pointer.guardCheckpointId ?? null,
					state,
					pointer.conversationEntryId ?? null,
					createdAt,
					completedAt,
				],
			);
		});
		upsert();
		const row = this.#findTransactionRow(pointer.id);
		if (!row) {
			throw new Error(`workspace-checkpoints: failed to read back transaction ${pointer.id}`);
		}
		return Promise.resolve(rowToTransaction(row));
	}

	markTransactionStatus(txId: string, state: WorkspaceTransaction["state"]): Promise<WorkspaceTransaction> {
		const completedAt = state === "open" ? null : nowIso();
		const tx = this.#db.transaction(() => {
			const result = this.#db
				.prepare("UPDATE transactions SET state = ?, completed_at = ? WHERE id = ?")
				.run(state, completedAt, txId);
			if (intValue(result.changes) === 0) {
				throw new Error(`workspace-checkpoints: transaction ${txId} not found`);
			}
		});
		tx();
		const updated = this.#findTransactionRow(txId);
		if (!updated) {
			throw new Error(`workspace-checkpoints: transaction ${txId} disappeared after update`);
		}
		return Promise.resolve(rowToTransaction(updated));
	}

	getTransaction(txId: string): Promise<WorkspaceTransaction | null> {
		const row = this.#findTransactionRow(txId);
		return Promise.resolve(row ? rowToTransaction(row) : null);
	}

	listIncompleteTransactions(rootPath?: string): Promise<WorkspaceTransaction[]> {
		const clauses: string[] = ["state = 'open'"];
		const params: string[] = [];
		if (rootPath !== undefined) {
			clauses.push("root_path = ?");
			params.push(normalizeRoot(rootPath));
		}
		const rows = this.#db
			.prepare<TransactionRow, typeof params>(
				`SELECT * FROM transactions WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`,
			)
			.all(...params);
		return Promise.resolve(rows.map(rowToTransaction));
	}

	listTransactions(filter: TransactionListFilter = {}): Promise<WorkspaceTransaction[]> {
		const clauses: string[] = [];
		const params: (string | number)[] = [];
		if (filter.rootPath !== undefined) {
			clauses.push("root_path = ?");
			params.push(normalizeRoot(filter.rootPath));
		}
		if (filter.state !== undefined) {
			clauses.push("state = ?");
			params.push(filter.state);
		}
		const limit = filter.limit !== undefined && filter.limit > 0 ? filter.limit : null;
		const sql = `SELECT * FROM transactions${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC${limit !== null ? ` LIMIT ${Math.floor(limit)}` : ""}`;
		const rows = this.#db.prepare<TransactionRow, typeof params>(sql).all(...params);
		return Promise.resolve(rows.map(rowToTransaction));
	}

	// ─── gc roots ────────────────────────────────────────────────────────

	listGcRoots(rootPath?: string): Promise<GcRoot[]> {
		const roots = new Map<string, Set<GcRootReason>>();
		const add = (id: string | null, reason: GcRootReason): void => {
			if (!id) return;
			let set = roots.get(id);
			if (!set) {
				set = new Set<GcRootReason>();
				roots.set(id, set);
			}
			set.add(reason);
		};

		// Pinned OR named (label set) checkpoints are explicitly retained.
		// Run as two separate narrow queries so the OR semantics are
		// preserved (a checkpoint with only one of the two flags still
		// protects itself), while still scoping by rootPath when asked.
		const scopedRootPath = rootPath === undefined ? null : normalizeRoot(rootPath);
		const rootFilter = scopedRootPath === null ? "" : " AND root_path = ?";
		const rootParam = scopedRootPath === null ? [] : [scopedRootPath];

		const pinnedRows = this.#db
			.prepare<{ id: string; pinned: number }, string[]>(
				`SELECT id, pinned FROM checkpoints WHERE pinned = 1${rootFilter}`,
			)
			.all(...rootParam);
		for (const row of pinnedRows) {
			add(row.id, "pinned");
		}

		const namedRows = this.#db
			.prepare<{ id: string; label: string | null }, string[]>(
				`SELECT id, label FROM checkpoints WHERE label IS NOT NULL AND label != ''${rootFilter}`,
			)
			.all(...rootParam);
		for (const row of namedRows) {
			add(row.id, "named");
		}

		// Checkpoints referenced as a guard by an open transaction.
		const txParams: string[] = [];
		const txClauses: string[] = ["state = 'open'"];
		if (rootPath !== undefined) {
			txClauses.push("root_path = ?");
			txParams.push(normalizeRoot(rootPath));
		}
		const txRows = this.#db
			.prepare<{ guard_checkpoint_id: string | null; checkpoint_id: string | null }, string[]>(
				`SELECT guard_checkpoint_id, checkpoint_id FROM transactions WHERE ${txClauses.join(" AND ")}`,
			)
			.all(...txParams);
		for (const row of txRows) {
			add(row.guard_checkpoint_id, "active_transaction");
			add(row.checkpoint_id, "active_transaction");
		}

		// Checkpoint at the redo edge.
		const redoParams: string[] = [];
		const redoClauses: string[] = ["1=1"];
		if (rootPath !== undefined) {
			redoClauses.push("root_path = ?");
			redoParams.push(normalizeRoot(rootPath));
		}
		const redoRows = this.#db
			.prepare<{ target_checkpoint_id: string; source_checkpoint_id: string | null }, string[]>(
				`SELECT target_checkpoint_id, source_checkpoint_id FROM redo_edges WHERE ${redoClauses.join(" AND ")}`,
			)
			.all(...redoParams);
		for (const row of redoRows) {
			add(row.target_checkpoint_id, "redo_edge");
			add(row.source_checkpoint_id, "redo_edge");
		}

		// Workspace pointers always retain their heads + the latest checkpoint.
		const workspaceParams: string[] = [];
		const workspaceClauses: string[] = ["1=1"];
		if (rootPath !== undefined) {
			workspaceClauses.push("root_path = ?");
			workspaceParams.push(normalizeRoot(rootPath));
		}
		const wsRows = this.#db
			.prepare<
				{
					undo_head_checkpoint_id: string | null;
					redo_head_checkpoint_id: string | null;
					last_checkpoint_id: string | null;
				},
				string[]
			>(
				`SELECT undo_head_checkpoint_id, redo_head_checkpoint_id, last_checkpoint_id FROM workspaces WHERE ${workspaceClauses.join(" AND ")}`,
			)
			.all(...workspaceParams);
		for (const row of wsRows) {
			add(row.undo_head_checkpoint_id, "workspace_pointer");
			add(row.redo_head_checkpoint_id, "workspace_pointer");
			add(row.last_checkpoint_id, "workspace_pointer");
		}

		const out: GcRoot[] = [];
		for (const [checkpointId, reasons] of roots) {
			out.push({ checkpointId, reasons: [...reasons].sort() });
		}
		out.sort((a, b) => a.checkpointId.localeCompare(b.checkpointId));
		return Promise.resolve(out);
	}

	workspaceIdForRoot(rootPath: string): string {
		return workspaceIdForRoot(rootPath);
	}
}

function readSchemaVersion(db: Database): number | null {
	const row = db
		.prepare<{ value: string }, [string]>("SELECT value FROM schema_meta WHERE key = 'version'")
		.get("version");
	if (!row) return null;
	const parsed = Number.parseInt(row.value, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Build a fresh {@link CheckpointMetadataStore}. Caller MUST call `init()` before use. */
export function createCheckpointMetadataStore(options: CheckpointMetadataStoreOptions = {}): CheckpointMetadataStore {
	return new SqliteCheckpointMetadataStore(options);
}

export { SqliteCheckpointMetadataStore as _SqliteCheckpointMetadataStore };
