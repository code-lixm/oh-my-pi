/**
 * Pure policy for asynchronous compaction speculation. Kept independent from
 * session state so every maintenance boundary uses the same lead and grace
 * envelope.
 */

const SPECULATION_LEAD_FRACTION = 0.125;
/** Floor of the speculation band; also the armed-summary refresh budget floor. */
export const SPECULATION_LEAD_MIN_TOKENS = 8_192;
const SPECULATION_LEAD_MAX_TOKENS = 32_000;

/** Tokens the pre-threshold band spans: `[threshold - lead, threshold)`. */
export function resolveSpeculationLeadTokens(thresholdTokens: number): number {
	return Math.min(
		SPECULATION_LEAD_MAX_TOKENS,
		Math.max(SPECULATION_LEAD_MIN_TOKENS, Math.floor(thresholdTokens * SPECULATION_LEAD_FRACTION)),
	);
}

/**
 * Upper bound for delaying a blocking threshold pass while its background
 * summary is still running. Always leaves the minimum lead below the model
 * window, so the grace path cannot consume the entire remaining context.
 */
export function resolveSpeculationGraceCapTokens(thresholdTokens: number, contextWindow: number): number {
	return Math.min(
		thresholdTokens + resolveSpeculationLeadTokens(thresholdTokens),
		contextWindow - SPECULATION_LEAD_MIN_TOKENS,
	);
}
