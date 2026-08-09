import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AuthCredential, AuthStorage, AuthStorageData } from "@oh-my-pi/pi-ai";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { loadPendingAdoption, removePendingAdoption } from "./adoption";
import { applyConfigSnapshot, collectConfigSnapshot, summarizeConfigSnapshot } from "./bundle";
import { decryptConfigBundle, encryptConfigSnapshot } from "./crypto";
import { mergeSnapshots } from "./merge";
import {
	getSyncConflictPath,
	isSyncProfileEnabled,
	loadSyncProfile,
	loadSyncState,
	requireSyncPassphrase,
	saveSyncProfile,
	saveSyncState,
} from "./profile";
import { findCommonRevisionId, loadRemoteGraph, publishSnapshot, type RemoteGraph } from "./protocol";
import { S3ConfigSyncStore } from "./store";
import {
	CONFIG_BUNDLE_VERSION,
	type ConfigConflictDocument,
	type ConfigConflictSummaryEntry,
	type ConfigFileEntry,
	type ConfigPublication,
	type ConfigSnapshot,
	type SyncPendingAdoption,
	type SyncProfile,
	type SyncState,
} from "./types";

export interface SyncRunOptions {
	mode: "push" | "pull";
	dryRun?: boolean;
	adopt?: boolean;
}
export interface SyncServiceDependencies {
	createStore?: (profile: SyncProfile) => S3ConfigSyncStore;
}

export interface SyncRunResult {
	status: "published" | "adopted" | "unchanged" | "conflict" | "empty-remote";
	publicationId?: string;
	revisionId?: string;
	conflicts?: ConfigConflictSummaryEntry[];
	tips: number;
	quarantined: number;
}

export interface SyncStatusResult {
	configured: boolean;
	enabled?: boolean;
	pendingAdoption?: boolean;
	writerId?: string;
	sequence?: number;
	publications?: number;
	revisions?: number;
	tips?: string[];
	quarantined?: Array<{ key: string; reason: string }>;
}

export async function getConfigSyncStatus(
	agentDir: string,
	dependencies: SyncServiceDependencies = {},
): Promise<SyncStatusResult> {
	const profile = await loadSyncProfile(agentDir, undefined, { allowDisabled: true });
	if (!profile) return { configured: false };
	const state = await loadSyncState(agentDir);
	const pendingAdoption = (await loadPendingAdoption(agentDir)) !== null;
	const graph = await loadRemoteGraph(dependencies.createStore?.(profile) ?? new S3ConfigSyncStore(profile));
	return {
		configured: true,
		enabled: await isSyncProfileEnabled(agentDir),
		pendingAdoption,
		writerId: state.writerId,
		sequence: state.sequence,
		publications: graph.publications.size,
		revisions: graph.revisions.size,
		tips: graph.tips.map(tip => tip.publicationId),
		quarantined: graph.quarantined,
	};
}

