/**
 * Coordinator: thin orchestrator that wires the persistence store, scanner,
 * git capsule, content store, conversation adapter, mutator guard, lock, and
 * restore transaction together for the six workspace service methods.
 *
 * Composes sibling modules (`store.ts`, `scanner.ts`, `git-state.ts`,
 * `content-store.ts`, `locks.ts`, `restore-transaction.ts`) without
 * reimplementing any of them.
 *
 * Workspace isolation: content, lock, and journals all live under
 * `<storeDir>/workspaces/<workspaceId>/...` — the workspace root itself is
 * never touched. `scanWorkspace` requires an explicit content store so the
 * scanner can't reach inside the project either.
 *
 * Manifest objectIds come from `content.putBytes(...)` (sha256:<hex>) — the
 * CAS only accepts ids it returned.
 *
 * Git snapshot lives in the manifest: `WorkspaceManifest.gitRepositories` is
 * `GitRepositorySnapshot[]` with optional `headContent` / `isSubmodule` /
 * `sharedIndexNames` fields populated by the capture path. Restore rebuilds
 * the `WorkspaceGitStateSnapshot` from those fields.
 *
 * Conversation scope: scope=conversation uses the adapter only. scope=all
 * applies the file transaction first; if the adapter fails afterwards the
 * file transaction is rolled back so the two halves stay atomic.
 *
 * Session-scoped undo/redo: undo/redo filter by `request.sessionId` so two
 * sessions sharing a project root don't trample each other.
 */
import * as path from "node:path";
import { canonicalSnapshotKey } from "../edit/file-snapshot-store";
import * as git from "../utils/git";
import { openWorkspaceContentStoreAt, type WorkspaceContentStore } from "./content-store";
import {
	captureWorkspaceGitState,
	restoreWorkspaceGitState,
	type WorkspaceGitRepositoryState,
	type WorkspaceGitStateSnapshot,
} from "./git-state";
import { WorkspaceLockUnavailableError, withWorkspaceLock } from "./locks";
import { collectWorkspaceManifestObjectIds, parseWorkspaceManifest, saveWorkspaceManifest } from "./manifest";
import { computeRestorePlan } from "./restore-planner";
import {
	createRestoreTransaction,
	type RestoreTransaction,
	type RestoreTransactionPointer,
	recoverPendingRestoreTransactions,
} from "./restore-transaction";
import {
	scanWorkspace,
	scanWorkspacePaths,
	sortWorkspaceEntries,
	toWorkspaceRelativePath,
	type WorkspaceScanResult,
} from "./scanner";
import type { CheckpointMetadataStore, CheckpointPatch, RedoEdge, WorkspaceState, WorkspaceTransaction } from "./store";
import type {
	ApplyWorkspaceRestoreRequest,
	CaptureIgnoredPathBaselineRequest,
	CreateWorkspaceCheckpointRequest,
	GitRepositorySnapshot,
	ListWorkspaceCheckpointsRequest,
	PreviewWorkspaceRestoreRequest,
	RedoWorkspaceRequest,
	UndoWorkspaceRequest,
	WorkspaceCheckpointConversationAdapter,
	WorkspaceCheckpointMutatorGuard,
	WorkspaceCheckpointReason,
	WorkspaceCheckpointRecord,
	WorkspaceManifest,
	WorkspaceRestoreConflict,
	WorkspaceRestoreOperation,
	WorkspaceRestorePlan,
	WorkspaceRestoreResult,
} from "./types";
import { WorkspaceCheckpointError } from "./types";

export { WorkspaceCheckpointError };

export interface CoordinatorOptions {
	store: CheckpointMetadataStore;
	mutatorGuard?: WorkspaceCheckpointMutatorGuard;
	conversationAdapter?: WorkspaceCheckpointConversationAdapter;
	lockBaseDir?: string;
	checkpointsBaseDir?: string;
	storeDir?: string;
	now?: () => Date;
	limits?: CoordinatorLimits;
}

export interface CoordinatorLimits {
	mutatorTimeoutMs: number;
	maxManifestEntries: number;
	maxAutoBytes: number;
}

export interface CoordinatorRetentionEvent {
	workspaceId: string;
	rootPath: string;
	checkpointId: string;
	reason: WorkspaceCheckpointReason;
	createdAt: string;
	totalBytes: number;
	completeness: WorkspaceCheckpointRecord["completeness"];
	warning?: string;
}

export interface CoordinatorRetentionOptions {
	rootPath: string;
	maxPerSession?: number;
	maxAgeMs?: number;
	/** Skip full CAS traversal unless metadata eviction requires immediate reclamation. */
	sweepContent?: boolean;
}

export interface CoordinatorRetentionResult {
	removedCheckpointIds: string[];
	releasedObjectIds: string[];
	releasedBytes: number;
	keptCheckpointIds: string[];
}

const DEFAULT_MUTATOR_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_MANIFEST_ENTRIES = 200_000;
const DEFAULT_MAX_AUTO_BYTES = 256 * 1024 * 1024;
const DEFAULT_PENDING_RESTORE_PLAN_TTL_MS = 24 * 60 * 60 * 1000;

type Completeness = WorkspaceCheckpointRecord["completeness"];
type RestoreTransition = "direct" | "undo" | "redo";

