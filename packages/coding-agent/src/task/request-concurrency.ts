import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { normalizeConcurrencyLimit, Semaphore } from "./parallel";

export interface TaskRequestConcurrencySnapshot {
	active: number;
	queued: number;
	/** Undefined means the configured limit is unlimited. */
	limit: number | undefined;
}

/**
 * Root-session limiter for subagent LLM requests.
 *
 * A slot covers one provider stream only, never an agent lifecycle. Parent
 * agents therefore release their slot before tools run or children are
 * awaited, so nested fan-out cannot deadlock at low limits.
 */
export class TaskRequestConcurrency {
	readonly #readLimit: () => number;
	readonly #semaphore: Semaphore;
	#active = 0;
	#queued = 0;

	constructor(readLimit: () => number) {
		this.#readLimit = readLimit;
		this.#semaphore = new Semaphore(readLimit());
	}

	#refreshLimit(): number | undefined {
		const limit = normalizeConcurrencyLimit(this.#readLimit());
		this.#semaphore.resize(limit);
		return limit > 0 ? limit : undefined;
	}

	async acquire(signal?: AbortSignal): Promise<() => void> {
		this.#refreshLimit();
		this.#queued++;
		try {
			await this.#semaphore.acquire(signal);
		} finally {
			this.#queued--;
		}
		this.#active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#active--;
			this.#semaphore.release();
		};
	}

	snapshot(): TaskRequestConcurrencySnapshot {
		return {
			active: this.#active,
			queued: this.#queued,
			limit: this.#refreshLimit(),
		};
	}
}

export interface TaskRunnableConcurrencySnapshot {
	active: number;
	queued: number;
	/** Undefined means the configured limit is unlimited. */
	limit: number | undefined;
}

interface RunnableLeaseState {
	releasePermit: (() => void) | undefined;
	suspendDepth: number;
	released: boolean;
}

export interface RunnableAcquireOptions {
	onWait?: () => void;
	onAcquire?: () => void;
}

export interface RunnableSuspensionOptions {
	signal?: AbortSignal;
	onSuspend?: () => void;
	onResume?: () => void;
}

/** Root-session scheduler for runnable subagent turns. */
export class TaskRunnableConcurrency {
	readonly #readLimit: () => number;
	readonly #semaphore: Semaphore;
	readonly #leases = new Map<string, RunnableLeaseState>();
	#active = 0;
	#queued = 0;

	constructor(readLimit: () => number) {
		this.#readLimit = readLimit;
		this.#semaphore = new Semaphore(readLimit());
	}

	#refreshLimit(): number | undefined {
		const limit = normalizeConcurrencyLimit(this.#readLimit());
		this.#semaphore.resize(limit);
		return limit > 0 ? limit : undefined;
	}

	async #acquirePermit(signal?: AbortSignal): Promise<() => void> {
		this.#refreshLimit();
		this.#queued++;
		try {
			await this.#semaphore.acquire(signal);
		} finally {
			this.#queued--;
		}
		this.#active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#active--;
			this.#semaphore.release();
		};
	}

	async acquire(agentId: string, signal?: AbortSignal, options?: RunnableAcquireOptions): Promise<() => void> {
		if (this.#leases.has(agentId)) {
			throw new Error(`Runnable lease already held by ${agentId}`);
		}
		const state: RunnableLeaseState = { releasePermit: undefined, suspendDepth: 0, released: false };
		this.#leases.set(agentId, state);
		try {
			options?.onWait?.();
			state.releasePermit = await this.#acquirePermit(signal);
			options?.onAcquire?.();
		} catch (error) {
			state.released = true;
			state.releasePermit?.();
			state.releasePermit = undefined;
			this.#leases.delete(agentId);
			throw error;
		}
		return () => {
			if (state.released) return;
			state.released = true;
			this.#leases.delete(agentId);
			state.releasePermit?.();
			state.releasePermit = undefined;
		};
	}

	hasLease(agentId: string): boolean {
		const state = this.#leases.get(agentId);
		return state !== undefined && !state.released;
	}

	async withSuspended<T>(agentId: string, run: () => Promise<T>, options?: RunnableSuspensionOptions): Promise<T> {
		const state = this.#leases.get(agentId);
		if (!state || state.released) return run();
		state.suspendDepth++;
		if (state.suspendDepth === 1) {
			state.releasePermit?.();
			state.releasePermit = undefined;
			options?.onSuspend?.();
		}
		const outcome = await run().then(
			value => ({ ok: true as const, value }),
			error => ({ ok: false as const, error }),
		);
		state.suspendDepth--;
		let resumeFailed = false;
		let resumeError: unknown;
		if (state.suspendDepth === 0 && !state.released) {
			try {
				state.releasePermit = await this.#acquirePermit(options?.signal);
				options?.onResume?.();
			} catch (error) {
				state.released = true;
				state.releasePermit?.();
				state.releasePermit = undefined;
				this.#leases.delete(agentId);
				resumeFailed = true;
				resumeError = error;
			}
		}
		if (!outcome.ok) throw outcome.error;
		if (resumeFailed) throw resumeError;
		return outcome.value;
	}

	snapshot(): TaskRunnableConcurrencySnapshot {
		return {
			active: this.#active,
			queued: this.#queued,
			limit: this.#refreshLimit(),
		};
	}
}

/** Limit every subagent provider stream through the root session's shared cap. */
export function wrapStreamFnWithTaskConcurrency(limiter: TaskRequestConcurrency, base: StreamFn): StreamFn {
	return async (model, context, options) => {
		const release = await limiter.acquire(options?.signal);
		try {
			const stream = await base(model, context, options);
			stream.result().then(release, release);
			return stream;
		} catch (error) {
			release();
			throw error;
		}
	};
}
