/**
 * Decode the native kernel's fixed-width tables into public CodeGraph shapes.
 * The offsets in `layout.ts` mirror `crates/pi-natives/src/codegraph/buffers.rs`.
 */
import type {
	CodeGraphEdge,
	CodeGraphExtractionError,
	CodeGraphNode,
	CodeGraphUnresolvedReference,
	EdgeKind,
	Language,
	NodeKind,
	ReferenceKind,
} from "../../types";
import { EDGE_KINDS, NODE_KINDS } from "../../types";
import {
	EDGE,
	EDGE_ROW_SIZE,
	FLAG,
	FUNCTION_REF_CODE,
	KERNEL_ABI_VERSION,
	META,
	META_SIZE,
	NODE,
	NODE_ROW_SIZE,
	NONE,
	PROVENANCES,
	REF,
	REF_FLAG_FILE_PATH,
	REF_ROW_SIZE,
	VISIBILITIES,
} from "./layout";
import type { KernelBuffers } from "./loader";

const textDecoder = new TextDecoder("utf-8");

function readRow(table: Uint8Array, index: number, rowSize: number, tableName: string): DataView {
	const offset = index * rowSize;
	if (offset + rowSize > table.byteLength) {
		throw new Error(`${tableName} row ${index} exceeds ${table.byteLength}-byte buffer`);
	}
	return new DataView(table.buffer, table.byteOffset + offset, rowSize);
}

function readStringAt(arena: Uint8Array, row: DataView, at: number): string | undefined {
	const offset = row.getUint32(at, true);
	if (offset === NONE) return undefined;
	const length = row.getUint32(at + 4, true);
	if (offset + length > arena.byteLength) {
		throw new Error(`string range ${offset}+${length} exceeds ${arena.byteLength}-byte arena`);
	}
	return textDecoder.decode(arena.subarray(offset, offset + length));
}

function readStringList(arena: Uint8Array, row: DataView, at: number): string[] | undefined {
	const joined = readStringAt(arena, row, at);
	return joined === undefined ? undefined : joined.split("\0");
}

function readFlag(flags: number, pair: number): boolean | undefined {
	if ((flags & (1 << (pair * 2))) === 0) return undefined;
	return (flags & (1 << (pair * 2 + 1))) !== 0;
}

function readOptionalU32(row: DataView, at: number): number | undefined {
	const value = row.getUint32(at, true);
	return value === NONE ? undefined : value;
}

function resolveNodeId(arena: Uint8Array, row: DataView, index: number, fallbackAt: number, ids: string[]): string {
	const id = index === NONE ? readStringAt(arena, row, fallbackAt) : ids[index];
	if (!id) throw new Error(`kernel row references missing node ${index}`);
	return id;
}

export interface DecodedExtraction {
	nodes: CodeGraphNode[];
	edges: CodeGraphEdge[];
	refs: CodeGraphUnresolvedReference[];
	errors: CodeGraphExtractionError[];
}

