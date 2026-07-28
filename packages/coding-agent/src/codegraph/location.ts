/**
 * Identity resolution, metadata, and lifecycle for project-out CodeGraph
 * indexes rooted at `~/.omp/codegraph/v1/indexes/<key>`.
 *
 * Storage layout version: `v1`.
 * Cache schema version: `2` — commit is intentionally excluded from the
 * digest so the same `<projectPath, ref, worktreeRoot, commonDir>` tuple
 * maps to a single slot regardless of HEAD position. Detached HEAD is
 * normalized to the literal `detached` ref so all commit values for a
 * detached checkout share one slot. Legacy schema-1 slots are still
 * readable by `normalizeMetadata` but are recognized as `invalid` entries
 * for prune so a sweep-and-rewrite cleans up the old format.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { head as gitHead, repo as gitRepo } from "../utils/git";
import {
	ensureCodeGraphIndexDir,
	getCodeGraphDirectoryByteSize,
	getCodeGraphIndexesRoot,
	getCodeGraphStorageRoot,
	isCodeGraphIndexKey,
	listDirectoryEntries,
	pathExists,
	readTextFileIfExists,
	removeDirectoryIfExists,
	writeTextFileAtomically,
} from "./location-fs";

const CODEGRAPH_CACHE_SCHEMA_VERSION = 2 as const;
const CODEGRAPH_METADATA_SCHEMA_VERSION = 2 as const;
/** Sentinel ref used when the project is not inside a Git repository. */
const NON_GIT_REF = "nogit";
/** Ref used for any detached HEAD check-out (commit no longer participates in the key). */
const DETACHED_REF = "detached";

/**
 * Auto-prune defaults — safe limits that bound the indexes root without
 * surprising users who never asked for housekeeping.
 */
export const CODEGRAPH_DEFAULT_TTL_DAYS = 30;
export const CODEGRAPH_DEFAULT_MAX_PROJECT_INDEXES = 8;
export const CODEGRAPH_DEFAULT_MAX_PROJECT_BYTES = 2 * 1024 ** 3; // 2 GiB
export const CODEGRAPH_DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 ** 3; // 8 GiB

export type CodeGraphCacheIdentity = {
	schemaVersion: 2;
	sourceRoot: string;
	worktreeRoot: string;
	commonDir: string | null;
	ref: string;
	/** Diagnostic-only — never hashed into `key` and ignored for equality. */
	commit: string | null;
	key: string;
};

export type CodeGraphIndexLocation = {
	available: boolean;
	reason?: string;
	identity: CodeGraphCacheIdentity;
	indexDir: string;
	dbPath: string;
	lockPath: string;
	metadataPath: string;
};

export type CodeGraphLocationMetadata = {
	schemaVersion: 2;
	identity: CodeGraphCacheIdentity;
	extractionVersion: string | null;
	indexSchemaVersion: string | number | null;
	nativeContractVersion: string | null;
	lastSyncedAt: string | null;
	lastUsedAt: string | null;
};

export type CodeGraphLocationMetadataUpdate = Partial<Omit<CodeGraphLocationMetadata, "schemaVersion" | "identity">>;

/** All rejection reasons the auto-prune recognizes as "invalid cache". */
export type CodeGraphIndexInvalidReason =
	| "legacy_non_directory_entry"
	| "legacy_directory_name"
	| "missing_metadata"
	| "invalid_metadata_json"
	| "invalid_metadata_shape"
	| "metadata_key_mismatch"
	| "metadata_identity_key_mismatch"
	| "metadata_legacy_schema"
	| "metadata_identity_invalid"
	| "identity_orphan";

/** All prune reasons — kinds of slots removed by `pruneCodeGraphIndexes`. */
export type CodeGraphIndexPruneReason =
	| CodeGraphIndexInvalidReason
	| "lru_age"
	| "lru_keep_limit"
	| "project_index_limit"
	| "project_bytes_limit"
	| "total_bytes_limit";

export type CodeGraphLocationIdentityVerification = {
	ok: boolean;
	reason?: string;
	metadata: CodeGraphLocationMetadata | null;
};

export type CodeGraphIndexLocationStatus = {
	location: CodeGraphIndexLocation;
	exists: boolean;
	metadata: CodeGraphLocationMetadata | null;
	verified: boolean;
	reason?: string;
};

export type CodeGraphIndexLocationClearResult = {
	location: CodeGraphIndexLocation;
	removed: boolean;
	wouldRemove?: boolean;
};

export type CodeGraphIndexLocationClearOptions = {
	dryRun?: boolean;
};

/** One entry returned by the enumerator / prune. */
export type CodeGraphIndexEntry = {
	key: string;
	project: string;
	sourceRoot: string;
	worktreeRoot: string;
	ref: string;
	commit: string | null;
	sizeBytes: number;
	lastUsedAtMs: number | null;
	orphan: boolean;
	reason: CodeGraphIndexPruneReason | "valid";
};

/** Plain, slot-independent pruning parameters (no per-slot state). */
export type CodeGraphAutoPrunePolicy = {
	ttlDays: number;
	maxProjectIndexes: number;
	maxProjectBytes: number;
	maxTotalBytes: number;
	deleteOrphans: boolean;
};

export const DEFAULT_CODEGRAPH_AUTO_PRUNE_POLICY: CodeGraphAutoPrunePolicy = {
	ttlDays: CODEGRAPH_DEFAULT_TTL_DAYS,
	maxProjectIndexes: CODEGRAPH_DEFAULT_MAX_PROJECT_INDEXES,
	maxProjectBytes: CODEGRAPH_DEFAULT_MAX_PROJECT_BYTES,
	maxTotalBytes: CODEGRAPH_DEFAULT_MAX_TOTAL_BYTES,
	deleteOrphans: true,
};

export type CodeGraphIndexPruneEntry = {
	path: string;
	key: string;
	entry: CodeGraphIndexEntry;
	removed: boolean;
	wouldRemove?: boolean;
	reason: CodeGraphIndexPruneReason | "valid";
};

