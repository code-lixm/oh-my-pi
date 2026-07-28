import {
	type CodeGraphIndexLocation,
	type CodeGraphIndexPruneResult,
	DEFAULT_CODEGRAPH_AUTO_PRUNE_POLICY,
	pruneCodeGraphIndexes,
} from "./location";

export interface AutoPruneOptions {
	olderThanDays?: number;
	maxProjectIndexes?: number;
	maxProjectBytes?: number;
	maxTotalBytes?: number;
	deleteOrphans?: boolean;
	protectedKeys?: readonly string[];
}

/** Apply the bounded global CodeGraph cache policy in the background worker. */
export function runAutoPrune(
	current: CodeGraphIndexLocation,
	options: AutoPruneOptions = {},
): Promise<CodeGraphIndexPruneResult> {
	return pruneCodeGraphIndexes({
		ttlDays: options.olderThanDays ?? DEFAULT_CODEGRAPH_AUTO_PRUNE_POLICY.ttlDays,
		maxProjectIndexes: options.maxProjectIndexes ?? DEFAULT_CODEGRAPH_AUTO_PRUNE_POLICY.maxProjectIndexes,
		maxProjectBytes: options.maxProjectBytes ?? DEFAULT_CODEGRAPH_AUTO_PRUNE_POLICY.maxProjectBytes,
		maxTotalBytes: options.maxTotalBytes ?? DEFAULT_CODEGRAPH_AUTO_PRUNE_POLICY.maxTotalBytes,
		deleteOrphans: options.deleteOrphans ?? DEFAULT_CODEGRAPH_AUTO_PRUNE_POLICY.deleteOrphans,
		protectedKeys: options.protectedKeys ?? [current.identity.key],
	});
}
