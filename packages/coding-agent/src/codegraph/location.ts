import * as fs from "node:fs/promises";
import * as path from "node:path";
import { head as gitHead, repo as gitRepo } from "../utils/git";
import {
	ensureCodeGraphIndexDir,
	getCodeGraphIndexesRoot,
	getCodeGraphStorageRoot,
	isCodeGraphIndexKey,
	listDirectoryEntries,
	pathExists,
	readTextFileIfExists,
	removeDirectoryIfExists,
	writeTextFileAtomically,
} from "./location-fs";

const CODEGRAPH_CACHE_SCHEMA_VERSION = 1 as const;
const CODEGRAPH_METADATA_SCHEMA_VERSION = 1 as const;
const NON_GIT_REF = "nogit";
const DETACHED_UNKNOWN_REF = "detached:unknown";

export type CodeGraphCacheIdentity = {
	schemaVersion: 1;
	sourceRoot: string;
	worktreeRoot: string;
	commonDir: string | null;
	ref: string;
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
	schemaVersion: 1;
	identity: CodeGraphCacheIdentity;
	extractionVersion: string | null;
	indexSchemaVersion: string | number | null;
	nativeContractVersion: string | null;
	lastSyncedAt: string | null;
	lastUsedAt: string | null;
	[key: string]: unknown;
};

export type CodeGraphLocationMetadataUpdate = Partial<Omit<CodeGraphLocationMetadata, "schemaVersion" | "identity">> & {
	[key: string]: unknown;
};

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

export type CodeGraphIndexPruneEntry = {
	path: string;
	removed: boolean;
	wouldRemove?: boolean;
	reason: string;
};

export type CodeGraphIndexPruneOptions = {
	dryRun?: boolean;
	keep?: number;
	olderThanDays?: number;
};

export type CodeGraphIndexPruneResult = {
	root: string;
	scanned: number;
	removed: number;
	kept: number;
	entries: CodeGraphIndexPruneEntry[];
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
		args.commit,
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

function isMetadataFieldMissing(metadata: CodeGraphLocationMetadata, field: string): boolean {
	const record = metadata as unknown as Record<string, unknown>;
	return !Object.hasOwn(record, field);
}

function normalizeMetadata(value: unknown): CodeGraphLocationMetadata | null {
	if (!isRecord(value)) return null;
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
	const metadata: CodeGraphLocationMetadata = {
		...(value as Record<string, unknown>),
		schemaVersion: CODEGRAPH_METADATA_SCHEMA_VERSION,
		identity,
		extractionVersion,
		indexSchemaVersion,
		nativeContractVersion,
		lastSyncedAt,
		lastUsedAt,
	};
	return metadata;
}

function normalizeIdentity(value: unknown): CodeGraphCacheIdentity | null {
	if (!isRecord(value)) return null;
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

function sameIdentity(left: CodeGraphCacheIdentity, right: CodeGraphCacheIdentity): boolean {
	return (
		left.schemaVersion === right.schemaVersion &&
		left.sourceRoot === right.sourceRoot &&
		left.worktreeRoot === right.worktreeRoot &&
		left.commonDir === right.commonDir &&
		left.ref === right.ref &&
		left.commit === right.commit &&
		left.key === right.key
	);
}

function verifyIdentityKey(identity: CodeGraphCacheIdentity): boolean {
	return (
		identity.key ===
		digestIdentityFields([
			identity.schemaVersion,
			identity.sourceRoot,
			identity.worktreeRoot,
			identity.commonDir,
			identity.ref,
			identity.commit,
		])
	);
}

async function readMetadataState(
	location: CodeGraphIndexLocation,
): Promise<{ metadata: CodeGraphLocationMetadata | null; reason?: string }> {
	const raw = await readTextFileIfExists(location.metadataPath);
	if (raw === null) return { metadata: null, reason: "metadata_missing" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { metadata: null, reason: "metadata_invalid_json" };
	}
	const metadata = normalizeMetadata(parsed);
	if (!metadata) return { metadata: null, reason: "metadata_invalid_shape" };
	if (!isCompleteMetadata(metadata)) return { metadata: null, reason: "metadata_incomplete" };
	return { metadata };
}

async function resolveLocationByKey(key: string): Promise<CodeGraphIndexLocation> {
	const fallback = buildIndexLocationForKey(key, undefined, "Resolved by index key only.");
	const { metadata, reason } = await readMetadataState(fallback);
	if (!metadata) {
		return reason ? { ...fallback, reason } : fallback;
	}
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
				ref: DETACHED_UNKNOWN_REF,
				commit: null,
			}),
			false,
			`Git repository detected, but HEAD could not be resolved: ${worktreeRoot}`,
		);
	}

	const commit = headState.commit;
	const ref = headState.kind === "ref" ? headState.ref : commit ? `detached:${commit}` : DETACHED_UNKNOWN_REF;
	return buildIndexLocation(buildIdentity({ sourceRoot, worktreeRoot, commonDir, ref, commit }), true);
}