export async function synchronizeConfiguration(
	agentDir: string,
	authStorage: AuthStorage,
	options: SyncRunOptions,
	dependencies: SyncServiceDependencies = {},
): Promise<SyncRunResult> {
	const profile = await loadSyncProfile(agentDir, undefined, {
		allowDisabled: options.mode === "pull",
	});
	if (!profile) throw new Error("Configuration sync is not initialized; run `omp sync init`");
	const enabled = await isSyncProfileEnabled(agentDir);
	if (!enabled && options.mode === "push") {
		throw new Error("Configuration sync is disabled; enable sync before pushing");
	}
	if (!enabled && options.mode === "pull" && options.adopt !== true && options.dryRun !== true) {
		throw new Error("Configuration sync is disabled; run `omp sync pull --adopt` to adopt the remote configuration");
	}
	const passphrase = requireSyncPassphrase(agentDir, profile);
	const state = await loadSyncState(agentDir);
	const pendingAdoption = await loadPendingAdoption(agentDir);
	const store = dependencies.createStore?.(profile) ?? new S3ConfigSyncStore(profile);
	const graph = await loadRemoteGraph(store);
	const hasRemote = graph.tips.length > 0;
	const lastPublication = state.lastPublicationId ? graph.publications.get(state.lastPublicationId) : undefined;
	const hasValidLineage =
		state.lastRevisionId !== undefined &&
		lastPublication !== undefined &&
		lastPublication.revisionId === state.lastRevisionId;
	const needsAdoption = hasRemote && (!hasValidLineage || pendingAdoption !== null);
	if (options.mode === "push") {
		if (pendingAdoption) {
			throw new Error("Configuration sync is awaiting remote adoption; run `omp sync pull --adopt` before pushing");
		}
		if (needsAdoption) {
			throw new Error(
				"Remote configuration already exists without local lineage; run `omp sync pull --adopt` before pushing",
			);
		}
	}
	if (options.mode === "pull" && graph.tips.length === 0) {
		if (pendingAdoption !== null && options.adopt === true && options.dryRun !== true) {
			await finalizeAdoption(agentDir, profile, pendingAdoption);
		}
		return { status: "empty-remote", tips: 0, quarantined: graph.quarantined.length };
	}
	if (options.mode === "pull" && needsAdoption && options.adopt !== true && options.dryRun !== true) {
		throw new Error("Remote configuration requires explicit adoption; rerun with `omp sync pull --adopt`");
	}

	const local = await collectConfigSnapshot(agentDir, authStorage);
	const base = await loadMergeBase(graph, state, passphrase);
	const adopting = options.mode === "pull" && needsAdoption;
	let merged = adopting ? base : local;
	for (const tip of graph.tips) {
		const remote = await decryptConfigBundle(graph.revisions.get(tip.revisionId)!.bundle, passphrase);
		const result = mergeSnapshots(base, merged, remote);
		if (!result.merged) {
			const conflict: ConfigConflictDocument = {
				format: "omp-config-conflict",
				formatVersion: 1,
				createdAt: new Date().toISOString(),
				baseRevisionId: state.lastRevisionId,
				remoteRevisionIds: [tip.revisionId],
				base,
				local: merged,
				remote,
				conflicts: result.conflicts,
			};
			if (!options.dryRun) await writeConflictDocument(agentDir, conflict);
			return {
				status: "conflict",
				conflicts: result.conflicts.map(entry => ({ kind: entry.kind, key: entry.key })),
				tips: graph.tips.length,
				quarantined: graph.quarantined.length,
			};
		}
		merged = result.merged;
	}

	const payloadHash = summarizeConfigSnapshot(merged).payloadHash;
	const soleTip = graph.tips.length === 1 ? graph.tips[0] : undefined;
	if (soleTip) {
		const remote = await decryptConfigBundle(graph.revisions.get(soleTip.revisionId)!.bundle, passphrase);
		if (summarizeConfigSnapshot(remote).payloadHash === payloadHash) {
			if (!options.dryRun) {
				await applyConfigSnapshot(agentDir, authStorage, merged, { replace: true });
				await saveSyncState(agentDir, {
					...state,
					lastPublicationId: soleTip.publicationId,
					lastRevisionId: soleTip.revisionId,
					lastPayloadHash: payloadHash,
				});
				if (adopting) await finalizeAdoption(agentDir, profile, pendingAdoption);
				await removeConflictDocument(agentDir);
			}
			return {
				status: adopting ? "adopted" : state.lastRevisionId === soleTip.revisionId ? "unchanged" : "adopted",
				publicationId: soleTip.publicationId,
				revisionId: soleTip.revisionId,
				tips: 1,
				quarantined: graph.quarantined.length,
			};
		}
	}

	if (options.dryRun) {
		return {
			status: adopting ? "adopted" : "published",
			tips: graph.tips.length,
			quarantined: graph.quarantined.length,
		};
	}
	await applyConfigSnapshot(agentDir, authStorage, merged, { replace: true });
	const published = await publishMergedSnapshot(store, merged, graph.tips, state, passphrase);
	await saveSyncState(agentDir, {
		...state,
		sequence: state.sequence + 1,
		lastPublicationId: published.publicationId,
		lastRevisionId: published.revisionId,
		lastPayloadHash: payloadHash,
	});
	if (adopting) await finalizeAdoption(agentDir, profile, pendingAdoption);
	await removeConflictDocument(agentDir);
	return {
		status: adopting ? "adopted" : "published",
		publicationId: published.publicationId,
		revisionId: published.revisionId,
		tips: graph.tips.length,
		quarantined: graph.quarantined.length,
	};
}

