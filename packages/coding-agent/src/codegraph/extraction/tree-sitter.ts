/**
 * Tree-sitter extraction engine — ported from upstream
 * `codegraph/src/extraction/tree-sitter.ts` (MIT, Copyright (c)
 * 2026 Colby Mchenry — see ./ATTRIBUTION.md and ../UPSTREAM_LICENSE).
 *
 * The OMP port keeps the dispatch shape (`TreeSitterExtractor` instance
 * per file + `extractFromSource(filePath, source, language?)` entry) so
 * upstream language packs can be dropped into `./languages/*` later.
 */
import * as path from "node:path";

import type { Node as SyntaxNode } from "web-tree-sitter";

import type {
	CodeGraphEdge,
	CodeGraphExtractionError,
	CodeGraphNode,
	CodeGraphUnresolvedReference,
	Language,
} from "../types";
import { detectLanguage, getParser, initGrammars, isFileLevelOnlyLanguage, isGrammarLoaded } from "./grammars";
import { EXTRACTORS } from "./languages";
import { extractSvelte } from "./svelte-extractor";
import { generateNodeId, getChildByField, getNodeText, getPrecedingDocstring } from "./tree-sitter-helpers";
import type { LanguageExtractor } from "./tree-sitter-types";
import { extractVue } from "./vue-extractor";

/** Local extraction result shape (consumed by Svelte/Vue + `extractFromSource`). */
export interface CodeGraphExtractionResult {
	nodes: CodeGraphNode[];
	edges: CodeGraphEdge[];
	refs: CodeGraphUnresolvedReference[];
	errors: CodeGraphExtractionError[];
}

const SFC_LANGUAGES: Record<string, true> = { svelte: true, vue: true };

/**
 * Run the tree-sitter extractor for one file with an explicit
 * `language`. Used by Svelte/Vue for `<script>` blocks at a line
 * offset. Falls back to file-only output on parse failure.
 */
export function treeSitterExtract(
	filePath: string,
	language: Language,
	source: string,
	lineOffset = 0,
): CodeGraphExtractionResult {
	const extractor = new TreeSitterExtractor(filePath, language, source, lineOffset);
	return extractor.extract();
}

/** Top-level entry — `extractFromSource(filePath, source, language?)`. */
export function extractFromSource(filePath: string, source: string, language?: Language): CodeGraphExtractionResult {
	const detected = language ?? detectLanguage(filePath, source);

	if (SFC_LANGUAGES[detected]) {
		return detected === "svelte" ? extractSvelte(filePath, source) : extractVue(filePath, source);
	}

	if (isFileLevelOnlyLanguage(detected)) {
		return { nodes: [], edges: [], refs: [], errors: [] };
	}

	const result = treeSitterExtract(filePath, detected, source);
	if (result.nodes.length === 0) {
		const lineCount = source.split(/\r?\n/).length;
		return {
			nodes: [
				{
					id: `file:${filePath}`,
					kind: "file",
					name: path.basename(filePath),
					qualifiedName: filePath,
					filePath,
					language: detected,
					startLine: 1,
					endLine: lineCount,
					startColumn: 0,
					endColumn: 0,
					updatedAt: Date.now(),
				},
			],
			edges: [],
			refs: [],
			errors: result.errors,
		};
	}
	return result;
}

/** Synchronous tree-sitter walk over `source`. */
class TreeSitterExtractor {
	readonly #filePath: string;
	readonly #language: Language;
	readonly #extractor: LanguageExtractor | null;
	#source: string;
	readonly #lineOffset: number;

	readonly #nodes: CodeGraphNode[] = [];
	readonly #edges: CodeGraphEdge[] = [];
	readonly #refs: CodeGraphUnresolvedReference[] = [];
	readonly #errors: CodeGraphExtractionError[] = [];

	/** Current scope (parent node IDs) for `contains` edges and qualified names. */
	readonly #scope: string[] = [];

	constructor(filePath: string, language: Language, source: string, lineOffset: number) {
		this.#filePath = filePath;
		this.#language = language;
		this.#extractor = EXTRACTORS[language] ?? null;
		this.#source = source;
		this.#lineOffset = lineOffset;
	}

