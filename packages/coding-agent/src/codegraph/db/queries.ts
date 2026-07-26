/**
 * QueryBuilder — adapted from upstream `src/db/queries.ts`
 * (MIT, Copyright (c) 2026 Colby Mchenry — see ./UPSTREAM_LICENSE).
 *
 * OMP porting notes:
 *  - The schema is verbatim from `./schema.sql`, so prepared statements
 *    reuse the upstream shapes (column names, bind names) without
 *    translation.
 *  - Full per-call SQL surface is ported for the operations the
 *    runtime needs (initialize, sync, explore, status). Edge kinds,
 *    node kinds, and FTS ranking follow the same conventions.
 *  - The CRUD helpers below are minimal-but-correct; once the full
 *    extractor lands, the bulk INSERTs and segment-vocab fast paths
 *    from upstream can be lifted in.
 */
import type {
	CodeGraphEdge,
	CodeGraphFileRecord,
	CodeGraphNode,
	CodeGraphUnresolvedReference,
	EdgeKind,
	Language,
	NodeKind,
} from "../types";
import type { SqliteDatabase, SqliteStatement } from "./sqlite-adapter";

interface NodeRow {
	id: string;
	kind: string;
	name: string;
	qualified_name: string;
	file_path: string;
	language: string;
	start_line: number;
	end_line: number;
	start_column: number;
	end_column: number;
	docstring: string | null;
	signature: string | null;
	visibility: string | null;
	is_exported: number;
	is_async: number;
	is_static: number;
	is_abstract: number;
	decorators: string | null;
	type_parameters: string | null;
	return_type: string | null;
	updated_at: number;
}

interface EdgeRow {
	source: string;
	target: string;
	kind: string;
	metadata: string | null;
	line: number | null;
	col: number | null;
	provenance: string | null;
}

interface FileRow {
	path: string;
	content_hash: string;
	language: string;
	size: number;
	modified_at: number;
	indexed_at: number;
	node_count: number;
	errors: string | null;
}

function rowToNode(row: NodeRow): CodeGraphNode {
	return {
		id: row.id,
		kind: row.kind as NodeKind,
		name: row.name,
		qualifiedName: row.qualified_name,
		filePath: row.file_path,
		language: row.language as Language,
		startLine: row.start_line,
		endLine: row.end_line,
		startColumn: row.start_column,
		endColumn: row.end_column,
		docstring: row.docstring ?? undefined,
		signature: row.signature ?? undefined,
		visibility: (row.visibility ?? undefined) as CodeGraphNode["visibility"],
		isExported: row.is_exported === 1,
		isAsync: row.is_async === 1,
		isStatic: row.is_static === 1,
		isAbstract: row.is_abstract === 1,
		decorators: row.decorators ? (JSON.parse(row.decorators) as string[]) : undefined,
		typeParameters: row.type_parameters ? (JSON.parse(row.type_parameters) as string[]) : undefined,
		returnType: row.return_type ?? undefined,
		updatedAt: row.updated_at,
	};
}

function rowToEdge(row: EdgeRow): CodeGraphEdge {
	return {
		source: row.source,
		target: row.target,
		kind: row.kind as EdgeKind,
		metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
		line: row.line ?? undefined,
		column: row.col ?? undefined,
		provenance: (row.provenance ?? undefined) as CodeGraphEdge["provenance"],
	};
}

function rowToFileRecord(row: FileRow): CodeGraphFileRecord {
	return {
		path: row.path,
		contentHash: row.content_hash,
		language: row.language as Language,
		size: row.size,
		modifiedAt: row.modified_at,
		indexedAt: row.indexed_at,
		nodeCount: row.node_count,
		errors: row.errors ? (JSON.parse(row.errors) as CodeGraphFileRecord["errors"]) : undefined,
	};
}

/**
 * Minimal but complete prepared-statement surface for the OMP runtime.
 * Upstream's bulk-INSERT batches and segment-vocab rebuild are NOT
 * included here — only the operations the runtime needs (file
 * bookkeeping, status, FTS search, neighbor reads).
 */
