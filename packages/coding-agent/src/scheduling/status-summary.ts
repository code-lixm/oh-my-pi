import type { ScheduleJob } from "./types";

/** How long a status snapshot may serve before a background re-read. */
export const SCHEDULE_STATUS_TTL_MS = 10_000;

/** Active/paused scheduled prompts plus the earliest pending run, for status surfaces. */
export interface ScheduleStatusSummary {
	/** Epoch ms of the earliest run among active jobs, or null when none is pending. */
	nextRunAt: number | null;
	/** Active (non-paused, non-terminal) scheduled prompts. */
	activeCount: number;
	/** Paused scheduled prompts. */
	pausedCount: number;
}

/** Minimal source shape; the session's scheduling runtime satisfies it. */
export interface ScheduleStatusSource {
	list(): Promise<readonly ScheduleJob[]>;
}

interface ScheduleStatusCacheOptions {
	/** Resolved per read so a session switch picks up the new runtime. */
	getSource: () => ScheduleStatusSource | undefined;
	/** Fired after a background read settles, so the host can repaint. */
	onChange?: () => void;
}

/** Fold a session's jobs into the status-line/activity-row summary. */
export function summarizeScheduleStatus(jobs: readonly ScheduleJob[]): ScheduleStatusSummary {
	let nextRunAt: number | null = null;
	let activeCount = 0;
	let pausedCount = 0;
	for (const job of jobs) {
		if (job.status === "paused") {
			pausedCount++;
			continue;
		}
		if (job.status !== "active") continue;
		activeCount++;
		const runAt = job.nextRunAt === undefined ? Number.NaN : Date.parse(job.nextRunAt);
		if (Number.isFinite(runAt) && (nextRunAt === null || runAt < nextRunAt)) nextRunAt = runAt;
	}
	return { nextRunAt, activeCount, pausedCount };
}

/**
 * Synchronous read-through cache over a session's scheduled prompts. Status
 * surfaces render in synchronous passes, so the store read happens in the
 * background: callers get the current snapshot immediately and repaint when
 * `onChange` fires. A failed read clears the snapshot instead of pinning a
 * stale countdown, and `reset()` bumps a generation so a read that settles
 * after a session switch can neither land nor keep the next read locked out.
 */
export class ScheduleStatusCache {
	readonly #getSource: () => ScheduleStatusSource | undefined;
	readonly #onChange: (() => void) | undefined;
	#summary: ScheduleStatusSummary | null = null;
	#fetchedAt = 0;
	#inFlight = false;
	#generation = 0;
	#disposed = false;

	constructor(options: ScheduleStatusCacheOptions) {
		this.#getSource = options.getSource;
		this.#onChange = options.onChange;
	}

	/** Current snapshot; a missing or stale one schedules a background read. */
	read(): ScheduleStatusSummary | null {
		if (this.#disposed) return this.#summary;
		const now = Date.now();
		if (this.#fetchedAt === 0 || now - this.#fetchedAt >= SCHEDULE_STATUS_TTL_MS) this.#refresh();
		return this.#summary;
	}

	/** Drop the snapshot on a session switch; an in-flight read is discarded. */
	reset(): void {
		this.#generation++;
		this.#summary = null;
		this.#fetchedAt = 0;
		this.#inFlight = false;
	}

	dispose(): void {
		this.#disposed = true;
	}

	#refresh(): void {
		if (this.#inFlight) return;
		const source = this.#getSource();
		if (!source) return;
		const generation = this.#generation;
		this.#inFlight = true;
		void source
			.list()
			.then(jobs => {
				if (this.#disposed || generation !== this.#generation) return;
				this.#summary = summarizeScheduleStatus(jobs);
				this.#fetchedAt = Date.now();
			})
			.catch(() => {
				if (this.#disposed || generation !== this.#generation) return;
				this.#summary = null;
				this.#fetchedAt = Date.now();
			})
			.finally(() => {
				// A reset already released the slot for the newer generation's read;
				// clearing it here would let that read's flag be wiped by this one.
				if (generation !== this.#generation) return;
				this.#inFlight = false;
				if (!this.#disposed) this.#onChange?.();
			});
	}
}
