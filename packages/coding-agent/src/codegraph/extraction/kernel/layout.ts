/**
 * Native-kernel buffer layout — byte-for-byte mirror of
 * `crates/pi-natives/src/codegraph/buffers.rs`.
 *
 * Rows are fixed-width little-endian; strings are `(offset, length)` pairs
 * into the UTF-8 arena. Any layout change MUST bump `KERNEL_ABI_VERSION` on
 * both sides so an incompatible addon falls back instead of being decoded.
 */

export const KERNEL_ABI_VERSION = 2;
export const NONE = 0xffffffff;

export const META_SIZE = 36;
export const NODE_ROW_SIZE = 96;
export const EDGE_ROW_SIZE = 44;
export const REF_ROW_SIZE = 40;

export const META = {
	version: 0,
	nodeCount: 4,
	edgeCount: 8,
	refCount: 12,
	arenaLen: 16,
	errorsOff: 20,
	errorsLen: 24,
	durationMs: 28,
} as const;

export const NODE = {
	kind: 0,
	visibility: 1,
	flags: 2,
	startLine: 4,
	endLine: 8,
	startColumn: 12,
	endColumn: 16,
	name: 20,
	qualifiedName: 28,
	id: 36,
	docstring: 44,
	signature: 52,
	decorators: 60,
	typeParameters: 68,
	returnType: 76,
	extraJson: 84,
	metrics: 92,
} as const;

export const EDGE = {
	sourceIdx: 0,
	targetIdx: 4,
	kind: 8,
	provenance: 9,
	line: 12,
	column: 16,
	metadataJson: 20,
	sourceIdStr: 28,
	targetIdStr: 36,
} as const;

export const REF = {
	fromIdx: 0,
	kind: 4,
	flags: 5,
	line: 8,
	column: 12,
	referenceName: 16,
	candidates: 24,
	fromIdStr: 32,
} as const;

export const FUNCTION_REF_CODE = 200;
export const REF_FLAG_FILE_PATH = 1;

export const FLAG = {
	isExported: 0,
	isAsync: 1,
	isStatic: 2,
	isAbstract: 3,
} as const;

export const VISIBILITIES = [undefined, "public", "private", "protected", "internal"] as const;
export const PROVENANCES = [undefined, "tree-sitter", "scip", "heuristic"] as const;
