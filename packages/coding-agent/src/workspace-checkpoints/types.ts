export type WorkspaceCheckpointReason = "turn" | "manual" | "user_bash" | "task_merge" | "restore_guard";

export type WorkspaceCheckpointCompleteness = "complete" | "partial" | "corrupt";

export type WorkspaceRestoreScope = "code" | "conversation" | "all";

export type WorkspaceRestoreStrategy = "preserve" | "exact";

export type WorkspaceNodeKind = "directory" | "file" | "symlink";

export interface WorkspaceCheckpointExclusion {
	path: string;
	reason: string;
}

export interface WorkspaceManifestEntry {
	path: string;
	kind: WorkspaceNodeKind;
	mode: number;
	mtimeMs: number;
	size: number;
	objectId?: string;
	linkTarget?: string;
}

export interface GitIndexSnapshot {
	path: string;
	objectId: string;
	sharedIndexObjectIds: string[];
	sharedIndexNames: readonly string[];
}

export interface GitRepositorySnapshot {
	worktreePath: string;
	gitDir: string;
	commonDir: string;
	head: string | null;
	headRef: string | null;
	index: GitIndexSnapshot | null;
	/** Optional fields populated by the git capsule restore path. */
	headContent?: string | null;
	rawHeadObjectId?: string | null;
	isSubmodule?: boolean;
}

export interface WorkspaceManifest {
	version: 1;
	workspaceId: string;
	rootPath: string;
	entries: WorkspaceManifestEntry[];
	gitRepositories: GitRepositorySnapshot[];
	exclusions: WorkspaceCheckpointExclusion[];
	/** Ignored paths that must be re-included in later live Git scans. */
	trackedIgnoredPaths?: string[];
	/** Whether the manifest's full scan applied Git ignore rules. Legacy manifests default to false. */
	respectsGitIgnore?: boolean;
}

export interface WorkspaceCheckpointRecord {
	id: string;
	workspaceId: string;
	rootPath: string;
	manifestObjectId: string;
	parentId: string | null;
	sessionId: string | null;
	sessionEntryId: string | null;
	promptEntryId: string | null;
	label: string | null;
	reason: WorkspaceCheckpointReason;
	completeness: WorkspaceCheckpointCompleteness;
	createdAt: string;
	fileCount: number;
	totalBytes: number;
	pinned: boolean;
}

export interface CreateWorkspaceCheckpointRequest {
	rootPath: string;
	reason: WorkspaceCheckpointReason;
	label?: string;
	parentId?: string;
	sessionId?: string;
	sessionEntryId?: string;
	promptEntryId?: string;
	pinned?: boolean;
}

export interface ListWorkspaceCheckpointsRequest {
	rootPath: string;
	sessionId?: string;
	limit?: number;
}

export type WorkspaceRestoreConflictKind =
	| "active_mutator"
	| "current_state_changed"
	| "git_head_changed"
	| "missing_object"
	| "path_type_changed"
	| "permission_denied"
	| "unsupported_node";

export type WorkspaceRestoreOperationKind = "create" | "update" | "delete" | "chmod" | "symlink";

export interface WorkspaceRestoreConflict {
	path: string | null;
	kind: WorkspaceRestoreConflictKind;
	message: string;
}

export interface WorkspaceRestoreOperation {
	path: string;
	kind: WorkspaceRestoreOperationKind;
	objectId?: string;
	mode?: number;
	linkTarget?: string;
	/** Preview-time live-state guard for stale-plan detection. */
	expectedKind?: WorkspaceNodeKind | null;
	expectedObjectId?: string | null;
	expectedMode?: number;
	expectedLinkTarget?: string | null;
}

export interface PreviewWorkspaceRestoreRequest {
	checkpointId: string;
	/** When supplied, reject checkpoints owned by another transcript session. */
	sessionId?: string;
	scope: WorkspaceRestoreScope;
	strategy: WorkspaceRestoreStrategy;
	paths?: string[];
}