	extract(): CodeGraphExtractionResult {
		if (!this.#extractor) {
			this.#errors.push({
				message: `no LanguageExtractor configured for ${this.#language}`,
				filePath: this.#filePath,
				severity: "error",
				code: "extractor_missing",
			});
			return this.#snapshot();
		}

		try {
			if (this.#extractor.preParse) {
				this.#source = this.#extractor.preParse(this.#source, this.#filePath);
			}

			const parser = getParser(this.#language);
			if (!parser) {
				this.#errors.push({
					message: `parser not loaded for ${this.#language}; grammar may be missing`,
					filePath: this.#filePath,
					severity: "warning",
				});
				return this.#snapshot();
			}

			const tree = parser.parse(this.#source);
			if (!tree) {
				this.#errors.push({
					message: `tree-sitter returned null tree for ${this.#filePath}`,
					filePath: this.#filePath,
					severity: "error",
					code: "parse_error",
				});
				return this.#snapshot();
			}

			this.#pushFileNode();
			this.#walk(tree.rootNode);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("memory access out of bounds") || msg.includes("out of memory")) {
				throw err;
			}
			this.#errors.push({
				message: `parse error: ${msg}`,
				filePath: this.#filePath,
				severity: "error",
				code: "parse_error",
			});
		}
		return this.#snapshot();
	}

	#pushFileNode() {
		const lineCount = this.#source.split(/\r?\n/).length;
		const fileNode: CodeGraphNode = {
			id: `file:${this.#filePath}`,
			kind: "file",
			name: path.basename(this.#filePath),
			qualifiedName: this.#filePath,
			filePath: this.#filePath,
			language: this.#language,
			startLine: 1 + this.#lineOffset,
			endLine: lineCount + this.#lineOffset,
			startColumn: 0,
			endColumn: 0,
			isExported: false,
			updatedAt: Date.now(),
		};
		this.#nodes.push(fileNode);
		this.#scope.push(fileNode.id);
	}

	#walk(node: SyntaxNode) {
		const extractor = this.#extractor;
		if (!extractor) return;

		const kind = this.#classifyNodeType(node, extractor);
		if (kind) {
			const created = this.#makeNode(node, kind);
			if (created) {
				this.#scope.push(created.id);
				this.#visitChildren(node);
				this.#scope.pop();
				return;
			}
		}

		if (extractor.importTypes.includes(node.type)) {
			this.#extractImport(node);
		}

		this.#visitChildren(node);
	}

	#visitChildren(node: SyntaxNode) {
		for (let i = 0; i < node.namedChildCount; i++) {
			const child = node.namedChild(i);
			if (child) this.#walk(child);
		}
	}

	#classifyNodeType(node: SyntaxNode, extractor: LanguageExtractor): CodeGraphNode["kind"] | null {
		const type = node.type;
		if (extractor.classTypes.includes(type)) {
			const classified = extractor.classifyClassNode?.(node);
			if (classified === "interface" || classified === "trait") {
				return extractor.interfaceKind ?? "interface";
			}
			if (classified === "struct") return "struct";
			if (classified === "enum") return "enum";
			return "class";
		}
		if (extractor.structTypes.includes(type)) return "struct";
		if (extractor.enumTypes.includes(type)) return "enum";
		if (extractor.interfaceTypes.includes(type)) {
			return extractor.interfaceKind ?? "interface";
		}
		if (extractor.methodTypes.includes(type)) {
			const classified = extractor.classifyMethodNode?.(node);
			return classified === "property" ? "property" : "method";
		}
		if (extractor.functionTypes.includes(type)) {
			return isInsideClass(node) ? "method" : "function";
		}
		if (extractor.typeAliasTypes.includes(type)) return "type_alias";
		if (extractor.variableTypes.includes(type)) {
			return extractor.isConst?.(node) ? "constant" : "variable";
		}
		if (extractor.enumMemberTypes?.includes(type)) return "enum_member";
		return null;
	}

	#makeNode(node: SyntaxNode, kind: CodeGraphNode["kind"]): CodeGraphNode | null {
		const extractor = this.#extractor;
		if (!extractor) return null;

		let name: string | undefined;
		if (extractor.resolveName) {
			name = extractor.resolveName(node, this.#source);
		}
		if (!name) {
			const nameNode = getChildByField(node, extractor.nameField);
			if (nameNode) name = getNodeText(nameNode, this.#source).trim();
		}
		if (!name) {
			if (node.type === "arrow_function" || node.type === "function_expression") {
				name = "<anonymous>";
			} else {
				return null;
			}
		}

		const startLine = node.startPosition.row + 1 + this.#lineOffset;
		const endLine = node.endPosition.row + 1 + this.#lineOffset;
		const startColumn = node.startPosition.column;
		const endColumn = node.endPosition.column;

		const signature = extractor.getSignature?.(node, this.#source);
		const visibility = extractor.getVisibility?.(node, this.#source);
		const isExported = extractor.isExported?.(node, this.#source) ?? false;
		const isAsync = extractor.isAsync?.(node, this.#source) ?? false;
		const isStatic = extractor.isStatic?.(node, this.#source) ?? false;

		const docstring = getPrecedingDocstring(node, this.#source);

		const qualifiedName = `${this.#filePath}::${name}::${startLine}`;
		const out: CodeGraphNode = {
			id: generateNodeId(this.#filePath, kind, qualifiedName, startLine),
			kind,
			name,
			qualifiedName,
			filePath: this.#filePath,
			language: this.#language,
			startLine,
			endLine,
			startColumn,
			endColumn,
			updatedAt: Date.now(),
		};
		if (signature !== undefined) out.signature = signature;
		if (visibility !== undefined) out.visibility = visibility;
		if (isExported) out.isExported = true;
		if (isAsync) out.isAsync = true;
		if (isStatic) out.isStatic = true;
		if (docstring) out.docstring = docstring;

		this.#nodes.push(out);

		const parentId = this.#scope.at(-1);
		if (parentId && parentId !== out.id) {
			this.#edges.push({
				source: parentId,
				target: out.id,
				kind: "contains",
				provenance: "tree-sitter",
				line: startLine,
				column: startColumn,
			});
		}

		this.#emitCallRefs(node, out.id);
		return out;
	}

	#emitCallRefs(node: SyntaxNode, ownerId: string) {
		const extractor = this.#extractor;
		if (!extractor) return;
		const body = extractor.resolveBody?.(node, extractor.bodyField) ?? getChildByField(node, extractor.bodyField);
		if (!body) return;
		for (let i = 0; i < body.namedChildCount; i++) {
			const child = body.namedChild(i);
			if (child) this.#sweepCalls(child, ownerId);
		}
	}

	#sweepCalls(node: SyntaxNode, ownerId: string) {
		const extractor = this.#extractor;
		if (!extractor) return;
		if (extractor.callTypes.includes(node.type)) {
			const callee = node.namedChildren[0];
			if (callee) {
				const name = getNodeText(callee, this.#source).trim();
				if (name && !/^(true|false|null|undefined|NaN|Infinity|this|super|new)$/.test(name)) {
					const refLine = node.startPosition.row + 1 + this.#lineOffset;
					const refCol = node.startPosition.column;
					this.#refs.push({
						fromNodeId: ownerId,
						referenceName: name,
						referenceKind: "calls",
						line: refLine,
						column: refCol,
						filePath: this.#filePath,
						language: this.#language,
					});
				}
			}
		}
		for (let i = 0; i < node.namedChildCount; i++) {
			const child = node.namedChild(i);
			if (child) this.#sweepCalls(child, ownerId);
		}
	}

	#extractImport(node: SyntaxNode) {
		const extractor = this.#extractor;
		if (!extractor) return;
		const info = extractor.extractImport?.(node, this.#source);
		const ownerId = this.#scope.at(-1);
		if (!ownerId) return;
		if (info?.moduleName) {
			const refLine = node.startPosition.row + 1 + this.#lineOffset;
			const refCol = node.startPosition.column;
			this.#refs.push({
				fromNodeId: ownerId,
				referenceName: info.moduleName,
				referenceKind: "imports",
				line: refLine,
				column: refCol,
				filePath: this.#filePath,
				language: this.#language,
			});
			return;
		}
		const literal = node.namedChildren.find(
			c =>
				c !== null &&
				(c.type === "string" ||
					c.type === "string_literal" ||
					c.type === "interpreted_string_literal" ||
					c.type === "dotted_name"),
		);
		if (!literal) return;
		const moduleName = getNodeText(literal, this.#source)
			.trim()
			.replace(/^['"]|['"]$/g, "");
		if (!moduleName) return;
		const refLine = node.startPosition.row + 1 + this.#lineOffset;
		const refCol = node.startPosition.column;
		this.#refs.push({
			fromNodeId: ownerId,
			referenceName: moduleName,
			referenceKind: "imports",
			line: refLine,
			column: refCol,
			filePath: this.#filePath,
			language: this.#language,
		});
	}

	#snapshot(): CodeGraphExtractionResult {
		return {
			nodes: this.#nodes,
			edges: this.#edges,
			refs: this.#refs,
			errors: this.#errors,
		};
	}
}

function isInsideClass(node: SyntaxNode): boolean {
	let p: SyntaxNode | null = node.parent;
	while (p) {
		if (p.type === "class_declaration" || p.type === "class_body" || p.type === "class") {
			return true;
		}
		p = p.parent;
	}
	return false;
}

export { initGrammars, isGrammarLoaded };
