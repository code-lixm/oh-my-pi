import type { AuthCredential, AuthStorageData } from "@oh-my-pi/pi-ai";
import { stableJson } from "./crypto";
import {
	CONFIG_BUNDLE_VERSION,
	type ConfigConflictEntry,
	type ConfigFileEntry,
	type ConfigSnapshot,
	type MergeResult,
} from "./types";

export interface MergeSnapshotsOptions {
	createdAt?: string;
}

interface IndexedSnapshot {
	files: Map<string, ConfigFileEntry>;
	auth: Map<string, AuthCredential[]>;
}

type MergeDecision<Value> =
	| {
			kind: "merged";
			value: Value | null;
	  }
	| {
			kind: "conflict";
	  };

/**
 * Merge one base, local snapshot, and remote snapshot. Missing paths/providers are
 * deletions. Provider credential arrays are deliberately atomic merge values.
 */
export function mergeSnapshots(
	base: ConfigSnapshot,
	local: ConfigSnapshot,
	remote: ConfigSnapshot,
	options: MergeSnapshotsOptions = {},
): MergeResult {
	const baseIndex = indexSnapshot(base, "base");
	const localIndex = indexSnapshot(local, "local");
	const remoteIndex = indexSnapshot(remote, "remote");
	const conflicts: ConfigConflictEntry[] = [];
	const files: ConfigFileEntry[] = [];
	const auth: AuthStorageData = {};

	for (const path of unionKeys(baseIndex.files, localIndex.files, remoteIndex.files)) {
		const baseFile = baseIndex.files.get(path) ?? null;
		const localFile = localIndex.files.get(path) ?? null;
		const remoteFile = remoteIndex.files.get(path) ?? null;
		const decision = resolveThreeWay(baseFile, localFile, remoteFile, equalFile);
		if (decision.kind === "conflict") {
			conflicts.push({
				kind: "file",
				key: path,
				base: baseFile,
				local: localFile,
				remote: remoteFile,
			});
		} else if (decision.value !== null) {
			files.push(decision.value);
		}
	}

	for (const provider of unionKeys(baseIndex.auth, localIndex.auth, remoteIndex.auth)) {
		const baseCredentials = baseIndex.auth.get(provider) ?? null;
		const localCredentials = localIndex.auth.get(provider) ?? null;
		const remoteCredentials = remoteIndex.auth.get(provider) ?? null;
		const decision = resolveThreeWay(baseCredentials, localCredentials, remoteCredentials, equalCredentials);
		if (decision.kind === "conflict") {
			conflicts.push({
				kind: "auth",
				key: provider,
				base: baseCredentials,
				local: localCredentials,
				remote: remoteCredentials,
			});
		} else if (decision.value !== null) {
			auth[provider] = decision.value;
		}
	}

	if (conflicts.length > 0) return { conflicts };
	return {
		merged: {
			formatVersion: CONFIG_BUNDLE_VERSION,
			createdAt: options.createdAt ?? new Date().toISOString(),
			files,
			auth,
		},
		conflicts,
	};
}

/**
 * Deterministic n-way merge against one common base. Every remote is folded by
 * the same three-way rule; a conflict stops the merge without fabricating data.
 */
export function mergeSnapshotSet(
	base: ConfigSnapshot,
	local: ConfigSnapshot,
	remotes: readonly ConfigSnapshot[],
	options: MergeSnapshotsOptions = {},
): MergeResult {
	let merged = local;
	const orderedRemotes = [...remotes].sort((left, right) => compareStrings(stableJson(left), stableJson(right)));
	for (const remote of orderedRemotes) {
		const result = mergeSnapshots(base, merged, remote, options);
		if (result.merged === undefined) return result;
		merged = result.merged;
	}
	return remotes.length === 0 ? { merged: local, conflicts: [] } : { merged, conflicts: [] };
}

export const mergeConfigSnapshots = mergeSnapshots;

function indexSnapshot(snapshot: ConfigSnapshot, label: string): IndexedSnapshot {
	const files = new Map<string, ConfigFileEntry>();
	for (const file of snapshot.files) {
		if (file.path.length === 0) throw new Error(`${label} snapshot contains an empty file path`);
		if (files.has(file.path)) throw new Error(`${label} snapshot contains duplicate file path ${file.path}`);
		files.set(file.path, file);
	}

	const auth = new Map<string, AuthCredential[]>();
	for (const [provider, entry] of Object.entries(snapshot.auth)) {
		if (provider.length === 0) throw new Error(`${label} snapshot contains an empty auth provider`);
		const credentials = normalizeCredentials(entry);
		if (credentials.length === 0)
			throw new Error(`${label} snapshot contains an empty credential group for ${provider}`);
		auth.set(provider, credentials);
	}
	return { files, auth };
}

function normalizeCredentials(entry: AuthCredential | AuthCredential[]): AuthCredential[] {
	return Array.isArray(entry) ? entry : [entry];
}

function resolveThreeWay<Value>(
	base: Value | null,
	local: Value | null,
	remote: Value | null,
	equals: (left: Value | null, right: Value | null) => boolean,
): MergeDecision<Value> {
	if (equals(local, remote)) return { kind: "merged", value: local };
	if (equals(base, local)) return { kind: "merged", value: remote };
	if (equals(base, remote)) return { kind: "merged", value: local };
	return { kind: "conflict" };
}

function equalFile(left: ConfigFileEntry | null, right: ConfigFileEntry | null): boolean {
	return left === right || (left !== null && right !== null && stableJson(left) === stableJson(right));
}

function equalCredentials(left: AuthCredential[] | null, right: AuthCredential[] | null): boolean {
	return left === right || (left !== null && right !== null && stableJson(left) === stableJson(right));
}

function unionKeys<Value>(...maps: ReadonlyArray<ReadonlyMap<string, Value>>): string[] {
	const keys = new Set<string>();
	for (const map of maps) {
		for (const key of map.keys()) keys.add(key);
	}
	return [...keys].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
