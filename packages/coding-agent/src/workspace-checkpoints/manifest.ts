/**
 * Workspace manifest serialisation.
 *
 * The {@link WorkspaceManifest} is the source of truth for what a checkpoint
 * captured. It is serialised as a deterministic, content-addressed JSON blob
 * stored in the workspace content store, keyed by `sha256:<hex>` and reused
 * across checkpoint records. Saving round-trips through an ordered JSON form
 * so identical manifests hash to the same object id, which is what makes
 * `manifestObjectId` reuse work between checkpoints with no file changes.
 */
import * as path from "node:path";
import { parseObjectId, type WorkspaceContentStore } from "./content-store";
import type {
	GitIndexSnapshot,
	GitRepositorySnapshot,
	WorkspaceCheckpointExclusion,
	WorkspaceManifest,
	WorkspaceManifestEntry,
} from "./types";

/** Schema version embedded in every serialised manifest. */
export const MANIFEST_VERSION = 1 as const;

/** Constructor options for {@link createWorkspaceManifest}. */
export interface CreateWorkspaceManifestOptions {
	workspaceId?: string;
	gitRepositories?: GitRepositorySnapshot[];
	trackedIgnoredPaths?: readonly string[];
	respectsGitIgnore?: boolean;
	now?: () => Date;
}

/** Per-cap contents for sub-objects to keep serialisation deterministic. */
export interface PersistedManifest {
	/** Manifest body, as stored in the content store. */
	manifest: WorkspaceManifest;
	/** Persisted JSON bytes (raw SHA-256 input). */
	bytes: Uint8Array;
	/** Content id `sha256:<hex>`. */
	manifestObjectId: string;
}

/**
 * Construct a {@link WorkspaceManifest} with sensible defaults:
 *
 *   - `version` is always `MANIFEST_VERSION`.
 *   - `workspaceId` defaults to a stable sha256 of `rootPath` so capturing
 *     an empty/unknown workspace still hashes deterministically.
 *   - `gitRepositories` defaults to an empty array when omitted.
 *   - Defensive copies of arrays and entries ensure later mutations to the
 *     caller's data don't leak back into the manifest.
 */
export function createWorkspaceManifest(
	rootPath: string,
	entries: WorkspaceManifestEntry[],
	exclusions: WorkspaceCheckpointExclusion[],
	options: CreateWorkspaceManifestOptions = {},
): WorkspaceManifest {
	const resolvedRoot = path.resolve(rootPath);
	return {
		version: MANIFEST_VERSION,
		workspaceId: options.workspaceId ?? stableWorkspaceId(resolvedRoot),
		rootPath: resolvedRoot,
		entries: entries.map(cloneEntry),
		gitRepositories: (options.gitRepositories ?? []).map(cloneRepositorySnapshot),
		exclusions: exclusions.map(cloneExclusion),
		trackedIgnoredPaths: normalizeTrackedIgnoredPaths(resolvedRoot, options.trackedIgnoredPaths),
		respectsGitIgnore: options.respectsGitIgnore ?? false,
	};
}

/**
 * Serialize `manifest` into the canonical JSON byte form the content store
 * hashes. Keys are emitted in a stable order across runs so identical
 * manifests always produce the same sha256.
 */
export function serializeWorkspaceManifest(manifest: WorkspaceManifest): string {
	return JSON.stringify(toStorable(manifest));
}

/**
 * Save `manifest` into `store` and return the persisted form (bytes + id).
 *
 * Re-uploading an identical manifest reuses the existing object — the
 * content-addressed store deduplicates by sha256 automatically.
 */
export async function saveWorkspaceManifest(
	store: WorkspaceContentStore,
	manifest: WorkspaceManifest,
): Promise<PersistedManifest> {
	const text = serializeWorkspaceManifest(manifest);
	const bytes = new TextEncoder().encode(text);
	const { id, bytes: stored } = await store.putBytes(bytes);
	if (stored !== bytes.byteLength) {
		// `putBytes` is infallible at byte-length zero and writes the buffer
		// whole; this branch is purely defensive against a future change.
		throw new Error(`Content store reported ${stored} bytes for a ${bytes.byteLength}-byte manifest`);
	}
	return { manifest: cloneManifest(manifest), bytes, manifestObjectId: id };
}

/** Load the manifest stored as `manifestObjectId`, or `null` when absent. */
export async function loadWorkspaceManifest(
	store: WorkspaceContentStore,
	manifestObjectId: string,
): Promise<WorkspaceManifest | null> {
	if (!store.hasId(manifestObjectId)) {
		return null;
	}
	const bytes = await store.readBytes(manifestObjectId);
	if (!bytes) return null;
	const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	return parseWorkspaceManifest(text, manifestObjectId);
}

