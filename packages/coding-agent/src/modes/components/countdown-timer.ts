/**
 * Reusable countdown timer for dialog components.
 */
import type { TUI } from "@oh-my-pi/pi-tui";

export interface CountdownTimerOptions {
	/** Absolute deadline to use when the timer starts. */
	deadlineMs?: number;
	/** Defer starting until {@link CountdownTimer.start} is called. */
	start?: boolean;
}

export class CountdownTimer {
	#intervalId: NodeJS.Timeout | undefined;
	#expireTimeoutId: NodeJS.Timeout | undefined;
	#remainingSeconds: number;
	#deadlineMs = 0;
	#started = false;
	readonly #initialMs: number;

	constructor(
		timeoutMs: number,
		private tui: TUI | undefined,
		private onTick: (seconds: number) => void,
		private onExpire: () => void,
		options: CountdownTimerOptions = {},
	) {
		this.#initialMs = timeoutMs;
		this.#remainingSeconds = Math.ceil(timeoutMs / 1000);
		if (options.start !== false) this.start(options.deadlineMs);
	}

	#calculateRemainingSeconds(now = Date.now()): number {
		const remainingMs = Math.max(0, this.#deadlineMs - now);
		return Math.ceil(remainingMs / 1000);
	}

	/** Start once, optionally from a deadline established by another surface. */
	start(deadlineMs?: number): void {
		if (this.#started) return;
		this.#started = true;
		this.#arm(deadlineMs ?? Date.now() + this.#initialMs);
	}

	#arm(deadlineMs: number): void {
		this.dispose();
		this.#deadlineMs = deadlineMs;
		const now = Date.now();
		this.#remainingSeconds = this.#calculateRemainingSeconds(now);
		this.onTick(this.#remainingSeconds);
		this.tui?.requestRender();

		this.#expireTimeoutId = setTimeout(
			() => {
				this.dispose();
				this.onExpire();
			},
			Math.max(0, this.#deadlineMs - now),
		);

		this.#startInterval();
	}

	#startInterval(): void {
		if (this.#intervalId) {
			clearInterval(this.#intervalId);
			this.#intervalId = undefined;
		}
		this.#intervalId = setInterval(() => {
			const remainingSeconds = this.#calculateRemainingSeconds();
			if (remainingSeconds !== this.#remainingSeconds) {
				this.#remainingSeconds = remainingSeconds;
				this.onTick(this.#remainingSeconds);
			}
			this.tui?.requestRender();
		}, 1000);
	}

	/** Reset the countdown to its initial value or a supplied absolute deadline. */
	reset(deadlineMs?: number): void {
		if (!this.#started) {
			this.start(deadlineMs);
			return;
		}
		this.#arm(deadlineMs ?? Date.now() + this.#initialMs);
	}

	dispose(): void {
		if (this.#intervalId) {
			clearInterval(this.#intervalId);
			this.#intervalId = undefined;
		}
		if (this.#expireTimeoutId) {
			clearTimeout(this.#expireTimeoutId);
			this.#expireTimeoutId = undefined;
		}
	}
}
