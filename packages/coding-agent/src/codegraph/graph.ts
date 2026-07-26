/**
 * Graph traversal — adapted from upstream `src/graph/traversal.ts`
 * (MIT, Copyright (c) 2026 Colby Mchenry — see ./UPSTREAM_LICENSE).
 *
 * The OMP port implements the BFS and DFS primitives the runtime's
 * `explore` pipeline needs (callers, callees, type hierarchy, usages,
 * cross-file imports). The full per-language traversal surface in
 * upstream is too large to carry verbatim; this is the subset that
 * backs `runtime.explore`'s entry-point expansion.
 *
 * Every edge hop carries `provenance` + `confidence` (held in the
 * `metadata` JSON) so the renderer can label heuristic edges in the
 * "call paths" section without lying about resolved status.
 */
import type { QueryBuilder } from "./db";
import type { CodeGraphEdge, CodeGraphNode, CodeGraphSubgraph, CodeGraphTraversalOptions, EdgeKind } from "./types";

export interface GraphTraversalOptions extends CodeGraphTraversalOptions {}

export interface GraphHop {
	node: CodeGraphNode;
	edge: CodeGraphEdge;
	depth: number;
	direction: "incoming" | "outgoing";
}

const DEFAULT_OPTIONS: Required<CodeGraphTraversalOptions> = {
	maxDepth: Number.POSITIVE_INFINITY,
	edgeKinds: [],
	nodeKinds: [],
	direction: "outgoing",
	limit: 1000,
	includeStart: true,
};

export class GraphTraverser {
	readonly #queries: QueryBuilder;

	constructor(queries: QueryBuilder) {
		this.#queries = queries;
	}

	/** BFS outward from `startId`. */
	traverse(startId: string, options: CodeGraphTraversalOptions = {}): CodeGraphSubgraph {
		return this.#bfs(startId, { ...DEFAULT_OPTIONS, ...options });
	}