export interface WorkspaceRestorePlan {
	id: string;
	checkpointId: string;
	rootPath: string;
	scope: WorkspaceRestoreScope;
	strategy: WorkspaceRestoreStrategy;
	operations: WorkspaceRestoreOperation[];
	conflicts: WorkspaceRestoreConflict[];
	conversationEntryId: string | null;
	createdAt: string;
}

export interface ApplyWorkspaceRestoreRequest {
	planId: string;
	allowConflicts?: boolean;
}

export interface WorkspaceRestoreResult {
	transactionId: string;
	checkpointId: string;
	guardCheckpointId: string | null;
	restoredPaths: string[];
	skippedPaths: string[];
	conversationEntryId: string | null;
	redoAvailable: boolean;
	scope: WorkspaceRestoreScope;
	strategy: WorkspaceRestoreStrategy;
}

export interface UndoWorkspaceRequest {
	rootPath: string;
	sessionId?: string;
	scope?: WorkspaceRestoreScope;
}

export interface RedoWorkspaceRequest {
	rootPath: string;
	sessionId?: string;
}

export interface CaptureIgnoredPathBaselineRequest {
	rootPath: string;
	path: string;
	sessionId?: string;
}

export interface WorkspaceCheckpointService {
	create(request: CreateWorkspaceCheckpointRequest): Promise<WorkspaceCheckpointRecord>;
	list(request: ListWorkspaceCheckpointsRequest): Promise<WorkspaceCheckpointRecord[]>;
	/** Lazily attach an ignored path's pre-mutation state to the active undo checkpoint. */
	captureIgnoredPathBaseline?(request: CaptureIgnoredPathBaselineRequest): Promise<WorkspaceCheckpointRecord | null>;
	previewRestore(request: PreviewWorkspaceRestoreRequest): Promise<WorkspaceRestorePlan>;
	restore(request: ApplyWorkspaceRestoreRequest): Promise<WorkspaceRestoreResult>;
	undo(request: UndoWorkspaceRequest): Promise<WorkspaceRestoreResult>;
	redo(request: RedoWorkspaceRequest): Promise<WorkspaceRestoreResult>;
	dispose(): void;
}

// ---------------------------------------------------------------------------
// Shared infrastructure contracts (kept inside this module so the public
// surface is one barrel). Each consumer is intentionally narrow so a fresh
// adapter can be swapped in without leaking implementation details.
// ---------------------------------------------------------------------------

export const WORKSPACE_CONVERSATION_ROOT_ENTRY_ID = "workspace:conversation-root";

/** Adapter used to restore the conversation side of a workspace checkpoint. */
export interface WorkspaceCheckpointConversationAdapter {
	/** Restore the conversation entry referenced by `entryId`. Returns the resolved entry id, if any. */
	restoreConversationEntry?(request: {
		entryId: string;
		scope: WorkspaceRestoreScope;
		rootPath: string;
	}): Promise<string | null>;
}

/** Hook surface for blocking concurrent mutations while a restore runs. */
export interface WorkspaceCheckpointMutatorGuard {
	/** Return true when a mutating tool is currently active in the calling session. */
	isMutatorActive(): boolean;
	/** Yield until no mutator is active, or reject if `timeoutMs` elapses. */
	waitForIdle(timeoutMs?: number): Promise<void>;
}

/** Captured manifest scanner contract (CAS scanner). */
export interface WorkspaceScannerLike {
	scanWorkspace(options: { rootPath: string; exclusions?: readonly string[] }): Promise<WorkspaceManifest>;
	/** Compute the live file tree under rootPath as a manifest, used for `current_state_changed` conflicts. */
	scanCurrentWorkspace?(options: { rootPath: string }): Promise<WorkspaceManifest>;
}

/** Read access to content addressed by `objectId`; the service reads CAS objects during restore. */
export interface WorkspaceContentReaderLike {
	readBytes(objectId: string): Promise<Uint8Array | null>;
	has(objectId: string): Promise<boolean>;
}

/** Minimal git capsule contract — discovery/capture/restore of git state. */
export interface WorkspaceGitCapsuleLike {
	isAvailable(): Promise<boolean>;
	capture(rootPath: string): Promise<GitRepositorySnapshot[]>;
	restore(
		rootPath: string,
		repositories: readonly GitRepositorySnapshot[],
		options?: { restoreRef?: boolean },
	): Promise<void>;
}