export async function readCodeGraphLocationMetadata(
	location: CodeGraphIndexLocation,
): Promise<CodeGraphLocationMetadata | null> {
	return (await readMetadataState(location)).metadata;
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
	const candidate: CodeGraphLocationMetadata = {
		...seed,
		...update,
		schemaVersion: CODEGRAPH_METADATA_SCHEMA_VERSION,
		identity: location.identity,
	};
	const metadata: CodeGraphLocationMetadata = {
		...candidate,
		lastUsedAt: now,
		lastSyncedAt: candidate.lastSyncedAt ?? now,
	};
	if (
		!isCompleteMetadata(metadata) ||
		isMetadataFieldMissing(metadata, "extractionVersion") ||
		isMetadataFieldMissing(metadata, "indexSchemaVersion") ||
		isMetadataFieldMissing(metadata, "nativeContractVersion") ||
		isMetadataFieldMissing(metadata, "lastSyncedAt") ||
		isMetadataFieldMissing(metadata, "lastUsedAt")
	) {
		throw new Error(
			`CodeGraph metadata is incomplete after normalization: ${JSON.stringify({
				keys: Object.keys(metadata),
				extractionVersion: metadata.extractionVersion,
				indexSchemaVersion: metadata.indexSchemaVersion,
				nativeContractVersion: metadata.nativeContractVersion,
				lastSyncedAt: metadata.lastSyncedAt,
				lastUsedAt: metadata.lastUsedAt,
			})}`,
		);
	}
	await writeTextFileAtomically(location.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
	return metadata;
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

function normalizePruneOptions(options: CodeGraphIndexPruneOptions = {}): {
	dryRun: boolean;
	keep: number | undefined;
	olderThanCutoffMs: number | undefined;
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
	return { dryRun, keep, olderThanCutoffMs };
}

async function applyPruneAction(entryPath: string, reason: string, dryRun: boolean): Promise<CodeGraphIndexPruneEntry> {
	if (dryRun) {
		return { path: entryPath, removed: false, wouldRemove: true, reason };
	}
	await fs.rm(entryPath, { recursive: true, force: true });
	return { path: entryPath, removed: true, reason };
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

export async function pruneCodeGraphIndexes(
	options: CodeGraphIndexPruneOptions = {},
): Promise<CodeGraphIndexPruneResult> {
	const { dryRun, keep, olderThanCutoffMs } = normalizePruneOptions(options);
	const root = getCodeGraphIndexesRoot();
	const entries = await listDirectoryEntries(root);
	const results: CodeGraphIndexPruneEntry[] = [];
	const validCandidates: Array<{
		path: string;
		lastUsedAtMs: number | null;
		result: CodeGraphIndexPruneEntry;
	}> = [];

	for (const entry of entries) {
		const entryPath = path.join(root, entry.name);
		if (!entry.isDirectory()) {
			results.push(await applyPruneAction(entryPath, "legacy_non_directory_entry", dryRun));
			continue;
		}
		if (!isCodeGraphIndexKey(entry.name)) {
			results.push(await applyPruneAction(entryPath, "legacy_directory_name", dryRun));
			continue;
		}
		const metadataPath = path.join(entryPath, "metadata.json");
		const raw = await readTextFileIfExists(metadataPath);
		if (raw === null) {
			results.push(await applyPruneAction(entryPath, "missing_metadata", dryRun));
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			results.push(await applyPruneAction(entryPath, "invalid_metadata_json", dryRun));
			continue;
		}
		const metadata = normalizeMetadata(parsed);
		if (!metadata) {
			results.push(await applyPruneAction(entryPath, "invalid_metadata_shape", dryRun));
			continue;
		}
		if (metadata.identity.key !== entry.name) {
			results.push(await applyPruneAction(entryPath, "metadata_key_mismatch", dryRun));
			continue;
		}
		if (!verifyIdentityKey(metadata.identity)) {
			results.push(await applyPruneAction(entryPath, "metadata_identity_key_mismatch", dryRun));
			continue;
		}
		const result: CodeGraphIndexPruneEntry = { path: entryPath, removed: false, reason: "valid" };
		results.push(result);
		validCandidates.push({
			path: entryPath,
			lastUsedAtMs: parseMetadataLastUsedAtMs(metadata),
			result,
		});
	}

	if (olderThanCutoffMs !== undefined) {
		for (const candidate of validCandidates) {
			if (candidate.result.removed || candidate.result.wouldRemove) continue;
			if (candidate.lastUsedAtMs !== null && candidate.lastUsedAtMs < olderThanCutoffMs) {
				Object.assign(candidate.result, await applyPruneAction(candidate.path, "lru_age", dryRun));
			}
		}
	}

	if (keep !== undefined) {
		const ranked = validCandidates
			.filter(
				candidate => candidate.lastUsedAtMs !== null && !candidate.result.removed && !candidate.result.wouldRemove,
			)
			.sort((left, right) => (right.lastUsedAtMs ?? 0) - (left.lastUsedAtMs ?? 0));
		for (const candidate of ranked.slice(keep)) {
			Object.assign(candidate.result, await applyPruneAction(candidate.path, "lru_keep_limit", dryRun));
		}
	}

	return {
		root,
		scanned: results.length,
		removed: results.filter(entry => entry.removed).length,
		kept: results.filter(entry => !entry.removed && !entry.wouldRemove).length,
		entries: results,
	};
}

export { getCodeGraphIndexesRoot, getCodeGraphStorageRoot };
