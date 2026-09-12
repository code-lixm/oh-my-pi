/**
 * Notification earcons — the short chimes the CLI plays for pending input,
 * turn completion, failure, and a queued subagent starting.
 *
 * Prompt sounds must never contain speech, and shipping audio assets would
 * also have to survive `bun build --compile`, so every earcon is rendered from
 * an additive-synthesis recipe the first time it is played. A music-box voice
 * (inharmonic upper partials with per-partial decay) reads as bright and
 * playful without depending on any sample library.
 */

/** Logical sample rate every earcon is rendered at. */
export const EARCON_SAMPLE_RATE = 44_100;

export type EarconKind = "ask" | "completion" | "error" | "queued";

/** Equal-tempered pitches the earcon recipes are built from. */
const PITCH_HZ = {
	C6: 1046.5,
	E6: 1318.51,
	G6: 1567.98,
	A6: 1760,
	C7: 2093,
	A5: 880,
	F5: 698.46,
} as const;

interface EarconVoice {
	/** Frequency ratios relative to the note fundamental. */
	partials: readonly number[];
	/** Amplitude of each partial. */
	amps: readonly number[];
	/** Per-partial decay multiplier; upper partials must die first. */
	decays: readonly number[];
	/** Decay rate of the fundamental, in 1/s. */
	base: number;
}

/** Bright celesta/music-box timbre: the inharmonic upper partials read as sparkle. */
const MUSIC_BOX: EarconVoice = {
	partials: [1, 2, 3.01, 4.16, 5.43],
	amps: [1, 0.42, 0.22, 0.1, 0.05],
	decays: [1, 1.7, 2.4, 3.2, 4.1],
	base: 6.2,
};

/** Rounder body for the failure tone: no high partials, so it cannot sound harsh. */
const SOFT: EarconVoice = {
	partials: [1, 2, 3.01],
	amps: [1, 0.3, 0.1],
	decays: [1, 1.8, 2.6],
	base: 5.4,
};

interface EarconNote {
	freq: number;
	/** Offset from the start of the earcon, in seconds. */
	at: number;
	/** Note length in seconds; the tail is where the decay is heard. */
	dur: number;
	gain: number;
	voice: EarconVoice;
}

interface EarconRecipe {
	notes: readonly EarconNote[];
	/** Total earcon length in seconds. */
	duration: number;
}

const RECIPES: Record<EarconKind, EarconRecipe> = {
	// Pending input: one short, soft, repeatable "ting". Tolerable when replayed
	// every couple of seconds until the user picks something.
	ask: {
		notes: [{ freq: PITCH_HZ.C7, at: 0, dur: 0.3, gain: 0.9, voice: MUSIC_BOX }],
		duration: 0.32,
	},
	// Success: a rising C6-E6-G6 arpeggio that resolves upward.
	completion: {
		notes: [
			{ freq: PITCH_HZ.C6, at: 0, dur: 0.34, gain: 0.72, voice: MUSIC_BOX },
			{ freq: PITCH_HZ.E6, at: 0.065, dur: 0.34, gain: 0.78, voice: MUSIC_BOX },
			{ freq: PITCH_HZ.G6, at: 0.13, dur: 0.9, gain: 0.95, voice: MUSIC_BOX },
		],
		duration: 1,
	},
	// Failure: a descending A5-F5 with a rounder body — clear, never harsh.
	error: {
		notes: [
			{ freq: PITCH_HZ.A5, at: 0, dur: 0.42, gain: 0.85, voice: SOFT },
			{ freq: PITCH_HZ.F5, at: 0.1, dur: 0.95, gain: 0.9, voice: SOFT },
		],
		duration: 1,
	},
	// A queued subagent starts running: a fast, light two-note lift.
	queued: {
		notes: [
			{ freq: PITCH_HZ.E6, at: 0, dur: 0.3, gain: 0.8, voice: MUSIC_BOX },
			{ freq: PITCH_HZ.A6, at: 0.055, dur: 0.42, gain: 0.9, voice: MUSIC_BOX },
		],
		duration: 0.5,
	},
};

/** Peak normalization target, ~2.5 dB below full scale. */
const NORMALIZE_TO = 0.75;
/** Attack ramp; long enough to avoid a click, short enough to stay percussive. */
const ATTACK_SECONDS = 0.004;
/** Release ramp so a note always lands exactly on zero. */
const RELEASE_SECONDS = 0.012;
/** Vibrato keeps the tone alive instead of sounding like a dead test beep. */
const VIBRATO_HZ = 5.5;
const VIBRATO_DEPTH = 0.0022;

function renderNote(buffer: Float32Array, note: EarconNote): void {
	const start = Math.round(note.at * EARCON_SAMPLE_RATE);
	const length = Math.round(note.dur * EARCON_SAMPLE_RATE);
	const { partials, amps, decays, base } = note.voice;
	for (let i = 0; i < length; i += 1) {
		const index = start + i;
		if (index >= buffer.length) break;
		const t = i / EARCON_SAMPLE_RATE;
		let sample = 0;
		for (let k = 0; k < partials.length; k += 1) {
			const vibrato = k === 0 ? 1 + VIBRATO_DEPTH * Math.sin(2 * Math.PI * VIBRATO_HZ * t) : 1;
			const freq = note.freq * partials[k]! * vibrato;
			sample += amps[k]! * Math.sin(2 * Math.PI * freq * t) * Math.exp(-base * decays[k]! * t);
		}
		const envelope = Math.min(1, t / ATTACK_SECONDS) * Math.min(1, (note.dur - t) / RELEASE_SECONDS);
		buffer[index] += sample * envelope * note.gain;
	}
}

function renderRecipe(recipe: EarconRecipe): Float32Array {
	const buffer = new Float32Array(Math.ceil(recipe.duration * EARCON_SAMPLE_RATE));
	for (const note of recipe.notes) renderNote(buffer, note);
	let peak = 0;
	for (const sample of buffer) peak = Math.max(peak, Math.abs(sample));
	if (peak > 0) {
		const scale = NORMALIZE_TO / peak;
		// Soft-limit after scaling so a dense chord can never clip.
		const norm = Math.tanh(1.06);
		for (let i = 0; i < buffer.length; i += 1) buffer[i] = Math.tanh(buffer[i]! * scale * 1.06) / norm;
	}
	return buffer;
}

const CACHE: Partial<Record<EarconKind, Float32Array>> = {};

/** Mono PCM at {@link EARCON_SAMPLE_RATE} for `kind`, rendered once and cached. */
export function renderEarcon(kind: EarconKind): Float32Array {
	const cached = CACHE[kind];
	if (cached) return cached;
	const rendered = renderRecipe(RECIPES[kind]);
	CACHE[kind] = rendered;
	return rendered;
}