/** Transaction abstraction over the persistence layer (journaling + locking). */
export interface WorkspaceRestoreTransactionLike {
	prepare(): Promise<void>;
	commit(): Promise<void>;
	rollback(): Promise<void>;
	readonly journalId: string;
}
/** Persistence contract for metadata, restore plans, redo edges, and tx pointers. */
export interface WorkspaceCheckpointStoreLike {
	init(): Promise<void>;
	close(): void;
	/** Stable workspace id derived from rootPath+agentDir; identical across restarts. */
	getWorkspaceId(rootPath: string): Promise<string>;
	getWorkspaceState(rootPath: string, sessionId?: string): Promise<WorkspaceStateRecord | null>;
	putWorkspaceState(state: WorkspaceStateRecord): Promise<void>;
	listWorkspaces(): Promise<WorkspaceStateRecord[]>;
	createCheckpoint(record: WorkspaceCheckpointRecord): Promise<void>;
	updateCheckpoint(id: string, patch: WorkspaceCheckpointRecordPatch): Promise<void>;
	getCheckpoint(id: string): Promise<WorkspaceCheckpointRecord | null>;
	listCheckpoints(filter: WorkspaceCheckpointFilter): Promise<WorkspaceCheckpointRecord[]>;
	deleteCheckpoint(id: string): Promise<void>;
	pinCheckpoint(id: string, pinned: boolean): Promise<void>;
	createRestorePlan(plan: WorkspaceRestorePlanRecord): Promise<void>;
	getRestorePlan(id: string): Promise<WorkspaceRestorePlanRecord | null>;
	updateRestorePlan(id: string, patch: WorkspaceRestorePlanPatch): Promise<void>;
	getRedoEdge(rootPath: string, sessionId?: string): Promise<WorkspaceRedoEdge | null>;
	setRedoEdge(edge: WorkspaceRedoEdge): Promise<void>;
	clearRedoEdge(rootPath: string, sessionId?: string): Promise<void>;
	listIncompleteTransactions(rootPath: string): Promise<WorkspaceTransactionPointer[]>;
	recordTransactionStart(tx: WorkspaceTransactionPointer): Promise<void>;
	markTransactionStatus(id: string, status: WorkspaceTransactionStatus): Promise<void>;
}

/** Constructor surface for a restore transaction, scoped to one rootPath. */
export type WorkspaceRestoreTransactionFactory = (
	options: WorkspaceRestoreTransactionFactoryOptions,
) => Promise<WorkspaceRestoreTransactionLike>;

export interface WorkspaceRestoreTransactionFactoryOptions {
	rootPath: string;
	workspaceId: string;
	operations: readonly WorkspaceRestoreOperation[];
	readObject: (objectId: string) => Promise<Uint8Array | null>;
}

// ---------------------------------------------------------------------------
// Records persisted alongside WorkspaceCheckpointRecord / WorkspaceRestorePlan.
// ---------------------------------------------------------------------------

export type WorkspaceRestorePlanStatus = "pending" | "applied" | "rolled_back" | "failed";

export type WorkspaceCheckpointCompletenessReason =
	| "scanner_partial"
	| "scanner_io_error"
	| "manifest_unreadable"
	| "git_capture_failed"
	| "aborted";

export interface WorkspaceCheckpointRecordPatch {
	completeness?: WorkspaceCheckpointCompleteness;
	completenessReason?: WorkspaceCheckpointCompletenessReason;
	fileCount?: number;
	totalBytes?: number;
	manifestObjectId?: string;
	parentId?: string | null;
	label?: string | null;
	pinned?: boolean;
}

export interface WorkspaceCheckpointFilter {
	rootPath?: string;
	sessionId?: string;
	reason?: WorkspaceCheckpointReason | readonly WorkspaceCheckpointReason[];
	pinnedOnly?: boolean;
	completeness?: WorkspaceCheckpointCompleteness | readonly WorkspaceCheckpointCompleteness[];
	limit?: number;
}

