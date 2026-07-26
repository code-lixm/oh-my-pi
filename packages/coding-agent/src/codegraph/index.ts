/**
 * Public barrel — every stable export downstream tools may consume.
 *
 * The contract surface (see `local://codegraph-contract.md`) is
 * sourced from `./location.ts` (owned by CodeGraphLocation) and
 * `./runtime.ts` (this module's facade). Other modules under
 * `./codegraph` are internal implementation details exposed for the
 * CLI / diagnostics.
 */

export { DatabaseConnection, ensureIndexDirs, QueryBuilder, removeDatabaseFiles } from "./db";
export { EXTRACTION_VERSION } from "./extraction";
export { GraphTraverser } from "./graph";
export type { CodeGraphCacheIdentity, CodeGraphIndexLocation } from "./location";
export {
	defaultMetadata,
	EXTRACTION_SCHEMA_VERSION,
	metadataIsStale,
	RUNTIME_SCHEMA_VERSION,
	readMetadata,
	writeMetadata,
} from "./metadata";
// Internal surface — exported for diagnostic / CLI use only.
export { describeNative, tryLoadNative } from "./native";
export {
	ReferenceResolver,
	type ResolutionResult,
	resolveAllPending,
	resolveReference,
} from "./resolution";
export {
	CodeGraphInternalError,
	openCodeGraphRuntime,
	probeRuntime,
} from "./runtime";
export type {
	CodeGraphExploreEntry,
	CodeGraphExploreOptions,
	CodeGraphExploreResult,
	CodeGraphFileEntry,
	CodeGraphRuntime,
	CodeGraphRuntimeOptions,
	CodeGraphStatus,
	CodeGraphSyncOptions,
	CodeGraphSyncResult,
} from "./runtime-types";
export { extractProseCandidates, parseQuery } from "./search";
