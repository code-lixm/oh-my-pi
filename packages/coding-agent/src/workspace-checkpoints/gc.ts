/**
 * Reference-marked garbage collection for workspace checkpoints.
 *
 * A checkpoint is eligible for deletion iff NONE of the following hold:
 *   • it is `pinned` (user-locked)
 *   • it has a `label` (i.e. it was created with an explicit name)
 *   • it is the guard checkpoint referenced by an open transaction
 *   • it is the redo edge target for any workspace
 *   • it is the workspace pointer's undo/redo/last checkpoint
 *   • it is younger than `opts.minKeepMs` (default 24h, configurable per-call)
 *
 * GC is a **two-phase operation**: this module only deletes metadata rows
 * and returns the set of `manifestObjectId`s that are now orphaned; the
 * CAS layer is responsible for actually unlinking the blob tree. Splitting
 * the phases keeps the metadata DB small and avoids a slow content scan
 * blocking the checkpoint hot path.
 *
 * GC is synchronous with respect to its owning process — it does no
 * network or filesystem work, just reads from and writes to the metadata
 * store. Runs on the same connection as the store, so all deletes are
 * transactional with foreign_keys=ON (the ON DELETE CASCADE on
 * restore_plans and transactions cleans up dependents for free).
 */
import type { CheckpointMetadataStore, GcResult, WorkspaceCheckpointRecord } from "./store";
export interface CheckpointGcOptions {
	/** Restrict GC to a single workspace; default = all workspaces. */
	rootPath?: string;
	/** Minimum age in ms before an automatic checkpoint is eligible. Default 24h. */
	minKeepMs?: number;
	/** Hard cap on how many checkpoints to delete in this sweep. */
	maxDelete?: number;
}

export interface CheckpointGcDeps {
	store: CheckpointMetadataStore;
	now?: () => number;
}

export const DEFAULT_CHECKPOINT_GC_MIN_KEEP_MS = 24 * 60 * 60 * 1000;

interface WorkspacePointer {
	rootPath: string;
	sessionId: string | null;
	undoHeadCheckpointId: string | null;
	redoHeadCheckpointId: string | null;
	lastCheckpointId: string | null;
}

interface TransactionRow {
	id: string;
	rootPath: string;
	state: "open" | "committed" | "rolled_back";
	guardCheckpointId: string | null;
	checkpointId: string | null;
}

interface RedoEdgeRow {
	rootPath: string;
	sessionId: string | null;
	targetCheckpointId: string;
	sourceCheckpointId: string | null;
}

export class CheckpointGc {
	readonly #store: CheckpointMetadataStore;
	readonly #now: () => number;

	constructor(deps: CheckpointGcDeps) {
		this.#store = deps.store;
		this.#now = deps.now ?? (() => Date.now());
	}

