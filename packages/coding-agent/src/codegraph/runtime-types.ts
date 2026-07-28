/**
 * Runtime facade public types — see ./runtime.ts for the implementations.
 *
 * Schema v2:
 *   - Identity `key` hashes `schemaVersion / sourceRoot / worktreeRoot /
 *     commonDir / ref` — `commit` is excluded so two detached worktrees on
 *     the same commit share a slot. `commit` is still carried in the
 *     identity (and in `metadata.json`) as a diagnostic aid only.
 *   - Detached worktree refs normalize to the literal `detached`.
 *   - Identity equality / verification ignore `commit`.
 */
import type { CodeGraphIndexLocation } from "./location";
import type { CodeGraphNode } from "./types";

export interface CodeGraphRuntimeOptions {
	sourceRoot: string;
	location: CodeGraphIndexLocation;
}

export type CodeGraphSyncOptions = {
	paths?: readonly string[];
};

export type CodeGraphExploreOptions = {
	maxFiles?: number;
};

export interface CodeGraphFileEntry {
	/** Source path, relative to `sourceRoot`. */
	filePath: string;
	language: string;
	nodeCount: number;
	lines?: string[];
}

export interface CodeGraphExploreEntry {
	node: CodeGraphNode;
	lines: string[];
	startLine: number;
	endLine: number;
}

export interface CodeGraphExploreResult {
	query: string;
	maxFiles: number;
	files: CodeGraphFileEntry[];
	entries: CodeGraphExploreEntry[];
	confidence?: "high" | "low";
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
 * usable index on disk (or its metadata was invalid) and the orchestrator
 * ran a full bootstrap pass. Warm callers can use it to skip the redundant
 * full-project sync that the worker is already performing in the background.
 */
export interface CodeGraphInitializeResult extends CodeGraphSyncResult {
	bootstrapped: boolean;
}

/**
 * Persistent progress state written to `<indexDir>/progress.json` by the
 * worker. The supervisor reads this file to decide whether a cold tool call
 * should return an indexing fallback or proceed. State transitions are:
 *   queued → indexing → ready | failed
 */
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
		this.name = "CodeGraphInternalError";
		this.stage = stage;
	}
}

/**
 * Options accepted by `runtime.initialize()`. The worker passes
 * `forceRebuild` when an interrupted or stale index must be rebuilt, and
 * a `progressCallback` so orchestrator progress reaches `progress.json`.
 */
export interface CodeGraphInitializeOptions {
	forceRebuild?: boolean;
	progressCallback?: (progress: CodeGraphProgress) => void;
}

export interface CodeGraphRuntime {
	initialize(options?: CodeGraphInitializeOptions): Promise<CodeGraphInitializeResult>;
	sync(options?: CodeGraphSyncOptions): Promise<CodeGraphSyncResult>;
	explore(query: string, options?: CodeGraphExploreOptions): Promise<CodeGraphExploreResult>;
	status(): Promise<CodeGraphStatus>;
	close(): void;
}