export type CodeGraphIndexPruneOptions = {
	/** Manual cap (legacy semantics): keep the newest N by `lastUsedAt`. */
	keep?: number;
	/** Manual TTL (legacy semantics): drop slots older than N days. */
	olderThanDays?: number;
	/** Auto-policy fields — combined with the above, auto fields win on conflict. */
	ttlDays?: number;
	maxProjectIndexes?: number;
	maxProjectBytes?: number;
	maxTotalBytes?: number;
	deleteOrphans?: boolean;
	/** Keys whose slots are never deleted, even if policy says otherwise. */
	protectedKeys?: readonly string[];
	dryRun?: boolean;
};

export type CodeGraphIndexPruneResult = {
	root: string;
	scanned: number;
	removed: number;
	kept: number;
	bytesFreed: number;
	policy: {
		ttlDays?: number;
		keep?: number;
		maxProjectBytes?: number;
		maxProjectIndexes?: number;
		maxTotalBytes?: number;
		deleteOrphans?: boolean;
	};
	entries: CodeGraphIndexPruneEntry[];
};

export type CodeGraphListOptions = {
	/** Restrict to a single project (resolved via current cwd OR `cwd`). */
	cwd?: string;
	/** When true, include entries that the policy considers `orphan`. */
	includeOrphans?: boolean;
};

export type CodeGraphListResult = {
	root: string;
	sourceRoot: string | null;
	scanned: number;
	entries: CodeGraphIndexEntry[];
};

export type CodeGraphClearAllOptions = {
	dryRun?: boolean;
};

export type CodeGraphClearAllEntry = {
	location: CodeGraphIndexLocation;
	removed: boolean;
	wouldRemove?: boolean;
};

export type CodeGraphClearAllResult = {
	cwd: string;
	sourceRoot: string;
	entries: CodeGraphClearAllEntry[];
};

function codeOf(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

async function canonicalizePath(targetPath: string): Promise<string> {
	const resolved = path.resolve(targetPath);
	try {
		return path.resolve(await fs.realpath(resolved));
	} catch (error) {
		if (codeOf(error) === "ENOENT") return resolved;
		throw error;
	}
}

function digestIdentityFields(fields: readonly (number | string | null)[]): string {
	const hasher = new Bun.SHA256();
	for (let index = 0; index < fields.length; index++) {
		if (index > 0) hasher.update("\0");
		hasher.update(String(fields[index] ?? ""));
	}
	return hasher.digest("hex");
}

/**
 * The project a slot belongs to, derived from identity fields that survive
 * commit churn. Two slots share a "project" if their `sourceRoot` matches.
 */
function projectKey(identity: CodeGraphCacheIdentity): string {
	return identity.sourceRoot || identity.worktreeRoot;
}

function buildIdentity(args: {
	sourceRoot: string;
	worktreeRoot: string;
	commonDir: string | null;
	ref: string;
	commit: string | null;
}): CodeGraphCacheIdentity {
	const key = digestIdentityFields([
		CODEGRAPH_CACHE_SCHEMA_VERSION,
		args.sourceRoot,
		args.worktreeRoot,
		args.commonDir,
		args.ref,
	]);
	return {
		schemaVersion: CODEGRAPH_CACHE_SCHEMA_VERSION,
		sourceRoot: args.sourceRoot,
		worktreeRoot: args.worktreeRoot,
		commonDir: args.commonDir,
		ref: args.ref,
		commit: args.commit,
		key,
	};
}

function buildIndexLocation(
	identity: CodeGraphCacheIdentity,
	available: boolean,
	reason?: string,
): CodeGraphIndexLocation {
	const indexDir = path.join(getCodeGraphIndexesRoot(), identity.key);
	return {
		available,
		...(reason ? { reason } : {}),
		identity,
		indexDir,
		dbPath: path.join(indexDir, "codegraph.db"),
		lockPath: path.join(indexDir, "codegraph.lock"),
		metadataPath: path.join(indexDir, "metadata.json"),
	};
}

function buildSyntheticIdentityForKey(key: string): CodeGraphCacheIdentity {
	if (!isCodeGraphIndexKey(key)) {
		throw new Error(`Invalid CodeGraph index key: ${JSON.stringify(key)}`);
	}
	return {
		schemaVersion: CODEGRAPH_CACHE_SCHEMA_VERSION,
		sourceRoot: "",
		worktreeRoot: "",
		commonDir: null,
		ref: NON_GIT_REF,
		commit: null,
		key,
	};
}

function buildIndexLocationForKey(
	key: string,
	identity: CodeGraphCacheIdentity | undefined,
	reason?: string,
): CodeGraphIndexLocation {
	if (!isCodeGraphIndexKey(key)) {
		throw new Error(`Invalid CodeGraph index key: ${JSON.stringify(key)}`);
	}
	if (identity && identity.key !== key) {
		throw new Error(`CodeGraph identity key mismatch: ${JSON.stringify({ expected: key, actual: identity.key })}`);
	}
	const indexesRoot = path.resolve(getCodeGraphIndexesRoot());
	const indexDir = path.resolve(path.join(indexesRoot, key));
	if (path.dirname(indexDir) !== indexesRoot) {
		throw new Error(`Unsafe CodeGraph index path for key: ${JSON.stringify(key)}`);
	}
	const effectiveIdentity = identity ?? buildSyntheticIdentityForKey(key);
	return {
		available: identity !== undefined,
		...(reason ? { reason } : {}),
		identity: effectiveIdentity,
		indexDir,
		dbPath: path.join(indexDir, "codegraph.db"),
		lockPath: path.join(indexDir, "codegraph.lock"),
		metadataPath: path.join(indexDir, "metadata.json"),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickNullableString(value: unknown): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value === "string") return value;
	return undefined;
}

function pickIndexSchemaVersion(value: unknown): string | number | null | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value === "string" || typeof value === "number") return value;
	return undefined;
}

