import { hashStableJson } from "./crypto";
import {
	createConfigPublication,
	createConfigRevision,
	decodeConfigPublication,
	decodeConfigRevision,
	type S3ConfigSyncStore,
	validateConfigPublication,
	validateConfigRevision,
} from "./store";
import type { ConfigPublication, ConfigRevision, EncryptedConfigBundle, PublicationParent } from "./types";

export interface RemoteGraph {
	publications: Map<string, ConfigPublication>;
	revisions: Map<string, ConfigRevision>;
	tips: ConfigPublication[];
	quarantined: Array<{ key: string; reason: string }>;
}

export interface PublishSnapshotInput {
	bundle: EncryptedConfigBundle;
	parents: readonly ConfigPublication[];
	writerId: string;
	sequence: number;
	epochId?: string;
}

export interface PublishedSnapshot {
	revision: ConfigRevision;
	publication: ConfigPublication;
}

export async function loadRemoteGraph(store: S3ConfigSyncStore): Promise<RemoteGraph> {
	const quarantined: Array<{ key: string; reason: string }> = [];
	const keys = await loadStableRemoteKeys(store);
	const revisions = new Map<string, ConfigRevision>();
	for (const key of keys.revisions) {
		const content = await store.get(key);
		if (content === null) {
			quarantined.push({ key, reason: "object disappeared while loading" });
			continue;
		}
		let value: unknown;
		try {
			value = JSON.parse(content);
		} catch (error) {
			quarantined.push({ key, reason: `invalid JSON: ${String(error)}` });
			continue;
		}
		const revision = decodeConfigRevision(value);
		const validationError = revision ? validateConfigRevision(revision) : "invalid revision shape";
		if (!revision || validationError) {
			quarantined.push({ key, reason: validationError ?? "invalid revision" });
			continue;
		}
		if (key !== store.revisionKey(revision.revisionId)) {
			quarantined.push({ key, reason: "revision object key does not match its content ID" });
			continue;
		}
		revisions.set(revision.revisionId, revision);
	}

	let removedRevision = true;
	while (removedRevision) {
		removedRevision = false;
		for (const [revisionId, revision] of revisions) {
			const missing = revision.parentRevisionIds.find(parentId => !revisions.has(parentId));
			if (!missing) continue;
			revisions.delete(revisionId);
			quarantined.push({ key: store.revisionKey(revisionId), reason: `missing revision parent ${missing}` });
			removedRevision = true;
		}
	}

	const publications = new Map<string, ConfigPublication>();
	for (const key of keys.publications) {
		const content = await store.get(key);
		if (content === null) {
			quarantined.push({ key, reason: "object disappeared while loading" });
			continue;
		}
		let value: unknown;
		try {
			value = JSON.parse(content);
		} catch (error) {
			quarantined.push({ key, reason: `invalid JSON: ${String(error)}` });
			continue;
		}
		const publication = decodeConfigPublication(value);
		const validationError = publication ? validateConfigPublication(publication) : "invalid publication shape";
		if (!publication || validationError) {
			quarantined.push({ key, reason: validationError ?? "invalid publication" });
			continue;
		}
		if (key !== store.publicationKey(publication.publicationId)) {
			quarantined.push({ key, reason: "publication object key does not match its content ID" });
			continue;
		}
		const revision = revisions.get(publication.revisionId);
		if (!revision) {
			quarantined.push({ key, reason: `missing revision ${publication.revisionId}` });
			continue;
		}
		const revisionParents = [...revision.parentRevisionIds].sort();
		const publicationParents = [...new Set(publication.parents.map(parent => parent.revisionId))].sort();
		if (JSON.stringify(revisionParents) !== JSON.stringify(publicationParents)) {
			quarantined.push({ key, reason: "publication parents do not match revision parents" });
			continue;
		}
		publications.set(publication.publicationId, publication);
	}

	let removedPublication = true;
	while (removedPublication) {
		removedPublication = false;
		for (const [publicationId, publication] of publications) {
			const invalidParent = publication.parents.find(parent => {
				const stored = publications.get(parent.publicationId);
				return !stored || stored.revisionId !== parent.revisionId;
			});
			if (!invalidParent) continue;
			publications.delete(publicationId);
			quarantined.push({
				key: store.publicationKey(publicationId),
				reason: `missing or inconsistent publication parent ${invalidParent.publicationId}`,
			});
			removedPublication = true;
		}
	}

	const covered = new Set<string>();
	for (const publication of publications.values()) {
		for (const parent of publication.parents) covered.add(parent.publicationId);
	}
	const tips = [...publications.values()]
		.filter(publication => !covered.has(publication.publicationId))
		.sort((left, right) => left.publicationId.localeCompare(right.publicationId));
	return { publications, revisions, tips, quarantined };
}