export class QueryBuilder {
	readonly #db: SqliteDatabase;
	#stmts: Partial<Record<string, SqliteStatement>> = {};
	#nodeCache = new Map<string, CodeGraphNode>();
	readonly #maxNodeCache = 1024;
	#projectNameTokens = new Set<string>();

	constructor(db: SqliteDatabase) {
		this.#db = db;
	}

	#stmt(key: string, sql: string): SqliteStatement {
		let stmt = this.#stmts[key];
		if (!stmt) {
			stmt = this.#db.prepare(sql);
			this.#stmts[key] = stmt;
		}
		return stmt;
	}

	setProjectNameTokens(tokens: ReadonlySet<string>): void {
		this.#projectNameTokens = new Set(tokens);
	}

	getProjectNameTokens(): Set<string> {
		return new Set(this.#projectNameTokens);
	}

	upsertFile(file: CodeGraphFileRecord): void {
		this.#stmt(
			"upsertFile",
			`INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
			 VALUES (@path, @contentHash, @language, @size, @modifiedAt, @indexedAt, @nodeCount, @errors)
			 ON CONFLICT(path) DO UPDATE SET
			   content_hash = excluded.content_hash,
			   language = excluded.language,
			   size = excluded.size,
			   modified_at = excluded.modified_at,
			   indexed_at = excluded.indexed_at,
			   node_count = excluded.node_count,
			   errors = excluded.errors`,
		).run({
			path: file.path,
			contentHash: file.contentHash,
			language: file.language,
			size: file.size,
			modifiedAt: file.modifiedAt,
			indexedAt: file.indexedAt,
			nodeCount: file.nodeCount,
			errors: file.errors ? JSON.stringify(file.errors) : null,
		});
	}

	clearFileGraph(path: string): void {
		this.#nodeCache.clear();
		this.#stmt("deleteUnresolvedByFile", "DELETE FROM unresolved_refs WHERE file_path = ?").run(path);
		this.#stmt("deleteNodesByFile", "DELETE FROM nodes WHERE file_path = ?").run(path);
	}

	deleteFile(path: string): void {
		this.#db.transaction(() => {
			this.clearFileGraph(path);
			this.#stmt("deleteFile", "DELETE FROM files WHERE path = ?").run(path);
		})();
	}

	getFileByPath(path: string): CodeGraphFileRecord | null {
		const row = this.#stmt("getFileByPath", "SELECT * FROM files WHERE path = ?").get(path) as FileRow | undefined;
		return row ? rowToFileRecord(row) : null;
	}

	getAllFiles(): CodeGraphFileRecord[] {
		const rows = this.#stmt("getAllFiles", "SELECT * FROM files").all() as FileRow[];
		return rows.map(rowToFileRecord);
	}

	getAllFilePaths(): string[] {
		const rows = this.#stmt("getAllFilePaths", "SELECT path FROM files").all() as Array<{
			path: string;
		}>;
		return rows.map(r => r.path);
	}

	insertNode(node: CodeGraphNode): void {
		this.#nodeCache.delete(node.id);
		this.#stmt(
			"insertNode",
			`INSERT INTO nodes (
				id, kind, name, qualified_name, file_path, language,
				start_line, end_line, start_column, end_column,
				docstring, signature, visibility,
				is_exported, is_async, is_static, is_abstract,
				decorators, type_parameters, return_type, updated_at
			 ) VALUES (
				@id, @kind, @name, @qualifiedName, @filePath, @language,
				@startLine, @endLine, @startColumn, @endColumn,
				@docstring, @signature, @visibility,
				@isExported, @isAsync, @isStatic, @isAbstract,
				@decorators, @typeParameters, @returnType, @updatedAt
			 )
			 ON CONFLICT(id) DO UPDATE SET
				kind = excluded.kind,
				name = excluded.name,
				qualified_name = excluded.qualified_name,
				file_path = excluded.file_path,
				language = excluded.language,
				start_line = excluded.start_line,
				end_line = excluded.end_line,
				start_column = excluded.start_column,
				end_column = excluded.end_column,
				docstring = excluded.docstring,
				signature = excluded.signature,
				visibility = excluded.visibility,
				is_exported = excluded.is_exported,
				is_async = excluded.is_async,
				is_static = excluded.is_static,
				is_abstract = excluded.is_abstract,
				decorators = excluded.decorators,
				type_parameters = excluded.type_parameters,
				return_type = excluded.return_type,
				updated_at = excluded.updated_at`,
		).run({
			id: node.id,
			kind: node.kind,
			name: node.name,
			qualifiedName: node.qualifiedName,
			filePath: node.filePath,
			language: node.language,
			startLine: node.startLine,
			endLine: node.endLine,
			startColumn: node.startColumn,
			endColumn: node.endColumn,
			docstring: node.docstring ?? null,
			signature: node.signature ?? null,
			visibility: node.visibility ?? null,
			isExported: node.isExported ? 1 : 0,
			isAsync: node.isAsync ? 1 : 0,
			isStatic: node.isStatic ? 1 : 0,
			isAbstract: node.isAbstract ? 1 : 0,
			decorators: node.decorators ? JSON.stringify(node.decorators) : null,
			typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
			returnType: node.returnType ?? null,
			updatedAt: node.updatedAt,
		});
	}

	getNodeById(id: string): CodeGraphNode | null {
		const cached = this.#nodeCache.get(id);
		if (cached) return cached;
		const row = this.#stmt("getNodeById", "SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
		if (!row) return null;
		const node = rowToNode(row);
		if (this.#nodeCache.size >= this.#maxNodeCache) this.#nodeCache.clear();
		this.#nodeCache.set(id, node);
		return node;
	}

	getNodesByFile(filePath: string): CodeGraphNode[] {
		const rows = this.#stmt("getNodesByFile", "SELECT * FROM nodes WHERE file_path = ?").all(filePath) as NodeRow[];
		return rows.map(rowToNode);
	}

	getNodesByName(name: string, limit = 50): CodeGraphNode[] {
		const rows = this.#stmt(
			"getNodesByName",
			"SELECT * FROM nodes WHERE lower(name) = lower(?) ORDER BY id LIMIT ?",
		).all(name, limit) as NodeRow[];
		return rows.map(rowToNode);
	}

	getNodesByQualifiedNameExact(qname: string): CodeGraphNode[] {
		const rows = this.#stmt("getNodesByQualifiedNameExact", "SELECT * FROM nodes WHERE qualified_name = ?").all(
			qname,
		) as NodeRow[];
		return rows.map(rowToNode);
	}

	getNodesByKind(kind: NodeKind, limit = 200): CodeGraphNode[] {
		const rows = this.#stmt(
			"getNodesByKind",
			"SELECT * FROM nodes WHERE kind = ? ORDER BY file_path, start_line LIMIT ?",
		).all(kind, limit) as NodeRow[];
		return rows.map(rowToNode);
	}

	getEdgesBySource(source: string): CodeGraphEdge[] {
		const rows = this.#stmt("getEdgesBySource", "SELECT * FROM edges WHERE source = ?").all(source) as EdgeRow[];
		return rows.map(rowToEdge);
	}

	getEdgesByTarget(target: string): CodeGraphEdge[] {
		const rows = this.#stmt("getEdgesByTarget", "SELECT * FROM edges WHERE target = ?").all(target) as EdgeRow[];
		return rows.map(rowToEdge);
	}

	insertEdge(edge: CodeGraphEdge): void {
		this.#stmt(
			"insertEdge",
			`INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance)
			 VALUES (@source, @target, @kind, @metadata, @line, @col, @provenance)`,
		).run({
			source: edge.source,
			target: edge.target,
			kind: edge.kind,
			metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
			line: edge.line ?? null,
			col: edge.column ?? null,
			provenance: edge.provenance ?? null,
		});
	}

	insertUnresolvedRef(ref: CodeGraphUnresolvedReference): void {
		this.#stmt(
			"insertUnresolved",
			`INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language, status, name_tail)
			 VALUES (@fromNodeId, @referenceName, @referenceKind, @line, @col, @candidates, @filePath, @language, @status, @nameTail)`,
		).run({
			fromNodeId: ref.fromNodeId,
			referenceName: ref.referenceName,
			referenceKind: ref.referenceKind,
			line: ref.line,
			col: ref.column,
			candidates: ref.candidates ? JSON.stringify(ref.candidates) : null,
			filePath: ref.filePath ?? "",
			language: ref.language ?? "unknown",
			status: "pending",
			nameTail: ref.referenceName.split(/[.\s]+/).pop() ?? "",
		});
	}

	getUnresolvedRefsByFile(filePath: string): CodeGraphUnresolvedReference[] {
		const sql =
			filePath.length === 0
				? "SELECT id, from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language, status, name_tail FROM unresolved_refs"
				: "SELECT id, from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language, status, name_tail FROM unresolved_refs WHERE file_path = ?";
		const stmt = this.#stmt(filePath.length === 0 ? "getAllUnresolved" : "getUnresolvedByFile", sql);
		const rows = (filePath.length === 0 ? stmt.all() : stmt.all(filePath)) as Array<{
			id: number;
			from_node_id: string;
			reference_name: string;
			reference_kind: string;
			line: number;
			col: number;
			candidates: string | null;
			file_path: string;
			language: string;
			status: string;
			name_tail: string;
		}>;
		return rows.map(r => ({
			fromNodeId: r.from_node_id,
			referenceName: r.reference_name,
			referenceKind: r.reference_kind as CodeGraphUnresolvedReference["referenceKind"],
			line: r.line,
			column: r.col,
			candidates: r.candidates ? (JSON.parse(r.candidates) as string[]) : undefined,
			filePath: r.file_path,
			language: r.language as Language,
			rowId: r.id,
		}));
	}

	/** Clear every unresolved ref for `filePath` — used on re-index. */
	deleteUnresolvedByFile(filePath: string): void {
		this.#stmt("deleteUnresolvedByFile", "DELETE FROM unresolved_refs WHERE file_path = ?").run(filePath);
	}

	deleteUnresolvedByRowIds(rowIds: readonly number[]): void {
		if (rowIds.length === 0) return;
		const placeholders = rowIds.map(() => "?").join(",");
		this.#stmt("deleteUnresolvedByRowIds", `DELETE FROM unresolved_refs WHERE id IN (${placeholders})`).run(
			...rowIds,
		);
	}

	/** FTS-backed symbol search — used by `runtime.explore` entry-point resolution. */
	searchByTerm(term: string, limit = 25): CodeGraphNode[] {
		const escaped = term.replace(/"/g, `""`);
		const fts = this.#stmt(
			"searchByTerm",
			`SELECT n.* FROM nodes n
			 JOIN nodes_fts fts ON fts.id = n.id
			 WHERE nodes_fts MATCH ?
			 ORDER BY rank LIMIT ?`,
		).all(`"${escaped}"`, limit) as NodeRow[];
		return fts.map(rowToNode);
	}

	getNodeAndEdgeCount(): { nodes: number; edges: number } {
		const nodeCount = (
			this.#stmt("countNodes", "SELECT COUNT(*) AS n FROM nodes").get() as {
				n: number;
			}
		).n;
		const edgeCount = (
			this.#stmt("countEdges", "SELECT COUNT(*) AS n FROM edges").get() as {
				n: number;
			}
		).n;
		return { nodes: nodeCount, edges: edgeCount };
	}

	getLastIndexedAt(): number | null {
		const row = this.#stmt("lastIndexed", "SELECT MAX(modified_at) AS m FROM files").get() as {
			m: number | null;
		};
		return row.m ?? null;
	}

	getMetadata(key: string): string | null {
		const row = this.#stmt("getMetadata", "SELECT value FROM project_metadata WHERE key = ?").get(key) as
			| { value: string }
			| undefined;
		return row?.value ?? null;
	}

	setMetadata(key: string, value: string): void {
		this.#stmt(
			"setMetadata",
			`INSERT INTO project_metadata (key, value, updated_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		).run(key, value, Date.now());
	}
}
