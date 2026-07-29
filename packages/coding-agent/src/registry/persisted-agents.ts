import * as fs from "node:fs";
import * as path from "node:path";
import { ADVISOR_TRANSCRIPT_FILENAME, isAdvisorTranscriptName } from "../advisor/transcript-recorder";
import { oneLineLabel } from "../task/types";
import { persistedVibeChildIds } from "../vibe/runtime";
import { type AgentRef, type AgentRegistry, MAIN_AGENT_ID, resolveTopLevelAgent } from "./agent-registry";
import {
	mergePersistedAgentSnapshot,
	type PersistedAgentSessionSnapshot,
	readPersistedAgentSessionSnapshot,
	rememberPersistedAgentSnapshot,
	snapshotPersistedSessionEntries,
} from "./persisted-agent-snapshot";

/**
 * Prefer the already-open SessionManager index. When the owner is not live,
 * the bounded tail snapshot is deliberately best-effort: an unavailable old
 * Vibe spawn record must not make us replay a large transcript.
 */
function persistedSessionSnapshot(
	ref: AgentRef | undefined,
	sessionFile: string,
): Promise<PersistedAgentSessionSnapshot> {
	const manager = ref?.session?.sessionManager;
	if (manager && ref.sessionFile === sessionFile) {
		return Promise.resolve(
			snapshotPersistedSessionEntries(manager.getEntries(), {
				sessionTitle: manager.getSessionName(),
				sessionId: manager.getSessionId(),
			}),
		);
	}
	return readPersistedAgentSessionSnapshot(sessionFile);
}

/** Resolve the live ref that owns a persisted session file and a valid root tree. */
function resolvePersistedSessionOwner(registry: AgentRegistry, sessionFile: string): string | undefined {
	const refs = registry.list();
	if (refs.length === 0) return MAIN_AGENT_ID;
	const owners = refs.filter(ref => {
		if (ref.kind === "advisor" || ref.sessionFile !== sessionFile) return false;
		return resolveTopLevelAgent(registry, ref.id) !== undefined;
	});
	return owners.length === 1 ? owners[0]!.id : undefined;
}

function snapshotMetadata(
	ref: AgentRef,
	snapshot: PersistedAgentSessionSnapshot,
	overwrite: boolean,
): Partial<Pick<AgentRef, "sessionTitle" | "sessionId" | "activityState">> {
	return {
		...(snapshot.sessionTitle && (overwrite || ref.sessionTitle === undefined)
			? { sessionTitle: snapshot.sessionTitle }
			: {}),
		...(snapshot.sessionId && (overwrite || ref.sessionId === undefined) ? { sessionId: snapshot.sessionId } : {}),
		...(snapshot.activityState && (overwrite || ref.activityState === undefined)
			? { activityState: snapshot.activityState }
			: {}),
	};
}

function applyPersistedSnapshot(
	registry: AgentRegistry,
	ref: AgentRef,
	snapshot: PersistedAgentSessionSnapshot,
	overwrite: boolean,
): void {
	const metadata = snapshotMetadata(ref, snapshot, overwrite);
	if (Object.keys(metadata).length > 0) registry.updateMetadata(ref.id, metadata, ref);
	const activity = ref.activityState;
	if (activity && (metadata.activityState === activity || (overwrite && snapshot.activityState === activity))) {
		// Register/updateMetadata use wall time for live refs. A restored snapshot
		// must instead preserve the timestamp that was actually observed.
		ref.lastActivity = activity.lastActivityAtMs;
		ref.activity = oneLineLabel(activity.detail || activity.label);
	}
	rememberPersistedAgentSnapshot(ref, snapshot);
}