function isCompleteMetadata(metadata: CodeGraphLocationMetadata): boolean {
	return (
		typeof metadata.extractionVersion === "string" &&
		(metadata.indexSchemaVersion === null ||
			typeof metadata.indexSchemaVersion === "string" ||
			typeof metadata.indexSchemaVersion === "number") &&
		(typeof metadata.nativeContractVersion === "string" || metadata.nativeContractVersion === null) &&
		(metadata.lastSyncedAt === null || typeof metadata.lastSyncedAt === "string") &&
		(metadata.lastUsedAt === null || typeof metadata.lastUsedAt === "string")
	);
}

/**
 * Result of reading slot metadata, including the schema-1 legacy case so
 * prune can recognize and reclaim outdated entries.
 */
type ReadMetadataResult =
	| { metadata: CodeGraphLocationMetadata; reason: undefined }
	| { metadata: null; reason: CodeGraphIndexInvalidReason | "metadata_incomplete" };

/**
 * Decide whether a parsed metadata blob is a schema-1 legacy cache.
 * Such slots are still readable as invalid entries so prune can reclaim them.
 */
function isLegacySchema1Metadata(value: unknown): boolean {
	return isRecord(value) && value.schemaVersion === 1;
}

function normalizeMetadata(value: unknown): CodeGraphLocationMetadata | null {
	if (!isRecord(value)) return null;
	if (isLegacySchema1Metadata(value)) return null;
	if (value.schemaVersion !== CODEGRAPH_METADATA_SCHEMA_VERSION) return null;
	const identity = normalizeIdentity(value.identity);
	if (!identity) return null;
	const extractionVersion = pickNullableString(value.extractionVersion);
	if (extractionVersion === undefined) return null;
	const indexSchemaVersion = pickIndexSchemaVersion(value.indexSchemaVersion);
	if (indexSchemaVersion === undefined) return null;
	const nativeContractVersion = pickNullableString(value.nativeContractVersion);
	if (nativeContractVersion === undefined) return null;
	const lastSyncedAt = pickNullableString(value.lastSyncedAt);
	if (lastSyncedAt === undefined) return null;
	const lastUsedAt = pickNullableString(value.lastUsedAt);
	if (lastUsedAt === undefined) return null;
	return {
		schemaVersion: CODEGRAPH_METADATA_SCHEMA_VERSION,
		identity,
		extractionVersion,
		indexSchemaVersion,
		nativeContractVersion,
		lastSyncedAt,
		lastUsedAt,
	};
}

function normalizeIdentity(value: unknown): CodeGraphCacheIdentity | null {
	if (!isRecord(value)) return null;
	if (isLegacySchema1Identity(value)) return null;
	if (value.schemaVersion !== CODEGRAPH_CACHE_SCHEMA_VERSION) return null;
	if (typeof value.sourceRoot !== "string") return null;
	if (typeof value.worktreeRoot !== "string") return null;
	if (!(value.commonDir === null || typeof value.commonDir === "string")) return null;
	if (typeof value.ref !== "string") return null;
	if (!(value.commit === null || typeof value.commit === "string")) return null;
	if (typeof value.key !== "string" || !isCodeGraphIndexKey(value.key)) return null;
	return {
		schemaVersion: CODEGRAPH_CACHE_SCHEMA_VERSION,
		sourceRoot: value.sourceRoot,
		worktreeRoot: value.worktreeRoot,
		commonDir: value.commonDir,
		ref: value.ref,
		commit: value.commit,
		key: value.key,
	};
}

function isLegacySchema1Identity(value: unknown): boolean {
	return isRecord(value) && value.schemaVersion === 1;
}

function isValidRef(value: string): boolean {
	return value === NON_GIT_REF || value === DETACHED_REF || value.startsWith("refs/") || value.startsWith("detached:");
}

/**
 * Equality ignores `commit` on purpose — same project + same ref = same slot.
 */
function sameIdentity(left: CodeGraphCacheIdentity, right: CodeGraphCacheIdentity): boolean {
	return (
		left.schemaVersion === right.schemaVersion &&
		left.sourceRoot === right.sourceRoot &&
		left.worktreeRoot === right.worktreeRoot &&
		left.commonDir === right.commonDir &&
		left.ref === right.ref &&
		left.key === right.key
	);
}

function verifyIdentityKey(identity: CodeGraphCacheIdentity): boolean {
	if (!isValidRef(identity.ref)) return false;
	return (
		identity.key ===
		digestIdentityFields([
			identity.schemaVersion,
			identity.sourceRoot,
			identity.worktreeRoot,
			identity.commonDir,
			identity.ref,
		])
	);
}

async function readMetadataState(location: CodeGraphIndexLocation): Promise<ReadMetadataResult> {
	const raw = await readTextFileIfExists(location.metadataPath);
	if (raw === null) return { metadata: null, reason: "missing_metadata" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { metadata: null, reason: "invalid_metadata_json" };
	}
	if (isLegacySchema1Metadata(parsed)) {
		return { metadata: null, reason: "metadata_legacy_schema" };
	}
	const metadata = normalizeMetadata(parsed);
	if (!metadata) return { metadata: null, reason: "invalid_metadata_shape" };
	if (!isCompleteMetadata(metadata)) return { metadata: null, reason: "metadata_incomplete" };
	return { metadata, reason: undefined };
}

async function resolveLocationByKey(key: string): Promise<CodeGraphIndexLocation> {
	const fallback = buildIndexLocationForKey(key, undefined, "Resolved by index key only.");
	const result = await readMetadataState(fallback);
	if (result.reason) {
		return { ...fallback, reason: fallback.available ? result.reason : fallback.reason };
	}
	const metadata = result.metadata;
	if (metadata.identity.key !== key) {
		return { ...fallback, reason: "metadata_key_mismatch" };
	}
	if (!verifyIdentityKey(metadata.identity)) {
		return { ...fallback, reason: "metadata_identity_key_mismatch" };
	}
	return buildIndexLocationForKey(key, metadata.identity);
}