async function loadStableRemoteKeys(
	store: S3ConfigSyncStore,
): Promise<{ revisions: string[]; publications: string[] }> {
	let previous: { revisions: string[]; publications: string[] } | undefined;
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const [revisions, publications] = await Promise.all([store.list("revisions/"), store.list("publications/")]);
		const current = { revisions, publications };
		if (
			previous &&
			arraysEqual(previous.revisions, current.revisions) &&
			arraysEqual(previous.publications, current.publications)
		) {
			return current;
		}
		previous = current;
	}
	throw new Error("Config sync object listing did not stabilize");
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
export async function publishSnapshot(
	store: S3ConfigSyncStore,
	input: PublishSnapshotInput,
): Promise<PublishedSnapshot> {
	const parentEpochIds = [...new Set(input.parents.map(parent => parent.epochId))];
	const epochId =
		input.epochId ??
		(parentEpochIds.length <= 1
			? (parentEpochIds[0] ?? "main")
			: `merge-${hashStableJson(input.parents.map(parent => parent.publicationId))}`);
	const parents: PublicationParent[] = input.parents.map(parent => ({
		publicationId: parent.publicationId,
		revisionId: parent.revisionId,
	}));
	const revision = createConfigRevision({
		parentRevisionIds: [...new Set(parents.map(parent => parent.revisionId))],
		payloadHash: hashStableJson(input.bundle),
		bundle: input.bundle,
	});
	await store.putRevision(revision);
	const publication = createConfigPublication({
		epochId,
		writerId: input.writerId,
		sequence: input.sequence,
		revisionId: revision.revisionId,
		parents,
	});
	await store.putPublication(publication);
	return { revision, publication };
}

export function findCommonRevisionId(graph: RemoteGraph, revisionIds: readonly string[]): string | undefined {
	const unique = [...new Set(revisionIds)];
	if (unique.length === 0) return undefined;
	const ancestorSets = unique.map(revisionId => collectRevisionAncestors(graph.revisions, revisionId));
	let candidates = [...ancestorSets[0]];
	for (let index = 1; index < ancestorSets.length; index += 1) {
		const ancestors = ancestorSets[index];
		candidates = candidates.filter(candidate => ancestors.has(candidate));
	}
	if (candidates.length === 0) return undefined;
	const depthCache = new Map<string, number>();
	candidates.sort((left, right) => {
		const depthDifference =
			revisionDepth(graph.revisions, right, depthCache, new Set()) -
			revisionDepth(graph.revisions, left, depthCache, new Set());
		return depthDifference || left.localeCompare(right);
	});
	return candidates[0];
}

function collectRevisionAncestors(revisions: ReadonlyMap<string, ConfigRevision>, revisionId: string): Set<string> {
	const result = new Set<string>();
	const pending = [revisionId];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || result.has(current)) continue;
		const revision = revisions.get(current);
		if (!revision) continue;
		result.add(current);
		pending.push(...revision.parentRevisionIds);
	}
	return result;
}

function revisionDepth(
	revisions: ReadonlyMap<string, ConfigRevision>,
	revisionId: string,
	cache: Map<string, number>,
	visiting: Set<string>,
): number {
	const cached = cache.get(revisionId);
	if (cached !== undefined) return cached;
	if (visiting.has(revisionId)) throw new Error(`Config revision graph contains a cycle at ${revisionId}`);
	visiting.add(revisionId);
	const revision = revisions.get(revisionId);
	const depth = revision
		? 1 + Math.max(0, ...revision.parentRevisionIds.map(parent => revisionDepth(revisions, parent, cache, visiting)))
		: 0;
	visiting.delete(revisionId);
	cache.set(revisionId, depth);
	return depth;
}