export class Coordinator {
	readonly #store: CheckpointMetadataStore;
	readonly #mutator: WorkspaceCheckpointMutatorGuard | null;
	readonly #conversation: WorkspaceCheckpointConversationAdapter | null;
	readonly #lockBaseDir: string | undefined;
	readonly #checkpointsBaseDir: string | undefined;
	readonly #storeDir: string;
	readonly #now: () => Date;
	readonly #mutatorTimeoutMs: number;
	readonly #maxManifestEntries: number;
	readonly #maxAutoBytes: number;
	#contentStoreCache = new Map<string, WorkspaceContentStore>();
	#retentionListeners = new Set<(event: CoordinatorRetentionEvent) => void>();

	constructor(options: CoordinatorOptions) {
		this.#store = options.store;
		this.#mutator = options.mutatorGuard ?? null;
		this.#conversation = options.conversationAdapter ?? null;
		this.#lockBaseDir = options.lockBaseDir;
		this.#checkpointsBaseDir = options.checkpointsBaseDir;
		this.#storeDir = options.storeDir ?? options.store.storageDir;
		this.#now = options.now ?? ((): Date => new Date());
		this.#mutatorTimeoutMs = options.limits?.mutatorTimeoutMs ?? DEFAULT_MUTATOR_TIMEOUT_MS;
		this.#maxManifestEntries = options.limits?.maxManifestEntries ?? DEFAULT_MAX_MANIFEST_ENTRIES;
		this.#maxAutoBytes = options.limits?.maxAutoBytes ?? DEFAULT_MAX_AUTO_BYTES;
	}

	onRetention(listener: (event: CoordinatorRetentionEvent) => void): () => void {
		this.#retentionListeners.add(listener);
		return () => this.#retentionListeners.delete(listener);
	}

	#contentStoreDirFor(rootPath: string): string {
		const workspaceId = this.#store.workspaceIdForRoot(rootPath);
		return path.join(this.#storeDir, "workspaces", workspaceId);
	}

