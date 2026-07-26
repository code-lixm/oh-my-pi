/**
 * Svelte Single-File Component extractor — ported from upstream
 * `codegraph/src/extraction/svelte-extractor.ts` (MIT, Copyright (c)
 * 2026 Colby Mchenry — see ./ATTRIBUTION.md and ../UPSTREAM_LICENSE).
 *
 * Svelte files contain `<script>` (or `<script setup>`), `<template>`,
 * and `<style>` blocks. Instead of parsing the full Svelte grammar with
 * the tree-sitter-wasm blobs we vendor, we take the same shortcut
 * upstream uses: extract the language-typed `<script>` contents and
 * feed them through `TreeSitterExtractor`. Then sweep the template
 * for `<Foo ... />` component references and `{fn(...)}` call sites.
 *
 * The output is a `component` node (Svelte components are always
 * importable) plus the script's symbol nodes with adjusted line/col
 * for the original file.
 */

import type {
	CodeGraphEdge,
	CodeGraphExtractionError,
	CodeGraphNode,
	CodeGraphUnresolvedReference,
	Language,
} from "../types";
import { isLanguageSupported } from "./grammars";
import { treeSitterExtract } from "./tree-sitter";

const SCRIPT_BLOCK_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const COMPONENT_TAG_RE = /<([A-Z][A-Za-z0-9]*)(?:-[a-z][\w-]*)?\b/g;

const SVELTE_DOM_EVENTS: Record<string, true> = {
	click: true,
	submit: true,
	input: true,
	change: true,
	focus: true,
	blur: true,
	keydown: true,
	keyup: true,
	keypress: true,
	mouseenter: true,
	mouseleave: true,
	mouseover: true,
	mouseout: true,
	mousedown: true,
	mouseup: true,
	load: true,
	resize: true,
	scroll: true,
	scrollend: true,
	dblclick: true,
	wheel: true,
	drag: true,
	dragstart: true,
	dragend: true,
	drop: true,
	contextmenu: true,
	touchstart: true,
	touchend: true,
	pointerdown: true,
	pointerup: true,
	pointermove: true,
};

/**
 * kebab-case → PascalCase (`my-foo` → `MyFoo`). Lets a template that
 * uses either form match the same component.
 */
function kebabToPascal(name: string): string {
	return name
		.split("-")
		.map(part => (part ? part[0]!.toUpperCase() + part.slice(1) : ""))
		.join("");
}

export interface SvelteExtractionResult {
	nodes: CodeGraphNode[];
	edges: CodeGraphEdge[];
	refs: CodeGraphUnresolvedReference[];
	errors: CodeGraphExtractionError[];
}

/** Entry point used by `extractFromSource` for `.svelte` files. */
export function extractSvelte(filePath: string, source: string): SvelteExtractionResult {
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
		language: "svelte",
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
		if (!isLanguageSupported(lang)) continue;

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
				message: `svelte <script> extraction failed: ${(err as Error).message}`,
				filePath,
				severity: "warning",
			});
		}
	}

	for (const match of source.matchAll(COMPONENT_TAG_RE)) {
		const name = match[1]!;
		const offset = blockOffsetFor(source, match.index ?? 0);
		const id = `${filePath}:component:${name}`;
		nodes.push({
			id,
			kind: "component",
			name,
			qualifiedName: `${filePath}::${name}`,
			filePath,
			language: "svelte",
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
		nodes.push(edgeComponentNode(filePath, "svelte", kebabToPascal(name), offset));
	}

	for (const match of source.matchAll(/on:(\w+)=\{([^}]+)\}/g)) {
		const eventName = match[1]!;
		const handler = (match[2] ?? "").trim();
		if (SVELTE_DOM_EVENTS[eventName]) continue;
		if (!/^[A-Za-z_$][\w$]*$/.test(handler)) continue;
		const offset = blockOffsetFor(source, match.index ?? 0);
		refs.push({
			fromNodeId: componentId,
			referenceName: handler,
			referenceKind: "calls",
			line: offset.line,
			column: offset.column,
			filePath,
			language: "svelte",
		});
	}

	return { nodes, edges, refs, errors };
}

function pickScriptLanguage(attrs: string): Language {
	const langAttr = /lang\s*=\s*"([^"]+)"/i.exec(attrs);
	const raw = (langAttr?.[1] ?? "javascript").toLowerCase();
	if (raw === "ts" || raw === "typescript") return "typescript";
	if (raw === "tsx") return "tsx";
	return "javascript";
}

function edgeComponentNode(
	filePath: string,
	language: Language,
	name: string,
	offset: { line: number; column: number },
): CodeGraphNode {
	return {
		id: `${filePath}:component:pascal:${name}`,
		kind: "component",
		name,
		qualifiedName: `${filePath}::${name}`,
		filePath,
		language,
		startLine: offset.line,
		endLine: offset.line,
		startColumn: offset.column,
		endColumn: offset.column + name.length,
		isExported: true,
		updatedAt: Date.now(),
	};
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