/** Register persisted subagent and advisor transcripts as parked registry refs. */
export async function registerPersistedSubagents(
	registry: AgentRegistry,
	sessionFile: string | null | undefined,
): Promise<void> {
	if (!sessionFile?.endsWith(".jsonl")) return;
	const ownerId = resolvePersistedSessionOwner(registry, sessionFile);
	if (!ownerId) return;
	const owner = registry.get(ownerId);
	const rootRef = resolveTopLevelAgent(registry, ownerId);
	const rootSnapshot = await persistedSessionSnapshot(owner, sessionFile);
	if (rootRef) applyPersistedSnapshot(registry, rootRef, rootSnapshot, rootRef.session === null);
	const vibeOwnedIds = persistedVibeChildIds(
		rootSnapshot.entries.filter(entry => typeof entry === "object" && entry !== null),
	);
	const root = sessionFile.slice(0, -6);
	await registerPersistedSubagentsFromDir(registry, root, ownerId, vibeOwnedIds, rootSnapshot);
}

async function registerPersistedSubagentsFromDir(
	registry: AgentRegistry,
	dir: string,
	parentId: string,
	vibeOwnedIds: ReadonlySet<string>,
	parentSnapshot: PersistedAgentSessionSnapshot,
): Promise<void> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.includes(".bak")) continue;
		const sessionFile = path.join(dir, entry.name);
		const childSnapshot = await persistedSessionSnapshot(registry.get(entry.name.slice(0, -6)), sessionFile);
		// The advisor transcript is observability-only: register it as a non-peer
		// `advisor` kind under its owning session so the Hub can show its read-only
		// transcript, but it never joins agent-facing rosters and is not revivable.
		if (isAdvisorTranscriptName(entry.name)) {
			const owner = parentId;
			// `__advisor.jsonl` → the default advisor (no slug); `__advisor.<slug>.jsonl`
			// → a named advisor, keyed and labeled by its slug.
			const slug =
				entry.name === ADVISOR_TRANSCRIPT_FILENAME ? "" : entry.name.slice("__advisor.".length, -".jsonl".length);
			const advisorId = slug ? `${owner}/advisor:${slug}` : `${owner}/advisor`;
			const displayName = slug ? `advisor:${slug}` : "advisor";
			const existing = registry.get(advisorId);
			// Never clobber a non-advisor ref that happens to share this id (a freak
			// user task literally named `<owner>/advisor`): leave it, skip the advisor.
			if (existing && existing.kind !== "advisor") continue;
			const snapshot = mergePersistedAgentSnapshot(childSnapshot, undefined);
			let ref = existing;
			if (existing?.sessionFile !== sessionFile) {
				// The id is reused across `/new`; refresh it to the current session's file.
				if (existing) registry.unregister(advisorId);
				ref = registry.register({
					id: advisorId,
					displayName,
					kind: "advisor",
					parentId: owner,
					session: null,
					sessionFile,
					status: "parked",
					...(snapshot.sessionTitle ? { sessionTitle: snapshot.sessionTitle } : {}),
					...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
					...(snapshot.activityState ? { activityState: snapshot.activityState } : {}),
				});
			}
			if (ref) applyPersistedSnapshot(registry, ref, snapshot, ref.session === null);
			continue;
		}
		const id = entry.name.slice(0, -6);
		if (vibeOwnedIds.has(id) && registry.get(id)?.sessionFile !== sessionFile) continue;
		const snapshot = mergePersistedAgentSnapshot(childSnapshot, parentSnapshot.observations.get(id));
		let ref = registry.get(id);
		if (!ref) {
			ref = registry.register({
				id,
				displayName: id,
				kind: "sub",
				parentId,
				session: null,
				sessionFile,
				status: "parked",
				...(snapshot.sessionTitle ? { sessionTitle: snapshot.sessionTitle } : {}),
				...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
				...(snapshot.activityState ? { activityState: snapshot.activityState } : {}),
			});
		}
		if (ref.sessionFile === sessionFile) applyPersistedSnapshot(registry, ref, snapshot, ref.session === null);
		await registerPersistedSubagentsFromDir(registry, path.join(dir, id), id, vibeOwnedIds, childSnapshot);
	}
}
