import * as fs from "node:fs/promises";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { type AgentRef, AgentRegistry, resolveTopLevelAgent } from "../../registry/agent-registry";
import { getPersistedAgentSnapshot } from "../../registry/persisted-agent-snapshot";
import { registerPersistedSubagents } from "../../registry/persisted-agents";
import type { FileEntry, SessionMessageEntry } from "../../session/session-entries";
import { parseSessionEntries } from "../../session/session-loader";
import {
	type AgentProgress,
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../../task";
import type { EventBus } from "../../utils/event-bus";
import type {
	RpcSubagentEventFrame,
	RpcSubagentFrame,
	RpcSubagentMessagesResult,
	RpcSubagentSnapshot,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

export interface RpcSubagentTranscriptSelector {
	subagentId?: string;
	sessionFile?: string;
	fromByte?: number;
}

type RpcSubagentOutput = (frame: RpcSubagentFrame) => void;

const MAX_RETAINED_TRANSCRIPT_REFERENCES = 256;

function isSessionMessageEntry(entry: FileEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function statusFromLifecycle(status: SubagentLifecyclePayload["status"]): AgentProgress["status"] {
	return status === "started" ? "running" : status;
}

function isTerminalLifecycleStatus(status: SubagentLifecyclePayload["status"]): boolean {
	return status !== "started";
}

function hasSameOwner(
	payload: Pick<SubagentLifecyclePayload | SubagentProgressPayload, "parentToolCallId" | "sessionFile">,
	snapshot: RpcSubagentSnapshot,
): boolean {
	if (payload.parentToolCallId !== undefined && snapshot.parentToolCallId !== undefined) {
		return payload.parentToolCallId === snapshot.parentToolCallId;
	}
	if (payload.sessionFile !== undefined && snapshot.sessionFile !== undefined) {
		return payload.sessionFile === snapshot.sessionFile;
	}
	return true;
}

function addPruned(set: Set<string>, value: string, maxSize: number): void {
	set.delete(value);
	set.add(value);
	while (set.size > maxSize) {
		const oldest = set.keys().next();
		if (oldest.done) break;
		set.delete(oldest.value);
	}
}

export async function readRpcSubagentTranscript(sessionFile: string, fromByte = 0): Promise<RpcSubagentMessagesResult> {
	let startByte = Number.isFinite(fromByte) ? Math.max(0, Math.trunc(fromByte)) : 0;
	const file = Bun.file(sessionFile);
	let size: number;
	try {
		({ size } = await fs.stat(sessionFile));
	} catch (err) {
		if (!isEnoent(err)) throw err;
		return {
			sessionFile,
			fromByte: startByte,
			nextByte: startByte,
			reset: false,
			entries: [],
			messages: [],
		};
	}
	let reset = false;
	if (startByte > size) {
		startByte = 0;
		reset = true;
	}

	const text = startByte >= size ? "" : await file.slice(startByte).text();
	const lastNewline = text.lastIndexOf("\n");
	const completeText = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
	const entries = completeText.length > 0 ? parseSessionEntries(completeText) : [];
	const nextByte = startByte + Buffer.byteLength(completeText, "utf8");

	return {
		sessionFile,
		fromByte: startByte,
		nextByte,
		reset,
		entries,
		messages: entries.filter(isSessionMessageEntry).map(entry => entry.message),
	};
}

export class RpcSubagentRegistry {
	#subagents = new Map<string, RpcSubagentSnapshot>();
	#transcriptSessionFilesBySubagentId = new Map<string, string>();
	#staleSubagentIds = new Set<string>();
	#unsubscribers: Array<() => void> = [];
	#output: RpcSubagentOutput;
	#subscriptionLevel: RpcSubagentSubscriptionLevel = "off";
	#persistedSessionFile: string | undefined;
	#persistedHydration: Promise<void> | undefined;

	constructor(eventBus: EventBus, output: RpcSubagentOutput) {
		this.#output = output;
		this.#unsubscribers.push(
			eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
				this.handleLifecycle(data as SubagentLifecyclePayload);
			}),
			eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
				this.handleProgress(data as SubagentProgressPayload);
			}),
			eventBus.on(TASK_SUBAGENT_EVENT_CHANNEL, data => {
				this.handleEvent(data as SubagentEventPayload);
			}),
		);
	}

	dispose(): void {
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#unsubscribers = [];
		this.#subagents.clear();
		this.#transcriptSessionFilesBySubagentId.clear();
		this.#staleSubagentIds.clear();
		this.#persistedSessionFile = undefined;
		this.#persistedHydration = undefined;
	}

	clear(): void {
		for (const subagentId of this.#subagents.keys()) {
			addPruned(this.#staleSubagentIds, subagentId, MAX_RETAINED_TRANSCRIPT_REFERENCES);
		}
		for (const subagentId of this.#transcriptSessionFilesBySubagentId.keys()) {
			addPruned(this.#staleSubagentIds, subagentId, MAX_RETAINED_TRANSCRIPT_REFERENCES);
		}
		this.#subagents.clear();
		this.#transcriptSessionFilesBySubagentId.clear();
		this.#persistedSessionFile = undefined;
		this.#persistedHydration = undefined;
	}

	setSubscriptionLevel(level: RpcSubagentSubscriptionLevel): void {
		this.#subscriptionLevel = level;
	}

	getSubscriptionLevel(): RpcSubagentSubscriptionLevel {
		return this.#subscriptionLevel;
	}

	/** Load parked refs once for the active RPC session without replaying transcripts. */
	async hydratePersisted(sessionFile: string | undefined): Promise<void> {
		if (!sessionFile?.endsWith(".jsonl")) return;
		if (this.#persistedSessionFile === sessionFile && this.#persistedHydration) {
			await this.#persistedHydration;
			return;
		}
		this.#persistedSessionFile = sessionFile;
		const hydration = registerPersistedSubagents(AgentRegistry.global(), sessionFile).catch(error => {
			logger.warn("Failed to hydrate persisted RPC subagents", { sessionFile, error: String(error) });
		});
		this.#persistedHydration = hydration;
		await hydration;
	}
	getSubagents(): RpcSubagentSnapshot[] {
		const snapshots = new Map(this.#subagents);
		for (const ref of AgentRegistry.global().list()) {
			if (snapshots.has(ref.id) || this.#staleSubagentIds.has(ref.id)) continue;
			const snapshot = this.#persistedSnapshot(ref);
			if (snapshot) snapshots.set(snapshot.id, snapshot);
		}
		return [...snapshots.values()]
			.map(snapshot => {
				const ref = AgentRegistry.global().get(snapshot.id);
				const persistedProgress =
					ref?.session === null
						? getPersistedAgentSnapshot(ref)?.observations.get(snapshot.id)?.progress
						: undefined;
				const progress = snapshot.progress ?? persistedProgress;
				const metadata = this.#mirrorMetadata(snapshot.id, progress, snapshot);
				return {
					...snapshot,
					...(snapshot.progress === undefined && progress !== undefined ? { progress } : {}),
					...metadata,
					...(metadata.terminalStatus === undefined ? {} : { status: metadata.terminalStatus }),
				};
			})
			.sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
	}

	#rememberTranscriptSession(subagentId: string, sessionFile: string | undefined): void {
		if (!sessionFile) return;
		this.#transcriptSessionFilesBySubagentId.delete(subagentId);
		this.#transcriptSessionFilesBySubagentId.set(subagentId, sessionFile);
		while (this.#transcriptSessionFilesBySubagentId.size > MAX_RETAINED_TRANSCRIPT_REFERENCES) {
			const oldest = this.#transcriptSessionFilesBySubagentId.keys().next();
			if (oldest.done) break;
			this.#transcriptSessionFilesBySubagentId.delete(oldest.value);
		}
	}

	#hasTranscriptSessionFile(sessionFile: string): boolean {
		for (const snapshot of this.#subagents.values()) {
			if (snapshot.sessionFile === sessionFile) return true;
		}
		for (const ref of AgentRegistry.global().list()) {
			if (this.#staleSubagentIds.has(ref.id)) continue;
			if (this.#persistedSnapshot(ref)?.sessionFile === sessionFile) return true;
		}
		for (const transcriptSessionFile of this.#transcriptSessionFilesBySubagentId.values()) {
			if (transcriptSessionFile === sessionFile) return true;
		}
		return false;
	}

	#persistedSnapshot(ref: AgentRef | undefined): RpcSubagentSnapshot | undefined {
		if (ref?.kind !== "sub" || ref.session !== null) return undefined;
		const persisted = getPersistedAgentSnapshot(ref);
		const observation = persisted?.observations.get(ref.id);
		const parentTerminalStatus =
			observation?.status === "completed" || observation?.status === "failed" || observation?.status === "aborted"
				? observation.status
				: undefined;
		const terminalStatus =
			ref.status === "aborted"
				? "aborted"
				: (ref.terminalStatus ?? parentTerminalStatus ?? persisted?.terminalStatus);
		if (
			!observation ||
			observation.id !== ref.id ||
			observation.index === undefined ||
			observation.agent === undefined ||
			observation.agentSource === undefined ||
			observation.status === undefined ||
			observation.lastUpdate === undefined
		) {
			return undefined;
		}
		const sessionFile = observation.sessionFile ?? ref.sessionFile ?? undefined;
		const status = terminalStatus ?? observation.status;
		const progress =
			observation.progress && terminalStatus !== undefined
				? { ...observation.progress, status: terminalStatus }
				: observation.progress;
		const snapshot: RpcSubagentSnapshot = {
			id: observation.id,
			index: observation.index,
			agent: observation.agent,
			agentSource: observation.agentSource,
			status,
			lastUpdate: observation.lastUpdate,
			...(observation.description === undefined ? {} : { description: observation.description }),
			...(observation.task === undefined ? {} : { task: observation.task }),
			...(observation.assignment === undefined ? {} : { assignment: observation.assignment }),
			...(sessionFile === undefined ? {} : { sessionFile }),
			...(observation.parentToolCallId === undefined ? {} : { parentToolCallId: observation.parentToolCallId }),
			...(progress === undefined ? {} : { progress }),
		};
		return { ...snapshot, ...this.#mirrorMetadata(ref.id, progress, snapshot) };
	}

	#mirrorMetadata(id: string, progress: AgentProgress | undefined, existing: RpcSubagentSnapshot | undefined) {
		const registry = AgentRegistry.global();
		const ref = registry.get(id);
		const persisted = ref?.session === null ? getPersistedAgentSnapshot(ref) : undefined;
		const observation = persisted?.observations.get(id);
		const topLevel = resolveTopLevelAgent(registry, id);
		const sessionTitle = topLevel?.sessionTitle ?? persisted?.sessionTitle ?? existing?.sessionTitle;
		const sessionId = topLevel?.sessionId ?? persisted?.sessionId ?? existing?.sessionId;
		const activeTopLevelAgentId = topLevel?.id ?? existing?.activeTopLevelAgentId;
		const activityState =
			progress?.activity ??
			ref?.activityState ??
			observation?.activityState ??
			persisted?.activityState ??
			existing?.activityState;
		const inflightTaskDetails = progress
			? progress.inflightTaskDetails
			: (observation?.progress?.inflightTaskDetails ?? existing?.inflightTaskDetails);
		const resolvedModel =
			progress?.resolvedModel ?? observation?.resolvedModel ?? persisted?.resolvedModel ?? existing?.resolvedModel;
		const resolvedModelIsFallback =
			progress?.resolvedModelIsFallback ??
			observation?.resolvedModelIsFallback ??
			persisted?.resolvedModelIsFallback ??
			existing?.resolvedModelIsFallback;
		const retryState = progress?.retryState ?? observation?.retryState ?? existing?.retryState;
		const retryFailure = progress?.retryFailure ?? observation?.retryFailure ?? existing?.retryFailure;
		const parentTerminalStatus =
			observation?.status === "completed" || observation?.status === "failed" || observation?.status === "aborted"
				? observation.status
				: undefined;
		const terminalStatus =
			ref?.status === "aborted"
				? "aborted"
				: (ref?.terminalStatus ?? parentTerminalStatus ?? persisted?.terminalStatus ?? existing?.terminalStatus);
		return {
			...(sessionTitle === undefined ? {} : { sessionTitle }),
			...(sessionId === undefined ? {} : { sessionId }),
			...(activeTopLevelAgentId === undefined ? {} : { activeTopLevelAgentId }),
			...(activityState === undefined ? {} : { activityState }),
			...(inflightTaskDetails === undefined ? {} : { inflightTaskDetails }),
			...(resolvedModel === undefined ? {} : { resolvedModel }),
			...(resolvedModelIsFallback === undefined ? {} : { resolvedModelIsFallback }),
			...(retryState === undefined ? {} : { retryState }),
			...(retryFailure === undefined ? {} : { retryFailure }),
			...(terminalStatus === undefined ? {} : { terminalStatus }),
		};
	}

	handleLifecycle(payload: SubagentLifecyclePayload): void {
		const existing = this.#subagents.get(payload.id);
		if (existing && !hasSameOwner(payload, existing)) return;
		if (!existing && payload.status !== "started") return;
		if (payload.status === "started") {
			this.#staleSubagentIds.delete(payload.id);
		}
		const sessionFile = payload.sessionFile ?? existing?.sessionFile;
		const snapshot: RpcSubagentSnapshot = {
			id: payload.id,
			index: payload.index,
			agent: payload.agent,
			agentSource: payload.agentSource,
			description: payload.description ?? existing?.description,
			status: statusFromLifecycle(payload.status),
			task: existing?.task,
			assignment: existing?.assignment,
			sessionFile,
			parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
			lastUpdate: Date.now(),
			progress: existing?.progress,
			...this.#mirrorMetadata(payload.id, existing?.progress, existing),
		};
		this.#rememberTranscriptSession(payload.id, sessionFile);
		if (isTerminalLifecycleStatus(payload.status)) {
			this.#subagents.delete(payload.id);
		} else {
			this.#subagents.set(payload.id, snapshot);
		}
		if (this.#subscriptionLevel !== "off") {
			this.#output({ type: "subagent_lifecycle", payload });
		}
	}

	handleProgress(payload: SubagentProgressPayload): void {
		const progress = payload.progress;
		if (this.#staleSubagentIds.has(progress.id)) return;
		const existing = this.#subagents.get(progress.id);
		if (!existing) return;
		if (!hasSameOwner(payload, existing)) return;
		const sessionFile = payload.sessionFile ?? existing?.sessionFile;
		this.#rememberTranscriptSession(progress.id, sessionFile);
		this.#subagents.set(progress.id, {
			id: progress.id,
			index: payload.index,
			agent: payload.agent,
			agentSource: payload.agentSource,
			description: progress.description ?? existing?.description,
			status: progress.status,
			task: payload.task,
			assignment: payload.assignment,
			sessionFile,
			lastUpdate: Date.now(),
			parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
			progress,
			...this.#mirrorMetadata(progress.id, progress, existing),
		});
		if (this.#subscriptionLevel !== "off") {
			this.#output({ type: "subagent_progress", payload });
		}
	}

	handleEvent(payload: SubagentEventPayload): void {
		if (this.#staleSubagentIds.has(payload.id)) return;
		if (this.#subscriptionLevel !== "events") return;
		this.#output({ type: "subagent_event", payload } satisfies RpcSubagentEventFrame);
	}

	resolveSessionFile(selector: RpcSubagentTranscriptSelector): string {
		if (selector.subagentId) {
			const snapshot = this.#subagents.get(selector.subagentId);
			const persisted = this.#staleSubagentIds.has(selector.subagentId)
				? undefined
				: this.#persistedSnapshot(AgentRegistry.global().get(selector.subagentId));
			const sessionFile =
				snapshot?.sessionFile ??
				persisted?.sessionFile ??
				this.#transcriptSessionFilesBySubagentId.get(selector.subagentId);
			if (!sessionFile) {
				throw new Error(`Unknown subagent or session file unavailable: ${selector.subagentId}`);
			}
			return sessionFile;
		}

		if (selector.sessionFile) {
			if (this.#hasTranscriptSessionFile(selector.sessionFile)) return selector.sessionFile;
			throw new Error("Unknown subagent session file");
		}

		throw new Error("get_subagent_messages requires subagentId or sessionFile");
	}
}