export interface WorkspaceRestorePlanRecord extends WorkspaceRestorePlan {
	workspaceId: string;
	status: WorkspaceRestorePlanStatus;
	appliedAt: string | null;
	failedReason: string | null;
}

export interface WorkspaceRestorePlanPatch {
	status?: WorkspaceRestorePlanStatus;
	operations?: readonly WorkspaceRestoreOperation[];
	conflicts?: readonly WorkspaceRestoreConflict[];
	conversationEntryId?: string | null;
	appliedAt?: string | null;
	failedReason?: string | null;
}

export interface WorkspaceStateRecord {
	workspaceId: string;
	rootPath: string;
	sessionId: string | null;
	undoHeadCheckpointId: string | null;
	redoHeadCheckpointId: string | null;
	lastCheckpointId: string | null;
	restoreSequence: number;
	updatedAt: string;
}

export interface WorkspaceRedoEdge {
	rootPath: string;
	sessionId: string | null;
	sourceCheckpointId: string | null;
	targetCheckpointId: string;
	planId: string | null;
	createdAt: string;
}

export type WorkspaceTransactionStatus = "PREPARED" | "APPLYING" | "COMMITTED" | "ROLLED_BACK" | "FAILED";

export interface WorkspaceTransactionPointer {
	id: string;
	rootPath: string;
	workspaceId: string;
	status: WorkspaceTransactionStatus;
	startedAt: string;
	updatedAt: string;
	operations: readonly WorkspaceRestoreOperation[];
	guardCheckpointId: string | null;
	planId: string | null;
	note?: string | null;
}

// ---------------------------------------------------------------------------
// Service-level errors.
// ---------------------------------------------------------------------------

/** Class name preserved for consumer `instanceof` checks. */
export const WORKSPACE_CHECKPOINT_ERROR_NAME = "WorkspaceCheckpointError";

/** Raised when restore cannot proceed because of conflicts and the caller didn't allow them. */
export class WorkspaceCheckpointError extends Error {
	readonly name = WORKSPACE_CHECKPOINT_ERROR_NAME;
	readonly conflicts: readonly WorkspaceRestoreConflict[];
	readonly planId: string | null;

	constructor(
		message: string,
		options: { conflicts?: readonly WorkspaceRestoreConflict[]; planId?: string | null } = {},
	) {
		super(message);
		this.conflicts = options.conflicts ?? [];
		this.planId = options.planId ?? null;
	}
}

// ---------------------------------------------------------------------------
// Defaults exposed so a thin adapter can reuse them without re-deriving.
// ---------------------------------------------------------------------------

/** Conservative limits; service-level knobs always override these. */
export const DEFAULT_WORKSPACE_CHECKPOINT_LIMITS = {
	/** Auto-create a checkpoint at most once per this many ms. */
	turnDebounceMs: 1_500,
	/** Default maximum entries persisted in a manifest; over this, the checkpoint is marked partial. */
	maxManifestEntries: 200_000,
	/** Default maximum total bytes for auto checkpoints. */
	maxAutoBytes: 256 * 1024 * 1024,
	/** Default retention: drop non-pinned checkpoints older than this (ms). */
	retentionMs: 14 * 24 * 60 * 60 * 1_000,
	/** Default maximum number of non-pinned checkpoints per workspace; GC evicts oldest first. */
	maxAutomaticPerWorkspace: 50,
	/** How long to wait for an active mutator before failing a restore. */
	mutatorTimeoutMs: 5_000,
} as const;

export interface WorkspaceCheckpointLimits {
	turnDebounceMs: number;
	maxManifestEntries: number;
	maxAutoBytes: number;
	retentionMs: number;
	maxAutomaticPerWorkspace: number;
	mutatorTimeoutMs: number;
}

/** Information passed to `applyPlan` after restore; consumed by retention scheduling. */
export interface WorkspaceCheckpointRetentionEvent {
	workspaceId: string;
	rootPath: string;
	checkpointId: string;
	reason: WorkspaceCheckpointReason;
	createdAt: string;
	totalBytes: number;
	completeness: WorkspaceCheckpointCompleteness;
}
