import type {
	ScheduleDispatch,
	ScheduleJob,
	ScheduleRunResult,
	Scheduler,
	ScheduleSchedulerHooks,
	ScheduleStore,
} from "./types";

const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * In-process timer runner. Durable state belongs exclusively to the store: this
 * class only chooses the next wake-up and serializes dispatches per session.
 */
export class SetTimeoutScheduleScheduler implements Scheduler {
	readonly #store: ScheduleStore;
	readonly #hooks: ScheduleSchedulerHooks;
	readonly #lanes = new Map<string, Promise<void>>();
	#timer: NodeJS.Timeout | undefined;
	#timerGeneration = 0;
	#started = false;
	#recovered = false;
	#starting: Promise<void> | undefined;
	#running = false;

	constructor(store: ScheduleStore, hooks: ScheduleSchedulerHooks) {
		this.#store = store;
		this.#hooks = hooks;
	}

	async start(): Promise<void> {
		if (this.#started) return;
		if (this.#starting) return await this.#starting;
		this.#started = true;
		this.#starting = this.#start();
		try {
			await this.#starting;
		} catch (error) {
			this.#started = false;
			throw error;
		} finally {
			this.#starting = undefined;
		}
	}

	stop(): void {
		this.#started = false;
		this.#timerGeneration++;
		this.#clearTimer();
	}

	wake(): void {
		if (!this.#started) return;
		this.#timerGeneration++;
		this.#clearTimer();
		void this.#scheduleNext();
	}

	async register(job: ScheduleJob): Promise<ScheduleJob> {
		const saved = await this.#store.save(job);
		this.wake();
		return saved;
	}

	async cancel(id: string): Promise<ScheduleJob | undefined> {
		const cancelled = await this.#store.cancel(id);
		if (cancelled) this.wake();
		return cancelled;
	}

	async runDue(now: Date = this.#now()): Promise<number> {
		if (this.#running) return 0;
		this.#running = true;
		try {
			const dispatches = await this.#store.claimDue(now, this.#now());
			const outcomes = await Promise.all(dispatches.map(dispatch => this.#enqueue(dispatch)));
			return outcomes.filter(outcome => outcome === "ran").length;
		} finally {
			this.#running = false;
			if (this.#started) void this.#scheduleNext();
		}
	}

	async #start(): Promise<void> {
		if (!this.#recovered) {
			await this.#store.recoverInterruptedDispatches(this.#now());
			this.#recovered = true;
		}
		if (this.#started) await this.#scheduleNext();
	}

	#enqueue(dispatch: ScheduleDispatch): Promise<ScheduleRunResult> {
		const key = dispatch.job.sessionId;
		const previous = this.#lanes.get(key) ?? Promise.resolve();
		const result = previous.catch(() => {}).then(async () => await this.#runDispatch(dispatch));
		const lane = result.then(
			() => undefined,
			() => undefined,
		);
		this.#lanes.set(key, lane);
		void lane.finally(() => {
			if (this.#lanes.get(key) === lane) this.#lanes.delete(key);
		});
		return result;
	}

	async #runDispatch(dispatch: ScheduleDispatch): Promise<ScheduleRunResult> {
		let outcome: ScheduleRunResult = "ran";
		let thrown: unknown;
		try {
			outcome = (await this.#hooks.runJob(dispatch.job, dispatch)) ?? "ran";
		} catch (error) {
			thrown = error;
			outcome = "ran";
			this.#reportError(dispatch.job, error);
		}

		try {
			await this.#store.recordDispatchResult(dispatch.id, {
				outcome,
				now: this.#now(),
				...(thrown === undefined ? {} : { error: thrown }),
			});
		} catch (error) {
			this.#reportError(dispatch.job, error);
			throw error;
		}
		return outcome;
	}

	async #scheduleNext(): Promise<void> {
		if (!this.#started) return;
		const generation = ++this.#timerGeneration;
		this.#clearTimer();
		try {
			const next = await this.#store.nextActiveRunAt();
			if (!this.#started || generation !== this.#timerGeneration || !next) return;
			const delay = Math.max(0, next.getTime() - this.#now().getTime());
			this.#timer = setTimeout(
				() => {
					if (!this.#started || generation !== this.#timerGeneration) return;
					this.#timer = undefined;
					void this.#runTimer(generation);
				},
				Math.min(delay, MAX_TIMEOUT_MS),
			);
			this.#timer.unref?.();
		} catch (error) {
			// A later mutation/wake can retry scheduling; do not leave a thrown async task.
			if (this.#started) this.#reportSchedulerError(error);
		}
	}

	async #runTimer(generation: number): Promise<void> {
		try {
			await this.runDue(this.#now());
		} catch (error) {
			this.#reportSchedulerError(error);
		} finally {
			if (this.#started && generation === this.#timerGeneration) await this.#scheduleNext();
		}
	}

	#clearTimer(): void {
		if (!this.#timer) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#now(): Date {
		return this.#hooks.now?.() ?? new Date();
	}

	#reportError(job: ScheduleJob, error: unknown): void {
		try {
			this.#hooks.onError?.(job, error);
		} catch {
			// User-supplied diagnostics must never break durable dispatch settlement.
		}
	}

	#reportSchedulerError(error: unknown): void {
		// Hooks intentionally only accept a job. There is no job to attribute a
		// failed sidecar lookup to, so retain the failure in the rejected operation.
		void error;
	}
}