async function finalizeAdoption(
	agentDir: string,
	profile: SyncProfile,
	pendingAdoption: SyncPendingAdoption | null,
): Promise<void> {
	if (pendingAdoption !== null) await removePendingAdoption(agentDir);
	await saveSyncProfile(
		agentDir,
		{ ...profile, autoPush: pendingAdoption?.autoPush ?? profile.autoPush },
		{ enabled: true },
	);
}
export async function resolveConfigurationConflict(
	agentDir: string,
	authStorage: AuthStorage,
	choice: "ours" | "theirs",
	target?: string,
): Promise<{ resolved: boolean; remaining: ConfigConflictSummaryEntry[]; publicationId?: string }> {
	const profile = await loadSyncProfile(agentDir);
	if (!profile) throw new Error("Configuration sync is not initialized");
	const passphrase = requireSyncPassphrase(agentDir, profile);
	const conflict = await readConflictDocument(agentDir);
	const selected = conflict.conflicts.filter(entry => target === undefined || entry.key === target);
	if (selected.length === 0)
		throw new Error(target ? `No configuration conflict for ${target}` : "No conflicts to resolve");
	const adjustedLocal = structuredClone(conflict.local);
	const adjustedRemote = structuredClone(conflict.remote);
	for (const entry of selected) {
		if (choice === "ours") setSnapshotValue(adjustedRemote, entry.kind, entry.key, entry.base);
		else setSnapshotValue(adjustedLocal, entry.kind, entry.key, entry.base);
	}
	const result = mergeSnapshots(conflict.base, adjustedLocal, adjustedRemote);
	if (!result.merged) {
		await writeConflictDocument(agentDir, {
			...conflict,
			createdAt: new Date().toISOString(),
			local: adjustedLocal,
			remote: adjustedRemote,
			conflicts: result.conflicts,
		});
		return {
			resolved: false,
			remaining: result.conflicts.map(entry => ({ kind: entry.kind, key: entry.key })),
		};
	}

	const state = await loadSyncState(agentDir);
	const store = new S3ConfigSyncStore(profile);
	const graph = await loadRemoteGraph(store);
	const remoteParents = new Set(conflict.remoteRevisionIds);
	const parents = graph.tips.filter(
		tip => remoteParents.has(tip.revisionId) || tip.publicationId === state.lastPublicationId,
	);
	await applyConfigSnapshot(agentDir, authStorage, result.merged, { replace: true });
	const published = await publishMergedSnapshot(store, result.merged, parents, state, passphrase);
	await saveSyncState(agentDir, {
		...state,
		sequence: state.sequence + 1,
		lastPublicationId: published.publicationId,
		lastRevisionId: published.revisionId,
		lastPayloadHash: summarizeConfigSnapshot(result.merged).payloadHash,
	});
	await removeConflictDocument(agentDir);
	return { resolved: true, remaining: [], publicationId: published.publicationId };
}

