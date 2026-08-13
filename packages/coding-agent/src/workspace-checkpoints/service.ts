/**
 * WorkspaceCheckpointService — public-facing service that composes the
 * coordinator and provides the six workspace methods promised to callers.
 *
 * Construction: `createWorkspaceCheckpointService(options)` factory. Defaults
 * use `<agentDir>/checkpoints/v1` for the metadata store and partition
 * per-workspace content under `<storeDir>/workspaces/<workspaceId>/`. The
 * workspace root itself is never touched.
 *
 * Retention: factory accepts `options.retention = { maxPerSession, maxAgeDays }`
 * — both feed `runRetention` after each create and on demand.
 */
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { Coordinator, type CoordinatorLimits } from "./coordinator";
import { type CheckpointMetadataStore, createCheckpointMetadataStore } from "./store";
import type {
	ApplyWorkspaceRestoreRequest,
	CaptureIgnoredPathBaselineRequest,
	CreateWorkspaceCheckpointRequest,
	ListWorkspaceCheckpointsRequest,
	PreviewWorkspaceRestoreRequest,
	RedoWorkspaceRequest,
	UndoWorkspaceRequest,
	WorkspaceCheckpointConversationAdapter,
	WorkspaceCheckpointMutatorGuard,
	WorkspaceCheckpointRecord,
	WorkspaceRestorePlan,
	WorkspaceRestoreResult,
} from "./types";
import { WorkspaceCheckpointError } from "./types";

const AUTOMATIC_CONTENT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** Result of a retention sweep. */
export interface WorkspaceCheckpointRetentionResult {
	removedCheckpointIds: string[];
	releasedObjectIds: string[];
	keptCheckpointIds: string[];
	releasedBytes: number;
	totalStoredBytes: number | null;
	maxTotalBytes: number | null;
	overBudgetBytes: number;
}

/** Retention knobs surfaced from settings (External agent wires these). */
export interface WorkspaceCheckpointRetentionOptions {
	maxPerSession?: number;
	maxAgeDays?: number;
	/** Global physical CAS soft limit in MiB; protected restore roots may keep usage above it. */
	maxTotalMiB?: number;
}

export interface CreateWorkspaceCheckpointServiceOptions {
	rootPath: string;
	agentDir?: string;
	storeDir?: string;
	store?: CheckpointMetadataStore;
	lockBaseDir?: string;
	checkpointsBaseDir?: string;
	conversationAdapter?: WorkspaceCheckpointConversationAdapter;
	mutatorGuard?: WorkspaceCheckpointMutatorGuard;
	now?: () => Date;
	newId?: () => string;
	enabled?: boolean;
	limits?: CoordinatorLimits;
	retention?: WorkspaceCheckpointRetentionOptions;
}

