import { type SyncOptions, type SyncProgress, syncAllSessions, syncSessionFiles } from "./aggregator";

export const DEFAULT_STATS_FRESHNESS_MS = 30_000;

export type DashboardSyncMode = "fresh" | "dirty" | "full";

export interface DashboardSyncResult {
	processed: number;
	files: number;
	mode: DashboardSyncMode;
}

export interface DashboardSyncOptions extends SyncOptions {
	/** Always reconcile every persisted session file instead of the dirty set. */
	forceFull?: boolean;
	/** Reuse a recent clean result until this age elapses. */
	freshnessMs?: number;
	/**
	 * Optional host-specific global reconciler. Coding-agent supplies a
	 * subprocess-backed implementation so a cold global scan cannot monopolize
	 * the interactive process on platforms where Bun workers are unavailable.
	 */
	runFullSync?: (options?: SyncOptions) => Promise<{ processed: number; files: number }>;
}

interface DirtyFile {
	generation: number;
}

export interface StatsSyncBackend {
	syncAllSessions(options?: SyncOptions): Promise<{ processed: number; files: number }>;
	syncSessionFiles(
		sessionFiles: readonly string[],
		options?: SyncOptions,
	): Promise<{ processed: number; files: number }>;
}

/**
 * Coordinates dashboard ingestion without weakening cross-process correctness.
 *
 * Appends observed in this process enter the dirty set and are synchronized by
 * path. Unobserved writers remain covered by a bounded full reconciliation.
 * Every request shares an active run; callers never race independent scans
 * against the SQLite file lock.
 */
export class StatsSyncCoordinator {
	#dirtyFiles = new Map<string, DirtyFile>();
	#nextGeneration = 0;
	#lastCompletedAt = 0;
	#inFlight: { forceFull: boolean; promise: Promise<DashboardSyncResult> } | undefined;
	#backend: StatsSyncBackend;

	constructor(backend: StatsSyncBackend = { syncAllSessions, syncSessionFiles }) {
		this.#backend = backend;
	}

	markDirty(sessionFile: string): void {
		if (!sessionFile.endsWith(".jsonl")) return;
		this.#dirtyFiles.set(sessionFile, { generation: ++this.#nextGeneration });
	}

	async sync(options: DashboardSyncOptions = {}): Promise<DashboardSyncResult> {
		const active = this.#inFlight;
		if (active) {
			if (!options.forceFull || active.forceFull) return active.promise;
			await active.promise;
			return await this.sync(options);
		}

		const run = this.#run(options);
		this.#inFlight = { forceFull: options.forceFull === true, promise: run };
		try {
			return await run;
		} finally {
			if (this.#inFlight?.promise === run) this.#inFlight = undefined;
		}
	}

	async #run(options: DashboardSyncOptions): Promise<DashboardSyncResult> {
		const now = Date.now();
		const freshnessMs = Math.max(0, options.freshnessMs ?? DEFAULT_STATS_FRESHNESS_MS);
		const dirty = [...this.#dirtyFiles.entries()];
		const { forceFull, runFullSync } = options;
		const syncOptions: SyncOptions = { onProgress: options.onProgress, workers: options.workers };

		if (!forceFull && dirty.length > 0) {
			const result = await this.#backend.syncSessionFiles(
				dirty.map(([sessionFile]) => sessionFile),
				syncOptions,
			);
			this.#clearSyncedDirtyFiles(dirty);
			this.#lastCompletedAt = Date.now();
			return { ...result, mode: "dirty" };
		}

		if (!forceFull && this.#lastCompletedAt > 0 && now - this.#lastCompletedAt <= freshnessMs) {
			return { processed: 0, files: 0, mode: "fresh" };
		}

		const result = runFullSync ? await runFullSync(syncOptions) : await this.#backend.syncAllSessions(syncOptions);
		this.#clearSyncedDirtyFiles(dirty);
		this.#lastCompletedAt = Date.now();
		return { ...result, mode: "full" };
	}

	#clearSyncedDirtyFiles(snapshot: readonly [string, DirtyFile][]): void {
		for (const [sessionFile, dirty] of snapshot) {
			if (this.#dirtyFiles.get(sessionFile)?.generation === dirty.generation) this.#dirtyFiles.delete(sessionFile);
		}
	}
}

const dashboardSyncCoordinator = new StatsSyncCoordinator();

export function markStatsSessionDirty(sessionFile: string): void {
	dashboardSyncCoordinator.markDirty(sessionFile);
}

export async function syncDashboardSessions(options?: DashboardSyncOptions): Promise<DashboardSyncResult> {
	return await dashboardSyncCoordinator.sync(options);
}

export type { SyncProgress };