async function resolveLocationInput(target: string | CodeGraphIndexLocation): Promise<CodeGraphIndexLocation> {
	return typeof target === "string" ? await resolveCodeGraphIndexLocation(target) : target;
}

function buildNonGitLocation(canonicalCwd: string, reason: string): CodeGraphIndexLocation {
	const identity = buildIdentity({
		sourceRoot: canonicalCwd,
		worktreeRoot: canonicalCwd,
		commonDir: null,
		ref: NON_GIT_REF,
		commit: null,
	});
	return buildIndexLocation(identity, false, reason);
}

export async function resolveCodeGraphIndexLocation(cwd: string): Promise<CodeGraphIndexLocation> {
	const canonicalCwd = await canonicalizePath(cwd);
	const repository = await gitRepo.resolve(canonicalCwd);
	if (!repository) {
		return buildNonGitLocation(canonicalCwd, `Not inside a Git repository: ${canonicalCwd}`);
	}

	const worktreeRoot = await canonicalizePath(repository.repoRoot);
	const commonDir = await canonicalizePath(repository.commonDir);
	const sourceRoot = worktreeRoot;

	const headState = await gitHead.resolve(worktreeRoot);
	if (!headState) {
		return buildIndexLocation(
			buildIdentity({
				sourceRoot,
				worktreeRoot,
				commonDir,
				ref: DETACHED_REF,
				commit: null,
			}),
			false,
			`Git repository detected, but HEAD could not be resolved: ${worktreeRoot}`,
		);
	}

	const commit = headState.commit;
	const ref = headState.kind === "ref" ? headState.ref : DETACHED_REF;
	return buildIndexLocation(buildIdentity({ sourceRoot, worktreeRoot, commonDir, ref, commit }), true);
}

export async function readCodeGraphLocationMetadata(
	location: CodeGraphIndexLocation,
): Promise<CodeGraphLocationMetadata | null> {
	const result = await readMetadataState(location);
	return result.metadata;
}

function validateRequiredMetadataUpdate(
	location: CodeGraphIndexLocation,
	update: CodeGraphLocationMetadataUpdate | undefined,
): void {
	if (!update) {
		throw new Error(
			`CodeGraph metadata write requires extractionVersion, indexSchemaVersion, nativeContractVersion, and lastSyncedAt: ${JSON.stringify(update)}`,
		);
	}
	const missing: string[] = [];
	if (typeof update.extractionVersion !== "string") missing.push("extractionVersion");
	if (
		update.indexSchemaVersion === undefined ||
		!(
			update.indexSchemaVersion === null ||
			typeof update.indexSchemaVersion === "string" ||
			typeof update.indexSchemaVersion === "number"
		)
	) {
		missing.push("indexSchemaVersion");
	}
	if (typeof update.nativeContractVersion !== "string" && update.nativeContractVersion !== null) {
		missing.push("nativeContractVersion");
	}
	if (typeof update.lastSyncedAt !== "string") missing.push("lastSyncedAt");
	if (missing.length > 0) {
		throw new Error(
			`CodeGraph metadata write for ${location.identity.key} is missing required fields ${missing.join(", ")}: ${JSON.stringify(update)}`,
		);
	}
}

export async function writeCodeGraphLocationMetadata(
	location: CodeGraphIndexLocation,
	update: CodeGraphLocationMetadataUpdate = {},
): Promise<CodeGraphLocationMetadata> {
	if (!location.available) {
		throw new Error(location.reason ?? "CodeGraph index location is unavailable.");
	}
	validateRequiredMetadataUpdate(location, update);
	await ensureCodeGraphIndexDir(location.identity.key);
	const existing = await readCodeGraphLocationMetadata(location);
	const now = new Date().toISOString();
	const seed: CodeGraphLocationMetadata = existing ?? {
		schemaVersion: CODEGRAPH_METADATA_SCHEMA_VERSION,
		identity: location.identity,
		extractionVersion: null,
		indexSchemaVersion: null,
		nativeContractVersion: null,
		lastSyncedAt: null,
		lastUsedAt: null,
	};
	const merged: CodeGraphLocationMetadata = {
		schemaVersion: CODEGRAPH_METADATA_SCHEMA_VERSION,
		identity: location.identity,
		extractionVersion: update.extractionVersion ?? seed.extractionVersion,
		indexSchemaVersion: update.indexSchemaVersion ?? seed.indexSchemaVersion,
		nativeContractVersion: update.nativeContractVersion ?? seed.nativeContractVersion,
		lastSyncedAt: update.lastSyncedAt ?? seed.lastSyncedAt ?? now,
		lastUsedAt: now,
	};
	await writeTextFileAtomically(location.metadataPath, `${JSON.stringify(merged, null, 2)}\n`);
	return merged;
}

export function verifyCodeGraphLocationIdentity(
	location: CodeGraphIndexLocation,
	metadata: CodeGraphLocationMetadata | null,
): CodeGraphLocationIdentityVerification {
	if (!metadata) {
		return { ok: false, reason: "metadata_missing", metadata: null };
	}
	if (!isCodeGraphIndexKey(location.identity.key)) {
		return { ok: false, reason: "location_key_invalid", metadata };
	}
	if (path.basename(location.indexDir) !== location.identity.key) {
		return { ok: false, reason: "location_path_mismatch", metadata };
	}
	if (!verifyIdentityKey(location.identity)) {
		return { ok: false, reason: "location_identity_key_mismatch", metadata };
	}
	if (!verifyIdentityKey(metadata.identity)) {
		return { ok: false, reason: "metadata_identity_key_mismatch", metadata };
	}
	if (!sameIdentity(location.identity, metadata.identity)) {
		return { ok: false, reason: "identity_mismatch", metadata };
	}
	return { ok: true, metadata };
}