/** Collect every CAS object reachable from a persisted manifest. */
export function collectWorkspaceManifestObjectIds(manifest: WorkspaceManifest): Set<string> {
	const objectIds = new Set<string>();
	const add = (objectId: string | null | undefined): void => {
		if (objectId === null || objectId === undefined) return;
		parseObjectId(objectId);
		objectIds.add(objectId);
	};
	for (const entry of manifest.entries) add(entry.objectId);
	for (const repository of manifest.gitRepositories) {
		add(repository.rawHeadObjectId);
		if (!repository.index) continue;
		add(repository.index.objectId);
		for (const objectId of repository.index.sharedIndexObjectIds) add(objectId);
	}
	return objectIds;
}

/** Parse a stored manifest JSON payload into a {@link WorkspaceManifest}. */
export function parseWorkspaceManifest(text: string, manifestObjectId?: string): WorkspaceManifest {
	const parsed = JSON.parse(text) as WorkspaceManifest;
	const validated = validateWorkspaceManifest(parsed, manifestObjectId);
	return validated;
}

/**
 * Validate `parsed` against the {@link WorkspaceManifest} contract. Throws
 * an `Error` with a useful message identifying the offending field when the
 * payload is malformed; returns the normalised value otherwise.
 */
export function validateWorkspaceManifest(parsed: unknown, manifestObjectId?: string): WorkspaceManifest {
	if (!parsed || typeof parsed !== "object") {
		throw new Error("Workspace manifest must be a JSON object");
	}
	const raw = parsed as Record<string, unknown>;
	if (raw.version !== MANIFEST_VERSION) {
		throw new Error(`Workspace manifest version mismatch: expected ${MANIFEST_VERSION}, got ${String(raw.version)}`);
	}
	if (typeof raw.workspaceId !== "string" || raw.workspaceId.length === 0) {
		throw new Error("Workspace manifest is missing a non-empty workspaceId");
	}
	if (typeof raw.rootPath !== "string" || raw.rootPath.length === 0) {
		throw new Error("Workspace manifest is missing a non-empty rootPath");
	}
	if (!Array.isArray(raw.entries)) {
		throw new Error("Workspace manifest must include an entries[] array");
	}
	if (!Array.isArray(raw.exclusions)) {
		throw new Error("Workspace manifest must include an exclusions[] array");
	}
	if (!Array.isArray(raw.gitRepositories)) {
		throw new Error("Workspace manifest must include a gitRepositories[] array");
	}
	const entries: WorkspaceManifestEntry[] = [];
	for (const [index, candidate] of raw.entries.entries()) {
		entries.push(validateManifestEntry(candidate, index));
	}
	const exclusions: WorkspaceCheckpointExclusion[] = [];
	for (const [index, candidate] of raw.exclusions.entries()) {
		if (!candidate || typeof candidate !== "object") {
			throw new Error(`Workspace manifest exclusion[${index}] must be an object`);
		}
		const rec = candidate as Record<string, unknown>;
		if (typeof rec.path !== "string") {
			throw new Error(`Workspace manifest exclusion[${index}].path must be a string`);
		}
		if (typeof rec.reason !== "string") {
			throw new Error(`Workspace manifest exclusion[${index}].reason must be a string`);
		}
		exclusions.push({ path: rec.path, reason: rec.reason });
	}
	const gitRepositories: GitRepositorySnapshot[] = [];
	for (const [index, candidate] of raw.gitRepositories.entries()) {
		gitRepositories.push(validateRepositorySnapshot(candidate, index));
	}
	const trackedIgnoredPaths = normalizeTrackedIgnoredPaths(raw.rootPath, raw.trackedIgnoredPaths);
	if (raw.respectsGitIgnore !== undefined && typeof raw.respectsGitIgnore !== "boolean") {
		throw new Error("Workspace manifest respectsGitIgnore must be a boolean when present");
	}
	const respectsGitIgnore = raw.respectsGitIgnore === true;
	// Optionally sanity-check that the manifestObjectId we trust matches the
	// canonical sha256 of the bytes — caller passes one when loading from disk
	// and we can mismatch loudly instead of silently swapping in a different
	// manifest in the future.
	if (typeof manifestObjectId === "string") {
		parseObjectId(manifestObjectId);
	}
	return {
		version: MANIFEST_VERSION,
		workspaceId: raw.workspaceId,
		rootPath: raw.rootPath,
		entries,
		exclusions,
		gitRepositories,
		trackedIgnoredPaths,
		respectsGitIgnore,
	};
}