export async function garbageCollectConfiguration(
	agentDir: string,
	dryRun: boolean,
): Promise<{ publications: number; revisions: number; quarantined: number }> {
	const profile = await loadSyncProfile(agentDir);
	if (!profile) throw new Error("Configuration sync is not initialized");
	const state = await loadSyncState(agentDir);
	const store = new S3ConfigSyncStore(profile);
	const graph = await loadRemoteGraph(store);
	if (graph.tips.length !== 1) throw new Error("Config sync GC requires exactly one converged tip");
	const tip = graph.tips[0];
	const publicationDeletes = graph.publications.size;
	const revisionDeletes = graph.revisions.size;
	if (dryRun)
		return { publications: publicationDeletes, revisions: revisionDeletes, quarantined: graph.quarantined.length };
	const revision = graph.revisions.get(tip.revisionId)!;
	const checkpoint = await publishSnapshot(store, {
		bundle: revision.bundle,
		parents: [],
		writerId: state.writerId,
		sequence: state.sequence + 1,
		epochId: randomUUID(),
	});
	await saveSyncState(agentDir, {
		...state,
		sequence: state.sequence + 1,
		lastPublicationId: checkpoint.publication.publicationId,
		lastRevisionId: checkpoint.revision.revisionId,
	});
	for (const publication of graph.publications.values())
		await store.delete(store.publicationKey(publication.publicationId));
	for (const oldRevision of graph.revisions.values()) {
		if (oldRevision.revisionId !== checkpoint.revision.revisionId)
			await store.delete(store.revisionKey(oldRevision.revisionId));
	}
	for (const entry of graph.quarantined) await store.delete(entry.key);
	return { publications: publicationDeletes, revisions: revisionDeletes, quarantined: graph.quarantined.length };
}

async function loadMergeBase(graph: RemoteGraph, state: SyncState, passphrase: string): Promise<ConfigSnapshot> {
	const revisionIds = graph.tips.map(tip => tip.revisionId);
	if (state.lastRevisionId && graph.revisions.has(state.lastRevisionId)) revisionIds.push(state.lastRevisionId);
	const commonRevisionId = findCommonRevisionId(graph, revisionIds);
	if (!commonRevisionId) return emptySnapshot();
	return decryptConfigBundle(graph.revisions.get(commonRevisionId)!.bundle, passphrase);
}

async function publishMergedSnapshot(
	store: S3ConfigSyncStore,
	snapshot: ConfigSnapshot,
	parents: readonly ConfigPublication[],
	state: SyncState,
	passphrase: string,
): Promise<{ publicationId: string; revisionId: string }> {
	const bundle = await encryptConfigSnapshot(snapshot, passphrase);
	const published = await publishSnapshot(store, {
		bundle,
		parents,
		writerId: state.writerId,
		sequence: state.sequence + 1,
	});
	return { publicationId: published.publication.publicationId, revisionId: published.revision.revisionId };
}

function emptySnapshot(): ConfigSnapshot {
	return { formatVersion: CONFIG_BUNDLE_VERSION, createdAt: new Date(0).toISOString(), files: [], auth: {} };
}

async function writeConflictDocument(agentDir: string, conflict: ConfigConflictDocument): Promise<void> {
	const filePath = getSyncConflictPath(agentDir);
	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(tempPath, `${JSON.stringify(conflict, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await fs.rename(tempPath, filePath);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function readConflictDocument(agentDir: string): Promise<ConfigConflictDocument> {
	const value: unknown = await Bun.file(getSyncConflictPath(agentDir)).json();
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(value as { format?: unknown }).format !== "omp-config-conflict"
	) {
		throw new Error("Invalid configuration conflict document");
	}
	return value as ConfigConflictDocument;
}

async function removeConflictDocument(agentDir: string): Promise<void> {
	try {
		await fs.rm(getSyncConflictPath(agentDir));
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

function setSnapshotValue(
	snapshot: ConfigSnapshot,
	kind: "file" | "auth",
	key: string,
	value: ConfigFileEntry | AuthCredential[] | null,
): void {
	if (kind === "file") {
		snapshot.files = snapshot.files.filter(entry => entry.path !== key);
		if (value) snapshot.files.push(value as ConfigFileEntry);
		snapshot.files.sort((left, right) => left.path.localeCompare(right.path));
		return;
	}
	const auth = snapshot.auth as AuthStorageData;
	delete auth[key];
	if (value) auth[key] = value as AuthCredential[];
}