export async function getCodeGraphIndexLocationStatus(
	target: string | CodeGraphIndexLocation,
): Promise<CodeGraphIndexLocationStatus> {
	const location = await resolveLocationInput(target);
	const exists = await pathExists(location.indexDir);
	if (!exists) {
		return {
			location,
			exists: false,
			metadata: null,
			verified: false,
			reason: location.available ? "index_missing" : location.reason,
		};
	}
	const { metadata, reason: metadataReason } = await readMetadataState(location);
	const verification = verifyCodeGraphLocationIdentity(location, metadata);
	return {
		location,
		exists,
		metadata,
		verified: verification.ok,
		reason: metadataReason ?? verification.reason ?? (!location.available ? location.reason : undefined),
	};
}

function parseMetadataLastUsedAtMs(metadata: CodeGraphLocationMetadata): number | null {
	const raw = metadata.lastUsedAt;
	if (!raw) return null;
	const value = Date.parse(raw);
	return Number.isFinite(value) ? value : null;
}

async function detectOrphan(identity: CodeGraphCacheIdentity): Promise<boolean> {
	if (!identity.sourceRoot) return true;
	if (!(await pathExists(identity.sourceRoot))) return true;
	try {
		const repository = await gitRepo.resolve(identity.sourceRoot);
		return repository === null;
	} catch {
		return true;
	}
}

/**
 * Recursively measure `dirPath` after confirming it is a valid slot child
 * of the indexes root. Returns `0` for missing or unsafe paths.
 */
async function safeByteSize(entryPath: string, indexesRoot: string): Promise<number> {
	const resolved = path.resolve(entryPath);
	if (path.dirname(resolved) !== indexesRoot) return 0;
	if (!isCodeGraphIndexKey(path.basename(resolved))) return 0;
	if (!(await pathExists(resolved))) return 0;
	return getCodeGraphDirectoryByteSize(resolved);
}

/**
 * Make sure `entryPath` is a direct child of `indexesRoot` and that its
 * basename is a valid sha256 key. Any `fs.rm` is gated on this.
 */
function assertSafeSlotPath(entryPath: string, indexesRoot: string): void {
	const resolved = path.resolve(entryPath);
	const root = path.resolve(indexesRoot);
	if (path.dirname(resolved) !== root || path.basename(resolved).length === 0) {
		throw new Error(`Refusing to operate on path outside of indexes root: ${entryPath}`);
	}
}

/**
 * Built once per call — every later pass attaches its outcome to the same
 * entry, so the caller's enumeration and prune decisions stay in sync.
 */
type EnumeratedSlot = {
	entryPath: string;
	key: string;
	identity: CodeGraphCacheIdentity;
	metadata: CodeGraphLocationMetadata;
	sizeBytes: number;
	lastUsedAtMs: number | null;
	orphan: boolean;
};

/** Result of enumerating the indexes root. */
type EnumerationResult = {
	indexesRoot: string;
	valid: EnumeratedSlot[];
	invalid: Array<{
		entryPath: string;
		key: string | null;
		sizeBytes: number;
		reason: CodeGraphIndexInvalidReason;
	}>;
};

/**
 * Walk the indexes root and split children into valid + invalid buckets.
 * Invalid buckets are still measured so their byte counts roll into the
 * global budget.
 */
async function enumerateSlots(indexesRoot: string): Promise<EnumerationResult> {
	const entries = await listDirectoryEntries(indexesRoot);
	const valid: EnumeratedSlot[] = [];
	const invalid: EnumerationResult["invalid"] = [];

	for (const entry of entries) {
		const entryPath = path.join(indexesRoot, entry.name);
		if (path.dirname(path.resolve(entryPath)) !== path.resolve(indexesRoot)) continue;
		if (!entry.isDirectory()) {
			invalid.push({ entryPath, key: null, sizeBytes: 0, reason: "legacy_non_directory_entry" });
			continue;
		}
		if (!isCodeGraphIndexKey(entry.name)) {
			invalid.push({
				entryPath,
				key: null,
				sizeBytes: await safeByteSize(entryPath, indexesRoot),
				reason: "legacy_directory_name",
			});
			continue;
		}
		const metadataPath = path.join(entryPath, "metadata.json");
		const raw = await readTextFileIfExists(metadataPath);
		if (raw === null) {
			invalid.push({
				entryPath,
				key: entry.name,
				sizeBytes: await safeByteSize(entryPath, indexesRoot),
				reason: "missing_metadata",
			});
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			invalid.push({
				entryPath,
				key: entry.name,
				sizeBytes: await safeByteSize(entryPath, indexesRoot),
				reason: "invalid_metadata_json",
			});
			continue;
		}
		if (isLegacySchema1Metadata(parsed)) {
			invalid.push({
				entryPath,
				key: entry.name,
				sizeBytes: await safeByteSize(entryPath, indexesRoot),
				reason: "metadata_legacy_schema",
			});
			continue;
		}
		const metadata = normalizeMetadata(parsed);
		if (!metadata) {
			invalid.push({
				entryPath,
				key: entry.name,
				sizeBytes: await safeByteSize(entryPath, indexesRoot),
				reason: "invalid_metadata_shape",
			});
			continue;
		}
		if (metadata.identity.key !== entry.name || !verifyIdentityKey(metadata.identity)) {
			invalid.push({
				entryPath,
				key: entry.name,
				sizeBytes: await safeByteSize(entryPath, indexesRoot),
				reason: metadata.identity.key !== entry.name ? "metadata_key_mismatch" : "metadata_identity_key_mismatch",
			});
			continue;
		}
		const sizeBytes = await safeByteSize(entryPath, indexesRoot);
		const orphan = await detectOrphan(metadata.identity);
		valid.push({
			entryPath,
			key: entry.name,
			identity: metadata.identity,
			metadata,
			sizeBytes,
			lastUsedAtMs: parseMetadataLastUsedAtMs(metadata),
			orphan,
		});
	}

	return { indexesRoot, valid, invalid };
}

