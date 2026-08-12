import { logger } from "@oh-my-pi/pi-utils";
import { tSettingsUi } from "../i18n/settings-locale";
import type { AsyncJobDeliveryStatus } from "../task/types";
import {
	type AsyncCompletionDeliveryPolicy,
	type AsyncJobType,
	isManualCompletionDelivery,
	RLM_JOB_TYPE,
} from "./rlm-job-policy";

const DELIVERY_RETRY_BASE_MS = 500;
const DELIVERY_RETRY_MAX_MS = 30_000;
const DELIVERY_RETRY_JITTER_MS = 200;
const DEFAULT_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RUNNING_JOBS = 15;
const PROGRESS_FLUSH_INTERVAL_MS = 100;
const PROGRESS_CALLBACK_BUDGET = 8;
/** Abort reason used only when the owning session shuts down the entire manager. */
export const ASYNC_JOB_MANAGER_SHUTDOWN_REASON = Symbol("AsyncJobManager shutdown");

/**
 * Adaptive ("smart") `hub` poll-wait ladder (ms). A tight poll loop climbs
 * these rungs so each immediate re-poll backs off and stops spending turns on
 * "still running" frames; the floor (first rung) is the shortest wait and the
 * top rung is the longest a smart poll will ever block. Only used when
 * `async.pollWaitDuration` is set to `smart`; fixed durations wait verbatim.
 */
const POLL_WAIT_LADDER_MS = [5_000, 10_000, 30_000, 60_000, 300_000] as const;
/**
 * Going at least this long between poll calls means the agent stepped out of
 * the poll loop to do real work — the next poll drops back to the ladder floor.
 */
const POLL_ESCALATION_RESET_MS = 60_000;

interface PollEscalationState {
	/** Index into POLL_WAIT_LADDER_MS used for the most recent poll wait. */
	level: number;
	/** Timestamp (ms) when the most recent poll wait returned. */
	lastPollEndAt: number;
}

export interface AsyncJob {
	id: string;
	type: AsyncJobType;
	status: "running" | "completed" | "failed" | "cancelled";
	/** Completion routing is explicit so manual jobs never enter async-result delivery. */
	completionDelivery: AsyncCompletionDeliveryPolicy;
	startTime: number;
	/** Time the job entered the manager, including jobs that start immediately. */
	queuedAt?: number;
	/** Time a queued job actually acquired its caller-managed execution slot. */
	startedAt?: number;
	label: string;
	/** User-facing work summary, distinct from the stable id/label. */
	description?: string;
	abortController: AbortController;
	promise: Promise<void>;
	resultText?: string;
	errorText?: string;
	/** Final lifecycle timestamp. Frozen on completion, failure, or cancellation. */
	endedAt?: number;
	/** Latest text emitted through `reportProgress`; bash jobs retain their bounded live output tail here. */
	latestProgressText?: string;
	/** Stable result-delivery lifecycle; absent until this job settles with a deliverable outcome. */
	deliveryStatus?: AsyncJobDeliveryStatus;
	/** Most recent sink failure while a retry remains pending, or dead-letter cause. */
	deliveryError?: string;

	/** Latest tool-render details reported by the running job. */
	latestDetails?: Record<string, unknown>;
	/** Time of the most recent explicit progress report from the job body. */
	lastProgressAt?: number;
	/**
	 * Registry id of the agent that registered the job (e.g. "Main",
	 * "AuthLoader"). Used by scoped cancel/list APIs so a subagent's teardown
	 * does not cancel its parent's jobs. Undefined for callers that don't
	 * supply an id (e.g. legacy tests, SDK consumers without an agent context).
	 */
	ownerId?: string;
	/**
	 * Registry id of the subagent this job runs (task/tan/vibe jobs). Lets
	 * job-view code link a job row to its AgentRegistry ref even when the job
	 * id differs from the agent id (vibe turn jobs, tan clones).
	 */
	agentId?: string;
	/**
	 * Job is registered but parked behind a caller-managed gate (e.g. a task
	 * batch semaphore). Queued jobs do not count toward the running-job limit
	 * until the caller invokes `markRunning()` from the run context.
	 */
	queued?: boolean;
}

/** Occupancy of the manager's real execution slots at one observation point. */
export interface AsyncJobConcurrencySnapshot {
	running: number;
	queued: number;
	limit: number;
}

/** Delivery callback for a settled job's result text. */
export type AsyncJobDeliverySink = (jobId: string, text: string, job?: AsyncJob) => void | Promise<void>;

export interface AsyncJobManagerOptions {
	/**
	 * Delivery sink for UNOWNED completions (jobs registered without an
	 * `ownerId`). Owned deliveries route exclusively through
	 * {@link AsyncJobManager.registerDeliverySink}; when the owner has no live
	 * sink they are dead-lettered (dropped with a warning; the job row keeps
	 * the result text until retention eviction) — never routed here, which
	 * would leak one agent's result into another session.
	 */
	onJobComplete?: AsyncJobDeliverySink;
	maxRunningJobs?: number;
	retentionMs?: number;
}

interface AsyncJobDelivery {
	jobId: string;
	text: string;
	attempt: number;
	nextAttemptAt: number;
	lastError?: string;
	ownerId?: string;
	promise?: Promise<void>;
}

export interface AsyncJobDeliveryState {
	queued: number;
	delivering: boolean;
	nextRetryAt?: number;
	pendingJobIds: string[];
}

interface AsyncJobProgressOptions {
	/** Prioritize this revision, but still dispatch it through the global callback budget. */
	terminal?: boolean;
}

type AsyncJobProgressText = string | (() => string);
type AsyncJobProgressDetails = Record<string, unknown> | (() => Record<string, unknown>);
type AsyncJobProgressKey = string | AsyncJob;

interface PendingAsyncJobProgress {
	key: AsyncJobProgressKey;
	job: AsyncJob;
	revision: number;
	text: AsyncJobProgressText;
	details?: AsyncJobProgressDetails;
	started?: boolean;
	onProgress: NonNullable<AsyncJobRegisterOptions["onProgress"]>;
	cancelled?: boolean;
	resolve(): void;
}

export interface AsyncJobReapResult {
	settled: boolean;
	pendingJobIds: string[];
	completion: Promise<void>;
}