	/**
	 * Plan a sweep without mutating anything. Returns the same shape as
	 * {@link run} so callers can preview the impact and decide whether to
	 * delete the underlying CAS blobs.
	 */
	async plan(options: CheckpointGcOptions = {}): Promise<GcResult> {
		const minKeepMs = options.minKeepMs ?? DEFAULT_CHECKPOINT_GC_MIN_KEEP_MS;
		const cutoff = this.#now() - Math.max(0, minKeepMs);

		const [roots, pointers, transactions, redoEdges, candidates] = await Promise.all([
			this.#store.listGcRoots(options.rootPath),
			this.#collectWorkspacePointers(options.rootPath),
			this.#collectActiveTransactions(options.rootPath),
			this.#collectRedoEdges(options.rootPath),
			this.#store.listCheckpoints({
				rootPath: options.rootPath,
				automaticOnly: true,
				limit: Number.MAX_SAFE_INTEGER,
			}),
		]);

		const rootIds = new Set(roots.map(r => r.checkpointId));
		const pointerIds = new Set<string>();
		for (const ptr of pointers) {
			if (ptr.undoHeadCheckpointId) pointerIds.add(ptr.undoHeadCheckpointId);
			if (ptr.redoHeadCheckpointId) pointerIds.add(ptr.redoHeadCheckpointId);
			if (ptr.lastCheckpointId) pointerIds.add(ptr.lastCheckpointId);
		}
		const txProtectedIds = new Set<string>();
		for (const tx of transactions) {
			if (tx.state !== "open") continue;
			if (tx.guardCheckpointId) txProtectedIds.add(tx.guardCheckpointId);
			if (tx.checkpointId) txProtectedIds.add(tx.checkpointId);
		}
		const redoEdgeIds = new Set<string>();
		for (const edge of redoEdges) {
			redoEdgeIds.add(edge.targetCheckpointId);
			if (edge.sourceCheckpointId) redoEdgeIds.add(edge.sourceCheckpointId);
		}

		const eligible: WorkspaceCheckpointRecord[] = [];
		const kept: WorkspaceCheckpointRecord[] = [];
		for (const checkpoint of candidates) {
			if (
				rootIds.has(checkpoint.id) ||
				pointerIds.has(checkpoint.id) ||
				txProtectedIds.has(checkpoint.id) ||
				redoEdgeIds.has(checkpoint.id)
			) {
				kept.push(checkpoint);
				continue;
			}
			// Reference-marked; treat anything not in the protection set as eligible.
			// Age is enforced via the cutoff so a fresh automatic checkpoint is
			// always retained until it has had a chance to be referenced.
			const createdAtMs = Date.parse(checkpoint.createdAt);
			if (Number.isFinite(createdAtMs) && createdAtMs > cutoff) {
				kept.push(checkpoint);
				continue;
			}
			eligible.push(checkpoint);
		}

		const limited =
			options.maxDelete !== undefined && options.maxDelete >= 0 ? eligible.slice(0, options.maxDelete) : eligible;

		const releasedObjectIds: string[] = [];
		const seenObjects = new Set<string>();
		for (const checkpoint of limited) {
			if (seenObjects.has(checkpoint.manifestObjectId)) continue;
			seenObjects.add(checkpoint.manifestObjectId);
			releasedObjectIds.push(checkpoint.manifestObjectId);
		}

		return {
			removedCheckpointIds: limited.map(c => c.id),
			releasedObjectIds,
			keptCheckpointIds: kept.map(c => c.id),
		};
	}

	/**
	 * Plan + delete in a single sweep. Returns the deleted checkpoint ids and
	 * the manifest object ids the CAS layer should reclaim.
	 */
	async run(options: CheckpointGcOptions = {}): Promise<GcResult> {
		const planResult = await this.plan(options);
		for (const id of planResult.removedCheckpointIds) {
			await this.#store.deleteCheckpoint(id);
		}
		return planResult;
	}

	async #collectWorkspacePointers(rootPath?: string): Promise<WorkspacePointer[]> {
		const workspaces = await this.#store.listWorkspaces();
		if (rootPath === undefined) return workspaces;
		const normalized = rootPath; // store normalizes internally
		return workspaces.filter(w => w.rootPath === normalized);
	}

	async #collectActiveTransactions(rootPath?: string): Promise<TransactionRow[]> {
		return this.#store.listTransactions({ rootPath, state: "open", limit: Number.MAX_SAFE_INTEGER });
	}

	async #collectRedoEdges(rootPath?: string): Promise<RedoEdgeRow[]> {
		const edges: RedoEdgeRow[] = [];
		const workspaces = await this.#store.listWorkspaces();
		for (const ws of workspaces) {
			if (rootPath !== undefined && ws.rootPath !== rootPath) continue;
			const edge = await this.#store.getRedoEdge(ws.rootPath, ws.sessionId);
			if (edge) {
				edges.push({
					rootPath: ws.rootPath,
					sessionId: ws.sessionId,
					targetCheckpointId: edge.targetCheckpointId,
					sourceCheckpointId: edge.sourceCheckpointId,
				});
			}
		}
		return edges;
	}
}

/** Thin convenience that builds a {@link CheckpointGc} from a store. */
export function createCheckpointGc(store: CheckpointMetadataStore, now?: () => number): CheckpointGc {
	return new CheckpointGc({ store, now });
}

export type { GcResult, GcRoot } from "./store";
