/**
 * Cross-turn thinking-loop guard.
 *
 * The in-stream {@link ThinkingLoopDetector} catches a reasoning loop *inside*
 * one streamed thinking block. A second failure shape lives across turns: the
 * model emits a short thinking block each turn, then takes an action, but the
 * *reasoning* is the same paragraph every time ("我陷入了循环，一直在用 bash
 * 占位…让我直接调用 X 工具。"). Each turn looks locally healthy — one thinking
 * block, visible text, a tool call with slightly different arguments (a
 * self-incrementing counter, a reshuffled JSON field) — so the verbatim
 * `ToolCallLoopGuard` and the `NoProgressLoopGuard` visible-text veto both miss
 * it. Observed on a real run: 69 consecutive placeholder `bash` turns with the
 * same reasoning re-emitted 8-9 times verbatim while claiming to break the loop.
 *
 * Fingerprinting is script-aware, because the failure shape was observed in
 * Chinese reasoning where word-level n-grams collapse:
 *
 * - **Latin thinking** uses word trigrams (the same `trigramShingles` the
 *   in-stream detector was calibrated on) with a high Jaccard threshold —
 *   word order carries the signal.
 * - **CJK thinking** uses character bigrams with a lower threshold — Chinese
 *   has no spaces, so "words" are 1-2 characters and a single verb swap
 *   ("写 JSON" → "输出占位符") destroys most word trigrams. Character bigrams
 *   stay robust: measured on the real loop transcript, near-duplicate turns
 *   scored 0.42-0.58 while distinct healthy turns scored ≤ 0.026 (a 16x gap).
 *
 * A turn with no meaningful thinking resets the window: genuine work changes
 * what the model reasons about, a loop does not.
 */

import type { AssistantMessage } from "../types";
import { jaccard, normalizeSegment, trigramShingles } from "./thinking-loop";

/** Normalized-length floor for a turn's thinking to be fingerprinted at all.
 *  Short thinking ("Let me check.") carries no loop signal; it breaks the
 *  streak without starting a new one. */
const TURN_MIN_NORM_CHARS = 24;
/** Near-duplicate turns in a contiguous streak that trip the guard. */
const TURN_MIN_CLUSTER_DEFAULT = 4;
/** Word-trigram Jaccard threshold for Latin (space-delimited) thinking. */
const LATIN_SIMILARITY = 0.8;
/** Character-bigram Jaccard threshold for CJK thinking. Measured separation:
 *  real near-duplicate turns 0.42-0.58, distinct healthy turns ≤ 0.026. */
const CJK_SIMILARITY = 0.35;
/** Fraction of CJK characters above which a turn is fingerprinted with
 *  character bigrams instead of word trigrams. */
const CJK_DOMINANCE = 0.3;

export interface CrossTurnThinkingLoopOptions {
	readonly threshold?: number;
}

/** Details carried by a cross-turn reasoning-loop detection. */
export interface CrossTurnThinkingLoopDetection {
	readonly kind: "repeated_reasoning";
	readonly count: number;
	readonly summary: string;
}

/** A completed assistant turn fed to the guard. */
export interface CrossTurnThinkingLoopTurn {
	readonly message: AssistantMessage;
}

interface TurnFingerprint {
	shingles: Set<string>;
	cjk: boolean;
	normalized: string;
}

function cjkRatio(normalized: string): number {
	const cjk = normalized.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
	if (cjk === 0) return 0;
	return cjk / normalized.replace(/ /g, "").length;
}

function charBigrams(normalized: string): Set<string> {
	const compact = normalized.replace(/ /g, "");
	const shingles = new Set<string>();
	for (let i = 0; i + 2 <= compact.length; i++) shingles.add(compact.slice(i, i + 2));
	return shingles;
}

function fingerprintTurn(thinking: string): TurnFingerprint | undefined {
	const normalized = normalizeSegment(thinking);
	if (normalized.length < TURN_MIN_NORM_CHARS) return undefined;
	const cjk = cjkRatio(normalized) >= CJK_DOMINANCE;
	return {
		shingles: cjk ? charBigrams(normalized) : trigramShingles(normalized),
		cjk,
		normalized,
	};
}

interface TurnFingerprint {
	shingles: Set<string>;
	cjk: boolean;
	normalized: string;
}

/**
 * Detects *consecutively* near-identical reasoning repeated across completed
 * turns. The streak grows only while each new turn's reasoning is a
 * near-duplicate of the previous turn's; any substantive different thinking
 * (or a turn with no meaningful thinking) resets it. This matters because a
 * windowed cluster count would fire on `A → real work B → A → real work C → A`
 * — genuine interleaved reasoning must not be punished.
 */
export class CrossTurnThinkingLoopGuard {
	#threshold: number;
	#streak: TurnFingerprint[] = [];

	constructor(options: CrossTurnThinkingLoopOptions = {}) {
		this.#threshold = Math.max(2, Math.trunc(options.threshold ?? TURN_MIN_CLUSTER_DEFAULT));
	}

	/** Records one completed turn and returns a detection when its reasoning
	 *  near-duplicates a contiguous run of preceding turns. */
	recordTurn(turn: CrossTurnThinkingLoopTurn): CrossTurnThinkingLoopDetection | null {
		const thinking = turn.message.content
			.filter(content => content.type === "thinking")
			.map(content => content.thinking)
			.join("\n");
		const fingerprint = fingerprintTurn(thinking);
		const previous = this.#streak.at(-1);
		if (!fingerprint || !previous || previous.cjk !== fingerprint.cjk) {
			this.#streak = fingerprint ? [fingerprint] : [];
			return null;
		}

		// Same script only: a CJK bigram set and a Latin word-trigram set are
		// incomparable shingle spaces, so a script switch breaks the streak.
		const similarity = fingerprint.cjk ? CJK_SIMILARITY : LATIN_SIMILARITY;
		if (jaccard(fingerprint.shingles, previous.shingles) >= similarity) {
			this.#streak.push(fingerprint);
		} else {
			this.#streak = [fingerprint];
			return null;
		}

		if (this.#streak.length < this.#threshold) return null;
		const count = this.#streak.length;
		this.#streak = [];
		return { kind: "repeated_reasoning", count, summary: summarize(fingerprint.normalized) };
	}
}

function summarize(normalized: string, limit = 200): string {
	const summary = normalized.replace(/\s+/g, " ").trim();
	return summary.length > limit ? `${summary.slice(0, limit)}…` : summary;
}
