/**
 * Tree-sitter extraction types — ported from upstream
 * `codegraph/src/extraction/tree-sitter-types.ts` (MIT, Copyright (c)
 * 2026 Colby Mchenry — see ./ATTRIBUTION.md and ../UPSTREAM_LICENSE).
 *
 * Defines the `LanguageExtractor` interface each per-language config
 * fills in. The OMP extractor honours only the surface it actually
 * consumes (the rest is reserved so future ports stay drop-in). When
 * adding a language pack, start here and copy the fields you need from
 * upstream's `tree-sitter-types.ts` — the source of truth.
 */
import type { Node as SyntaxNode } from "web-tree-sitter";

import type { NodeKind } from "../types";

/** Result of a language's `extractImport` hook. */
export interface ImportInfo {
	/** Module/package specifier as written in source. */
	moduleName: string;
	/** Whole import statement text (for display + dedup). */
	signature: string;
	/** `true` when the hook already pushed unresolved refs onto the extractor. */
	handledRefs?: boolean;
}

/** A single variable declarator from a multi-declarator statement. */
export interface VariableInfo {
	name: string;
	kind: NodeKind;
	signature?: string;
	/** Set when this declarator is actually a function and should be promoted. */
	delegateToFunction?: SyntaxNode;
	/** Optional AST node to use for position; defaults to the declaration node. */
	positionNode?: SyntaxNode;
}

/**
 * Per-language configuration object. Each supported language provides one.
 * Only a subset of fields is consumed by the OMP extractor — the rest is
 * reserved so additional ports land without interface churn.
 */
export interface LanguageExtractor {
	// --- Node-type mappings ---
	functionTypes: string[];
	classTypes: string[];
	methodTypes: string[];
	interfaceTypes: string[];
	structTypes: string[];
	enumTypes: string[];
	typeAliasTypes: string[];
	importTypes: string[];
	callTypes: string[];
	variableTypes: string[];
	fieldTypes?: string[];
	propertyTypes?: string[];

	// --- Field mappings ---
	nameField: string;
	bodyField: string;
	paramsField: string;
	returnField?: string;

	// --- Hooks ---
	preParse?: (source: string, filePath?: string) => string;
	resolveName?: (node: SyntaxNode, source: string) => string | undefined;
	getSignature?: (node: SyntaxNode, source: string) => string | undefined;
	getVisibility?: (node: SyntaxNode, source: string) => "public" | "private" | "protected" | "internal" | undefined;
	isExported?: (node: SyntaxNode, source: string) => boolean;
	isAsync?: (node: SyntaxNode, source: string) => boolean;
	isStatic?: (node: SyntaxNode, source: string) => boolean;
	isConst?: (node: SyntaxNode) => boolean;
	resolveBody?: (node: SyntaxNode, bodyField: string) => SyntaxNode | null;
	extractImport?: (node: SyntaxNode, source: string) => ImportInfo | null;
	extractVariables?: (node: SyntaxNode, source: string) => VariableInfo[];
	classifyMethodNode?: (node: SyntaxNode) => "method" | "property";
	enumMemberTypes?: string[];
	interfaceKind?: NodeKind;
	classifyClassNode?: (node: SyntaxNode) => "class" | "struct" | "enum" | "interface" | "trait";
	packageTypes?: string[];
	extractPackage?: (node: SyntaxNode, source: string) => string | null;
	extraClassNodeTypes?: string[];
}