/** Convert an enumerated slot to the public `CodeGraphIndexEntry` shape. */
function toPublicEntry(slot: EnumeratedSlot, reason: CodeGraphIndexPruneReason | "valid"): CodeGraphIndexEntry {
	return {
		key: slot.key,
		project: projectKey(slot.identity),
		sourceRoot: slot.identity.sourceRoot,
		worktreeRoot: slot.identity.worktreeRoot,
		ref: slot.identity.ref,
		commit: slot.identity.commit,
		sizeBytes: slot.sizeBytes,
		lastUsedAtMs: slot.lastUsedAtMs,
		orphan: slot.orphan,
		reason,
	};
}

/** Currently-valid enumeration exposed as `list` (no mutation). */
export async function listCodeGraphIndexSlots(options: CodeGraphListOptions = {}): Promise<CodeGraphListResult> {
	const indexesRoot = getCodeGraphIndexesRoot();
	const { valid } = await enumerateSlots(indexesRoot);
	let sourceRootFilter: string | null = null;
	if (options.cwd !== undefined) {
		const canonical = await canonicalizePath(options.cwd);
		const repository = await gitRepo.resolve(canonical);
		sourceRootFilter = repository ? await canonicalizePath(repository.repoRoot) : canonical;
	}
	const entries = valid
		.filter(slot => (sourceRootFilter === null ? true : slot.identity.sourceRoot === sourceRootFilter))
		.filter(slot => (options.includeOrphans === true ? true : !slot.orphan))
		.sort((a, b) => (b.lastUsedAtMs ?? 0) - (a.lastUsedAtMs ?? 0))
		.map(slot => toPublicEntry(slot, "valid"));

	return {
		root: indexesRoot,
		sourceRoot: sourceRootFilter,
		scanned: valid.length,
		entries,
	};
}

/**
 * Validate the merged prune-options payload. Throws on invalid input —
 * callers (CLI) translate errors into user-facing messages.
 */
function normalizePruneOptions(options: CodeGraphIndexPruneOptions): {
	dryRun: boolean;
	keep: number | undefined;
	olderThanCutoffMs: number | undefined;
	maxTotalBytes: number | undefined;
	maxProjectBytes: number | undefined;
	maxProjectIndexes: number | undefined;
	ttlMs: number | undefined;
	deleteOrphans: boolean;
	protectedKeys: ReadonlySet<string>;
	policyEcho: CodeGraphIndexPruneResult["policy"];
} {
	const dryRun = options.dryRun === true;
	let keep: number | undefined;
	if (options.keep !== undefined) {
		if (!Number.isInteger(options.keep) || options.keep < 0) {
			throw new Error(`Invalid CodeGraph prune keep value: ${JSON.stringify(options.keep)}`);
		}
		keep = options.keep;
	}
	let olderThanCutoffMs: number | undefined;
	if (options.olderThanDays !== undefined) {
		if (
			typeof options.olderThanDays !== "number" ||
			!Number.isFinite(options.olderThanDays) ||
			options.olderThanDays < 0
		) {
			throw new Error(`Invalid CodeGraph prune olderThanDays value: ${JSON.stringify(options.olderThanDays)}`);
		}
		olderThanCutoffMs = Date.now() - options.olderThanDays * 86_400_000;
	}
	const positiveInt = (value: number | undefined, name: string): number | undefined => {
		if (value === undefined) return undefined;
		if (!Number.isInteger(value) || value < 0) {
			throw new Error(`Invalid CodeGraph prune ${name}: ${JSON.stringify(value)}`);
		}
		return value;
	};
	const maxTotalBytes = positiveInt(options.maxTotalBytes, "maxTotalBytes");
	const maxProjectBytes = positiveInt(options.maxProjectBytes, "maxProjectBytes");
	const maxProjectIndexes = positiveInt(options.maxProjectIndexes, "maxProjectIndexes");
	let ttlMs: number | undefined;
	if (options.ttlDays !== undefined) {
		if (typeof options.ttlDays !== "number" || !Number.isFinite(options.ttlDays) || options.ttlDays < 0) {
			throw new Error(`Invalid CodeGraph prune ttlDays: ${JSON.stringify(options.ttlDays)}`);
		}
		ttlMs = options.ttlDays * 86_400_000;
	}
	const deleteOrphans = options.deleteOrphans === true;
	const protectedKeys = new Set<string>(options.protectedKeys ?? []);
	const policyEcho: CodeGraphIndexPruneResult["policy"] = {
		...(keep !== undefined ? { keep } : {}),
		...(options.ttlDays !== undefined ? { ttlDays: options.ttlDays } : {}),
		...(maxTotalBytes !== undefined ? { maxTotalBytes } : {}),
		...(maxProjectBytes !== undefined ? { maxProjectBytes } : {}),
		...(maxProjectIndexes !== undefined ? { maxProjectIndexes } : {}),
		...(options.deleteOrphans !== undefined ? { deleteOrphans: options.deleteOrphans } : {}),
	};
	return {
		dryRun,
		keep,
		olderThanCutoffMs,
		maxTotalBytes,
		maxProjectBytes,
		maxProjectIndexes,
		ttlMs,
		deleteOrphans,
		protectedKeys,
		policyEcho,
	};
}

/** Apply or report a deletion for a single slot. */
async function applyPruneAction(
	entryPath: string,
	dryRun: boolean,
): Promise<{ removed: boolean; wouldRemove: boolean }> {
	if (dryRun) return { removed: false, wouldRemove: true };
	await fs.rm(entryPath, { recursive: true, force: true });
	return { removed: true, wouldRemove: false };
}

/** Mutable pass state — each step writes its decisions into this struct. */
type PruneDecision = {
	entry: CodeGraphIndexPruneEntry;
	mark: (reason: CodeGraphIndexPruneReason, dryRun: boolean) => Promise<void>;
	isMarked: () => boolean;
};

