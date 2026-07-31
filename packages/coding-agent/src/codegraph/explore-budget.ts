import { CODE_GRAPH_EXPLORE_ABSOLUTE_MAX_CHARACTERS, type CodeGraphExploreBudget } from "./runtime-types";

interface CodeGraphExploreBudgetTier {
	maxProjectFiles: number;
	maxCharacters: number;
	maxFiles: number;
	maxCharactersPerFile: number;
}

/**
 * Source budgets for one model-visible CodeGraph explore result. The final
 * tier is intentionally open-ended and every result is additionally clamped
 * to the absolute 25k ceiling exported by the public contract.
 */
export const CODE_GRAPH_EXPLORE_BUDGET_TIERS: readonly CodeGraphExploreBudgetTier[] = [
	{ maxProjectFiles: 149, maxCharacters: 13_000, maxFiles: 4, maxCharactersPerFile: 3_800 },
	{ maxProjectFiles: 499, maxCharacters: 18_000, maxFiles: 5, maxCharactersPerFile: 3_800 },
	{ maxProjectFiles: 4_999, maxCharacters: 24_000, maxFiles: 8, maxCharactersPerFile: 6_500 },
	{ maxProjectFiles: Number.POSITIVE_INFINITY, maxCharacters: 24_000, maxFiles: 8, maxCharactersPerFile: 7_000 },
];

/**
 * Select the fixed contract tier without scanning source. Exported so callers
 * and contract tests can reason about a project before opening an index.
 */
export function getCodeGraphExploreBudget(
	projectFileCount: number,
	requestedMaxFiles?: number,
): CodeGraphExploreBudget {
	const normalizedProjectFileCount = Number.isFinite(projectFileCount) ? Math.max(0, Math.floor(projectFileCount)) : 0;
	const tier =
		CODE_GRAPH_EXPLORE_BUDGET_TIERS.find(candidate => normalizedProjectFileCount <= candidate.maxProjectFiles) ??
		CODE_GRAPH_EXPLORE_BUDGET_TIERS[CODE_GRAPH_EXPLORE_BUDGET_TIERS.length - 1]!;
	const normalizedRequestedMaxFiles =
		requestedMaxFiles !== undefined && Number.isFinite(requestedMaxFiles) && requestedMaxFiles > 0
			? Math.floor(requestedMaxFiles)
			: tier.maxFiles;
	const maxCharacters = Math.min(tier.maxCharacters, CODE_GRAPH_EXPLORE_ABSOLUTE_MAX_CHARACTERS);
	const effectiveMaxFiles = Math.min(tier.maxFiles, normalizedRequestedMaxFiles);
	return {
		projectFileCount: normalizedProjectFileCount,
		maxCharacters,
		maxFiles: tier.maxFiles,
		maxCharactersPerFile: tier.maxCharactersPerFile,
		effectiveMaxFiles,
		charactersUsed: 0,
		filesUsed: 0,
		sectionsUsed: 0,
		remainingCharacters: maxCharacters,
		exhausted: false,
	};
}