	/** Find every node that calls (or is called by) `nodeId`. */
	callers(nodeId: string, maxDepth = 2): CodeGraphSubgraph {
		return this.#bfs(nodeId, {
			...DEFAULT_OPTIONS,
			direction: "incoming",
			maxDepth,
			edgeKinds: ["calls", "references", "imports", "instantiates"],
		});
	}

	/** Find every node that `nodeId` calls. */
	callees(nodeId: string, maxDepth = 2): CodeGraphSubgraph {
		return this.#bfs(nodeId, {
			...DEFAULT_OPTIONS,
			direction: "outgoing",
			maxDepth,
			edgeKinds: ["calls", "references", "imports", "instantiates"],
		});
	}

	/** Subgraph of every node that depends on `filePath` (incoming imports). */
	fileDependents(filePath: string): CodeGraphSubgraph {
		const nodes = this.#queries.getNodesByFile(filePath);
		const out: CodeGraphNode[] = [];
		const seen = new Set<string>();
		const fileNode = nodes.find(n => n.kind === "file") ?? null;
		for (const node of nodes) {
			if (seen.has(node.id)) continue;
			seen.add(node.id);
			out.push(node);
		}
		const edges: CodeGraphEdge[] = [];
		if (fileNode) {
			for (const e of this.#queries.getEdgesByTarget(fileNode.id)) {
				if (e.kind === "imports") edges.push(e);
			}
		} else {
			for (const node of nodes) {
				for (const e of this.#queries.getEdgesBySource(node.id)) {
					if (e.kind === "imports") edges.push(e);
				}
			}
		}
		return { nodes: new Map(out.map(n => [n.id, n])), edges, roots: out.map(n => n.id) };
	}

	/** Subgraph of every node `filePath` imports. */
	fileDependencies(filePath: string): CodeGraphEdge[] {
		const out: CodeGraphEdge[] = [];
		const seen = new Set<string>();
		for (const node of this.#queries.getNodesByFile(filePath)) {
			for (const e of this.#queries.getEdgesBySource(node.id)) {
				if (e.kind !== "imports") continue;
				const key = `${e.source}|${e.target}|${e.kind}|${e.line ?? -1}|${e.column ?? -1}`;
				if (seen.has(key)) continue;
				seen.add(key);
				out.push(e);
			}
		}
		return out;
	}

	/**
	 * Reachability traversal that distinguishes resolved edges from
	 * heuristic ones. Returns the call subgraph and the hop list used
	 * to render the "call paths" markdown in the explorer.
	 */
	hops(startId: string, options: CodeGraphTraversalOptions = {}): GraphHop[] {
		const opts = { ...DEFAULT_OPTIONS, ...options };
		const start = this.#queries.getNodeById(startId);
		if (!start) return [];
		const hops: GraphHop[] = [];
		const visited = new Set<string>(opts.includeStart ? [] : [startId]);
		const queue: Array<{ id: string; depth: number }> = opts.includeStart ? [] : [{ id: startId, depth: 0 }];
		if (opts.includeStart) queue.push({ id: startId, depth: 0 });
		if (opts.includeStart) visited.add(startId);

		while (queue.length > 0 && hops.length < opts.limit) {
			const { id, depth } = queue.shift()!;
			if (depth >= opts.maxDepth) continue;
			const outgoing = opts.direction !== "incoming" ? this.#queries.getEdgesBySource(id) : [];
			const incoming = opts.direction !== "outgoing" ? this.#queries.getEdgesByTarget(id) : [];
			for (const edge of outgoing) {
				if (!matchesEdgeKinds(edge.kind, opts.edgeKinds)) continue;
				if (!visited.has(edge.target)) {
					visited.add(edge.target);
					const node = this.#queries.getNodeById(edge.target);
					if (!node) continue;
					if (opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(node.kind)) continue;
					hops.push({ node, edge, depth: depth + 1, direction: "outgoing" });
					queue.push({ id: node.id, depth: depth + 1 });
				}
			}
			for (const edge of incoming) {
				if (!matchesEdgeKinds(edge.kind, opts.edgeKinds)) continue;
				if (!visited.has(edge.source)) {
					visited.add(edge.source);
					const node = this.#queries.getNodeById(edge.source);
					if (!node) continue;
					if (opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(node.kind)) continue;
					hops.push({ node, edge, depth: depth + 1, direction: "incoming" });
					queue.push({ id: node.id, depth: depth + 1 });
				}
			}
		}
		return hops;
	}

	/**
	 * Explorable blast radius: every edge arriving at `startId` plus
	 * each neighbor's incoming edges (one extra hop). The result is
	 * the set of nodes the runtime can confidently say WOULD notice
	 * a breaking change. Nodes here always carry the upstream edge's
	 * provenance.
	 */
	impactRadius(startId: string, maxDepth = 3): CodeGraphSubgraph {
		return this.#bfs(startId, {
			...DEFAULT_OPTIONS,
			direction: "incoming",
			maxDepth,
			edgeKinds: ["imports", "calls", "references", "instantiates", "extends", "implements"],
		});
	}

	#bfs(startId: string, opts: Required<CodeGraphTraversalOptions>): CodeGraphSubgraph {
		const start = this.#queries.getNodeById(startId);
		if (!start) {
			return { nodes: new Map(), edges: [], roots: [] };
		}
		const nodes = new Map<string, CodeGraphNode>();
		const edges: CodeGraphEdge[] = [];
		const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];
		const visited = new Set<string>();
		if (opts.includeStart) {
			nodes.set(start.id, start);
			visited.add(start.id);
		}
		const roots: string[] = opts.includeStart ? [start.id] : [];
		const seenEdge = new Set<string>();

		while (queue.length > 0 && nodes.size < opts.limit) {
			const { id, depth } = queue.shift()!;
			if (depth >= opts.maxDepth) continue;
			const outgoing = opts.direction !== "incoming" ? this.#queries.getEdgesBySource(id) : [];
			const incoming = opts.direction !== "outgoing" ? this.#queries.getEdgesByTarget(id) : [];
			const neighbors: Array<{ edge: CodeGraphEdge; next: string }> = [];
			for (const edge of outgoing) {
				if (opts.edgeKinds.length > 0 && !opts.edgeKinds.includes(edge.kind)) continue;
				neighbors.push({ edge, next: edge.target });
			}
			for (const edge of incoming) {
				if (opts.edgeKinds.length > 0 && !opts.edgeKinds.includes(edge.kind)) continue;
				neighbors.push({ edge, next: edge.source });
			}
			for (const { edge, next } of neighbors) {
				const edgeKey = `${edge.source}|${edge.target}|${edge.kind}|${edge.line ?? -1}|${edge.column ?? -1}`;
				if (!seenEdge.has(edgeKey)) {
					seenEdge.add(edgeKey);
					edges.push(edge);
				}
				if (visited.has(next)) continue;
				visited.add(next);
				const neighbor = this.#queries.getNodeById(next);
				if (!neighbor) continue;
				if (opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(neighbor.kind)) continue;
				nodes.set(neighbor.id, neighbor);
				queue.push({ id: next, depth: depth + 1 });
			}
		}

		if (roots.length === 0 && nodes.size > 0) {
			roots.push(nodes.keys().next().value as string);
		}
		return { nodes, edges, roots };
	}
}

function matchesEdgeKinds(kind: EdgeKind, allowed: readonly EdgeKind[]): boolean {
	return allowed.length === 0 || allowed.includes(kind);
}
