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
import { getCodeGraphExploreBudget } from "./explore-budget";
import { GraphTraverser } from "./graph";
import type {
	CodeGraphBlastRadius,
	CodeGraphCoverageItem,
	CodeGraphExploreEntry,
	CodeGraphExploreMode,
	CodeGraphExploreResult,
	CodeGraphFileEntry,
	CodeGraphFlowChain,
	CodeGraphResolvedExploreMode,
	CodeGraphSourceCompleteness,
	CodeGraphSourceSection,
	CodeGraphSourceSectionRole,
} from "./runtime-types";
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
	mode?: CodeGraphExploreMode;
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

export type EnrichedExploreResult = CodeGraphExploreResult;

const MAX_FLOW_CHAINS = 5;
const MAX_FLOW_HOPS = 6;
const CONTAINER_KINDS: Record<string, true> = {
	class: true,
	struct: true,
	interface: true,
	trait: true,
	protocol: true,
	enum: true,
	namespace: true,
	module: true,
};

function inferExploreMode(query: string, requested: CodeGraphExploreMode): CodeGraphResolvedExploreMode {
	if (requested !== "auto") return requested;
	if (/\b(?:flow|call\s*path|reach|become|route)\b|调用链|流程|路径|到达/iu.test(query)) return "flow";
	if (/\b(?:impact|blast\s*radius|affect|break|dependents?)\b|影响|波及|依赖范围/iu.test(query)) return "impact";
	if (/\b(?:edit|change|modify|fix|implement|refactor)\b|修改|修复|实现|重构/iu.test(query)) return "edit";
	if (/\b(?:where|locate|defined|definition|find)\b|哪里|定位|定义/iu.test(query)) return "locate";
	return "understand";
}

function sourceRoleFor(mode: CodeGraphResolvedExploreMode, target: boolean, test: boolean): CodeGraphSourceSectionRole {
	if (test) return "test";
	if (target) return "target";
	if (mode === "flow") return "flow-spine";
	return "relationship";
}

function coverageItem(section: CodeGraphSourceSection): CodeGraphCoverageItem {
	return {
		path: section.filePath,
		startLine: section.startLine,
		endLine: section.endLine,
		symbolId: section.symbol?.id,
		role: section.role,
		...(section.reason ? { reason: section.reason } : {}),
	};
}

function omittedCoverage(
	node: CodeGraphNode,
	role: CodeGraphSourceSectionRole,
	reason: CodeGraphCoverageItem["reason"],
): CodeGraphCoverageItem {
	return {
		path: node.filePath,
		startLine: Math.max(1, node.startLine),
		endLine: Math.max(node.startLine, node.endLine),
		symbolId: node.id,
		role,
		reason,
	};
}

async function buildSourceSection(
	ctx: ExplorerContext,
	node: CodeGraphNode,
	role: CodeGraphSourceSectionRole,
	remainingTotal: number,
	remainingFile: number,
): Promise<CodeGraphSourceSection | null> {
	const allLines = await readLines(path.resolve(ctx.sourceRoot, node.filePath));
	if (allLines.length === 0 || remainingTotal <= 0 || remainingFile <= 0) return null;
	const startLine = Math.max(1, Math.min(node.startLine || 1, allLines.length));
	const declaredEnd = node.endLine > 0 ? node.endLine : startLine;
	const endLine = Math.max(startLine, Math.min(declaredEnd, allLines.length));
	const body = allLines.slice(startLine - 1, endLine);
	const completeText = body.join("\n");
	const limit = Math.min(remainingTotal, remainingFile);
	let lines = body;
	let completeness: CodeGraphSourceCompleteness = "complete";
	let reason: CodeGraphSourceSection["reason"];
	if (completeText.length > limit) {
		lines = [];
		let used = 0;
		for (const line of body) {
			const cost = line.length + (lines.length > 0 ? 1 : 0);
			if (used + cost > limit) break;
			lines.push(line);
			used += cost;
		}
		if (lines.length === 0) return null;
		completeness = "partial";
		reason = "per-file-budget";
	}
	const visibleEndLine = startLine + lines.length - 1;
	const roleForContainer = CONTAINER_KINDS[node.kind] && completeness === "partial" ? "container-outline" : role;
	return {
		id: `${node.id}:${startLine}-${visibleEndLine}`,
		path: node.filePath,
		filePath: node.filePath,
		language: node.language,
		startLine,
		endLine: visibleEndLine,
		lineNumbers: Array.from({ length: lines.length }, (_, index) => startLine + index),
		lines,
		text: lines.join("\n"),
		role: roleForContainer,
		completeness,
		symbol: {
			id: node.id,
			name: node.name,
			qualifiedName: node.qualifiedName || node.name,
			kind: node.kind,
		},
		...(reason ? { reason } : {}),
	};
}

