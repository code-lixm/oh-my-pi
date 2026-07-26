/**
 * Vue Single-File Component extractor — ported from upstream
 * `codegraph/src/extraction/vue-extractor.ts` (MIT, Copyright (c)
 * 2026 Colby Mchenry — see ./ATTRIBUTION.md and ../UPSTREAM_LICENSE).
 *
 * Vue SFCs carry `<script>`, `<template>`, and `<style>` blocks. We
 * delegate the `<script>` body to the matching language's
 * `TreeSitterExtractor` (TypeScript by default, JavaScript on
 * `<script>`, otherwise determined by `lang="…"`); the template
 * contributes component references via `<Foo ... />`.
 */

import type {
	CodeGraphEdge,
	CodeGraphExtractionError,
	CodeGraphNode,
	CodeGraphUnresolvedReference,
	Language,
} from "../types";
import { treeSitterExtract } from "./tree-sitter";

const SCRIPT_BLOCK_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const COMPONENT_TAG_RE = /<([A-Z][A-Za-z0-9]*)(?:-[a-z][\w-]*)?\b/g;
const TEMPLATE_CALL_RE = /@(?:\w[\w-]*)="([^"]+)"/g;

const VUE_BUILTINS: Record<string, true> = {
	Transition: true,
	TransitionGroup: true,
	KeepAlive: true,
	Suspense: true,
	Teleport: true,
	Component: true,
	Slot: true,
};

function kebabToPascal(name: string): string {
	return name
		.split("-")
		.map(p => (p ? p[0]!.toUpperCase() + p.slice(1) : ""))
		.join("");
}

export interface VueExtractionResult {
	nodes: CodeGraphNode[];
	edges: CodeGraphEdge[];
	refs: CodeGraphUnresolvedReference[];
	errors: CodeGraphExtractionError[];
}

export function extractVue(filePath: string, source: string): VueExtractionResult {
	const nodes: CodeGraphNode[] = [];
	const edges: CodeGraphEdge[] = [];
	const refs: CodeGraphUnresolvedReference[] = [];
	const errors: CodeGraphExtractionError[] = [];

	const componentId = `file:${filePath}`;
	const lineCount = source.split(/\r?\n/).length;
	nodes.push({
		id: componentId,
		kind: "component",
		name: filePath.split("/").pop() ?? filePath,
		qualifiedName: filePath,
		filePath,
		language: "vue",
		startLine: 1,
		endLine: lineCount,
		startColumn: 0,
		endColumn: 0,
		isExported: true,
		updatedAt: Date.now(),
	});

	for (const m of source.matchAll(SCRIPT_BLOCK_RE)) {
		const attrs = m[1] ?? "";
		const innerSource = m[2] ?? "";
		const blockStart = source.indexOf(m[0]);
		const offset = lineCountFor(source.slice(0, blockStart + m[0].indexOf(">") + 1));
		const lang = pickScriptLanguage(attrs);

		try {
			const inner = treeSitterExtract(filePath, lang, innerSource, offset);
			for (const node of inner.nodes) {
				if (node.id === componentId) continue;
				nodes.push(node);
			}
			for (const edge of inner.edges) edges.push(edge);
			for (const ref of inner.refs) refs.push(ref);
		} catch (err) {
			errors.push({
				message: `vue <script> extraction failed: ${(err as Error).message}`,
				filePath,
				severity: "warning",
			});
		}
	}

	for (const match of source.matchAll(COMPONENT_TAG_RE)) {
		const raw = match[1]!;
		if (VUE_BUILTINS[raw]) continue;
		const pascal = kebabToPascal(raw);
		if (VUE_BUILTINS[pascal]) continue;
		const offset = blockOffsetFor(source, match.index ?? 0);
		for (const name of [raw, pascal]) {
			const id = `${filePath}:component:${name}`;
			nodes.push({
				id,
				kind: "component",
				name,
				qualifiedName: `${filePath}::${name}`,
				filePath,
				language: "vue",
				startLine: offset.line,
				endLine: offset.line,
				startColumn: offset.column,
				endColumn: offset.column + name.length,
				isExported: true,
				updatedAt: Date.now(),
			});
			edges.push({
				source: componentId,
				target: id,
				kind: "references",
				provenance: "tree-sitter",
				line: offset.line,
				column: offset.column,
			});
		}
	}

	for (const match of source.matchAll(TEMPLATE_CALL_RE)) {
		const expr = (match[1] ?? "").trim();
		const ident = expr.match(/^([A-Za-z_$][\w$]*)\s*\(/);
		if (!ident) continue;
		const offset = blockOffsetFor(source, match.index ?? 0);
		refs.push({
			fromNodeId: componentId,
			referenceName: ident[1]!,
			referenceKind: "calls",
			line: offset.line,
			column: offset.column,
			filePath,
			language: "vue",
		});
	}

	return { nodes, edges, refs, errors };
}

function pickScriptLanguage(attrs: string): Language {
	const langAttr = /lang\s*=\s*"([^"]+)"/i.exec(attrs);
	const raw = (langAttr?.[1] ?? "javascript").toLowerCase();
	if (raw === "ts" || raw === "typescript") return "typescript";
	if (raw === "tsx") return "tsx";
	if (raw === "coffee") return "javascript"; // best-effort
	return "javascript";
}

function lineCountFor(prefix: string): number {
	return prefix.split(/\r?\n/).length - 1;
}

function blockOffsetFor(
	source: string,
	absoluteIndex: number,
): {
	line: number;
	column: number;
} {
	const prefix = source.slice(0, absoluteIndex);
	const lines = prefix.split(/\r?\n/);
	return {
		line: lines.length,
		column: (lines[lines.length - 1] ?? "").length,
	};
}