	async #contentStoreFor(rootPath: string): Promise<WorkspaceContentStore> {
		const storeDir = this.#contentStoreDirFor(rootPath);
		const cached = this.#contentStoreCache.get(storeDir);
		if (cached) return cached;
		const store = await openWorkspaceContentStoreAt(storeDir);
		this.#contentStoreCache.set(storeDir, store);
		return store;
	}

	async #withLock<T>(rootPath: string, workspaceId: string, fn: () => Promise<T>): Promise<T> {
		try {
			return await withWorkspaceLock({ rootPath, workspaceId, lockBaseDir: this.#lockBaseDir }, async () => fn());
		} catch (error) {
			if (error instanceof WorkspaceLockUnavailableError) {
				throw new WorkspaceCheckpointError(`workspace lock unavailable for ${rootPath}: ${error.message}`, {
					conflicts: [{ path: null, kind: "active_mutator", message: error.message }],
				});
			}
			throw error;
		}
	}

	#gitCas(rootPath: string): {
		put(bytes: Uint8Array): Promise<string>;
		get(id: string): Promise<Uint8Array | null>;
	} {
		return {
			put: async (bytes: Uint8Array): Promise<string> => {
				const store = await this.#contentStoreFor(rootPath);
				const { id } = await store.putBytes(bytes);
				return id;
			},
			get: async (id: string): Promise<Uint8Array | null> => {
				const store = await this.#contentStoreFor(rootPath);
				return store.readBytes(id);
			},
		};
	}

	#assertAllPathsSafe(operations: readonly WorkspaceRestoreOperation[], rootPath: string): void {
		const absoluteRoot = path.resolve(rootPath);
		for (const op of operations) {
			const absolute = path.resolve(absoluteRoot, op.path);
			const relative = path.relative(absoluteRoot, absolute);
			if (relative.startsWith("..") || path.isAbsolute(relative)) {
				throw new WorkspaceCheckpointError(`restore op escapes root: ${op.path}`);
			}
		}
	}

	async #readObject(rootPath: string, objectId: string): Promise<Uint8Array | null> {
		const store = await this.#contentStoreFor(rootPath);
		return store.readBytes(objectId);
	}

	async #loadManifest(checkpoint: WorkspaceCheckpointRecord): Promise<WorkspaceManifest> {
		const content = await this.#contentStoreFor(checkpoint.rootPath);
		const bytes = await content.readBytes(checkpoint.manifestObjectId);
		if (!bytes) {
			throw new WorkspaceCheckpointError(
				`manifest missing for checkpoint ${checkpoint.id} (objectId=${checkpoint.manifestObjectId})`,
			);
		}
		try {
			const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
			if (checkpoint.manifestObjectId !== `sha256:${digest}`) {
				throw new Error(`content hash mismatch for ${checkpoint.manifestObjectId}`);
			}
			return parseWorkspaceManifest(
				new TextDecoder("utf-8", { fatal: false }).decode(bytes),
				checkpoint.manifestObjectId,
			);
		} catch (error) {
			throw new WorkspaceCheckpointError(
				`manifest corrupt for checkpoint ${checkpoint.id}: ${(error as Error).message}`,
			);
		}
	}

	#buildGitSnapshotFromManifest(manifest: WorkspaceManifest): WorkspaceGitStateSnapshot {
		const repositories: WorkspaceGitRepositoryState[] = manifest.gitRepositories.map(repo => ({
			worktreePath: repo.worktreePath,
			gitDir: repo.gitDir,
			commonDir: repo.commonDir,
			head: repo.head,
			headRef: repo.headRef,
			index: repo.index,
			headContent: repo.headContent ?? null,
			rawHeadObjectId: repo.rawHeadObjectId ?? null,
			isSubmodule: repo.isSubmodule ?? false,
		}));
		return { repositories };
	}

	async #safeLiveScan(rootPath: string, includePaths: readonly string[] = []): Promise<WorkspaceScanResult | null> {
		try {
			const content = await this.#contentStoreFor(rootPath);
			return await scanWorkspace({ rootPath, contentStore: content, persistFileContents: false, includePaths });
		} catch {
			return null;
		}
	}

	#includePathsForManifest(manifest: WorkspaceManifest): string[] {
		if (manifest.respectsGitIgnore === true) return [...(manifest.trackedIgnoredPaths ?? [])];
		return manifest.entries.filter(entry => entry.path !== "" && entry.kind !== "directory").map(entry => entry.path);
	}

	async #captureFullGitSnapshot(rootPath: string, required = false): Promise<WorkspaceGitStateSnapshot | null> {
		try {
			return await captureWorkspaceGitState(rootPath, this.#gitCas(rootPath));
		} catch (error) {
			if (required) {
				throw new WorkspaceCheckpointError(`restore guard git capture failed: ${(error as Error).message}`);
			}
			return null;
		}
	}

	async #createRestoreGuard(
		rootPath: string,
		checkpoint: WorkspaceCheckpointRecord,
		includePaths: readonly string[],
	): Promise<WorkspaceCheckpointRecord> {
		return this.#createCheckpointInner(
			{
				rootPath,
				reason: "restore_guard",
				parentId: checkpoint.id,
				sessionId: checkpoint.sessionId ?? undefined,
			},
			{ updateWorkspaceState: false, includePaths },
		);
	}

	#emitRetention(event: CoordinatorRetentionEvent): void {
		for (const listener of this.#retentionListeners) {
			try {
				listener(event);
			} catch {
				// listeners must not break the create path
			}
		}
	}

	#emitWarning(rootPath: string, workspaceId: string, message: string): void {
		this.#emitRetention({
			workspaceId,
			rootPath,
			checkpointId: "",
			reason: "manual",
			createdAt: this.#now().toISOString(),
			totalBytes: 0,
			completeness: "partial",
			warning: message,
		});
	}

	// ─── create ───────────────────────────────────────────────────────────

	createCheckpoint(request: CreateWorkspaceCheckpointRequest): Promise<WorkspaceCheckpointRecord> {
		return this.#withLock(request.rootPath, this.#store.workspaceIdForRoot(request.rootPath), async () => {
			const result = await this.#createCheckpointInner(request);
			this.#emitRetention({
				workspaceId: result.workspaceId,
				rootPath: result.rootPath,
				checkpointId: result.id,
				reason: result.reason,
				createdAt: result.createdAt,
				totalBytes: result.totalBytes,
				completeness: result.completeness,
			});
			return result;
		});
	}

	async captureIgnoredPathBaseline(
		request: CaptureIgnoredPathBaselineRequest,
	): Promise<WorkspaceCheckpointRecord | null> {
		const rootPath = path.resolve(request.rootPath);
		const absolutePath = path.isAbsolute(request.path)
			? path.resolve(request.path)
			: path.resolve(rootPath, request.path);
		const canonicalRootPath = canonicalSnapshotKey(rootPath);
		let relativePath: string;
		try {
			relativePath = toWorkspaceRelativePath(rootPath, absolutePath);
		} catch {
			try {
				relativePath = toWorkspaceRelativePath(canonicalRootPath, canonicalSnapshotKey(absolutePath));
			} catch {
				return null;
			}
		}
		if (!relativePath) return null;

		const repositoryRoot = await git.repo.root(rootPath);
		if (!repositoryRoot) return null;
		const workspaceRootInRepository = path.relative(canonicalSnapshotKey(repositoryRoot), canonicalRootPath);
		if (
			workspaceRootInRepository === ".." ||
			workspaceRootInRepository.startsWith(`..${path.sep}`) ||
			path.isAbsolute(workspaceRootInRepository)
		) {
			return null;
		}
		const repositoryRelativePath = workspaceRootInRepository
			? path.join(workspaceRootInRepository, relativePath)
			: relativePath;
		if (!(await git.ignore.isIgnored(repositoryRoot, repositoryRelativePath))) return null;

		const workspaceId = this.#store.workspaceIdForRoot(rootPath);
		return this.#withLock(rootPath, workspaceId, async () => {
			const state = await this.#store.getWorkspaceState(rootPath);
			if (!state?.undoHeadCheckpointId) return null;
			const checkpoint = await this.#store.getCheckpoint(state.undoHeadCheckpointId);
			if (!checkpoint) {
				throw new WorkspaceCheckpointError(`undo head checkpoint missing: ${state.undoHeadCheckpointId}`);
			}
			if (request.sessionId && checkpoint.sessionId && checkpoint.sessionId !== request.sessionId) {
				throw new WorkspaceCheckpointError(`undo head belongs to a different session (${checkpoint.sessionId})`);
			}

			const manifest = await this.#loadManifest(checkpoint);
			const trackedIgnoredPaths = new Set(
				manifest.respectsGitIgnore === true
					? (manifest.trackedIgnoredPaths ?? [])
					: manifest.entries
							.filter(entry => entry.path !== "" && entry.kind !== "directory")
							.map(entry => entry.path),
			);
			if (trackedIgnoredPaths.has(relativePath)) return checkpoint;
			trackedIgnoredPaths.add(relativePath);

			const entriesByPath = new Map(manifest.entries.map(entry => [entry.path, entry] as const));
			if (!entriesByPath.has(relativePath)) {
				const content = await this.#contentStoreFor(rootPath);
				const baseline = await scanWorkspacePaths({ rootPath, contentStore: content, paths: [relativePath] });
				for (const entry of baseline.entries) {
					if (!entriesByPath.has(entry.path)) entriesByPath.set(entry.path, entry);
				}
			}

			const entries = sortWorkspaceEntries([...entriesByPath.values()]);
			const nextManifest: WorkspaceManifest = {
				...manifest,
				entries,
				trackedIgnoredPaths: [...trackedIgnoredPaths].sort(),
				respectsGitIgnore: true,
			};
			const content = await this.#contentStoreFor(rootPath);
			const persisted = await saveWorkspaceManifest(content, nextManifest);
			return this.#store.updateCheckpoint(checkpoint.id, {
				manifestObjectId: persisted.manifestObjectId,
				fileCount: entries.reduce((count, entry) => count + (entry.kind === "file" ? 1 : 0), 0),
				totalBytes: entries.reduce((bytes, entry) => bytes + (entry.kind === "file" ? entry.size : 0), 0),
			});
		});
	}

	async #createCheckpointInner(
		request: CreateWorkspaceCheckpointRequest,
		options: { updateWorkspaceState?: boolean; includePaths?: readonly string[] } = {},
	): Promise<WorkspaceCheckpointRecord> {
		await this.#store.init();
		const rootPath = request.rootPath;
		const workspaceId = this.#store.workspaceIdForRoot(rootPath);
		const content = await this.#contentStoreFor(rootPath);

		let scan: WorkspaceScanResult;
		try {
			scan = await scanWorkspace({ rootPath, contentStore: content, includePaths: options.includePaths });
		} catch (error) {
			if (options.updateWorkspaceState === false) {
				throw new WorkspaceCheckpointError(`restore guard scan failed: ${(error as Error).message}`);
			}
			scan = {
				rootPath,
				workspaceId,
				entries: [],
				exclusions: [],
				gitRepositories: [],
				trackedIgnoredPaths: [],
				respectsGitIgnore: false,
				fileCount: 0,
				totalBytes: 0,
				completeness: "partial",
			};
			this.#emitWarning(rootPath, workspaceId, `scanner failed: ${(error as Error).message}`);
		}
		if (options.updateWorkspaceState === false && scan.completeness !== "complete") {
			throw new WorkspaceCheckpointError("restore guard scan was incomplete");
		}

		// Embed the rich git snapshot (headContent + isSubmodule) into the
		// manifest's gitRepositories slot via the optional GitRepositorySnapshot
		// fields. Restore rebuilds the WorkspaceGitStateSnapshot from there.
		const fullGitSnapshot = await this.#captureFullGitSnapshot(rootPath, options.updateWorkspaceState === false);
		const gitForManifest: GitRepositorySnapshot[] = fullGitSnapshot
			? fullGitSnapshot.repositories.map(repo => slimGitRepository(repo))
			: scan.gitRepositories;

		let completeness: Completeness = scan.completeness;
		if (scan.entries.length > this.#maxManifestEntries) completeness = "partial";
		if (scan.totalBytes > this.#maxAutoBytes) completeness = "partial";

		const manifest: WorkspaceManifest = {
			version: 1,
			workspaceId,
			rootPath,
			entries: scan.entries,
			gitRepositories: gitForManifest,
			exclusions: scan.exclusions,
			trackedIgnoredPaths: scan.trackedIgnoredPaths,
			respectsGitIgnore: scan.respectsGitIgnore,
		};
		const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
		const { id: manifestObjectId } = await content.putBytes(manifestBytes);

		const previousState = await this.#store.getWorkspaceState(rootPath);
		const previousHead = previousState?.lastCheckpointId ?? null;

		const created = await this.#store.createCheckpoint({
			...request,
			rootPath,
			manifestObjectId,
			parentId: request.parentId ?? previousHead ?? undefined,
			advanceLastCheckpoint: options.updateWorkspaceState !== false,
		});
		const record = await this.#store.updateCheckpoint(created.id, {
			completeness,
			fileCount: scan.fileCount,
			totalBytes: scan.totalBytes,
		});

		if (options.updateWorkspaceState !== false) {
			const nextState: WorkspaceState = {
				workspaceId,
				rootPath,
				undoHeadCheckpointId: created.id,
				redoHeadCheckpointId: null,
				restoreSequence: previousState?.restoreSequence ?? 0,
				lastCheckpointId: created.id,
				updatedAt: this.#now().toISOString(),
			};
			await this.#store.putWorkspaceState(nextState);
			await this.#store.clearRedoEdge(rootPath);
		}

		return record;
	}

	// ─── list ─────────────────────────────────────────────────────────────

	async listCheckpoints(request: ListWorkspaceCheckpointsRequest): Promise<WorkspaceCheckpointRecord[]> {
		await this.#store.init();
		return this.#store.listCheckpoints({
			rootPath: request.rootPath,
			sessionId: request.sessionId,
			limit: request.limit,
		});
	}

	async runRetention(options: CoordinatorRetentionOptions): Promise<CoordinatorRetentionResult> {
		await this.#store.init();
		const workspaceId = this.#store.workspaceIdForRoot(options.rootPath);
		return this.#withLock(options.rootPath, workspaceId, async () => {
			const checkpoints = await this.#store.listCheckpoints({ rootPath: options.rootPath });
			const roots = await this.#store.listGcRoots(options.rootPath);
			const protectedIds = new Set(roots.map(root => root.checkpointId));
			const pendingPlanCutoffMs = this.#now().getTime() - DEFAULT_PENDING_RESTORE_PLAN_TTL_MS;
			const pendingPlans = await this.#store.listRestorePlans({
				rootPath: options.rootPath,
				status: "pending",
				limit: Number.MAX_SAFE_INTEGER,
			});
			for (const plan of pendingPlans) {
				const createdAtMs = Date.parse(plan.createdAt);
				if (Number.isFinite(createdAtMs) && createdAtMs >= pendingPlanCutoffMs) {
					protectedIds.add(plan.checkpointId);
					continue;
				}
				await this.#store.updateRestorePlan(plan.id, {
					status: "failed",
					failedReason: "restore plan expired before apply",
				});
			}
			const cutoffMs =
				typeof options.maxAgeMs === "number" && options.maxAgeMs > 0
					? this.#now().getTime() - options.maxAgeMs
					: Number.NEGATIVE_INFINITY;
			const removableBySession = new Map<string, WorkspaceCheckpointRecord[]>();
			const removedIds = new Set<string>();

			for (const checkpoint of checkpoints) {
				if (protectedIds.has(checkpoint.id)) continue;
				const sessionId = checkpoint.sessionId ?? "<no-session>";
				const sessionCheckpoints = removableBySession.get(sessionId);
				if (sessionCheckpoints) sessionCheckpoints.push(checkpoint);
				else removableBySession.set(sessionId, [checkpoint]);
				const createdAtMs = Date.parse(checkpoint.createdAt);
				if (Number.isFinite(createdAtMs) && createdAtMs < cutoffMs) removedIds.add(checkpoint.id);
			}

			if (options.maxPerSession !== undefined && options.maxPerSession > 0) {
				for (const sessionCheckpoints of removableBySession.values()) {
					if (sessionCheckpoints.length <= options.maxPerSession) continue;
					const sorted = sessionCheckpoints.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
					const evictCount = sorted.length - options.maxPerSession;
					for (let index = 0; index < evictCount; index++) {
						const checkpoint = sorted[index];
						if (checkpoint) removedIds.add(checkpoint.id);
					}
				}
			}

			for (const checkpointId of removedIds) await this.#store.deleteCheckpoint(checkpointId);

			const remaining = await this.#store.listCheckpoints({ rootPath: options.rootPath });
			if (options.sweepContent === false && removedIds.size === 0) {
				return {
					removedCheckpointIds: [],
					releasedObjectIds: [],
					releasedBytes: 0,
					keptCheckpointIds: remaining.map(checkpoint => checkpoint.id),
				};
			}
			const reachableObjectIds = new Set<string>();
			for (const checkpoint of remaining) {
				reachableObjectIds.add(checkpoint.manifestObjectId);
				const manifest = await this.#loadManifest(checkpoint);
				for (const objectId of collectWorkspaceManifestObjectIds(manifest)) reachableObjectIds.add(objectId);
			}
			const content = await this.#contentStoreFor(options.rootPath);
			const sweep = await content.sweepUnreachable(reachableObjectIds);
			return {
				removedCheckpointIds: [...removedIds],
				releasedObjectIds: sweep.deletedObjectIds,
				releasedBytes: sweep.deletedBytes,
				keptCheckpointIds: remaining.map(checkpoint => checkpoint.id),
			};
		});
	}

	// ─── preview ──────────────────────────────────────────────────────────

	previewRestore(request: PreviewWorkspaceRestoreRequest): Promise<WorkspaceRestorePlan> {
		return this.#store.getCheckpoint(request.checkpointId).then(checkpoint => {
			if (!checkpoint) throw new WorkspaceCheckpointError(`checkpoint not found: ${request.checkpointId}`);
			return this.#withLock(checkpoint.rootPath, checkpoint.workspaceId, async () =>
				this.#previewRestoreInner(request),
			);
		});
	}

	async #previewRestoreInner(request: PreviewWorkspaceRestoreRequest): Promise<WorkspaceRestorePlan> {
		await this.#store.init();
		const checkpoint = await this.#store.getCheckpoint(request.checkpointId);
		if (!checkpoint) {
			throw new WorkspaceCheckpointError(`checkpoint not found: ${request.checkpointId}`);
		}
		const manifest = await this.#loadManifest(checkpoint);
		const liveScan =
			request.scope !== "conversation"
				? await this.#safeLiveScan(checkpoint.rootPath, this.#includePathsForManifest(manifest))
				: null;
		const liveManifest: WorkspaceManifest | null = liveScan
			? {
					version: 1,
					workspaceId: liveScan.workspaceId,
					rootPath: liveScan.rootPath,
					entries: liveScan.entries,
					gitRepositories: liveScan.gitRepositories,
					exclusions: liveScan.exclusions,
					trackedIgnoredPaths: liveScan.trackedIgnoredPaths,
					respectsGitIgnore: liveScan.respectsGitIgnore,
				}
			: null;
		const plan = computeRestorePlan({
			checkpointId: checkpoint.id,
			rootPath: checkpoint.rootPath,
			target: manifest,
			liveManifest,
			request,
		});
		plan.conversationEntryId = checkpoint.promptEntryId ?? checkpoint.sessionEntryId ?? null;
		if (this.#mutator?.isMutatorActive()) {
			const conflicts: WorkspaceRestoreConflict[] = [
				...plan.conflicts,
				{ path: null, kind: "active_mutator", message: "active mutator is running" },
			];
			plan.conflicts = conflicts;
		}
		const persisted = await this.#store.createRestorePlan({
			checkpointId: checkpoint.id,
			rootPath: checkpoint.rootPath,
			scope: request.scope,
			strategy: request.strategy,
			operations: plan.operations,
			conflicts: plan.conflicts,
			conversationEntryId: plan.conversationEntryId,
		});
		return {
			...plan,
			id: persisted.id,
			conversationEntryId: persisted.conversationEntryId ?? plan.conversationEntryId,
		};
	}

	// ─── restore ──────────────────────────────────────────────────────────

	restorePlan(request: ApplyWorkspaceRestoreRequest): Promise<WorkspaceRestoreResult> {
		return this.#store.getRestorePlan(request.planId).then(plan => {
			if (!plan) throw new WorkspaceCheckpointError(`restore plan not found: ${request.planId}`);
			const workspaceId = this.#store.workspaceIdForRoot(plan.rootPath);
			return this.#withLock(plan.rootPath, workspaceId, async () =>
				this.#restorePlanInner(request, workspaceId, plan.rootPath, "direct"),
			);
		});
	}

	async #restorePlanInner(
		request: ApplyWorkspaceRestoreRequest,
		workspaceId: string,
		rootPath: string,
		transition: RestoreTransition,
	): Promise<WorkspaceRestoreResult> {
		await this.#store.init();
		const planRecord = await this.#store.getRestorePlan(request.planId);
		if (!planRecord) throw new WorkspaceCheckpointError(`restore plan not found: ${request.planId}`);

		const checkpoint = await this.#store.getCheckpoint(planRecord.checkpointId);
		if (!checkpoint) {
			throw new WorkspaceCheckpointError(`checkpoint not found: ${planRecord.checkpointId}`);
		}
		const manifest = await this.#loadManifest(checkpoint);
		if (planRecord.scope === "conversation") {
			if (!this.#conversation?.restoreConversationEntry || !planRecord.conversationEntryId) {
				throw new WorkspaceCheckpointError(
					"conversation restore requires a conversation adapter with restoreConversationEntry and a conversation entry id",
				);
			}
			const conversationEntryId = await this.#conversation.restoreConversationEntry({
				entryId: planRecord.conversationEntryId,
				scope: planRecord.scope,
				rootPath,
			});
			return {
				transactionId: "",
				checkpointId: planRecord.checkpointId,
				guardCheckpointId: null,
				restoredPaths: [],
				skippedPaths: [],
				conversationEntryId,
				redoAvailable: false,
			};
		}

		if (this.#mutator) {
			try {
				await this.#mutator.waitForIdle(this.#mutatorTimeoutMs);
			} catch {
				throw new WorkspaceCheckpointError(`mutator did not settle within ${this.#mutatorTimeoutMs}ms`, {
					conflicts: [{ path: null, kind: "active_mutator", message: "mutator busy" }],
					planId: request.planId,
				});
			}
		}
		this.#assertAllPathsSafe(planRecord.operations, rootPath);

		const liveScan = await this.#safeLiveScan(rootPath, this.#includePathsForManifest(manifest));
		const liveManifest: WorkspaceManifest | null = liveScan
			? {
					version: 1,
					workspaceId: liveScan.workspaceId,
					rootPath: liveScan.rootPath,
					entries: liveScan.entries,
					gitRepositories: liveScan.gitRepositories,
					exclusions: liveScan.exclusions,
					trackedIgnoredPaths: liveScan.trackedIgnoredPaths,
					respectsGitIgnore: liveScan.respectsGitIgnore,
				}
			: null;
		const liveIndex = liveManifest
			? new Map(liveManifest.entries.map(entry => [entry.path, entry] as const))
			: new Map();
		const revalidationConflicts: WorkspaceRestoreConflict[] = [];
		for (const op of planRecord.operations) {
			if ((op.kind === "create" || op.kind === "update") && op.objectId) {
				const bytes = await this.#readObject(rootPath, op.objectId);
				if (bytes === null) {
					revalidationConflicts.push({
						path: op.path,
						kind: "missing_object",
						message: `missing object ${op.objectId}`,
					});
				}
			}
			const liveEntry = liveIndex.get(op.path);
			const currentKind = liveEntry?.kind;
			const currentObjectId = liveEntry?.objectId ?? null;
			const currentMode = liveEntry?.mode;
			const currentLinkTarget = liveEntry?.linkTarget ?? null;
			const changed =
				(op.expectedKind !== undefined && currentKind !== op.expectedKind) ||
				(op.expectedObjectId !== undefined && currentObjectId !== op.expectedObjectId) ||
				(op.expectedMode !== undefined && currentMode !== op.expectedMode) ||
				(op.expectedLinkTarget !== undefined && currentLinkTarget !== op.expectedLinkTarget);
			if (changed) {
				revalidationConflicts.push({
					path: op.path,
					kind: "current_state_changed",
					message: `workspace changed at ${op.path} since preview; rerun previewRestore`,
				});
			}
		}
		if (revalidationConflicts.some(conflict => conflict.kind === "missing_object")) {
			await this.#store.updateRestorePlan(planRecord.id, { conflicts: revalidationConflicts });
			throw new WorkspaceCheckpointError("restore plan references missing CAS objects", {
				conflicts: revalidationConflicts,
				planId: request.planId,
			});
		}
		if (revalidationConflicts.length > 0 && !request.allowConflicts) {
			await this.#store.updateRestorePlan(planRecord.id, { conflicts: revalidationConflicts });
			throw new WorkspaceCheckpointError("workspace changed since preview; rerun previewRestore", {
				conflicts: revalidationConflicts,
				planId: request.planId,
			});
		}

		const previousState = await this.#store.getWorkspaceState(rootPath);
		const guard = await this.#createRestoreGuard(rootPath, checkpoint, this.#includePathsForManifest(manifest));
		const transactionOperations: WorkspaceRestoreOperation[] = [];
		for (const op of planRecord.operations) {
			const liveEntry = liveIndex.get(op.path);
			if (op.kind === "symlink" && liveEntry) {
				transactionOperations.push({
					path: op.path,
					kind: "delete",
					expectedKind: liveEntry.kind,
					expectedObjectId: liveEntry.objectId ?? null,
					expectedMode: liveEntry.mode,
					expectedLinkTarget: liveEntry.linkTarget ?? null,
				});
			}
			transactionOperations.push(op);
		}

		const tx = await createRestoreTransaction({
			rootPath,
			workspaceId,
			operations: transactionOperations,
			readObject: (objectId: string) => this.#readObject(rootPath, objectId),
			agentDir: this.#store.storageDir,
			checkpointsBaseDir: this.#checkpointsBaseDir,
		});

		const pointer: RestoreTransactionPointer = tx.toPointer({
			planId: planRecord.id,
			checkpointId: planRecord.checkpointId,
			guardCheckpointId: guard.id,
		});
		const txRow = await this.#store.recordTransactionFromPointer(pointer);

		try {
			await tx.prepare();
			await this.#store.markTransactionStatus(txRow.id, "open");

			let conversationEntryId: string | null = planRecord.conversationEntryId ?? null;
			if (planRecord.scope === "all") {
				if (!this.#conversation?.restoreConversationEntry || !planRecord.conversationEntryId) {
					throw new WorkspaceCheckpointError(
						"scope=all requires a conversation adapter with restoreConversationEntry and a conversation entry id",
					);
				}
				try {
					conversationEntryId = await this.#conversation.restoreConversationEntry({
						entryId: planRecord.conversationEntryId,
						scope: planRecord.scope,
						rootPath,
					});
				} catch (adapterError) {
					await tx.rollback().catch(() => undefined);
					await this.#store.markTransactionStatus(txRow.id, "rolled_back");
					await this.#store.updateRestorePlan(planRecord.id, { status: "failed" });
					throw adapterError instanceof Error ? adapterError : new Error(String(adapterError));
				}
			}

			const apply = await tx.apply();
			await this.#store.markTransactionStatus(txRow.id, "committed");

			if (manifest.gitRepositories.length > 0) {
				const snapshot = this.#buildGitSnapshotFromManifest(manifest);
				await restoreWorkspaceGitState(rootPath, snapshot, this.#gitCas(rootPath));
			}

			await this.#store.updateRestorePlan(planRecord.id, {
				status: "applied",
				appliedAt: this.#now().toISOString(),
			});

			const nowIso = this.#now().toISOString();
			const nextState: WorkspaceState = {
				workspaceId,
				rootPath,
				undoHeadCheckpointId: transition === "undo" ? null : guard.id,
				redoHeadCheckpointId: transition === "undo" ? guard.id : null,
				restoreSequence: (previousState?.restoreSequence ?? 0) + 1,
				lastCheckpointId: previousState?.lastCheckpointId ?? planRecord.checkpointId,
				updatedAt: nowIso,
			};
			await this.#store.putWorkspaceState(nextState);
			if (transition === "undo") {
				const redoEdge: RedoEdge = {
					rootPath,
					targetCheckpointId: guard.id,
					sourceCheckpointId: planRecord.checkpointId,
					planId: planRecord.id,
					createdAt: nowIso,
				};
				await this.#store.setRedoEdge(redoEdge);
			} else {
				await this.#store.clearRedoEdge(rootPath);
			}

			const restoredPaths = [...new Set(apply.appliedPaths)];
			const skippedPaths = [...new Set(apply.skippedPaths)];
			return {
				transactionId: txRow.id,
				checkpointId: planRecord.checkpointId,
				guardCheckpointId: guard.id,
				restoredPaths,
				skippedPaths,
				conversationEntryId,
				redoAvailable: transition === "undo",
			};
		} catch (error) {
			await tx.rollback().catch(() => undefined);
			await this.#store.markTransactionStatus(txRow.id, "rolled_back");
			await this.#store.updateRestorePlan(planRecord.id, { status: "failed" });
			throw error instanceof Error ? error : new Error(String(error));
		}
	}

	// ─── undo / redo ──────────────────────────────────────────────────────

	undoLast(request: UndoWorkspaceRequest): Promise<WorkspaceRestoreResult> {
		const workspaceId = this.#store.workspaceIdForRoot(request.rootPath);
		return this.#withLock(request.rootPath, workspaceId, async () => {
			const state = await this.#store.getWorkspaceState(request.rootPath);
			if (!state?.undoHeadCheckpointId) {
				throw new WorkspaceCheckpointError(`no undo head available for ${request.rootPath}`);
			}
			const head = await this.#store.getCheckpoint(state.undoHeadCheckpointId);
			if (!head) {
				throw new WorkspaceCheckpointError(`undo head checkpoint missing: ${state.undoHeadCheckpointId}`);
			}
			if (request.sessionId && head.sessionId && head.sessionId !== request.sessionId) {
				throw new WorkspaceCheckpointError(`undo head belongs to a different session (${head.sessionId})`);
			}
			const preview = await this.#previewRestoreInner({
				checkpointId: head.id,
				scope: request.scope ?? "code",
				strategy: "preserve",
			});
			return this.#restorePlanInner(
				{ planId: preview.id, allowConflicts: true },
				state.workspaceId,
				request.rootPath,
				"undo",
			);
		});
	}

	redoLast(request: RedoWorkspaceRequest): Promise<WorkspaceRestoreResult> {
		const workspaceId = this.#store.workspaceIdForRoot(request.rootPath);
		return this.#withLock(request.rootPath, workspaceId, async () => {
			const [state, edge] = await Promise.all([
				this.#store.getWorkspaceState(request.rootPath),
				this.#store.getRedoEdge(request.rootPath),
			]);
			if (!state?.redoHeadCheckpointId || !edge) {
				throw new WorkspaceCheckpointError(`no redo head available for ${request.rootPath}`);
			}
			if (edge.targetCheckpointId !== state.redoHeadCheckpointId) {
				throw new WorkspaceCheckpointError(
					`redo head does not match the persisted redo edge for ${request.rootPath}`,
				);
			}
			const target = await this.#store.getCheckpoint(state.redoHeadCheckpointId);
			if (!target) {
				throw new WorkspaceCheckpointError(`redo target missing: ${state.redoHeadCheckpointId}`);
			}
			if (request.sessionId && target.sessionId && target.sessionId !== request.sessionId) {
				throw new WorkspaceCheckpointError(`redo target belongs to a different session (${target.sessionId})`);
			}
			const preview = await this.#previewRestoreInner({
				checkpointId: target.id,
				scope: "code",
				strategy: "preserve",
			});
			return this.#restorePlanInner(
				{ planId: preview.id, allowConflicts: true },
				target.workspaceId,
				request.rootPath,
				"redo",
			);
		});
	}

	// ─── recovery ─────────────────────────────────────────────────────────

	recoverIncompleteTransactions(rootPath: string): Promise<number> {
		return this.#store.listIncompleteTransactions(rootPath).then(async pending => {
			const workspaceId = this.#store.workspaceIdForRoot(rootPath);
			const report = await recoverPendingRestoreTransactions({
				rootPath,
				workspaceId,
				readObject: (objectId: string) => this.#readObject(rootPath, objectId),
				agentDir: this.#store.storageDir,
				checkpointsBaseDir: this.#checkpointsBaseDir,
			});
			for (const tx of pending) {
				if (tx.state === "open") await this.#store.markTransactionStatus(tx.id, "rolled_back");
			}
			return report.recovered + report.rolledBack;
		});
	}

	// ─── retention helpers ────────────────────────────────────────────────

	async applyPatchToCheckpoint(id: string, patch: CheckpointPatch): Promise<WorkspaceCheckpointRecord> {
		return this.#store.updateCheckpoint(id, patch);
	}
}

/** Slim `GitRepositorySnapshot` for the manifest. Rich fields travel as
 *  optional `GitRepositorySnapshot` fields and restore promotes them back. */
function slimGitRepository(repo: WorkspaceGitRepositoryState): GitRepositorySnapshot {
	return {
		worktreePath: repo.worktreePath,
		gitDir: repo.gitDir,
		commonDir: repo.commonDir,
		head: repo.head,
		headRef: repo.headRef,
		index: repo.index,
		headContent: repo.headContent,
		rawHeadObjectId: repo.rawHeadObjectId,
		isSubmodule: repo.isSubmodule,
	};
}

export type { RestoreTransaction, WorkspaceTransaction };