function toPublicFlow(
	chains: readonly ExplorerFlowChain[],
	queries: QueryBuilder,
	sectionByNode: ReadonlyMap<string, string>,
): CodeGraphFlowChain[] {
	const out: CodeGraphFlowChain[] = [];
	for (const chain of chains) {
		const first = chain.hops[0];
		const last = chain.hops[chain.hops.length - 1];
		if (!first || !last) continue;
		const start = queries.getNodeById(first.from);
		const end = queries.getNodeById(last.to);
		if (!start || !end) continue;
		const sourceSectionIds = [
			...new Set(
				chain.hops
					.flatMap(hop => [sectionByNode.get(hop.from), sectionByNode.get(hop.to)])
					.filter((id): id is string => id !== undefined),
			),
		];
		out.push({
			start,
			end,
			hops: chain.hops.map(hop => ({
				...hop,
				...(sectionByNode.get(hop.from) ? { sourceSectionId: sectionByNode.get(hop.from) } : {}),
			})),
			sourceSectionIds,
		});
	}
	return out;
}

export async function runExplore(ctx: ExplorerContext, rawQuery: string): Promise<EnrichedExploreResult> {
	const parsed = parseQuery(rawQuery);
	const requestedMode = ctx.mode ?? "auto";
	const mode = inferExploreMode(rawQuery, requestedMode);
	const projectFileCount = ctx.queryBuilder.getAllFiles().length;
	const budget = getCodeGraphExploreBudget(projectFileCount, ctx.maxFiles);
	const candidates: CodeGraphNode[] = [];
	const seen = new Set<string>();
	const push = (node: CodeGraphNode | undefined | null) => {
		if (!node || seen.has(node.id)) return;
		seen.add(node.id);
		candidates.push(node);
	};
	for (const term of extractProseCandidates(parsed.freeText)) {
		for (const variant of segmentLookupVariants(term)) {
			for (const node of ctx.queryBuilder.searchByTerm(variant, 25)) push(node);
		}
	}
	for (const symbol of extractSearchTerms(parsed.freeText, { stems: false })) {
		for (const node of ctx.queryBuilder.getNodesByName(symbol, 25)) push(node);
	}

	const ranked = rankCandidates(
		candidates.filter(node => matchesFilters(node, parsed)),
		parsed.freeText,
	);
	const entryNodes = dedupeByFile(ranked);
	const entryList = entryNodes.slice(0, budget.effectiveMaxFiles);
	const emptyCoverage = { complete: [], partial: [], omitted: [] };
	const emptyFreshness = {
		state: "fresh" as const,
		checkedAt: Date.now(),
		candidatePaths: [],
		stalePaths: [],
		files: [],
		sync: { state: "not-required" as const, paths: [] },
	};
	if (entryList.length === 0) {
		return {
			query: rawQuery,
			maxFiles: budget.effectiveMaxFiles,
			files: [],
			entries: [],
			confidence: "low",
			requestedMode,
			mode,
			sourceSections: [],
			entryCount: 0,
			edges: [],
			flow: [],
			blastRadius: null,
			relevance: ranked,
			testCandidates: [],
			coverage: emptyCoverage,
			freshness: emptyFreshness,
			budget,
		};
	}

	const edges: CodeGraphEdge[] = [];
	const targetGraphIds = new Set<string>();
	for (const entry of entryList) {
		for (const node of ctx.queryBuilder.getNodesByFile(entry.filePath)) {
			targetGraphIds.add(node.id);
			for (const edge of ctx.queryBuilder.getEdgesBySource(node.id)) edges.push(edge);
			for (const edge of ctx.queryBuilder.getEdgesByTarget(node.id)) edges.push(edge);
		}
	}
	const traverser = ctx.traverser ?? new GraphTraverser(ctx.queryBuilder);
	const internalFlow = computeFlowChains(ctx.queryBuilder, traverser, entryList);
	const focal = entryList[0] ?? null;
	const internalBlastRadius = focal ? computeBlastRadius(ctx.queryBuilder, traverser, focal) : null;
	const testCandidates = focal ? computeTestCandidates(ctx.queryBuilder, focal) : [];

	const targetIds = targetGraphIds;
	const related: Array<{ node: CodeGraphNode; test: boolean }> = [];
	if (mode === "understand" || mode === "edit" || mode === "impact") {
		for (const node of entryNodes.slice(entryList.length)) related.push({ node, test: false });
		for (const item of internalBlastRadius?.entries ?? []) related.push({ node: item.node, test: false });
		for (const edge of edges) {
			const relatedId = targetIds.has(edge.target)
				? edge.source
				: targetIds.has(edge.source)
					? edge.target
					: undefined;
			if (!relatedId) continue;
			const node = ctx.queryBuilder.getNodeById(relatedId);
			if (node) related.push({ node, test: false });
		}
		const targetNames = new Set(
			entryList.flatMap(node => [node.name.toLowerCase(), (node.qualifiedName || node.name).toLowerCase()]),
		);
		for (const reference of ctx.queryBuilder.getUnresolvedRefsByFile("")) {
			const referenceName = reference.referenceName.toLowerCase();
			const tail = referenceName.split(/::|[./]/u).at(-1);
			if (!targetNames.has(referenceName) && (!tail || !targetNames.has(tail))) continue;
			const node = ctx.queryBuilder.getNodeById(reference.fromNodeId);
			if (node) related.push({ node, test: isTestFile(node.filePath) });
		}
	}
	if (mode === "flow") {
		for (const chain of internalFlow) {
			for (const hop of chain.hops) {
				const from = ctx.queryBuilder.getNodeById(hop.from);
				const to = ctx.queryBuilder.getNodeById(hop.to);
				if (from) related.push({ node: from, test: false });
				if (to) related.push({ node: to, test: false });
			}
		}
	}
	if (mode === "impact") {
		for (const node of testCandidates) related.push({ node, test: true });
	}

	const ordered: Array<{ node: CodeGraphNode; target: boolean; test: boolean }> = entryList.map(node => ({
		node,
		target: true,
		test: false,
	}));
	const queued = new Set(entryList.map(node => node.id));
	for (const item of related) {
		if (queued.has(item.node.id)) continue;
		queued.add(item.node.id);
		ordered.push({ node: item.node, target: false, test: item.test });
	}

	const sourceSections: CodeGraphSourceSection[] = [];
	const complete: CodeGraphCoverageItem[] = [];
	const partial: CodeGraphCoverageItem[] = [];
	const omitted: CodeGraphCoverageItem[] = [];
	const fileCharacters = new Map<string, number>();
	const selectedFiles = new Set<string>();
	let charactersUsed = 0;
	for (const item of ordered) {
		const role = sourceRoleFor(mode, item.target, item.test);
		if (!selectedFiles.has(item.node.filePath) && selectedFiles.size >= budget.effectiveMaxFiles) {
			omitted.push(omittedCoverage(item.node, role, "file-limit"));
			continue;
		}
		const usedForFile = fileCharacters.get(item.node.filePath) ?? 0;
		const section = await buildSourceSection(
			ctx,
			item.node,
			role,
			budget.maxCharacters - charactersUsed,
			budget.maxCharactersPerFile - usedForFile,
		);
		if (!section) {
			omitted.push(
				omittedCoverage(item.node, role, charactersUsed >= budget.maxCharacters ? "budget" : "source-unavailable"),
			);
			continue;
		}
		sourceSections.push(section);
		selectedFiles.add(item.node.filePath);
		charactersUsed += section.text.length;
		fileCharacters.set(item.node.filePath, usedForFile + section.text.length);
		(section.completeness === "complete" ? complete : partial).push(coverageItem(section));
	}

	const sectionByNode = new Map(
		sourceSections.flatMap(section => (section.symbol ? [[section.symbol.id, section.id] as const] : [])),
	);
	const flow = toPublicFlow(internalFlow, ctx.queryBuilder, sectionByNode);
	const blastRadius: CodeGraphBlastRadius | null = internalBlastRadius
		? {
				focal: internalBlastRadius.focal,
				entries: internalBlastRadius.entries.map(entry => ({
					...entry,
					...(sectionByNode.get(entry.node.id) ? { sourceSectionId: sectionByNode.get(entry.node.id) } : {}),
				})),
				sourceSectionIds: [
					...new Set(
						internalBlastRadius.entries
							.map(entry => sectionByNode.get(entry.node.id))
							.filter((id): id is string => id !== undefined),
					),
				],
			}
		: null;
	const entries: CodeGraphExploreEntry[] = entryList.map(node => {
		const section = sourceSections.find(candidate => candidate.symbol?.id === node.id);
		return {
			node,
			lines: section?.lines ?? [],
			startLine: section?.startLine ?? Math.max(1, node.startLine),
			endLine: section?.endLine ?? Math.max(node.startLine, node.endLine),
			...(section
				? {
						text: section.text,
						lineNumbers: section.lineNumbers,
						sourceSectionId: section.id,
						completeness: section.completeness,
						...(section.reason ? { reason: section.reason } : {}),
					}
				: {}),
		};
	});
	const files: CodeGraphFileEntry[] = [...selectedFiles].map(filePath => ({
		filePath,
		language: sourceSections.find(section => section.filePath === filePath)?.language ?? "text",
		nodeCount: ctx.queryBuilder.getNodesByFile(filePath).length,
	}));
	budget.charactersUsed = charactersUsed;
	budget.filesUsed = selectedFiles.size;
	budget.sectionsUsed = sourceSections.length;
	budget.remainingCharacters = Math.max(0, budget.maxCharacters - charactersUsed);
	budget.exhausted = omitted.length > 0 || budget.remainingCharacters === 0;
	const candidatePaths = [...new Set([...selectedFiles, ...omitted.map(item => item.path)])];
	return {
		query: rawQuery,
		maxFiles: budget.effectiveMaxFiles,
		files,
		entries,
		confidence: "high",
		requestedMode,
		mode,
		sourceSections,
		entryCount: entryList.length,
		edges: dedupeEdges(edges),
		flow,
		blastRadius,
		relevance: ranked,
		testCandidates,
		coverage: { complete, partial, omitted },
		freshness: {
			state: "fresh",
			checkedAt: Date.now(),
			candidatePaths,
			stalePaths: [],
			files: candidatePaths.map(candidatePath => ({ path: candidatePath, state: "fresh" })),
			sync: { state: "not-required", paths: [] },
		},
		budget,
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
	const entryIds = new Set(entries.map(entry => entry.id));
	const cache = new Map<string, ExplorerFlowHop[]>();
	const hopsFrom = (id: string): ExplorerFlowHop[] => {
		const cached = cache.get(id);
		if (cached) return cached;
		const hops: ExplorerFlowHop[] = [];
		for (const edge of queries.getEdgesBySource(id)) {
			if (!FLOW_EDGE_KINDS.has(edge.kind)) continue;
			const metadata = (edge.metadata ?? {}) as Record<string, unknown>;
			const confidence =
				typeof metadata.confidence === "number" ? metadata.confidence : edge.provenance === "heuristic" ? 0.5 : 0.9;
			const resolvedBy = typeof metadata.resolvedBy === "string" ? metadata.resolvedBy : undefined;
			hops.push({
				from: edge.source,
				to: edge.target,
				edgeKind: edge.kind,
				provenance: edge.provenance,
				resolvedBy,
				confidence,
			});
		}
		const sourceNode = queries.getNodeById(id);
		if (sourceNode) {
			for (const reference of queries.getUnresolvedRefsByFile(sourceNode.filePath)) {
				if (reference.fromNodeId !== id) continue;
				const targetName = reference.referenceName.split(/::|[./]/u).at(-1) ?? reference.referenceName;
				const candidateKind: EdgeKind =
					reference.referenceKind === "function_ref" ? "references" : reference.referenceKind;
				const edgeKind: EdgeKind = FLOW_EDGE_KINDS.has(candidateKind) ? candidateKind : "references";
				for (const target of queries.getNodesByName(targetName, 10)) {
					if (target.id === id || hops.some(hop => hop.to === target.id && hop.edgeKind === edgeKind)) continue;
					hops.push({
						from: id,
						to: target.id,
						edgeKind,
						provenance: "heuristic",
						resolvedBy: "unresolved-name",
						confidence: 0.5,
					});
				}
			}
		}
		cache.set(id, hops);
		return hops;
	};

	const chains: ExplorerFlowChain[] = [];
	let remainingSteps = 1500;
	const walk = (startId: string, id: string, current: ExplorerFlowHop[], depth: number, seen: Set<string>) => {
		if (remainingSteps-- <= 0 || chains.length >= MAX_FLOW_CHAINS) return;
		for (const hop of hopsFrom(id)) {
			if (seen.has(hop.to)) continue;
			const next = [...current, hop];
			if (hop.to !== startId && entryIds.has(hop.to)) {
				chains.push({ hops: next });
				if (chains.length >= MAX_FLOW_CHAINS) return;
				continue;
			}
			if (depth >= MAX_FLOW_HOPS) continue;
			seen.add(hop.to);
			walk(startId, hop.to, next, depth + 1, seen);
			seen.delete(hop.to);
		}
	};
	for (const entry of entries.slice(0, MAX_FLOW_CHAINS)) {
		walk(entry.id, entry.id, [], 1, new Set([entry.id]));
		if (chains.length >= MAX_FLOW_CHAINS) break;
	}
	if (chains.length === 0) {
		for (const entry of entries) {
			for (const hop of hopsFrom(entry.id)) {
				chains.push({ hops: [hop] });
				if (chains.length >= MAX_FLOW_CHAINS) return chains;
			}
		}
	}
	chains.sort((left, right) => left.hops.length - right.hops.length);
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
	const focalNames = new Set([focal.name.toLowerCase(), (focal.qualifiedName || focal.name).toLowerCase()]);
	for (const reference of queries.getUnresolvedRefsByFile("")) {
		const referenceName = reference.referenceName.toLowerCase();
		const tail = referenceName.split(/::|[./]/u).at(-1);
		if (!focalNames.has(referenceName) && (!tail || !focalNames.has(tail))) continue;
		const next = queries.getNodeById(reference.fromNodeId);
		if (!next || visited.has(next.id)) continue;
		visited.add(next.id);
		const candidateKind: EdgeKind =
			reference.referenceKind === "function_ref" ? "references" : reference.referenceKind;
		const kind: EdgeKind = FLOW_EDGE_KINDS.has(candidateKind) ? candidateKind : "references";
		const via: CodeGraphEdge = {
			source: next.id,
			target: focal.id,
			kind,
			line: reference.line,
			column: reference.column,
			provenance: "heuristic",
			metadata: { resolvedBy: "unresolved-name", confidence: 0.5 },
		};
		entries.push({ node: next, via, depth: 1 });
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