/** Produce a fresh, deep-cloned copy of `manifest`. */
export function cloneManifest(manifest: WorkspaceManifest): WorkspaceManifest {
	return {
		version: manifest.version,
		workspaceId: manifest.workspaceId,
		rootPath: manifest.rootPath,
		entries: manifest.entries.map(cloneEntry),
		exclusions: manifest.exclusions.map(cloneExclusion),
		gitRepositories: manifest.gitRepositories.map(cloneRepositorySnapshot),
		trackedIgnoredPaths: normalizeTrackedIgnoredPaths(manifest.rootPath, manifest.trackedIgnoredPaths),
		respectsGitIgnore: manifest.respectsGitIgnore ?? false,
	};
}

/**
 * Stable workspace id derived from a resolved root path. Mirrors the scanner
 * implementation so the manifest and the scan cannot drift apart on what
 * they call "the same workspace".
 */
export function getStableWorkspaceIdFromPath(rootPath: string): string {
	return stableWorkspaceId(path.resolve(rootPath));
}

function stableWorkspaceId(resolvedRoot: string): string {
	const digest = new Bun.CryptoHasher("sha256").update(resolvedRoot).digest("hex");
	return `ws:${digest}`;
}

/** Validate, slash-normalize, deduplicate, and order paths relative to `rootPath`. */
function normalizeTrackedIgnoredPaths(rootPath: string, candidates: unknown): string[] {
	if (candidates === undefined) return [];
	if (!Array.isArray(candidates)) {
		throw new Error("Workspace manifest trackedIgnoredPaths must be an array when present");
	}
	const resolvedRoot = path.resolve(rootPath);
	const normalized = new Set<string>();
	for (const [index, candidate] of candidates.entries()) {
		if (typeof candidate !== "string" || candidate.length === 0) {
			throw new Error(`Workspace manifest trackedIgnoredPaths[${index}] must be a non-empty string`);
		}
		const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(resolvedRoot, candidate);
		const relative = path.relative(resolvedRoot, resolved);
		if (
			relative === "" ||
			relative === "." ||
			relative === ".." ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		) {
			throw new Error(`Workspace manifest trackedIgnoredPaths[${index}] escapes workspace root`);
		}
		normalized.add(relative.split(path.sep).join("/"));
	}
	return [...normalized].sort();
}

function validateManifestEntry(candidate: unknown, index: number): WorkspaceManifestEntry {
	if (!candidate || typeof candidate !== "object") {
		throw new Error(`Workspace manifest entry[${index}] must be an object`);
	}
	const rec = candidate as Record<string, unknown>;
	if (rec.kind !== "directory" && rec.kind !== "file" && rec.kind !== "symlink") {
		throw new Error(`Workspace manifest entry[${index}].kind must be directory|file|symlink`);
	}
	if (typeof rec.path !== "string") {
		throw new Error(`Workspace manifest entry[${index}].path must be a string`);
	}
	if (typeof rec.mode !== "number") {
		throw new Error(`Workspace manifest entry[${index}].mode must be a number`);
	}
	if (typeof rec.mtimeMs !== "number") {
		throw new Error(`Workspace manifest entry[${index}].mtimeMs must be a number`);
	}
	if (typeof rec.size !== "number") {
		throw new Error(`Workspace manifest entry[${index}].size must be a number`);
	}
	const entry: WorkspaceManifestEntry = {
		path: rec.path,
		kind: rec.kind,
		mode: rec.mode,
		mtimeMs: rec.mtimeMs,
		size: rec.size,
	};
	if (typeof rec.objectId === "string") entry.objectId = rec.objectId;
	if (typeof rec.linkTarget === "string") entry.linkTarget = rec.linkTarget;
	return entry;
}

function validateRepositorySnapshot(candidate: unknown, index: number): GitRepositorySnapshot {
	if (!candidate || typeof candidate !== "object") {
		throw new Error(`Workspace manifest gitRepositories[${index}] must be an object`);
	}
	const rec = candidate as Record<string, unknown>;
	if (typeof rec.worktreePath !== "string") {
		throw new Error(`gitRepositories[${index}].worktreePath must be a string`);
	}
	if (typeof rec.gitDir !== "string") {
		throw new Error(`gitRepositories[${index}].gitDir must be a string`);
	}
	if (typeof rec.commonDir !== "string") {
		throw new Error(`gitRepositories[${index}].commonDir must be a string`);
	}
	const snapshot: GitRepositorySnapshot = {
		worktreePath: rec.worktreePath,
		gitDir: rec.gitDir,
		commonDir: rec.commonDir,
		head: typeof rec.head === "string" ? rec.head : null,
		headRef: typeof rec.headRef === "string" ? rec.headRef : null,
		index: rec.index && typeof rec.index === "object" ? validateIndexSnapshot(rec.index) : null,
	};
	if (rec.headContent !== undefined) {
		if (rec.headContent !== null && typeof rec.headContent !== "string") {
			throw new Error(`gitRepositories[${index}].headContent must be a string or null`);
		}
		snapshot.headContent = rec.headContent;
	}
	if (rec.rawHeadObjectId !== undefined) {
		if (rec.rawHeadObjectId !== null && typeof rec.rawHeadObjectId !== "string") {
			throw new Error(`gitRepositories[${index}].rawHeadObjectId must be a string or null`);
		}
		snapshot.rawHeadObjectId = rec.rawHeadObjectId;
	}
	if (rec.isSubmodule !== undefined) {
		if (typeof rec.isSubmodule !== "boolean") {
			throw new Error(`gitRepositories[${index}].isSubmodule must be a boolean`);
		}
		snapshot.isSubmodule = rec.isSubmodule;
	}
	return snapshot;
}