/** Public service surface. */
export class WorkspaceCheckpointServiceImpl {
	readonly #coordinator: Coordinator;
	readonly #enabled: boolean;
	readonly #rootPath: string;
	readonly #retention: WorkspaceCheckpointRetentionOptions;
	readonly #now: () => Date;
	#lastContentSweepAtMs: number | null = null;
	#retentionInFlight: Promise<void> | null = null;
	#retentionRerunRequested = false;
	#retentionTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(coordinator: Coordinator, deps: ServiceDeps) {
		this.#coordinator = coordinator;
		this.#enabled = deps.enabled;
		this.#rootPath = deps.rootPath;
		this.#retention = deps.retention;
		this.#now = deps.now;
	}

	/** Apply a retention sweep using the configured per-session, age, and global physical-byte limits. */
	async runRetention(): Promise<WorkspaceCheckpointRetentionResult> {
		return this.#runRetention(true);
	}

	async #runRetention(sweepContent: boolean): Promise<WorkspaceCheckpointRetentionResult> {
		if (!this.#enabled) {
			return {
				removedCheckpointIds: [],
				releasedObjectIds: [],
				releasedBytes: 0,
				keptCheckpointIds: [],
				totalStoredBytes: null,
				maxTotalBytes: null,
				overBudgetBytes: 0,
			};
		}
		const result = await this.#coordinator.runRetention({
			rootPath: this.#rootPath,
			maxPerSession: this.#retention.maxPerSession,
			maxAgeMs:
				this.#retention.maxAgeDays !== undefined ? this.#retention.maxAgeDays * 24 * 60 * 60 * 1_000 : undefined,
			maxTotalBytes:
				sweepContent && typeof this.#retention.maxTotalMiB === "number" && this.#retention.maxTotalMiB > 0
					? this.#retention.maxTotalMiB * 1024 * 1024
					: undefined,
			sweepContent,
		});
		if (sweepContent || result.removedCheckpointIds.length > 0) {
			this.#lastContentSweepAtMs = this.#now().getTime();
		}
		if (result.overBudgetBytes > 0 && result.maxTotalBytes !== null) {
			logger.warn("workspace checkpoint storage remains above the protected soft limit", {
				totalStoredBytes: result.totalStoredBytes,
				maxTotalBytes: result.maxTotalBytes,
				overBudgetBytes: result.overBudgetBytes,
			});
		}
		return result;
	}

	async create(request: CreateWorkspaceCheckpointRequest): Promise<WorkspaceCheckpointRecord> {
		this.#assertEnabled();
		const record = await this.#coordinator.createCheckpoint(request);
		this.#scheduleRetention();
		return record;
	}

	async captureIgnoredPathBaseline(
		request: CaptureIgnoredPathBaselineRequest,
	): Promise<WorkspaceCheckpointRecord | null> {
		this.#assertEnabled();
		return this.#coordinator.captureIgnoredPathBaseline(request);
	}

	async list(request: ListWorkspaceCheckpointsRequest): Promise<WorkspaceCheckpointRecord[]> {
		this.#assertEnabled();
		return this.#coordinator.listCheckpoints(request);
	}

	async previewRestore(request: PreviewWorkspaceRestoreRequest): Promise<WorkspaceRestorePlan> {
		this.#assertEnabled();
		return this.#coordinator.previewRestore(request);
	}

	async restore(request: ApplyWorkspaceRestoreRequest): Promise<WorkspaceRestoreResult> {
		this.#assertEnabled();
		return this.#coordinator.restorePlan(request);
	}

	async undo(request: UndoWorkspaceRequest): Promise<WorkspaceRestoreResult> {
		this.#assertEnabled();
		return this.#coordinator.undoLast(request);
	}

	async redo(request: RedoWorkspaceRequest): Promise<WorkspaceRestoreResult> {
		this.#assertEnabled();
		return this.#coordinator.redoLast(request);
	}

	async recoverPending(rootPath: string = this.#rootPath): Promise<number> {
		this.#assertEnabled();
		return this.#coordinator.recoverIncompleteTransactions(rootPath);
	}

	get coordinator(): Coordinator {
		return this.#coordinator;
	}

	onRetention(listener: Parameters<Coordinator["onRetention"]>[0]): () => void {
		return this.#coordinator.onRetention(listener);
	}

	dispose(): void {
		if (this.#retentionTimer !== null) clearTimeout(this.#retentionTimer);
	}

	#assertEnabled(): void {
		if (!this.#enabled) throw new WorkspaceCheckpointError("workspace checkpoints are disabled");
	}

	#scheduleRetention(): void {
		if (this.#retentionTimer !== null) clearTimeout(this.#retentionTimer);
		this.#retentionTimer = setTimeout(() => this.#startScheduledRetention(), 250);
	}

	#startScheduledRetention(): void {
		if (this.#retentionInFlight) {
			this.#retentionRerunRequested = true;
			return;
		}
		this.#retentionInFlight = this.#drainScheduledRetention().finally(() => {
			this.#retentionInFlight = null;
			if (this.#retentionRerunRequested) this.#startScheduledRetention();
		});
	}

	async #drainScheduledRetention(): Promise<void> {
		do {
			this.#retentionRerunRequested = false;
			const nowMs = this.#now().getTime();
			const sweepContent =
				this.#lastContentSweepAtMs === null ||
				nowMs - this.#lastContentSweepAtMs >= AUTOMATIC_CONTENT_SWEEP_INTERVAL_MS;
			try {
				await this.#runRetention(sweepContent);
			} catch (error) {
				logger.warn("workspace checkpoint retention failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} while (this.#retentionRerunRequested);
	}
}

interface ServiceDeps {
	enabled: boolean;
	rootPath: string;
	retention: WorkspaceCheckpointRetentionOptions;
	now: () => Date;
}

export async function createWorkspaceCheckpointService(
	options: CreateWorkspaceCheckpointServiceOptions,
): Promise<WorkspaceCheckpointServiceImpl> {
	const agentDir = options.agentDir ?? getAgentDir();
	const storeDir = options.storeDir ?? `${agentDir}/checkpoints/v1`;
	const store = options.store ?? createCheckpointMetadataStore({ storageDir: storeDir });
	const now = options.now ?? ((): Date => new Date());
	await store.init();

	const coordinator = new Coordinator({
		store,
		mutatorGuard: options.mutatorGuard,
		conversationAdapter: options.conversationAdapter,
		lockBaseDir: options.lockBaseDir,
		checkpointsBaseDir: options.checkpointsBaseDir,
		storeDir,
		now,
		limits: options.limits,
	});

	return new WorkspaceCheckpointServiceImpl(coordinator, {
		enabled: options.enabled ?? true,
		rootPath: options.rootPath,
		now,
		retention: options.retention ?? {},
	});
}

export type { CoordinatorLimits, CoordinatorRetentionEvent } from "./coordinator";
export type {
	ApplyWorkspaceRestoreRequest,
	CaptureIgnoredPathBaselineRequest,
	CreateWorkspaceCheckpointRequest,
	ListWorkspaceCheckpointsRequest,
	PreviewWorkspaceRestoreRequest,
	RedoWorkspaceRequest,
	UndoWorkspaceRequest,
	WorkspaceCheckpointConversationAdapter,
	WorkspaceCheckpointMutatorGuard,
	WorkspaceCheckpointRecord,
	WorkspaceRestorePlan,
	WorkspaceRestoreResult,
} from "./types";

export { Coordinator };
