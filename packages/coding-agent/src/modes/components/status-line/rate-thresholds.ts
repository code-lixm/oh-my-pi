import type { ThemeColor } from "../../theme/theme";

/**
 * Traffic-light grade for a throughput/latency reading, so a number reads at a
 * glance without the user having to know what "good" is for the current model.
 *
 * Ordered best → worst: `good` (green), `fair` (yellow), `poor` (red).
 */
export type MetricLevel = "good" | "fair" | "poor";

// ── Throughput (t/s): higher is better ──────────────────────────────────────
/** At or above this, generation outpaces comfortable reading speed. */
const THROUGHPUT_GOOD = 30;
/** Below {@link THROUGHPUT_GOOD} but at or above this, still usable. */
const THROUGHPUT_FAIR = 10;

// ── Time to first token (ms): lower is better ───────────────────────────────
/** Up to this, the reply feels immediate. */
const TTFT_GOOD_MS = 2_000;
/** Above {@link TTFT_GOOD_MS} but up to this, noticeable but tolerable. */
const TTFT_FAIR_MS = 5_000;

/**
 * Grade generation speed. A reading at or above {@link THROUGHPUT_GOOD} is
 * green, {@link THROUGHPUT_FAIR}..{@link THROUGHPUT_GOOD} yellow, below that red.
 */
export function getThroughputLevel(tokensPerSecond: number): MetricLevel {
	if (!Number.isFinite(tokensPerSecond)) return "poor";
	if (tokensPerSecond >= THROUGHPUT_GOOD) return "good";
	if (tokensPerSecond >= THROUGHPUT_FAIR) return "fair";
	return "poor";
}

/**
 * Grade first-token latency. Up to {@link TTFT_GOOD_MS} is green,
 * {@link TTFT_GOOD_MS}..{@link TTFT_FAIR_MS} yellow, above that red.
 */
export function getTtftLevel(ttftMs: number): MetricLevel {
	if (!Number.isFinite(ttftMs)) return "poor";
	if (ttftMs <= TTFT_GOOD_MS) return "good";
	if (ttftMs <= TTFT_FAIR_MS) return "fair";
	return "poor";
}

/** Map a grade onto the theme's semantic colors (green / yellow / red). */
export function getMetricThemeColor(level: MetricLevel): ThemeColor {
	switch (level) {
		case "good":
			return "success";
		case "fair":
			return "warning";
		case "poor":
			return "error";
	}
}