/**
 * Build the public `CodeGraphIndexPruneEntry` wrapper for a slot or
 * invalid stub. The returned `mark` mutates the same entry object so the
 * final result reflects all decisions in order.
 */
function buildDecision(
	indexesRoot: string,
	subject: { entryPath: string; key: string | null; sizeBytes: number },
	identity: CodeGraphCacheIdentity | undefined,
	initialReason: CodeGraphIndexPruneReason | "valid",
): PruneDecision {
	const slotIdentity: CodeGraphCacheIdentity =
		identity ??
		(subject.key
			? buildSyntheticIdentityForKey(subject.key)
			: buildIdentity({
					sourceRoot: "",
					worktreeRoot: "",
					commonDir: null,
					ref: NON_GIT_REF,
					commit: null,
				}));
	const entry: CodeGraphIndexPruneEntry = {
		path: subject.entryPath,
		key: subject.key ?? path.basename(subject.entryPath),
		entry: {
			key: subject.key ?? path.basename(subject.entryPath),
			project: projectKey(slotIdentity),
			sourceRoot: slotIdentity.sourceRoot,
			worktreeRoot: slotIdentity.worktreeRoot,
			ref: slotIdentity.ref,
			commit: slotIdentity.commit,
			sizeBytes: subject.sizeBytes,
			lastUsedAtMs: null,
			orphan: false,
			reason: initialReason,
		},
		removed: false,
		wouldRemove: false,
		reason: initialReason,
	};
	return {
		entry,
		isMarked: () => entry.removed || entry.wouldRemove === true,
		mark: async (reason, dryRun) => {
			if (entry.removed || entry.wouldRemove) return;
			assertSafeSlotPath(subject.entryPath, indexesRoot);
			const action = await applyPruneAction(subject.entryPath, dryRun);
			entry.removed = action.removed;
			entry.wouldRemove = action.wouldRemove ? true : undefined;
			entry.reason = reason;
		},
	};
}

type ProjectGroup = {
	project: string;
	slots: Array<{ slot: EnumeratedSlot; decision: PruneDecision }>;
};

function groupByProject(
	valid: readonly EnumeratedSlot[],
	decisions: ReadonlyMap<string, PruneDecision>,
): ProjectGroup[] {
	const groups = new Map<string, ProjectGroup>();
	for (const slot of valid) {
		const decision = decisions.get(slot.key);
		if (!decision) continue;
		const project = projectKey(slot.identity);
		const group = groups.get(project) ?? { project, slots: [] };
		group.slots.push({ slot, decision });
		groups.set(project, group);
	}
	return [...groups.values()];
}

/**
 * Sweep the indexes root. Order is fixed so callers get a reproducible
 * result and the CLI presenter can render it without further sorting:
 *
 *   1. invalid legacy / malformed slots
 *   2. TTL (`olderThanDays` | `ttlDays`)
 *   3. deletable orphans (`deleteOrphans`)
 *   4. per-project LRU indexes cap
 *   5. per-project byte cap
 *   6. global byte cap (with `--keep` slots protected, then LRU)
 *   7. global LRU `--keep` (legacy)
 *
 * Protected keys (`protectedKeys`) are skipped at every step.
 */