function validateIndexSnapshot(candidate: unknown): GitIndexSnapshot | null {
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
		return null;
	}
	const rec = candidate as Record<string, unknown>;
	if (typeof rec.path !== "string" || typeof rec.objectId !== "string") return null;
	const sharedIds = Array.isArray(rec.sharedIndexObjectIds)
		? rec.sharedIndexObjectIds.filter((id): id is string => typeof id === "string")
		: [];
	const sharedNames = Array.isArray(rec.sharedIndexNames)
		? rec.sharedIndexNames.filter((name): name is string => typeof name === "string")
		: [];
	return {
		path: rec.path,
		objectId: rec.objectId,
		sharedIndexObjectIds: sharedIds,
		sharedIndexNames: sharedNames,
	};
}

function cloneEntry(entry: WorkspaceManifestEntry): WorkspaceManifestEntry {
	const cloned: WorkspaceManifestEntry = {
		path: entry.path,
		kind: entry.kind,
		mode: entry.mode,
		mtimeMs: entry.mtimeMs,
		size: entry.size,
	};
	if (entry.objectId !== undefined) cloned.objectId = entry.objectId;
	if (entry.linkTarget !== undefined) cloned.linkTarget = entry.linkTarget;
	return cloned;
}

function cloneExclusion(exclusion: WorkspaceCheckpointExclusion): WorkspaceCheckpointExclusion {
	return { path: exclusion.path, reason: exclusion.reason };
}

function cloneRepositorySnapshot(snapshot: GitRepositorySnapshot): GitRepositorySnapshot {
	const cloned: GitRepositorySnapshot = {
		worktreePath: snapshot.worktreePath,
		gitDir: snapshot.gitDir,
		commonDir: snapshot.commonDir,
		head: snapshot.head,
		headRef: snapshot.headRef,
		index: snapshot.index ? cloneIndexSnapshot(snapshot.index) : null,
	};
	if (snapshot.headContent !== undefined) cloned.headContent = snapshot.headContent;
	if (snapshot.rawHeadObjectId !== undefined) cloned.rawHeadObjectId = snapshot.rawHeadObjectId;
	if (snapshot.isSubmodule !== undefined) cloned.isSubmodule = snapshot.isSubmodule;
	return cloned;
}

function cloneIndexSnapshot(
	index: NonNullable<GitRepositorySnapshot["index"]>,
): NonNullable<GitRepositorySnapshot["index"]> {
	return {
		path: index.path,
		objectId: index.objectId,
		sharedIndexObjectIds: index.sharedIndexObjectIds.slice(),
		sharedIndexNames: index.sharedIndexNames.slice(),
	};
}

/**
 * Stable JSON form for {@link WorkspaceManifest}. The keys are emitted in a
 * fixed order so identical content always produces identical bytes.
 *
 * The manifest's shape is fixed in the types module; this function enforces
 * key ordering (helps when debugging diffs between two captured manifests).
 */
function toStorable(manifest: WorkspaceManifest): Record<string, unknown> {
	return {
		version: manifest.version,
		workspaceId: manifest.workspaceId,
		rootPath: manifest.rootPath,
		entries: manifest.entries.map(entry => ({
			path: entry.path,
			kind: entry.kind,
			mode: entry.mode,
			mtimeMs: entry.mtimeMs,
			size: entry.size,
			objectId: entry.objectId,
			linkTarget: entry.linkTarget,
		})),
		gitRepositories: manifest.gitRepositories.map(repo => ({
			worktreePath: repo.worktreePath,
			gitDir: repo.gitDir,
			commonDir: repo.commonDir,
			head: repo.head,
			headRef: repo.headRef,
			index: repo.index,
			headContent: repo.headContent,
			rawHeadObjectId: repo.rawHeadObjectId,
			isSubmodule: repo.isSubmodule,
		})),
		exclusions: manifest.exclusions.map(exclusion => ({
			path: exclusion.path,
			reason: exclusion.reason,
		})),
		trackedIgnoredPaths: normalizeTrackedIgnoredPaths(manifest.rootPath, manifest.trackedIgnoredPaths),
		respectsGitIgnore: manifest.respectsGitIgnore ?? false,
	};
}
