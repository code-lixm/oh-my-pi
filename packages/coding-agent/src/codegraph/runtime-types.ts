/**
 * Runtime facade public types — see ./runtime.ts for the implementations.
 *
 * Explore results are intentionally data-only.  The tool layer may replace
 * source text with a current hashline snapshot, while graph relationships and
 * coverage remain stable metadata from this runtime.
 */
import type { CodeGraphIndexLocation } from "./location";
import type { CodeGraphEdge, CodeGraphNode, EdgeKind, Language, NodeKind } from "./types";

export interface CodeGraphRuntimeOptions {
	sourceRoot: string;
	location: CodeGraphIndexLocation;
}

export type CodeGraphSyncOptions = {
	paths?: readonly string[];
};

export const CODE_GRAPH_EXPLORE_MODES = ["auto", "locate", "understand", "flow", "impact", "edit"] as const;
export type CodeGraphExploreMode = (typeof CODE_GRAPH_EXPLORE_MODES)[number];
export type CodeGraphResolvedExploreMode = Exclude<CodeGraphExploreMode, "auto">;

export type CodeGraphExploreOptions = {
	maxFiles?: number;
	mode?: CodeGraphExploreMode;
};

export type CodeGraphSourceCompleteness = "complete" | "partial" | "omitted";

export type CodeGraphSourceSectionRole =
	| "target"
	| "relationship"
	| "flow-spine"
	| "container-outline"
	| "call-site"
	| "test";

export type CodeGraphCoverageReason =
	| "budget"
	| "per-file-budget"
	| "file-limit"
	| "source-unavailable"
	| "mode"
	| "not-indexed"
	| "stale";

export interface CodeGraphSourceSymbol {
	id: string;
	name: string;
	qualifiedName: string;
	kind: NodeKind;
}

/** A selected source range. `lineNumbers` preserves gaps in outline/windows. */
export interface CodeGraphSourceSection {
	id: string;
	/** Source path, relative to `sourceRoot`. */
	path: string;
	/** Alias retained for consumers that use the graph's file terminology. */
	filePath: string;
	language: Language | string;
	startLine: number;
	endLine: number;
	lineNumbers: number[];
	/** Raw current-disk lines; no downstream truncation is applied. */
	lines: string[];
	/** Raw current-disk text corresponding to `lines`. */
	text: string;
	role: CodeGraphSourceSectionRole;
	completeness: CodeGraphSourceCompleteness;
	symbol?: CodeGraphSourceSymbol;
	reason?: CodeGraphCoverageReason;
}

export interface CodeGraphFileEntry {
	/** Source path, relative to `sourceRoot`. */
	filePath: string;
	language: string;
	nodeCount: number;
	/** Optional legacy file preview; explore sections are the bounded source API. */
	lines?: string[];
}

export interface CodeGraphExploreEntry {
	node: CodeGraphNode;
	/** Bounded source body selected for this entry. */
	lines: string[];
	startLine: number;
	endLine: number;
	text?: string;
	lineNumbers?: number[];
	sourceSectionId?: string;
	completeness?: CodeGraphSourceCompleteness;
	reason?: CodeGraphCoverageReason;
}

export interface CodeGraphFlowHop {
	from: string;
	to: string;
	edgeKind: EdgeKind;
	provenance?: "tree-sitter" | "scip" | "heuristic";
	resolvedBy?: string;
	confidence: number;
	sourceSectionId?: string;
}

export interface CodeGraphFlowChain {
	/** Resolved endpoint nodes for renderers that need names without lookups. */
	start: CodeGraphNode;
	end: CodeGraphNode;
	hops: CodeGraphFlowHop[];
	/** IDs of selected source sections that form this path's source spine. */
	sourceSectionIds: string[];
}

export interface CodeGraphBlastRadiusEntry {
	node: CodeGraphNode;
	via: CodeGraphEdge;
	depth: number;
	sourceSectionId?: string;
}

export interface CodeGraphBlastRadius {
	focal: CodeGraphNode;
	entries: CodeGraphBlastRadiusEntry[];
	sourceSectionIds: string[];
}

export interface CodeGraphRelevantNode {
	node: CodeGraphNode;
	score: number;
	matchedTerms: string[];
}

export interface CodeGraphCoverageItem {
	path: string;
	startLine?: number;
	endLine?: number;
	symbolId?: string;
	role: CodeGraphSourceSectionRole;
	reason?: CodeGraphCoverageReason;
}

export interface CodeGraphExploreCoverage {
	complete: CodeGraphCoverageItem[];
	partial: CodeGraphCoverageItem[];
	omitted: CodeGraphCoverageItem[];
}

