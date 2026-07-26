/**
 * Explore pipeline — adapted from upstream `src/context/index.ts`
 * (MIT, Copyright (c) 2026 Colby Mchenry — see ./UPSTREAM_LICENSE).
 *
 * Per the OMP shared contract §"Core runtime facade":
 *   "Explore reads current source files from sourceRoot, never stale
 *    DB content."
 *
 * Pipeline:
 *   1. Parse the raw query into structured filters (`search.ts`).
 *   2. Score candidate nodes via FTS, exact-name, and CamelCase
 *      segment matches using the search helpers.
 *   3. Walk the call graph (calls / references / imports / instantiates)
 *      from the chosen entry points and surface both source fragments
 *      and call chains in the returned envelope.
 *   4. The runtime pulls current source bytes from disk so a stale
 *      DB never leaks into the rendered span.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { DatabaseConnection, QueryBuilder } from "./db";
import { GraphTraverser } from "./graph";
import type { CodeGraphExploreEntry, CodeGraphExploreResult, CodeGraphFileEntry } from "./runtime-types";
import {
	extractProseCandidates,
	extractSearchTerms,
	isTestFile,
	kindBonus,
	nameMatchBonus,
	parseQuery,
	scorePathRelevance,
	segmentLookupVariants,
	splitIdentifierSegments,
} from "./search";
import type { CodeGraphEdge, CodeGraphNode, EdgeKind } from "./types";

const FLOW_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>(["calls", "references", "imports", "instantiates"]);

export interface ExplorerContext {
	sourceRoot: string;
	connection: DatabaseConnection;
	queryBuilder: QueryBuilder;
	maxFiles: number;
	traverser?: GraphTraverser;
}

export interface ExplorerFlowHop {
	from: string;
	to: string;
	edgeKind: EdgeKind;
	provenance?: "tree-sitter" | "scip" | "heuristic";
	resolvedBy?: string;
	confidence: number;
}

export interface ExplorerFlowChain {
	hops: ExplorerFlowHop[];
}

export interface ExplorerBlastRadiusEntry {
	node: CodeGraphNode;
	via: CodeGraphEdge;
	depth: number;
}

export interface ExplorerBlastRadius {
	focal: CodeGraphNode;
	entries: ExplorerBlastRadiusEntry[];
}

export interface ExplorerRelevantNode {
	node: CodeGraphNode;
	score: number;
	matchedTerms: string[];
}

export interface EnrichedExploreResult extends CodeGraphExploreResult {
	entryCount: number;
	edges: CodeGraphEdge[];
	flow: ExplorerFlowChain[];
	blastRadius: ExplorerBlastRadius | null;
	relevance: ExplorerRelevantNode[];
	testCandidates: CodeGraphNode[];
}

const MAX_FLOW_CHAINS = 5;
const MAX_FLOW_HOPS = 6;

export async function runExplore(ctx: ExplorerContext, rawQuery: string): Promise<EnrichedExploreResult> {
	const parsed = parseQuery(rawQuery);
	const candidates: CodeGraphNode[] = [];
	const seen = new Set<string>();
	const push = (node: CodeGraphNode | undefined | null) => {
		if (!node) return;
		if (seen.has(node.id)) return;
		seen.add(node.id);
		candidates.push(node);
	};
	for (const term of extractProseCandidates(parsed.freeText)) {
		for (const variant of segmentLookupVariants(term)) {
			for (const node of ctx.queryBuilder.searchByTerm(variant, 25)) push(node);
		}
	}
	for (const sym of extractSearchTerms(parsed.freeText, { stems: false })) {
		for (const node of ctx.queryBuilder.getNodesByName(sym, 25)) push(node);
	}
	for (const node of candidates) {
		if (!seen.has(node.id)) seen.add(node.id);
	}

	const filtered = candidates.filter(node => matchesFilters(node, parsed));
	const ranked = rankCandidates(filtered, parsed.freeText);
	const entryNodes = dedupeByFile(ranked);
	const entryList = entryNodes.slice(0, ctx.maxFiles);
	if (entryList.length === 0) {
		return {
			query: rawQuery,
			maxFiles: ctx.maxFiles,
			files: [],
			entries: [],
			confidence: "low",
			entryCount: 0,
			edges: [],
			flow: [],
			blastRadius: null,
			relevance: ranked,
			testCandidates: [],
		};
	}
	const entryPaths = new Set(entryList.map(n => n.filePath));
	const scanned = await scanProject(ctx.sourceRoot, { paths: Array.from(entryPaths) });
	const byPath = new Map(scanned.map(s => [s.filePath, s]));
	const files: CodeGraphFileEntry[] = [];
	for (const scannedEntry of scanned) {
		const lines = await readLines(path.resolve(ctx.sourceRoot, scannedEntry.filePath));
		files.push({
			filePath: scannedEntry.filePath,
			language: scannedEntry.language,
			nodeCount: lines.length,
			lines,
		});
	}

	const entries: CodeGraphExploreEntry[] = [];
	for (const node of entryList) {
		const absPath = path.resolve(ctx.sourceRoot, node.filePath);
		const lines = await readLines(absPath);
		if (!byPath.has(node.filePath)) continue;
		const startLine = Math.max(1, node.startLine);
		const endLine = Math.min(node.endLine || lines.length, lines.length);
		entries.push({
			node,
			lines,
			startLine,
			endLine,
		});
	}

	const edges: CodeGraphEdge[] = [];
	for (const node of entryList) {
		for (const edge of ctx.queryBuilder.getEdgesBySource(node.id)) edges.push(edge);
		for (const edge of ctx.queryBuilder.getEdgesByTarget(node.id)) edges.push(edge);
	}

	const traverser = ctx.traverser ?? new GraphTraverser(ctx.queryBuilder);
	const flow = computeFlowChains(ctx.queryBuilder, traverser, entryList);
	const focal = entryList[0] ?? null;
	const blastRadius = focal ? computeBlastRadius(ctx.queryBuilder, traverser, focal) : null;
	const testCandidates = focal ? computeTestCandidates(ctx.queryBuilder, focal) : [];
	const confidence: "high" | "low" = entryList.length > 0 && !parsed.freeText.startsWith("?") ? "high" : "low";

	return {
		query: rawQuery,
		maxFiles: ctx.maxFiles,
		files,
		entries,
		confidence,
		entryCount: entryList.length,
		edges: dedupeEdges(edges),
		flow,
		blastRadius,
		relevance: ranked,
		testCandidates,
	};
}

function matchesFilters(node: CodeGraphNode, parsed: ReturnType<typeof parseQuery>): boolean {
	if (parsed.kinds.length > 0 && !parsed.kinds.includes(node.kind)) return false;
	if (parsed.languages.length > 0 && !parsed.languages.includes(node.language)) return false;
	if (parsed.pathIncludes.length > 0) {
		const lower = node.filePath.toLowerCase();
		if (!parsed.pathIncludes.every(p => lower.includes(p))) return false;
	}
	if (parsed.nameIncludes.length > 0) {
		const segs = splitIdentifierSegments(node.name);
		if (!parsed.nameIncludes.every(p => segs.some(seg => seg.includes(p)))) return false;
	}
	return true;
}

function rankCandidates(nodes: readonly CodeGraphNode[], query: string): ExplorerRelevantNode[] {
	const terms = extractSearchTerms(query, { stems: true });
	const scored: ExplorerRelevantNode[] = [];
	for (const node of nodes) {
		if (node.kind === "file" || node.kind === "import" || node.kind === "export") continue;
		const matchedTerms: string[] = [];
		let score = 0;
		for (const term of terms) {
			if (node.name.toLowerCase().includes(term)) {
				matchedTerms.push(term);
				score += 5;
			} else if (splitIdentifierSegments(node.name).some(seg => seg.includes(term))) {
				matchedTerms.push(term);
				score += 3;
			}
		}
		score += nameMatchBonus(node.name, query);
		score += kindBonus(node.kind);
		score += scorePathRelevance(node.filePath, query);
		scored.push({ node, score, matchedTerms: Array.from(new Set(matchedTerms)) });
	}
	scored.sort((a, b) => b.score - a.score || a.node.filePath.localeCompare(b.node.filePath));
	return scored;
}

function dedupeByFile(nodes: ExplorerRelevantNode[]): CodeGraphNode[] {
	const seen = new Set<string>();
	const out: CodeGraphNode[] = [];
	for (const { node } of nodes) {
		if (seen.has(node.filePath)) continue;
		seen.add(node.filePath);
		out.push(node);
	}
	return out;
}

function dedupeEdges(edges: CodeGraphEdge[]): CodeGraphEdge[] {
	const seen = new Set<string>();
	const out: CodeGraphEdge[] = [];
	for (const edge of edges) {
		const key = `${edge.source}|${edge.target}|${edge.kind}|${edge.line ?? -1}|${edge.column ?? -1}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(edge);
	}
	return out;
}

function computeFlowChains(
	queries: QueryBuilder,
	_traverser: GraphTraverser,
	entries: CodeGraphNode[],
): ExplorerFlowChain[] {
	if (entries.length === 0) return [];
	const entryIds = new Set(entries.map(e => e.id));
	const adj = new Map<string, ExplorerFlowHop[]>();
	for (const entry of entries) {
		for (const edge of queries.getEdgesBySource(entry.id)) {
			if (!FLOW_EDGE_KINDS.has(edge.kind)) continue;
			const metadata = (edge.metadata ?? {}) as Record<string, unknown>;
			const confidence =
				typeof metadata.confidence === "number"
					? (metadata.confidence as number)
					: edge.provenance === "heuristic"
						? 0.5
						: 0.9;
			const resolvedBy = typeof metadata.resolvedBy === "string" ? (metadata.resolvedBy as string) : undefined;
			const list = adj.get(entry.id) ?? [];
			list.push({
				from: edge.source,
				to: edge.target,
				edgeKind: edge.kind,
				provenance: edge.provenance,
				resolvedBy,
				confidence,
			});
			adj.set(entry.id, list);
		}
	}

	const chains: ExplorerFlowChain[] = [];
	const budget = 1500;
	const walk = (id: string, path: ExplorerFlowHop[], depth: number, seen: Set<string>) => {
		if (budget <= 0) return;
		const next = adj.get(id) ?? [];
		if (next.length === 0 || depth >= MAX_FLOW_HOPS) {
			if (path.length >= 2 && path.some(hop => entryIds.has(hop.from) && entryIds.has(hop.to))) {
				chains.push({ hops: [...path] });
			}
			return;
		}
		for (const hop of next) {
			if (seen.has(hop.to)) continue;
			seen.add(hop.to);
			walk(hop.to, [...path, hop], depth + 1, seen);
			seen.delete(hop.to);
		}
	};
	for (const entry of entries.slice(0, MAX_FLOW_CHAINS)) {
		walk(entry.id, [], 1, new Set([entry.id]));
		if (chains.length >= MAX_FLOW_CHAINS) break;
	}
	chains.sort((a, b) => b.hops.length - a.hops.length);
	return chains.slice(0, MAX_FLOW_CHAINS);
}

function computeBlastRadius(
	queries: QueryBuilder,
	_traverser: GraphTraverser,
	focal: CodeGraphNode,
): ExplorerBlastRadius {
	const entries: ExplorerBlastRadiusEntry[] = [];
	const visited = new Set<string>([focal.id]);
	const queue: Array<{ id: string; depth: number }> = [];
	for (const edge of queries.getEdgesByTarget(focal.id)) {
		if (!FLOW_EDGE_KINDS.has(edge.kind)) continue;
		const next = queries.getNodeById(edge.source);
		if (!next || visited.has(next.id)) continue;
		visited.add(next.id);
		entries.push({ node: next, via: edge, depth: 1 });
		queue.push({ id: next.id, depth: 1 });
	}
	while (queue.length > 0 && entries.length < 100) {
		const current = queue.shift()!;
		if (current.depth >= 3) continue;
		for (const edge of queries.getEdgesByTarget(current.id)) {
			if (!FLOW_EDGE_KINDS.has(edge.kind)) continue;
			const next = queries.getNodeById(edge.source);
			if (!next || visited.has(next.id)) continue;
			visited.add(next.id);
			entries.push({ node: next, via: edge, depth: current.depth + 1 });
			queue.push({ id: next.id, depth: current.depth + 1 });
		}
	}
	return { focal, entries };
}

function computeTestCandidates(queries: QueryBuilder, focal: CodeGraphNode): CodeGraphNode[] {
	const seen = new Set<string>();
	const out: CodeGraphNode[] = [];
	const queue: string[] = [focal.filePath];
	while (queue.length > 0) {
		const file = queue.shift()!;
		if (seen.has(file)) continue;
		seen.add(file);
		for (const node of queries.getNodesByFile(file)) {
			const incoming = queries.getEdgesByTarget(node.id);
			for (const edge of incoming) {
				if (edge.kind !== "imports") continue;
				const sourceFile = queries.getNodeById(edge.source)?.filePath;
				if (!sourceFile || seen.has(sourceFile)) continue;
				queue.push(sourceFile);
				if (isTestFile(sourceFile)) {
					for (const n of queries.getNodesByFile(sourceFile)) {
						if (n.kind === "function" || n.kind === "method") out.push(n);
					}
				}
			}
		}
	}
	return out;
}

async function readLines(filePath: string): Promise<string[]> {
	try {
		const text = await fs.readFile(filePath, "utf8");
		return text.split(/\r?\n/);
	} catch {
		return [];
	}
}

import { scanProject } from "./scanner";