export async function pruneCodeGraphIndexes(
	options: CodeGraphIndexPruneOptions = {},
): Promise<CodeGraphIndexPruneResult> {
	const settings = normalizePruneOptions(options);
	const indexesRoot = getCodeGraphIndexesRoot();
	const { valid, invalid } = await enumerateSlots(indexesRoot);

	const allDecisions: PruneDecision[] = [];
	const invalidDecisions = invalid.map(slot =>
		buildDecision(
			indexesRoot,
			{ entryPath: slot.entryPath, key: slot.key, sizeBytes: slot.sizeBytes },
			undefined,
			slot.reason,
		),
	);

	for (const d of invalidDecisions) allDecisions.push(d);
	const validDecisions = new Map<string, PruneDecision>();
	for (const slot of valid) {
		validDecisions.set(slot.key, buildDecision(indexesRoot, slot, slot.identity, "valid"));
	}
	for (const d of validDecisions.values()) allDecisions.push(d);

	const isProtected = (decision: PruneDecision): boolean => settings.protectedKeys.has(decision.entry.key);

	// Step 1: invalid (non-bypassable — these are invalid cache by definition).
	for (const decision of invalidDecisions) {
		if (isProtected(decision)) continue;
		await decision.mark(decision.entry.reason as CodeGraphIndexPruneReason, settings.dryRun);
	}

	// Step 2: TTL.
	const ttlCutoff = settings.ttlMs !== undefined ? Date.now() - settings.ttlMs : settings.olderThanCutoffMs;
	if (ttlCutoff !== undefined) {
		for (const decision of validDecisions.values()) {
			if (isProtected(decision)) continue;
			if (decision.isMarked()) continue;
			const slot = valid.find(s => s.key === decision.entry.key);
			if (slot && slot.lastUsedAtMs !== null && slot.lastUsedAtMs !== undefined && slot.lastUsedAtMs < ttlCutoff) {
				await decision.mark("lru_age", settings.dryRun);
			}
		}
	}

	// Step 3: orphans.
	if (settings.deleteOrphans) {
		for (const decision of validDecisions.values()) {
			if (isProtected(decision)) continue;
			if (decision.isMarked()) continue;
			const slot = valid.find(s => s.key === decision.entry.key);
			if (slot?.orphan) {
				decision.entry.entry.orphan = true;
				await decision.mark("identity_orphan", settings.dryRun);
			}
		}
	}

	// Step 4: per-project index cap (LRU among survivors).
	if (settings.maxProjectIndexes !== undefined) {
		const groups = groupByProject(valid, validDecisions);
		for (const group of groups) {
			const survivors = group.slots
				.filter(s => !s.decision.isMarked())
				.sort((a, b) => (b.slot.lastUsedAtMs ?? 0) - (a.slot.lastUsedAtMs ?? 0));
			for (const { decision } of survivors.slice(settings.maxProjectIndexes)) {
				if (isProtected(decision)) continue;
				await decision.mark("project_index_limit", settings.dryRun);
			}
		}
	}

	// Step 5: per-project byte cap (LRU within each project).
	if (settings.maxProjectBytes !== undefined) {
		const groups = groupByProject(valid, validDecisions);
		for (const group of groups) {
			const survivors = group.slots.filter(s => !s.decision.isMarked());
			let bytes = survivors.reduce((sum, s) => sum + s.slot.sizeBytes, 0);
			if (bytes <= settings.maxProjectBytes) continue;
			const sortedLru = [...survivors].sort((a, b) => (a.slot.lastUsedAtMs ?? 0) - (b.slot.lastUsedAtMs ?? 0));
			for (const { decision, slot } of sortedLru) {
				if (isProtected(decision)) continue;
				if (bytes <= settings.maxProjectBytes) break;
				await decision.mark("project_bytes_limit", settings.dryRun);
				bytes -= slot.sizeBytes;
			}
		}
	}

	// Step 6: global byte cap. Protected keys stay; otherwise, LRU.
	if (settings.maxTotalBytes !== undefined) {
		const survivorSlots = valid.filter(s => !validDecisions.get(s.key)?.isMarked());
		let totalBytes = survivorSlots.reduce((sum, s) => sum + s.sizeBytes, 0);
		if (totalBytes > settings.maxTotalBytes) {
			const sortedLru = [...survivorSlots].sort((a, b) => (a.lastUsedAtMs ?? 0) - (b.lastUsedAtMs ?? 0));
			for (const slot of sortedLru) {
				if (totalBytes <= settings.maxTotalBytes) break;
				const decision = validDecisions.get(slot.key);
				if (!decision || decision.isMarked()) continue;
				if (isProtected(decision)) continue;
				await decision.mark("total_bytes_limit", settings.dryRun);
				totalBytes -= slot.sizeBytes;
			}
		}
	}

	// Step 7: legacy `--keep` — newest N survive (LRU).
	if (settings.keep !== undefined) {
		const survivorSlots = valid.filter(s => !validDecisions.get(s.key)?.isMarked());
		const ranked = [...survivorSlots].sort((a, b) => (b.lastUsedAtMs ?? 0) - (a.lastUsedAtMs ?? 0));
		for (const slot of ranked.slice(settings.keep)) {
			const decision = validDecisions.get(slot.key);
			if (!decision || decision.isMarked()) continue;
			if (isProtected(decision)) continue;
			await decision.mark("lru_keep_limit", settings.dryRun);
		}
	}

	const entries = allDecisions.map(d => d.entry);
	let removed = 0;
	let kept = 0;
	let bytesFreed = 0;
	for (const decision of allDecisions) {
		if (decision.entry.removed) {
			removed += 1;
			bytesFreed += decision.entry.entry.sizeBytes;
		} else if (!decision.entry.wouldRemove) {
			kept += 1;
		}
	}
	if (settings.dryRun) {
		for (const decision of allDecisions) {
			if (decision.entry.wouldRemove && !decision.entry.removed) {
				bytesFreed += decision.entry.entry.sizeBytes;
			}
		}
	}

	return {
		root: indexesRoot,
		scanned: entries.length,
		removed,
		kept,
		bytesFreed,
		policy: settings.policyEcho,
		entries,
	};
}

async function resolveClearResult(
	location: CodeGraphIndexLocation,
	options: CodeGraphIndexLocationClearOptions = {},
): Promise<CodeGraphIndexLocationClearResult> {
	if (options.dryRun === true) {
		const wouldRemove = await pathExists(location.indexDir);
		return {
			location,
			removed: false,
			...(wouldRemove ? { wouldRemove: true } : {}),
		};
	}
	return {
		location,
		removed: await removeDirectoryIfExists(location.indexDir, { dryRun: false }),
	};
}

export async function clearCodeGraphIndexLocation(
	target: string | CodeGraphIndexLocation,
	options: CodeGraphIndexLocationClearOptions = {},
): Promise<CodeGraphIndexLocationClearResult> {
	const location = await resolveLocationInput(target);
	return await resolveClearResult(location, options);
}

export async function clearCodeGraphIndexLocationByKey(
	key: string,
	options: CodeGraphIndexLocationClearOptions = {},
): Promise<CodeGraphIndexLocationClearResult> {
	const location = await resolveLocationByKey(key);
	return await resolveClearResult(location, options);
}

/**
 * Remove every slot that belongs to the current project's sourceRoot. Other
 * projects are left untouched. The dry-run variant reports the plan without
 * touching disk.
 */
export async function clearAllCodeGraphIndexLocations(
	options: CodeGraphClearAllOptions = {},
	targetCwd?: string,
): Promise<CodeGraphClearAllResult> {
	const cwd = targetCwd ?? process.cwd();
	const canonical = await canonicalizePath(cwd);
	const repository = await gitRepo.resolve(canonical);
	const sourceRoot = repository ? await canonicalizePath(repository.repoRoot) : canonical;
	const enumeration = await enumerateSlots(getCodeGraphIndexesRoot());
	const matches = enumeration.valid.filter(slot => slot.identity.sourceRoot === sourceRoot);

	const entries: CodeGraphClearAllEntry[] = [];
	for (const slot of matches) {
		const location = buildIndexLocation(slot.identity, true);
		const result = await resolveClearResult(location, { dryRun: options.dryRun });
		entries.push(result);
	}

	return {
		cwd,
		sourceRoot,
		entries,
	};
}

export { getCodeGraphDirectoryByteSize, getCodeGraphIndexesRoot, getCodeGraphStorageRoot, isCodeGraphIndexKey };