export interface AsyncJobRegisterOptions {
	id?: string;
	/** Registry id of the agent that owns this job; used to scope cancelAll. */
	ownerId?: string;
	/** Registry id of the subagent this job runs; see {@link AsyncJob.agentId}. */
	agentId?: string;
	/** User-facing work summary available before the first progress event. */
	description?: string;
	onProgress?: (text: string, details?: Record<string, unknown>) => void | Promise<void>;
	/** Shared UI target for latest-wins progress coalescing (for example one task batch/tool call). */
	progressKey?: string;
	/** Register the job in queued state; see {@link AsyncJob.queued}. */
	queued?: boolean;
	/**
	 * `manual` persists settlement on the job row but never calls a delivery
	 * sink or queues an `async-result`. RLM is the only current user of it.
	 */
	completionDelivery?: AsyncCompletionDeliveryPolicy;
}

/**
 * Filter applied to job query/cancel APIs. With `ownerId`, results are
 * restricted to jobs registered by that agent (registry id from
 * `AgentRegistry`, e.g. "Main", "AuthLoader").
 */
export interface AsyncJobFilter {
	ownerId?: string;
}

export class AsyncJobManager {
	static #instance: AsyncJobManager | undefined;

	/** Process-global instance shared by internal URL protocol handlers and tools. */
	static instance(): AsyncJobManager | undefined {
		return AsyncJobManager.#instance;
	}

	/** Install or clear the process-global instance. */
	static setInstance(value: AsyncJobManager | undefined): void {
		AsyncJobManager.#instance = value;
	}

	/** Reset the process-global instance. Test-only. */
	static resetForTests(): void {
		AsyncJobManager.#instance = undefined;
	}

	readonly #jobs = new Map<string, AsyncJob>();
	readonly #deliveries: AsyncJobDelivery[] = [];
	readonly #inFlightDeliveries: AsyncJobDelivery[] = [];
	readonly #suppressedDeliveries = new Set<string>();
	readonly #watchedJobs = new Set<string>();
	readonly #evictionTimers = new Map<string, NodeJS.Timeout>();
	readonly #pollEscalation = new Map<string | undefined, PollEscalationState>();
	readonly #deliverySinks = new Map<string, AsyncJobDeliverySink>();
	readonly #onJobComplete: AsyncJobManagerOptions["onJobComplete"];
	readonly #maxRunningJobs: number;
	readonly #retentionMs: number;
	#runningJobCount = 0;
	#activeRunningJobCount = 0;
	#queuedRunningJobCount = 0;
	readonly #runningJobCountByOwner = new Map<string, number>();
	readonly #pendingProgress = new Map<AsyncJobProgressKey, PendingAsyncJobProgress>();
	readonly #pendingTerminalProgress: PendingAsyncJobProgress[] = [];
	readonly #activeProgressKeys = new Set<AsyncJobProgressKey>();
	readonly #inFlightProgressByJob = new Map<AsyncJob, Set<Promise<void>>>();
	readonly #dispatchedProgressByJob = new Map<AsyncJob, Set<PendingAsyncJobProgress>>();
	readonly #settlingJobs = new Set<AsyncJob>();
	#progressRevision = 0;
	#progressTimer: NodeJS.Timeout | undefined;
	#progressCooldown = false;
	#deliveryLoop: Promise<void> | undefined;
	#disposed = false;