export function decodeExtractBuffers(buffers: KernelBuffers, filePath: string, language: Language): DecodedExtraction {
	if (buffers.meta.byteLength < META_SIZE) {
		throw new Error(`kernel meta too short: ${buffers.meta.byteLength}`);
	}
	const meta = new DataView(buffers.meta.buffer, buffers.meta.byteOffset, buffers.meta.byteLength);
	const version = meta.getUint8(META.version);
	if (version !== KERNEL_ABI_VERSION) {
		throw new Error(`kernel buffer ABI ${version} != expected ${KERNEL_ABI_VERSION}`);
	}
	const nodeCount = meta.getUint32(META.nodeCount, true);
	const edgeCount = meta.getUint32(META.edgeCount, true);
	const refCount = meta.getUint32(META.refCount, true);
	const arenaLength = meta.getUint32(META.arenaLen, true);
	if (buffers.nodes.byteLength !== nodeCount * NODE_ROW_SIZE) {
		throw new Error(`kernel node table length ${buffers.nodes.byteLength} != ${nodeCount * NODE_ROW_SIZE}`);
	}
	if (buffers.edges.byteLength !== edgeCount * EDGE_ROW_SIZE) {
		throw new Error(`kernel edge table length ${buffers.edges.byteLength} != ${edgeCount * EDGE_ROW_SIZE}`);
	}
	if (buffers.refs.byteLength !== refCount * REF_ROW_SIZE) {
		throw new Error(`kernel ref table length ${buffers.refs.byteLength} != ${refCount * REF_ROW_SIZE}`);
	}
	if (buffers.arena.byteLength !== arenaLength) {
		throw new Error(`kernel arena length ${buffers.arena.byteLength} != ${arenaLength}`);
	}

	const now = Date.now();
	const nodes: CodeGraphNode[] = new Array(nodeCount);
	const idByRow: string[] = new Array(nodeCount);
	for (let index = 0; index < nodeCount; index += 1) {
		const row = readRow(buffers.nodes, index, NODE_ROW_SIZE, "node");
		const id = readStringAt(buffers.arena, row, NODE.id);
		const name = readStringAt(buffers.arena, row, NODE.name);
		const qualifiedName = readStringAt(buffers.arena, row, NODE.qualifiedName);
		const kind = NODE_KINDS[row.getUint8(NODE.kind)] as NodeKind | undefined;
		if (!id || !name || !qualifiedName || !kind) throw new Error(`invalid kernel node row ${index}`);
		idByRow[index] = id;
		const flags = row.getUint16(NODE.flags, true);
		const node: CodeGraphNode = {
			id,
			kind,
			name,
			qualifiedName,
			filePath,
			language,
			startLine: row.getUint32(NODE.startLine, true),
			endLine: row.getUint32(NODE.endLine, true),
			startColumn: row.getUint32(NODE.startColumn, true),
			endColumn: row.getUint32(NODE.endColumn, true),
			updatedAt: now,
		};
		const docstring = readStringAt(buffers.arena, row, NODE.docstring);
		if (docstring !== undefined) node.docstring = docstring;
		const signature = readStringAt(buffers.arena, row, NODE.signature);
		if (signature !== undefined) node.signature = signature;
		const visibility = VISIBILITIES[row.getUint8(NODE.visibility)];
		if (visibility !== undefined) node.visibility = visibility;
		const isExported = readFlag(flags, FLAG.isExported);
		if (isExported !== undefined) node.isExported = isExported;
		const isAsync = readFlag(flags, FLAG.isAsync);
		if (isAsync !== undefined) node.isAsync = isAsync;
		const isStatic = readFlag(flags, FLAG.isStatic);
		if (isStatic !== undefined) node.isStatic = isStatic;
		const isAbstract = readFlag(flags, FLAG.isAbstract);
		if (isAbstract !== undefined) node.isAbstract = isAbstract;
		const decorators = readStringList(buffers.arena, row, NODE.decorators);
		if (decorators !== undefined) node.decorators = decorators;
		const typeParameters = readStringList(buffers.arena, row, NODE.typeParameters);
		if (typeParameters !== undefined) node.typeParameters = typeParameters;
		const returnType = readStringAt(buffers.arena, row, NODE.returnType);
		if (returnType !== undefined) node.returnType = returnType;
		const extraJson = readStringAt(buffers.arena, row, NODE.extraJson);
		if (extraJson !== undefined) Object.assign(node, JSON.parse(extraJson) as Partial<CodeGraphNode>);
		nodes[index] = node;
	}

	const edges: CodeGraphEdge[] = new Array(edgeCount);
	for (let index = 0; index < edgeCount; index += 1) {
		const row = readRow(buffers.edges, index, EDGE_ROW_SIZE, "edge");
		const kind = EDGE_KINDS[row.getUint8(EDGE.kind)] as EdgeKind | undefined;
		if (!kind) throw new Error(`invalid kernel edge kind in row ${index}`);
		const edge: CodeGraphEdge = {
			source: resolveNodeId(buffers.arena, row, row.getUint32(EDGE.sourceIdx, true), EDGE.sourceIdStr, idByRow),
			target: resolveNodeId(buffers.arena, row, row.getUint32(EDGE.targetIdx, true), EDGE.targetIdStr, idByRow),
			kind,
		};
		const line = readOptionalU32(row, EDGE.line);
		if (line !== undefined) edge.line = line;
		const column = readOptionalU32(row, EDGE.column);
		if (column !== undefined) edge.column = column;
		const provenance = PROVENANCES[row.getUint8(EDGE.provenance)];
		if (provenance !== undefined) edge.provenance = provenance;
		const metadataJson = readStringAt(buffers.arena, row, EDGE.metadataJson);
		if (metadataJson !== undefined) edge.metadata = JSON.parse(metadataJson) as Record<string, unknown>;
		edges[index] = edge;
	}

	const refs: CodeGraphUnresolvedReference[] = new Array(refCount);
	for (let index = 0; index < refCount; index += 1) {
		const row = readRow(buffers.refs, index, REF_ROW_SIZE, "ref");
		const kindByte = row.getUint8(REF.kind);
		const referenceKind =
			kindByte === FUNCTION_REF_CODE ? "function_ref" : (EDGE_KINDS[kindByte] as ReferenceKind | undefined);
		if (!referenceKind) throw new Error(`invalid kernel reference kind in row ${index}`);
		const referenceName = readStringAt(buffers.arena, row, REF.referenceName);
		if (!referenceName) throw new Error(`missing kernel reference name in row ${index}`);
		const ref: CodeGraphUnresolvedReference = {
			fromNodeId: resolveNodeId(buffers.arena, row, row.getUint32(REF.fromIdx, true), REF.fromIdStr, idByRow),
			referenceName,
			referenceKind,
			line: row.getUint32(REF.line, true),
			column: row.getUint32(REF.column, true),
		};
		if ((row.getUint8(REF.flags) & REF_FLAG_FILE_PATH) !== 0) ref.filePath = filePath;
		const candidates = readStringList(buffers.arena, row, REF.candidates);
		if (candidates !== undefined) ref.candidates = candidates;
		refs[index] = ref;
	}

	let errors: CodeGraphExtractionError[] = [];
	const errorsOffset = meta.getUint32(META.errorsOff, true);
	if (errorsOffset !== NONE) {
		const errorsLength = meta.getUint32(META.errorsLen, true);
		if (errorsOffset + errorsLength > buffers.arena.byteLength) throw new Error("kernel errors range exceeds arena");
		errors = JSON.parse(
			textDecoder.decode(buffers.arena.subarray(errorsOffset, errorsOffset + errorsLength)),
		) as CodeGraphExtractionError[];
	}
	return { nodes, edges, refs, errors };
}
