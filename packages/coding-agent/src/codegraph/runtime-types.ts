/**
 * Runtime facade public types — see ./runtime.ts for the implementations.
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

export interface CodeGraphRuntime {
	initialize(): Promise<void>;
	sync(options?: CodeGraphSyncOptions): Promise<CodeGraphSyncResult>;
	explore(query: string, options?: CodeGraphExploreOptions): Promise<CodeGraphExploreResult>;
	status(): Promise<CodeGraphStatus>;
	close(): void;
}