	#filterJobs(jobs: Iterable<AsyncJob>, filter?: AsyncJobFilter): AsyncJob[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return Array.from(jobs);
		const out: AsyncJob[] = [];
		for (const job of jobs) {
			if (job.ownerId === ownerId) out.push(job);
		}
		return out;
	}

	constructor(options: AsyncJobManagerOptions) {
		this.#onJobComplete = options.onJobComplete;
		this.#maxRunningJobs = Math.max(1, Math.floor(options.maxRunningJobs ?? DEFAULT_MAX_RUNNING_JOBS));
		this.#retentionMs = Math.max(0, Math.floor(options.retentionMs ?? DEFAULT_RETENTION_MS));
	}

	/** True when the running-job count has reached the configured cap. */
	get atCapacity(): boolean {
		if (this.#disposed) return true;
		return this.#activeRunningJobCount >= this.#maxRunningJobs;
	}

	/** Snapshot real manager capacity without scheduling work or polling. */
	getConcurrencySnapshot(): AsyncJobConcurrencySnapshot {
		return {
			running: this.#activeRunningJobCount,
			queued: this.#queuedRunningJobCount,
			limit: this.#maxRunningJobs,
		};
	}

	/**
	 * One-based position among this owner's caller-managed queued jobs, in
	 * registration order. Jobs from other owners never affect the position.
	 */
	getQueuePosition(id: string): number | undefined {
		const job = this.#jobs.get(id);
		if (job?.status !== "running" || !job.queued) return undefined;

		let position = 0;
		for (const candidate of this.#jobs.values()) {
			if (candidate.ownerId !== job.ownerId || candidate.status !== "running" || !candidate.queued) continue;
			position++;
			if (candidate.id === id) return position;
		}

		return undefined;
	}

	register(
		type: AsyncJobType,
		label: string,
		run: (ctx: {
			jobId: string;
			signal: AbortSignal;
			reportProgress: (
				text: AsyncJobProgressText,
				details?: AsyncJobProgressDetails,
				progressOptions?: AsyncJobProgressOptions,
			) => Promise<void>;
			/** Clear the queued flag once the job actually starts executing. */
			markRunning: () => void;
		}) => Promise<string>,
		options?: AsyncJobRegisterOptions,
	): string {
		if (this.#disposed) {
			throw new Error(tSettingsUi("Async job manager is disposed"));
		}
		// Queued jobs hold no execution slot yet — only count jobs that are
		// actually running so a large parked batch cannot starve registration.
		if (this.#activeRunningJobCount >= this.#maxRunningJobs) {
			throw new Error(
				tSettingsUi("Background job limit reached ({count}). Wait for running jobs to finish or cancel one.", {
					count: this.#maxRunningJobs,
				}),
			);
		}

		const id = this.#resolveJobId(options?.id);
		this.#suppressedDeliveries.delete(id);
		const abortController = new AbortController();
		const startTime = Date.now();
		const queued = options?.queued === true;
		const completionDelivery: AsyncCompletionDeliveryPolicy =
			type === RLM_JOB_TYPE ? "manual" : (options?.completionDelivery ?? "automatic");
		if (type === RLM_JOB_TYPE && options?.completionDelivery === "automatic") {
			throw new Error("RLM jobs must use manual completion delivery.");
		}

		const job: AsyncJob = {
			id,
			type,
			status: "running",
			startTime,
			queuedAt: startTime,
			startedAt: queued ? undefined : startTime,
			label,
			description: options?.description,
			abortController,
			promise: Promise.resolve(),
			ownerId: options?.ownerId,
			agentId: options?.agentId,
			queued,
			completionDelivery,
		};
		this.#jobs.set(id, job);
		this.#incrementRunningJob(job);

		const reportProgress = (
			text: AsyncJobProgressText,
			details?: AsyncJobProgressDetails,
			progressOptions?: AsyncJobProgressOptions,
		): Promise<void> => this.#queueProgress(job, options, text, details, progressOptions);
		job.promise = (async () => {
			try {
				const text = await run({
					jobId: id,
					signal: abortController.signal,
					reportProgress,
					markRunning: () => {
						if (job.status !== "running" || !job.queued) return;
						job.queued = false;
						job.startedAt ??= Date.now();
						this.#queuedRunningJobCount--;
						this.#activeRunningJobCount++;
					},
				});
				await this.#prepareJobSettlement(job);
				if (job.status === "cancelled") {
					job.resultText = text;
					job.endedAt ??= Date.now();
					this.#scheduleEviction(job);
					return;
				}
				this.#settleRunningJob(job, "completed");
				job.resultText = text;
				job.endedAt = Date.now();
				if (isManualCompletionDelivery(job.completionDelivery)) this.#setDeliveryStatus(id, "manual");
				else this.#enqueueDelivery(id, text);
				this.#scheduleEviction(job);
			} catch (error) {
				await this.#prepareJobSettlement(job);
				if (job.status === "cancelled") {
					job.errorText = error instanceof Error ? error.message : String(error);
					job.endedAt ??= Date.now();
					this.#scheduleEviction(job);
					return;
				}
				const errorText = error instanceof Error ? error.message : String(error);
				this.#settleRunningJob(job, "failed");
				job.errorText = errorText;
				job.endedAt = Date.now();
				if (isManualCompletionDelivery(job.completionDelivery)) this.#setDeliveryStatus(id, "manual");
				else this.#enqueueDelivery(id, errorText);
				this.#scheduleEviction(job);
			}
		})();

		return id;
	}

	/**
	 * Cancel a single job by id. When `filter.ownerId` is set and does not
	 * match the job's owner, the call is treated as not-found (returns false)
	 * so cross-agent cancellation is rejected at the manager level.
	 */
	cancel(id: string, filter?: AsyncJobFilter): boolean {
		const job = this.#jobs.get(id);
		if (!job) return false;
		if (filter?.ownerId && job.ownerId !== filter.ownerId) return false;
		if (job.status !== "running") return false;
		this.#settleRunningJob(job, "cancelled");
		job.endedAt = Date.now();
		job.abortController.abort();
		this.#scheduleEviction(job);
		return true;
	}

	getJob(id: string): AsyncJob | undefined {
		return this.#jobs.get(id);
	}

	/**
	 * Return the newest retained task job for an exact subagent id without
	 * materializing or sorting a job list. Agent Hub polls this to read the
	 * authoritative result and delivery lifecycle for one row.
	 */
	getLatestJobForAgent(agentId: string): AsyncJob | undefined {
		if (!agentId) return undefined;
		let latest: AsyncJob | undefined;
		for (const job of this.#jobs.values()) {
			if (job.type !== "task" || job.agentId !== agentId) continue;
			if (!latest || job.startTime >= latest.startTime) latest = job;
		}
		return latest;
	}

	getRunningJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter).filter(job => job.status === "running");
	}

	/** Number of jobs whose lifecycle status is still `running`, including queued jobs. */
	getRunningJobCount(filter?: AsyncJobFilter): number {
		const ownerId = filter?.ownerId;
		return ownerId ? (this.#runningJobCountByOwner.get(ownerId) ?? 0) : this.#runningJobCount;
	}

	getRecentJobs(limit = 10, filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter)
			.filter(job => job.status !== "running")
			.sort((a, b) => b.startTime - a.startTime)
			.slice(0, limit);
	}

	getAllJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter);
	}

	getDeliveryState(filter?: AsyncJobFilter): AsyncJobDeliveryState {
		const deliveries = this.#filterDeliveries(filter);
		const inFlightDeliveries = this.#filterInFlightDeliveries(filter);
		const nextRetryAt = deliveries.reduce<number | undefined>((next, delivery) => {
			if (next === undefined) return delivery.nextAttemptAt;
			return Math.min(next, delivery.nextAttemptAt);
		}, undefined);

		return {
			queued: deliveries.length + inFlightDeliveries.length,
			delivering: inFlightDeliveries.length > 0 || (this.#deliveryLoop !== undefined && deliveries.length > 0),
			nextRetryAt,
			pendingJobIds: deliveries.concat(inFlightDeliveries).map(delivery => delivery.jobId),
		};
	}

	hasPendingDeliveries(filter?: AsyncJobFilter): boolean {
		return this.getDeliveryState(filter).queued > 0;
	}

	watchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		for (const jobId of uniqueJobIds) {
			this.#watchedJobs.add(jobId);
		}
		return uniqueJobIds.length;
	}

	unwatchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		let removed = 0;
		for (const jobId of uniqueJobIds) {
			if (this.#watchedJobs.delete(jobId)) {
				removed += 1;
			}
		}
		return removed;
	}

	/**
	 * Compute the next adaptive ("smart") wait (ms) for a blocking `hub` wait by
	 * the given owner. Consecutive polls — those starting within
	 * POLL_ESCALATION_RESET_MS of the previous poll returning — climb
	 * POLL_WAIT_LADDER_MS so a tight wait loop backs off; a longer gap means the
	 * agent left to do real work, so the wait resets to the floor. Pair each call
	 * with `recordPollWaitEnd()` once the wait returns.
	 */
	nextPollWaitMs(ownerId: string | undefined, now: number = Date.now()): number {
		const prev = this.#pollEscalation.get(ownerId);
		const reset = !prev || now - prev.lastPollEndAt >= POLL_ESCALATION_RESET_MS;
		const level = reset ? 0 : Math.min(prev.level + 1, POLL_WAIT_LADDER_MS.length - 1);
		this.#pollEscalation.set(ownerId, { level, lastPollEndAt: prev?.lastPollEndAt ?? now });
		return POLL_WAIT_LADDER_MS[level];
	}

	/**
	 * Mark a blocking poll wait as finished so the idle-reset window is measured
	 * from now. Polling again before POLL_ESCALATION_RESET_MS elapses keeps
	 * climbing the ladder; waiting longer resets it to the floor.
	 */
	recordPollWaitEnd(ownerId: string | undefined, now: number = Date.now()): void {
		const prev = this.#pollEscalation.get(ownerId);
		this.#pollEscalation.set(ownerId, { level: prev?.level ?? 0, lastPollEndAt: now });
	}

	acknowledgeDeliveries(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		if (uniqueJobIds.length === 0) return 0;

		for (const jobId of uniqueJobIds) {
			this.#suppressedDeliveries.add(jobId);
		}
		for (const jobId of uniqueJobIds) {
			const job = this.#jobs.get(jobId);
			if (!job || isManualCompletionDelivery(job.completionDelivery)) continue;
			if (job.status !== "completed" && job.status !== "failed") continue;
			if (
				job.deliveryStatus !== "dead-letter" &&
				!this.#inFlightDeliveries.some(delivery => delivery.jobId === jobId)
			) {
				this.#setDeliveryStatus(jobId, "delivered");
			}
		}

		const before = this.#deliveries.length;
		this.#deliveries.splice(
			0,
			this.#deliveries.length,
			...this.#deliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId)),
		);
		return before - this.#deliveries.length;
	}

	/**
	 * Lift a foreground-wait suppression set via `acknowledgeDeliveries`. If the
	 * job already finished while suppressed (its delivery enqueue was skipped),
	 * re-enqueue the completion so the result is still delivered exactly once.
	 */
	resumeDeliveries(jobIds: string[]): void {
		for (const rawId of jobIds) {
			const jobId = rawId.trim();
			if (!jobId) continue;
			if (!this.#suppressedDeliveries.delete(jobId)) continue;
			const job = this.#jobs.get(jobId);
			if (!job || isManualCompletionDelivery(job.completionDelivery)) continue;
			if (job.status !== "completed" && job.status !== "failed") continue;
			const queued =
				this.#deliveries.some(delivery => delivery.jobId === jobId) ||
				this.#inFlightDeliveries.some(delivery => delivery.jobId === jobId);
			if (queued) continue;
			this.#enqueueDelivery(jobId, job.status === "completed" ? (job.resultText ?? "") : (job.errorText ?? ""));
		}
	}

	/**
	 * Cancel running jobs. With `filter.ownerId` set, cancels only jobs the
	 * matching agent registered; with no filter, cancels every running job
	 * (used by `dispose()` to nuke the manager's state).
	 *
	 * `reason` is forwarded to each job's `AbortController.abort`, so a session
	 * teardown can tag its owned jobs with {@link ASYNC_JOB_MANAGER_SHUTDOWN_REASON}
	 * before `dispose()` runs — the task executor reads it to park (not
	 * tombstone) a subagent interrupted purely by process shutdown.
	 */
	cancelAll(filter?: AsyncJobFilter, reason?: unknown): void {
		this.#cancelJobs(filter, reason);
	}

	#cancelJobs(filter?: AsyncJobFilter, reason?: unknown): void {
		for (const job of this.getRunningJobs(filter)) {
			if (!this.#settleRunningJob(job, "cancelled")) continue;
			job.endedAt = Date.now();
			job.abortController.abort(reason);
			this.#scheduleEviction(job);
		}
	}

	/**
	 * Immediately evict completed and failed jobs matching the filter instead of
	 * waiting for retention expiry, dropping every queued delivery so a prior
	 * session's result can never be injected into a later transcript. Returns the
	 * number of jobs evicted.
	 *
	 * A delivery whose sink call is already in flight (or drained onto a caller's
	 * yield queue) is guarded by the owner's delivery generation, not the per-id
	 * suppression marker — that marker is cleared when the id is reused.
	 */
	evictCompletedJobs(filter?: AsyncJobFilter): number {
		let evicted = 0;
		for (const job of this.#filterJobs(this.#jobs.values(), filter)) {
			if (job.status !== "completed" && job.status !== "failed") continue;
			this.acknowledgeDeliveries([job.id]);
			if (this.#evictJob(job)) evicted += 1;
		}
		return evicted;
	}

	async waitForAll(): Promise<void> {
		await Promise.all(Array.from(this.#jobs.values()).map(job => job.promise));
	}

	/**
	 * Route completions for jobs owned by `ownerId` to `sink`. Sessions register
	 * their own sink at construction and unregister on dispose. Owned deliveries
	 * with no live sink are dead-lettered — `onJobComplete` serves only unowned
	 * deliveries.
	 *
	 * Last registration wins for an owner id; the returned unregister clears the
	 * mapping only while it still points at `sink`, so a revived session's fresh
	 * registration survives its parked predecessor's late cleanup.
	 */
	registerDeliverySink(ownerId: string, sink: AsyncJobDeliverySink): () => void {
		this.#deliverySinks.set(ownerId, sink);
		return () => {
			if (this.#deliverySinks.get(ownerId) === sink) this.#deliverySinks.delete(ownerId);
		};
	}

	/**
	 * Wait until every job owned by `ownerId` has settled — its run promise
	 * resolved, which for cancelled jobs means the underlying process actually
	 * exited. Jobs registered while waiting (e.g. by a follow-up turn) are
	 * awaited too. Returns false when `timeoutMs` elapses first.
	 *
	 * `excludeSuppressed` skips jobs whose delivery is suppressed (acknowledged
	 * or `hub`-watched): those can never re-wake a run, so quiescence barriers
	 * pass it to share one contract with the pending-async-wake predicate.
	 * Teardown reaps omit it — worktree safety concerns every owner process.
	 */
	async waitForOwnerJobs(
		ownerId: string,
		options?: { timeoutMs?: number; excludeSuppressed?: boolean },
	): Promise<boolean> {
		const deadline =
			options?.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + Math.max(0, options.timeoutMs);
		const awaited = new Set<string>();
		for (;;) {
			const pending = this.#filterJobs(this.#jobs.values(), { ownerId }).filter(
				job => !awaited.has(job.id) && (options?.excludeSuppressed !== true || !this.isDeliverySuppressed(job.id)),
			);
			if (pending.length === 0) return true;
			for (const job of pending) awaited.add(job.id);
			const settled = await this.#waitForDeliveryPromise(
				Promise.all(pending.map(job => job.promise)).then(() => {}),
				deadline,
			);
			if (!settled) return false;
		}
	}

	/**
	 * Cancel every job owned by `ownerId`, then wait only until `deadlineAt`.
	 * The returned completion keeps waiting for actual process settlement when
	 * the deadline expires, so callers can move that cleanup out of the
	 * user-visible Task wait without losing ownership of the live work.
	 */
	async cancelAndReapOwnerJobs(ownerId: string, deadlineAt: number): Promise<AsyncJobReapResult> {
		this.cancelAll({ ownerId });
		const timeoutMs = Math.max(0, deadlineAt - Date.now());
		const settled = await this.waitForOwnerJobs(ownerId, { timeoutMs });
		if (settled) {
			return { settled: true, pendingJobIds: [], completion: Promise.resolve() };
		}
		const pendingJobIds = this.getAllJobs({ ownerId })
			.filter(job => job.status === "running" || job.status === "cancelled")
			.map(job => job.id);
		const completion = this.waitForOwnerJobs(ownerId).then(() => {});
		return { settled: false, pendingJobIds, completion };
	}

	async #waitForAllUntil(deadline: number): Promise<boolean> {
		const promises = Array.from(this.#jobs.values()).map(job => job.promise);
		if (promises.length === 0) return true;
		if (deadline === Number.POSITIVE_INFINITY) {
			await Promise.all(promises);
			return true;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;

		const timeout = Promise.withResolvers<"timeout">();
		const timer = setTimeout(() => timeout.resolve("timeout"), remainingMs);
		timer.unref();
		try {
			const result = await Promise.race([Promise.all(promises).then(() => "settled" as const), timeout.promise]);
			return result === "settled";
		} finally {
			clearTimeout(timer);
		}
	}

	async drainDeliveries(options?: { timeoutMs?: number; filter?: AsyncJobFilter }): Promise<boolean> {
		const timeoutMs = options?.timeoutMs;
		const filter = options?.filter;
		const hasDeadline = timeoutMs !== undefined;
		const deadline = hasDeadline ? Date.now() + Math.max(timeoutMs, 0) : Number.POSITIVE_INFINITY;

		while (this.hasPendingDeliveries(filter)) {
			if (filter?.ownerId) {
				const delivered = await this.#deliverNextFiltered(filter, deadline);
				if (delivered) continue;
				return false;
			}
			const inFlightDeliveries = this.#filterInFlightDeliveries();
			if (inFlightDeliveries.length > 0 && this.#filterDeliveries().length === 0) {
				const delivered = await this.#waitForDeliveryPromise(inFlightDeliveries[0]?.promise, deadline);
				if (delivered) continue;
				return false;
			}

			this.#ensureDeliveryLoop();
			const loop = this.#deliveryLoop;
			if (!loop) {
				continue;
			}

			if (!hasDeadline) {
				await loop;
				continue;
			}

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}

			await Promise.race([loop, Bun.sleep(remainingMs)]);
			if (Date.now() >= deadline && this.hasPendingDeliveries(filter)) {
				return false;
			}
		}

		return true;
	}

	async dispose(options?: { timeoutMs?: number }): Promise<boolean> {
		this.#disposed = true;
		this.#clearEvictionTimers();
		this.#cancelJobs(undefined, ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
		this.#clearQueuedProgress();
		const timeoutMs = Math.max(options?.timeoutMs ?? 3_000, 0);
		const deadline = Date.now() + timeoutMs;
		const jobsSettled = await this.#waitForAllUntil(deadline);
		const drained = await this.drainDeliveries({ timeoutMs: Math.max(deadline - Date.now(), 0) });
		this.#clearEvictionTimers();
		this.#jobs.clear();
		this.#deliveries.length = 0;
		this.#inFlightDeliveries.length = 0;
		this.#suppressedDeliveries.clear();
		this.#watchedJobs.clear();
		this.#pollEscalation.clear();
		this.#deliverySinks.clear();
		this.#runningJobCount = 0;
		this.#activeRunningJobCount = 0;
		this.#queuedRunningJobCount = 0;
		this.#runningJobCountByOwner.clear();
		this.#activeProgressKeys.clear();
		this.#inFlightProgressByJob.clear();
		this.#dispatchedProgressByJob.clear();
		this.#settlingJobs.clear();
		return jobsSettled && drained;
	}

	#queueProgress(
		job: AsyncJob,
		registerOptions: AsyncJobRegisterOptions | undefined,
		text: AsyncJobProgressText,
		details: AsyncJobProgressDetails | undefined,
		progressOptions: AsyncJobProgressOptions | undefined,
	): Promise<void> {
		if (job.status !== "running" || this.#settlingJobs.has(job)) return Promise.resolve();
		job.lastProgressAt = Date.now();
		const onProgress = registerOptions?.onProgress;
		if (!onProgress) {
			job.latestProgressText = typeof text === "function" ? text() : text;
			if (details) job.latestDetails = typeof details === "function" ? details() : details;
			return Promise.resolve();
		}
		if (typeof text === "string") job.latestProgressText = text;
		if (details && typeof details !== "function") job.latestDetails = details;

		const key = registerOptions?.progressKey?.trim() || job;
		const completion = Promise.withResolvers<void>();
		const entry: PendingAsyncJobProgress = {
			key,
			job,
			revision: ++this.#progressRevision,
			text,
			details,
			onProgress,
			resolve: completion.resolve,
		};
		const previous = this.#pendingProgress.get(key);
		if (previous) {
			this.#pendingProgress.delete(key);
			previous.resolve();
		}
		if (progressOptions?.terminal === true) {
			this.#pendingTerminalProgress.push(entry);
			this.#scheduleProgressFlush(true);
		} else {
			this.#pendingProgress.set(key, entry);
			this.#scheduleProgressFlush();
		}
		return completion.promise;
	}
	#hasDispatchableProgress(): boolean {
		for (const entry of this.#pendingTerminalProgress) {
			if (!this.#activeProgressKeys.has(entry.key)) return true;
		}
		for (const key of this.#pendingProgress.keys()) {
			if (!this.#activeProgressKeys.has(key)) return true;
		}
		return false;
	}

	#scheduleProgressFlush(priority = false): void {
		if (this.#disposed || !this.#hasDispatchableProgress()) return;
		if (this.#progressTimer) {
			if (this.#progressCooldown || !priority) return;
			clearTimeout(this.#progressTimer);
		}
		this.#progressTimer = setTimeout(
			() => {
				this.#progressTimer = undefined;
				if (this.#hasDispatchableProgress()) this.#flushProgressBudget();
			},
			priority ? 0 : PROGRESS_FLUSH_INTERVAL_MS,
		);
		this.#progressTimer.unref?.();
	}

	#flushProgressBudget(): void {
		this.#progressCooldown = true;
		this.#progressTimer = setTimeout(() => {
			this.#progressTimer = undefined;
			this.#progressCooldown = false;
			if (this.#hasDispatchableProgress()) this.#flushProgressBudget();
		}, PROGRESS_FLUSH_INTERVAL_MS);
		this.#progressTimer.unref?.();
		let reservedOrdinary: [AsyncJobProgressKey, PendingAsyncJobProgress] | undefined;
		for (const candidate of this.#pendingProgress) {
			if (this.#activeProgressKeys.has(candidate[0])) continue;
			reservedOrdinary = candidate;
			break;
		}
		const terminalBudget = reservedOrdinary ? PROGRESS_CALLBACK_BUDGET - 1 : PROGRESS_CALLBACK_BUDGET;
		let dispatched = 0;
		for (let index = 0; index < this.#pendingTerminalProgress.length && dispatched < terminalBudget; ) {
			const entry = this.#pendingTerminalProgress[index];
			if (!entry || this.#activeProgressKeys.has(entry.key) || entry.key === reservedOrdinary?.[0]) {
				index++;
				continue;
			}
			this.#pendingTerminalProgress.splice(index, 1);
			void this.#dispatchProgress(entry);
			dispatched++;
		}
		if (reservedOrdinary && dispatched < PROGRESS_CALLBACK_BUDGET) {
			this.#pendingProgress.delete(reservedOrdinary[0]);
			void this.#dispatchProgress(reservedOrdinary[1]);
			dispatched++;
		}
		if (dispatched < PROGRESS_CALLBACK_BUDGET) {
			for (const [key, entry] of this.#pendingProgress) {
				if (this.#activeProgressKeys.has(key)) continue;
				this.#pendingProgress.delete(key);
				void this.#dispatchProgress(entry);
				dispatched++;
				if (dispatched >= PROGRESS_CALLBACK_BUDGET) break;
			}
		}
	}

	#dispatchProgress(entry: PendingAsyncJobProgress): Promise<void> {
		this.#activeProgressKeys.add(entry.key);
		let dispatched = this.#dispatchedProgressByJob.get(entry.job);
		if (!dispatched) {
			dispatched = new Set();
			this.#dispatchedProgressByJob.set(entry.job, dispatched);
		}
		dispatched.add(entry);
		let tracked: Promise<void>;
		tracked = Promise.resolve()
			.then(async () => {
				if (entry.cancelled) return;
				if (
					this.#jobs.get(entry.job.id) !== entry.job ||
					entry.job.status !== "running" ||
					this.#settlingJobs.has(entry.job)
				)
					return;
				entry.started = true;
				try {
					const text = typeof entry.text === "function" ? entry.text() : entry.text;
					const details = typeof entry.details === "function" ? entry.details() : entry.details;
					entry.job.latestProgressText = text;
					if (details) entry.job.latestDetails = details;
					await entry.onProgress(text, details);
				} catch (error) {
					logger.warn("Async job progress callback failed", {
						jobId: entry.job.id,
						revision: entry.revision,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			})
			.finally(() => {
				entry.resolve();
				this.#activeProgressKeys.delete(entry.key);
				const dispatchedForJob = this.#dispatchedProgressByJob.get(entry.job);
				dispatchedForJob?.delete(entry);
				if (dispatchedForJob?.size === 0) this.#dispatchedProgressByJob.delete(entry.job);
				const inFlight = this.#inFlightProgressByJob.get(entry.job);
				inFlight?.delete(tracked);
				if (inFlight?.size === 0) {
					this.#inFlightProgressByJob.delete(entry.job);
					if (entry.job.status !== "running") this.#settlingJobs.delete(entry.job);
				}
				this.#scheduleProgressFlush(
					this.#pendingTerminalProgress.some(candidate => !this.#activeProgressKeys.has(candidate.key)),
				);
			});
		let inFlight = this.#inFlightProgressByJob.get(entry.job);
		if (!inFlight) {
			inFlight = new Set();
			this.#inFlightProgressByJob.set(entry.job, inFlight);
		}
		inFlight.add(tracked);
		return tracked;
	}

	async #prepareJobSettlement(job: AsyncJob): Promise<void> {
		if (job.status !== "running") return;
		this.#settlingJobs.add(job);
		this.#cancelQueuedProgress(job);
		const inFlight = this.#inFlightProgressByJob.get(job);
		if (!inFlight?.size) return;
		if (job.abortController.signal.aborted) return;
		const aborted = Promise.withResolvers<void>();
		const onAbort = () => aborted.resolve();
		job.abortController.signal.addEventListener("abort", onAbort, { once: true });
		try {
			await Promise.race([Promise.all(inFlight), aborted.promise]);
		} finally {
			job.abortController.signal.removeEventListener("abort", onAbort);
		}
	}

	#cancelQueuedProgress(job: AsyncJob): void {
		for (const [key, entry] of this.#pendingProgress) {
			if (entry.job !== job) continue;
			this.#pendingProgress.delete(key);
			entry.resolve();
		}
		for (let index = this.#pendingTerminalProgress.length - 1; index >= 0; index--) {
			const entry = this.#pendingTerminalProgress[index];
			if (entry?.job !== job) continue;
			this.#pendingTerminalProgress.splice(index, 1);
			entry.resolve();
		}
		if (
			this.#pendingTerminalProgress.length === 0 &&
			this.#pendingProgress.size === 0 &&
			this.#progressTimer &&
			!this.#progressCooldown
		) {
			clearTimeout(this.#progressTimer);
			this.#progressTimer = undefined;
		}
	}

	#cancelDispatchedProgress(job: AsyncJob): void {
		const dispatched = this.#dispatchedProgressByJob.get(job);
		if (!dispatched) return;
		for (const entry of dispatched) {
			entry.cancelled = true;
			if (!entry.started) entry.resolve();
		}
		this.#dispatchedProgressByJob.delete(job);
	}

	#clearQueuedProgress(): void {
		if (this.#progressTimer) {
			clearTimeout(this.#progressTimer);
			this.#progressTimer = undefined;
		}
		this.#progressCooldown = false;
		for (const entry of this.#pendingProgress.values()) entry.resolve();
		for (const entry of this.#pendingTerminalProgress) entry.resolve();
		this.#pendingProgress.clear();
		this.#pendingTerminalProgress.length = 0;
	}

	#incrementRunningJob(job: AsyncJob): void {
		this.#runningJobCount++;
		if (job.queued) this.#queuedRunningJobCount++;
		else this.#activeRunningJobCount++;
		if (!job.ownerId) return;
		this.#runningJobCountByOwner.set(job.ownerId, (this.#runningJobCountByOwner.get(job.ownerId) ?? 0) + 1);
	}

	#settleRunningJob(job: AsyncJob, status: Exclude<AsyncJob["status"], "running">): boolean {
		if (job.status !== "running") return false;
		job.status = status;
		this.#cancelQueuedProgress(job);
		if (status === "cancelled") this.#cancelDispatchedProgress(job);
		if ((this.#inFlightProgressByJob.get(job)?.size ?? 0) === 0) this.#settlingJobs.delete(job);
		this.#runningJobCount--;
		if (job.queued) this.#queuedRunningJobCount--;
		else this.#activeRunningJobCount--;
		if (job.ownerId) {
			const ownerCount = (this.#runningJobCountByOwner.get(job.ownerId) ?? 1) - 1;
			if (ownerCount === 0) this.#runningJobCountByOwner.delete(job.ownerId);
			else this.#runningJobCountByOwner.set(job.ownerId, ownerCount);
		}
		return true;
	}

	#resolveJobId(preferredId?: string): string {
		preferredId = preferredId?.trim();
		if (!preferredId) {
			let candidate = 1;
			while (true) {
				const id = `bg_${candidate}`;
				if (!this.#jobs.has(id)) {
					return id;
				}
				candidate += 1;
			}
		}

		const base = preferredId.trim();
		if (!this.#jobs.has(base)) return base;

		let suffix = 2;
		let candidate = `${base}-${suffix}`;
		while (this.#jobs.has(candidate)) {
			suffix += 1;
			candidate = `${base}-${suffix}`;
		}
		return candidate;
	}

	#evictJob(job: AsyncJob): boolean {
		if (this.#jobs.get(job.id) !== job) return false;
		clearTimeout(this.#evictionTimers.get(job.id));
		this.#evictionTimers.delete(job.id);
		this.#suppressedDeliveries.delete(job.id);
		this.#watchedJobs.delete(job.id);
		return this.#jobs.delete(job.id);
	}

	#scheduleEviction(job: AsyncJob): void {
		if (this.#disposed || this.#jobs.get(job.id) !== job) return;
		if (this.#retentionMs <= 0) {
			this.#evictJob(job);
			return;
		}
		const existing = this.#evictionTimers.get(job.id);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.#evictJob(job);
		}, this.#retentionMs);
		timer.unref();
		this.#evictionTimers.set(job.id, timer);
	}

	#clearEvictionTimers(): void {
		for (const timer of this.#evictionTimers.values()) {
			clearTimeout(timer);
		}
		this.#evictionTimers.clear();
	}

	#setDeliveryStatus(jobId: string, status: AsyncJobDeliveryStatus, error?: string): void {
		const job = this.#jobs.get(jobId);
		if (!job) return;
		job.deliveryStatus = status;
		if (error === undefined) delete job.deliveryError;
		else job.deliveryError = error;
	}

	#markSuppressedDeliveryDelivered(jobId: string): void {
		this.#setDeliveryStatus(jobId, "delivered");
	}

	#filterDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return this.#deliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId));
		return this.#deliveries.filter(
			delivery => delivery.ownerId === ownerId && !this.isDeliverySuppressed(delivery.jobId),
		);
	}

	#filterInFlightDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return this.#inFlightDeliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId));
		return this.#inFlightDeliveries.filter(
			delivery => delivery.ownerId === ownerId && !this.isDeliverySuppressed(delivery.jobId),
		);
	}

	async #deliverNextFiltered(filter: AsyncJobFilter, deadline: number): Promise<boolean> {
		while (true) {
			let selected: AsyncJobDelivery | undefined;
			for (const delivery of this.#deliveries) {
				if (delivery.ownerId !== filter.ownerId) continue;
				if (this.isDeliverySuppressed(delivery.jobId)) continue;
				if (!selected || delivery.nextAttemptAt < selected.nextAttemptAt) {
					selected = delivery;
				}
			}

			if (!selected) {
				const inFlight = this.#filterInFlightDeliveries(filter);
				if (inFlight.length === 0) return true;
				return this.#waitForDeliveryPromise(inFlight[0]?.promise, deadline);
			}

			const now = Date.now();
			if (selected.nextAttemptAt > now) {
				if (selected.nextAttemptAt > deadline) return false;
				await Bun.sleep(selected.nextAttemptAt - now);
				continue;
			}

			const index = this.#deliveries.indexOf(selected);
			if (index === -1) continue;
			this.#deliveries.splice(index, 1);
			if (this.isDeliverySuppressed(selected.jobId)) {
				this.#markSuppressedDeliveryDelivered(selected.jobId);
				continue;
			}

			return this.#waitForDeliveryPromise(this.#deliverDelivery(selected), deadline);
		}
	}

	isDeliverySuppressed(jobId: string): boolean {
		const job = this.#jobs.get(jobId);
		return (
			isManualCompletionDelivery(job?.completionDelivery ?? "automatic") ||
			this.#suppressedDeliveries.has(jobId) ||
			this.#watchedJobs.has(jobId)
		);
	}

	#enqueueDelivery(jobId: string, text: string): void {
		const job = this.#jobs.get(jobId);
		if (!job || isManualCompletionDelivery(job.completionDelivery)) return;
		this.#setDeliveryStatus(jobId, "pending");
		// A foreground snapshot or watcher consumes the result instead of auto-delivering it.
		if (this.isDeliverySuppressed(jobId)) {
			this.#markSuppressedDeliveryDelivered(jobId);
			return;
		}
		this.#deliveries.push({
			jobId,
			text,
			attempt: 0,
			nextAttemptAt: Date.now(),
			ownerId: job.ownerId,
		});
		this.#ensureDeliveryLoop();
	}

	#ensureDeliveryLoop(): void {
		if (this.#deliveryLoop) {
			return;
		}

		this.#deliveryLoop = this.#runDeliveryLoop()
			.catch(error => {
				logger.error("Async job delivery loop crashed", { error: String(error) });
			})
			.finally(() => {
				this.#deliveryLoop = undefined;
				if (this.#deliveries.length > 0) {
					this.#ensureDeliveryLoop();
				}
			});
	}

	async #runDeliveryLoop(): Promise<void> {
		while (this.#deliveries.length > 0) {
			const delivery = this.#deliveries[0];
			if (this.isDeliverySuppressed(delivery.jobId)) {
				this.#deliveries.shift();
				this.#markSuppressedDeliveryDelivered(delivery.jobId);
				continue;
			}
			const waitMs = delivery.nextAttemptAt - Date.now();
			if (waitMs > 0) {
				await Bun.sleep(waitMs);
			}
			if (this.#deliveries[0] !== delivery) {
				continue;
			}
			if (this.isDeliverySuppressed(delivery.jobId)) {
				this.#deliveries.shift();
				this.#markSuppressedDeliveryDelivered(delivery.jobId);
				continue;
			}

			this.#deliveries.shift();
			await this.#deliverDelivery(delivery);
		}
	}

	/**
	 * Resolve the sink for one delivery attempt: owned deliveries route ONLY to
	 * their owner's registered sink (a missing sink dead-letters — never the
	 * default, which would misroute a dead owner's result into another
	 * session); unowned deliveries use the constructor default. Resolved per
	 * attempt so a sink registered between retries (e.g. a revived session)
	 * picks up the retry.
	 */
	#resolveDeliverySink(ownerId: string | undefined): AsyncJobDeliverySink | undefined {
		if (ownerId !== undefined) return this.#deliverySinks.get(ownerId);
		return this.#onJobComplete;
	}

	#deliverDelivery(delivery: AsyncJobDelivery): Promise<void> {
		const sink = this.#resolveDeliverySink(delivery.ownerId);
		if (!sink) {
			// Dead-letter: owned delivery with no live sink (session disposed or
			// parked), or unowned delivery with no default sink. Drop it — the
			// job row keeps its result/error text until retention eviction, so
			// the outcome stays inspectable via job queries and agent:// reads.
			logger.warn("Async job delivery dead-lettered: no delivery sink", {
				jobId: delivery.jobId,
				ownerId: delivery.ownerId,
			});
			this.#setDeliveryStatus(delivery.jobId, "dead-letter", "No delivery sink available");

			delivery.promise = Promise.resolve();
			return delivery.promise;
		}
		const promise = (async () => {
			this.#inFlightDeliveries.push(delivery);
			this.#setDeliveryStatus(delivery.jobId, "delivering");
			try {
				await sink(delivery.jobId, delivery.text, this.#jobs.get(delivery.jobId));
				this.#setDeliveryStatus(delivery.jobId, "delivered");
			} catch (error) {
				delivery.attempt += 1;
				delivery.lastError = error instanceof Error ? error.message : String(error);
				delivery.nextAttemptAt = Date.now() + this.#getRetryDelay(delivery.attempt);
				if (!this.isDeliverySuppressed(delivery.jobId)) {
					this.#setDeliveryStatus(delivery.jobId, "pending", delivery.lastError);
					this.#deliveries.push(delivery);
				} else {
					this.#markSuppressedDeliveryDelivered(delivery.jobId);
				}
				logger.warn("Async job completion delivery failed", {
					jobId: delivery.jobId,
					attempt: delivery.attempt,
					nextRetryAt: delivery.nextAttemptAt,
					error: delivery.lastError,
				});
			} finally {
				const index = this.#inFlightDeliveries.indexOf(delivery);
				if (index !== -1) this.#inFlightDeliveries.splice(index, 1);
				if (this.#deliveries.length > 0) this.#ensureDeliveryLoop();
			}
		})();
		delivery.promise = promise;
		return promise;
	}

	async #waitForDeliveryPromise(promise: Promise<void> | undefined, deadline: number): Promise<boolean> {
		if (!promise) return true;
		if (deadline === Number.POSITIVE_INFINITY) {
			await promise;
			return true;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;
		let timedOut = false;
		await Promise.race([
			promise,
			Bun.sleep(remainingMs).then(() => {
				timedOut = true;
			}),
		]);
		return !timedOut;
	}

	#getRetryDelay(attempt: number): number {
		const exp = Math.min(Math.max(attempt - 1, 0), 8);
		const backoffMs = DELIVERY_RETRY_BASE_MS * 2 ** exp;
		const jitterMs = Math.floor(Math.random() * DELIVERY_RETRY_JITTER_MS);
		return Math.min(DELIVERY_RETRY_MAX_MS, backoffMs + jitterMs);
	}
}