export interface CodeGraphExploreBudget {
	/** Number of source files in the selected project's index. */
	projectFileCount: number;
	/** Contract tier ceiling for source characters (never above 25,000). */
	maxCharacters: number;
	/** Contract tier ceiling for source files. */
	maxFiles: number;
	/** Contract tier ceiling for one file's source characters. */
	maxCharactersPerFile: number;
	/** `min(maxFiles, requestedMaxFiles)` when a caller supplied a cap. */
	effectiveMaxFiles: number;
	charactersUsed: number;
	filesUsed: number;
	sectionsUsed: number;
	remainingCharacters: number;
	exhausted: boolean;
}

export type CodeGraphFreshnessState = "fresh" | "partial-stale";
export type CodeGraphFreshnessFileState = "fresh" | "stale" | "missing" | "unindexed" | "unreadable";

export interface CodeGraphFreshnessFile {
	path: string;
	state: CodeGraphFreshnessFileState;
	indexedHash?: string;
	diskHash?: string;
}

export interface CodeGraphExploreFreshness {
	state: CodeGraphFreshnessState;
	checkedAt: number;
	/** Candidate paths inspected before a possible scoped resync. */
	candidatePaths: string[];
	stalePaths: string[];
	files: CodeGraphFreshnessFile[];
	sync: {
		state: "not-required" | "required";
		paths: string[];
	};
}

export const CODE_GRAPH_EXPLORE_ABSOLUTE_MAX_CHARACTERS = 25_000;

export interface CodeGraphExploreResult {
	query: string;
	maxFiles: number;
	files: CodeGraphFileEntry[];
	entries: CodeGraphExploreEntry[];
	confidence?: "high" | "low";
	/** Explicit caller mode (`auto` when omitted). */
	requestedMode: CodeGraphExploreMode;
	/** Model-free resolved mode used for section prioritization. */
	mode: CodeGraphResolvedExploreMode;
	sourceSections: CodeGraphSourceSection[];
	entryCount: number;
	edges: CodeGraphEdge[];
	flow: CodeGraphFlowChain[];
	blastRadius: CodeGraphBlastRadius | null;
	relevance: CodeGraphRelevantNode[];
	testCandidates: CodeGraphNode[];
	coverage: CodeGraphExploreCoverage;
	freshness: CodeGraphExploreFreshness;
	budget: CodeGraphExploreBudget;
}

export interface CodeGraphSyncResult {
	filesChecked: number;
	filesIndexed: number;
	filesUpdated: number;
	filesRemoved: number;
	durationMs: number;
}

/**
 * `initialize()` outcome — `bootstrapped` is `true` when the slot had no
 * usable index on disk (or its metadata was invalid) and the orchestrator ran
 * a full bootstrap pass.
 */
export interface CodeGraphInitializeResult extends CodeGraphSyncResult {
	bootstrapped: boolean;
}

export type CodeGraphIndexState = "queued" | "indexing" | "ready" | "failed";

export interface CodeGraphProgress {
	state: CodeGraphIndexState;
	phase: string;
	current: number;
	total: number;
	updatedAt: string;
	workerId: string;
	attempt: number;
	error?: string;
	forceRebuild?: boolean;
}

export interface CodeGraphStatus {
	initialized: boolean;
	sourceRoot: string;
	indexDir: string;
	dbPath: string;
	dbSizeBytes: number;
	nodeCount: number;
	edgeCount: number;
	fileCount: number;
	lastSyncedAt: number | null;
	lastUsedAt: number;
	nativeAvailable: boolean;
	progress?: CodeGraphProgress;
	reason?: string;
}

export class CodeGraphInternalError extends Error {
	readonly stage: string;
	constructor(stage: string, message?: string) {
		super(message ?? `CodeGraph stage failed: ${stage}`);
		this.stage = stage;
		this.name = "CodeGraphInternalError";
	}
}

export interface CodeGraphInitializeOptions {
	forceRebuild?: boolean;
	progressCallback?: (progress: CodeGraphProgress) => void;
}

export interface CodeGraphRuntime {
	initialize(options?: CodeGraphInitializeOptions): Promise<CodeGraphInitializeResult>;
	sync(options?: CodeGraphSyncOptions): Promise<CodeGraphSyncResult>;
	explore(query: string, options?: CodeGraphExploreOptions): Promise<CodeGraphExploreResult>;
	inspectFreshness(paths?: readonly string[]): Promise<CodeGraphExploreFreshness>;
	status(): Promise<CodeGraphStatus>;
	close(): void;
}
