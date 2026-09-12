/**
 * Playback side of the notification earcons in `./earcons`.
 *
 * Every chime goes through the native speaker binding used by speech
 * vocalization, so no external player, asset file, or per-platform branch is
 * involved. Playback is fire-and-forget: a chime must never delay a turn, and
 * a host without an output device stays silent instead of failing.
 */

import { AudioPlayback } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import type { SettingPath } from "../config/settings-schema";
import { EARCON_SAMPLE_RATE, type EarconKind, renderEarcon } from "./earcons";

/**
 * Minimal speaker session the chimes need. The native {@link AudioPlayback}
 * satisfies it; tests substitute a silent recorder so asserting playback
 * never opens the real device.
 */
export interface EarconOutput {
	write(samples: Float32Array): void;
	end(): Promise<void>;
	stop(): void;
}

/** Chime cadence while a prompt waits for the user. */
export const PENDING_CHIME_INTERVAL_MS = 2_000;

const SETTING_BY_KIND: Record<EarconKind, SettingPath> = {
	ask: "sound.ask",
	completion: "sound.completion",
	error: "sound.error",
	queued: "sound.queued",
};

/**
 * Minimum gap between two chimes of the same kind. A burst of subagents
 * leaving the runnable queue at once would otherwise chain identical chimes
 * into one long beep; one "a queued task started" signal is enough.
 */
const COOLDOWN_MS: Record<EarconKind, number> = {
	ask: 0,
	completion: 0,
	error: 0,
	queued: 1_000,
};

/** Opens one speaker session at the earcon sample rate. */
export type EarconOutputFactory = (sampleRate: number) => EarconOutput;

export class SoundService {
	readonly #openOutput: EarconOutputFactory;
	/** Serializes playback so two chimes can never fight over the device. */
	#tail: Promise<void> = Promise.resolve();
	#lastPlayedAt: Partial<Record<EarconKind, number>> = {};
	#repeats: Partial<Record<EarconKind, () => void>> = {};

	constructor(openOutput: EarconOutputFactory) {
		this.#openOutput = openOutput;
	}

	/** Whether `kind` is allowed to make noise right now. */
	enabled(kind: EarconKind): boolean {
		return settings.get("sound.enabled") && settings.get(SETTING_BY_KIND[kind]) !== "off";
	}

	/** Queue one chime. Never blocks, never throws. */
	play(kind: EarconKind): void {
		if (!this.enabled(kind)) return;
		const now = Date.now();
		if (now - (this.#lastPlayedAt[kind] ?? 0) < COOLDOWN_MS[kind]) return;
		this.#lastPlayedAt[kind] = now;
		const pcm = renderEarcon(kind);
		this.#tail = this.#tail
			.then(() => this.#write(pcm))
			.catch(error => logger.debug("Earcon playback failed", { kind, error }));
	}

	async #write(pcm: Float32Array): Promise<void> {
		let player: EarconOutput;
		try {
			player = this.#openOutput(EARCON_SAMPLE_RATE);
		} catch (error) {
			// No output device (headless or muted host): stay silent.
			logger.debug("Earcon output device unavailable", { error });
			return;
		}
		try {
			player.write(pcm);
		} catch (error) {
			player.stop();
			throw error;
		}
		await player.end();
	}

	/**
	 * Chime now, then every `intervalMs`, until the returned function runs.
	 * Starting a repeat for a kind that already repeats replaces the old loop.
	 */
	startRepeat(kind: EarconKind, intervalMs = PENDING_CHIME_INTERVAL_MS): () => void {
		this.stopRepeat(kind);
		if (!this.enabled(kind)) return () => {};
		const timer = setInterval(() => {
			// Settings can be toggled mid-prompt; stop instead of chining on.
			if (!this.enabled(kind)) {
				stop();
				return;
			}
			this.play(kind);
		}, intervalMs);
		timer.unref?.();
		const stop = (): void => {
			clearInterval(timer);
			if (this.#repeats[kind] === stop) delete this.#repeats[kind];
		};
		this.#repeats[kind] = stop;
		this.play(kind);
		return stop;
	}

	stopRepeat(kind: EarconKind): void {
		this.#repeats[kind]?.();
	}

	stopAll(): void {
		for (const stop of Object.values(this.#repeats)) stop?.();
	}
}

export const sounds = new SoundService(sampleRate => new AudioPlayback(sampleRate));
