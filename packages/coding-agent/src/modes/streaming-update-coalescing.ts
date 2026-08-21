const MIN_COALESCE_MS = 33;
const MAX_COALESCE_MS = 250;
const SLOW_COMPOSE_MS = 50;
const FAST_COMPOSE_MS = 30;
const SLOW_SAMPLES_TO_STEP = 2;
const FAST_SAMPLES_TO_RECOVER = 8;
const RECOVERY_COOLDOWN_SAMPLES = 8;
const SLOW_STEP_MS = 25;
const FAST_STEP_MS = 10;

/**
 * Bounded, hysteretic delay controller for cumulative streaming updates.
 *
 * Only completed compose samples should be fed to this controller. Slow samples
 * increase the delay gradually; recovery requires a quiet period and several
 * fast samples so render latency cannot make the window oscillate.
 */
export class AdaptiveStreamingUpdateWindow {
	#delayMs = MIN_COALESCE_MS;
	#slowSamples = 0;
	#fastSamples = 0;
	#recoveryCooldown = 0;

	get delayMs(): number {
		return this.#delayMs;
	}

	observeComposeMs(composeMs: number): void {
		if (!Number.isFinite(composeMs) || composeMs < 0) return;

		if (composeMs >= SLOW_COMPOSE_MS) {
			this.#slowSamples++;
			this.#fastSamples = 0;
			if (this.#slowSamples >= SLOW_SAMPLES_TO_STEP) {
				this.#delayMs = Math.min(MAX_COALESCE_MS, this.#delayMs + SLOW_STEP_MS);
				this.#slowSamples = 0;
				this.#recoveryCooldown = RECOVERY_COOLDOWN_SAMPLES;
			}
			return;
		}

		this.#slowSamples = 0;
		if (composeMs > FAST_COMPOSE_MS) {
			this.#fastSamples = 0;
			if (this.#recoveryCooldown > 0) this.#recoveryCooldown--;
			return;
		}

		if (this.#recoveryCooldown > 0) {
			this.#recoveryCooldown--;
			this.#fastSamples = 0;
			return;
		}

		this.#fastSamples++;
		if (this.#fastSamples >= FAST_SAMPLES_TO_RECOVER) {
			this.#delayMs = Math.max(MIN_COALESCE_MS, this.#delayMs - FAST_STEP_MS);
			this.#fastSamples = 0;
		}
	}
}

export const STREAMING_UPDATE_COALESCE_MIN_MS = MIN_COALESCE_MS;
export const STREAMING_UPDATE_COALESCE_MAX_MS = MAX_COALESCE_MS;
