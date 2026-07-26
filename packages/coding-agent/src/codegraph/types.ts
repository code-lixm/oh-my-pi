/**
 * CodeGraph semantic graph types.
 *
 * Adapted from upstream `src/types.ts`
 * (MIT, Copyright (c) 2026 Colby Mchenry — see ./UPSTREAM_LICENSE).
 *
 * The NODE_KINDS / EDGE_KINDS / LANGUAGES arrays keep the upstream order
 * verbatim because the optional native kernel reads them as wire indexes
 * (see upstream `src/extraction/kernel/layout.ts`). Append new kinds,
 * never reorder.
 *
 * OMP contract: `Node.filePath` and `FileRecord.path` remain
 * sourceRoot-relative. The runtime never stores or returns an absolute
 * source path; absolute paths only appear as canonical inputs on
 * `FileMutationEvent.path` (see shared `local://codegraph-contract.md`).
 */
export const NODE_KINDS = [
	"file",
	"module",
	"class",
	"struct",
	"interface",
	"trait",
	"protocol",
	"function",
	"method",
	"property",
	"field",
	"variable",
	"constant",
	"enum",
	"enum_member",
	"type_alias",
	"namespace",
	"parameter",
	"import",
	"export",
	"route",
	"component",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
	"contains",
	"calls",
	"imports",
	"exports",
	"extends",
	"implements",
	"references",
	"type_of",
	"returns",
	"instantiates",
	"overrides",
	"decorates",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const LANGUAGES = [
	"typescript",
	"javascript",
	"tsx",
	"jsx",
	"arkts",
	"python",
	"go",
	"rust",
	"java",
	"c",
	"cpp",
	"csharp",
	"razor",
	"php",
	"ruby",
	"swift",
	"kotlin",
	"dart",
	"svelte",
	"vue",
	"astro",
	"liquid",
	"pascal",
	"scala",
	"lua",
	"luau",
	"objc",
	"r",
	"solidity",
	"nix",
	"yaml",
	"twig",
	"xml",
	"properties",
	"cfml",
	"cfscript",
	"cfquery",
	"cobol",
	"vbnet",
	"erlang",
	"terraform",
	"unknown",
] as const;
export type Language = (typeof LANGUAGES)[number];

/**
 * A node in the knowledge graph representing a code symbol.
 */
export interface CodeGraphNode {
	/** Unique identifier (hash of file path + qualified name). */
	id: string;
	kind: NodeKind;
	name: string;
	qualifiedName: string;
	/** Source path, relative to `sourceRoot`. */
	filePath: string;
	language: Language;
	startLine: number;
	endLine: number;
	startColumn: number;
	endColumn: number;
	docstring?: string;
	signature?: string;
	visibility?: "public" | "private" | "protected" | "internal";
	isExported?: boolean;
	isAsync?: boolean;
	isStatic?: boolean;
	isAbstract?: boolean;
	decorators?: string[];
	typeParameters?: string[];
	returnType?: string;
	updatedAt: number;
}

/**
 * An edge representing a relationship between two nodes.
 */
export interface CodeGraphEdge {
	source: string;
	target: string;
	kind: EdgeKind;
	metadata?: Record<string, unknown>;
	line?: number;
	column?: number;
	provenance?: "tree-sitter" | "scip" | "heuristic";
}

/**
 * Metadata about a tracked file. `path` is sourceRoot-relative.
 */
export interface CodeGraphFileRecord {
	path: string;
	contentHash: string;
	language: Language;
	size: number;
	modifiedAt: number;
	indexedAt: number;
	nodeCount: number;
	errors?: CodeGraphExtractionError[];
}

/**
 * Error during extraction.
 */
export interface CodeGraphExtractionError {
	message: string;
	filePath?: string;
	line?: number;
	column?: number;
	severity: "error" | "warning";
	code?: string;
}

/**
 * Kinds an unresolved reference can carry. `function_ref` is internal-only
 * (function name used as a VALUE — see upstream resolution/matchFunctionRef).
 */
export type CodeGraphReferenceKind = EdgeKind | "function_ref";
export type ReferenceKind = CodeGraphReferenceKind;

export interface CodeGraphUnresolvedReference {
	fromNodeId: string;
	referenceName: string;
	referenceKind: CodeGraphReferenceKind;
	line: number;
	column: number;
	filePath?: string;
	language?: Language;
	candidates?: string[];
	rowId?: number;
}

export interface CodeGraphSubgraph {
	nodes: Map<string, CodeGraphNode>;
	edges: CodeGraphEdge[];
	roots: string[];
	confidence?: "high" | "low";
}

export interface CodeGraphTraversalOptions {
	maxDepth?: number;
	edgeKinds?: EdgeKind[];
	nodeKinds?: NodeKind[];
	direction?: "outgoing" | "incoming" | "both";
	limit?: number;
	includeStart?: boolean;
}

export interface CodeGraphSearchOptions {
	kinds?: NodeKind[];
	languages?: Language[];
	includePatterns?: string[];
	excludePatterns?: string[];
	limit?: number;
	offset?: number;
	caseSensitive?: boolean;
}

export interface CodeGraphSearchResult {
	node: CodeGraphNode;
	/** Relative ranking only — higher means more relevant. Not 0-1. */
	score: number;
	highlights?: string[];
}

export interface CodeGraphSegmentMatch {
	name: string;
	kind: NodeKind;
	filePath: string;
	startLine: number;
	matchedWords: string[];
}

export interface CodeGraphGraphContext {
	focal: CodeGraphNode;
	ancestors: CodeGraphNode[];
	children: CodeGraphNode[];
	incomingRefs: Array<{ node: CodeGraphNode; edge: CodeGraphEdge }>;
	outgoingRefs: Array<{ node: CodeGraphNode; edge: CodeGraphEdge }>;
	types: CodeGraphNode[];
	imports: CodeGraphNode[];
}

export interface CodeGraphCodeBlock {
	content: string;
	filePath: string;
	startLine: number;
	endLine: number;
	language: Language;
	node?: CodeGraphNode;
}

export interface CodeGraphGraphStats {
	nodeCount: number;
	edgeCount: number;
	fileCount: number;
	nodesByKind: Record<NodeKind, number>;
	edgesByKind: Record<EdgeKind, number>;
	filesByLanguage: Record<Language, number>;
	dbSizeBytes: number;
	lastUpdated: number;
}

export interface CodeGraphTaskInput {
	title?: string;
	description?: string;
}

export type CodeGraphTaskInputAlt = string | CodeGraphTaskInput;

export interface CodeGraphBuildContextOptions {
	maxNodes?: number;
	maxCodeBlocks?: number;
	maxCodeBlockSize?: number;
	includeCode?: boolean;
	format?: "markdown" | "json";
	searchLimit?: number;
	traversalDepth?: number;
	minScore?: number;
}

export interface CodeGraphTaskContext {
	query: string;
	subgraph: CodeGraphSubgraph;
	entryPoints: CodeGraphNode[];
	codeBlocks: CodeGraphCodeBlock[];
	relatedFiles: string[];
	summary: string;
	stats: {
		nodeCount: number;
		edgeCount: number;
		fileCount: number;
		codeBlockCount: number;
		totalCodeSize: number;
	};
}

export interface CodeGraphFindRelevantContextOptions {
	searchLimit?: number;
	traversalDepth?: number;
	maxNodes?: number;
	minScore?: number;
	edgeKinds?: EdgeKind[];
	nodeKinds?: NodeKind[];
}

export interface CodeGraphSchemaVersion {
	version: number;
	appliedAt: number;
	description?: string;
}
