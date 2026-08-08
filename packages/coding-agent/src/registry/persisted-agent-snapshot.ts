import { parseJsonlLenient } from "@oh-my-pi/pi-utils";
import { TOOL_EXECUTION_START_CUSTOM_TYPE } from "../session/exit-diagnostics";
import {
	EPHEMERAL_MODEL_CHANGE_ROLE,
	type SessionEntry,
	type SessionHeader,
	type SessionTitleSlotEntry,
} from "../session/session-entries";
import { FileSessionStorage, type SessionStorage } from "../session/session-storage";
import { parseTitleSlotLine } from "../session/session-title-slot";
import type { AgentProgress, AgentSource } from "../task/types";
import type { AgentActivityPhase, AgentActivityState } from "./agent-activity";
import type { AgentRef } from "./agent-registry";

/**
 * Disk snapshots intentionally stay small: persisted-agent discovery can run
 * while a transcript is large, so it must never replay the whole JSONL solely
 * for observer metadata.
 */
export const PERSISTED_AGENT_SNAPSHOT_HEAD_BYTES = 4096;
export const PERSISTED_AGENT_SNAPSHOT_TAIL_BYTES = 256 * 1024;

const ACTIVITY_PHASES = new Set<AgentActivityPhase>([
	"queued",
	"requesting",
	"thinking",
	"streaming",
	"tool",
	"delegating",
	"retrying",
	"compacting",
	"waiting-user",
	"waiting-peer",
	"finishing",
	"idle",
]);

const AGENT_SOURCES = new Set<AgentSource>(["bundled", "user", "project"]);
const PROGRESS_STATUSES = new Set<AgentProgress["status"]>(["pending", "running", "completed", "failed", "aborted"]);

export interface PersistedAgentObservation {
	id: string;
	displayName?: string;
	index?: number;
	agent?: string;
	agentSource?: AgentSource;
	status?: AgentProgress["status"];
	task?: string;
	assignment?: string;
	description?: string;
	parentToolCallId?: string;
	sessionFile?: string;
	lastUpdate?: number;
	activityState?: AgentActivityState;
	resolvedModel?: string;
	resolvedModelIsFallback?: boolean;
	retryState?: AgentProgress["retryState"];
	retryFailure?: AgentProgress["retryFailure"];
	/** Present only when the persisted task result carries a complete progress record. */
	progress?: AgentProgress;
}

export interface PersistedAgentSessionSnapshot {
	sessionTitle?: string;
	displayName?: string;
	sessionId?: string;
	activityState?: AgentActivityState;
	resolvedModel?: string;
	resolvedModelIsFallback?: boolean;
	/** Terminal task outcome recovered from this transcript's own yield/assistant records. */
	terminalStatus?: Extract<AgentProgress["status"], "completed" | "failed" | "aborted">;
	observations: ReadonlyMap<string, PersistedAgentObservation>;
	/** Complete parsed entries only when supplied by an already-live SessionManager. */
	entries: readonly SessionEntry[];
}

const snapshotsByRef = new WeakMap<AgentRef, PersistedAgentSessionSnapshot>();

/** Associate a bounded/on-disk snapshot with the ref registered for that transcript. */
export function rememberPersistedAgentSnapshot(ref: AgentRef, snapshot: PersistedAgentSessionSnapshot): void {
	snapshotsByRef.set(ref, snapshot);
}

/** Read-only persisted metadata for observer/RPC consumers. */
export function getPersistedAgentSnapshot(ref: AgentRef | undefined): PersistedAgentSessionSnapshot | undefined {
	return ref ? snapshotsByRef.get(ref) : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function terminalYieldStatus(message: Record<string, unknown>): PersistedAgentSessionSnapshot["terminalStatus"] {
	if (message.toolName !== "yield" || message.isError !== false) return undefined;
	const details = objectRecord(message.details);
	if (!details) return undefined;
	if (details.status === "aborted") return "aborted";
	if (details.status !== "success") return undefined;
	const type = details.type;
	// A non-empty string array is an incremental yield; only a string (or an
	// omitted/null terminal type) completes the task. Aborted yields are terminal
	// regardless of their type because the runtime uses that status directly.
	if (Array.isArray(type)) return undefined;
	if (type !== undefined && type !== null && typeof type !== "string") return undefined;
	return "completed";
}

function latestSessionInit(entries: readonly unknown[]): Record<string, unknown> | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = objectRecord(entries[index]);
		if (entry?.type === "session_init") return entry;
	}
	return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestampMs(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseAgentSource(value: unknown): AgentSource | undefined {
	return typeof value === "string" && AGENT_SOURCES.has(value as AgentSource) ? (value as AgentSource) : undefined;
}

function parseProgressStatus(value: unknown): AgentProgress["status"] | undefined {
	return typeof value === "string" && PROGRESS_STATUSES.has(value as AgentProgress["status"])
		? (value as AgentProgress["status"])
		: undefined;
}

function parseActivityState(value: unknown): AgentActivityState | undefined {
	const record = objectRecord(value);
	if (!record) return undefined;
	const phase = record.phase;
	const label = nonEmptyString(record.label);
	const phaseStartedAtMs = finiteNumber(record.phaseStartedAtMs);
	const lastActivityAtMs = finiteNumber(record.lastActivityAtMs);
	if (
		typeof phase !== "string" ||
		!ACTIVITY_PHASES.has(phase as AgentActivityPhase) ||
		!label ||
		phaseStartedAtMs === undefined ||
		lastActivityAtMs === undefined
	) {
		return undefined;
	}
	const activity: AgentActivityState = {
		phase: phase as AgentActivityPhase,
		label,
		phaseStartedAtMs,
		lastActivityAtMs,
	};
	const detail = nonEmptyString(record.detail);
	if (detail) activity.detail = detail;
	const progress = objectRecord(record.progress);
	if (progress) {
		const completed = finiteNumber(progress.completed);
		const total = finiteNumber(progress.total);
		if (completed !== undefined && total !== undefined) {
			activity.progress = {
				completed,
				total,
				...(nonEmptyString(progress.unit) ? { unit: nonEmptyString(progress.unit) } : {}),
			};
		}
	}
	return activity;
}

function parseRetryState(value: unknown): AgentProgress["retryState"] | undefined {
	const record = objectRecord(value);
	if (!record) return undefined;
	const attempt = finiteNumber(record.attempt);
	const maxAttempts = finiteNumber(record.maxAttempts);
	const delayMs = finiteNumber(record.delayMs);
	const errorMessage = nonEmptyString(record.errorMessage);
	const startedAtMs = finiteNumber(record.startedAtMs);
	if (
		attempt === undefined ||
		maxAttempts === undefined ||
		delayMs === undefined ||
		!errorMessage ||
		startedAtMs === undefined
	) {
		return undefined;
	}
	return { attempt, maxAttempts, delayMs, errorMessage, startedAtMs };
}

function parseRetryFailure(value: unknown): AgentProgress["retryFailure"] | undefined {
	const record = objectRecord(value);
	if (!record) return undefined;
	const attempt = finiteNumber(record.attempt);
	const errorMessage = nonEmptyString(record.errorMessage);
	return attempt === undefined || !errorMessage ? undefined : { attempt, errorMessage };
}

function parseRecentTools(value: unknown): AgentProgress["recentTools"] | undefined {
	if (!Array.isArray(value)) return undefined;
	const recentTools: AgentProgress["recentTools"] = [];
	for (const item of value) {
		const record = objectRecord(item);
		const tool = nonEmptyString(record?.tool);
		const args = typeof record?.args === "string" ? record.args : undefined;
		const endMs = finiteNumber(record?.endMs);
		if (!tool || args === undefined || endMs === undefined) return undefined;
		recentTools.push({ tool, args, endMs });
	}
	return recentTools;
}

function parseRecentOutput(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? [...value] : undefined;
}

function parseCompleteProgress(value: unknown): AgentProgress | undefined {
	const record = objectRecord(value);
	if (!record) return undefined;
	const index = finiteNumber(record.index);
	const id = nonEmptyString(record.id);
	const agent = nonEmptyString(record.agent);
	const agentSource = parseAgentSource(record.agentSource);
	const status = parseProgressStatus(record.status);
	const task = typeof record.task === "string" ? record.task : undefined;
	const recentTools = parseRecentTools(record.recentTools);
	const recentOutput = parseRecentOutput(record.recentOutput);
	const toolCount = finiteNumber(record.toolCount);
	const requests = finiteNumber(record.requests);
	const tokens = finiteNumber(record.tokens);
	const cost = finiteNumber(record.cost);
	const durationMs = finiteNumber(record.durationMs);
	if (
		index === undefined ||
		!id ||
		!agent ||
		!agentSource ||
		!status ||
		task === undefined ||
		!recentTools ||
		!recentOutput ||
		toolCount === undefined ||
		requests === undefined ||
		tokens === undefined ||
		cost === undefined ||
		durationMs === undefined
	) {
		return undefined;
	}
	const progress: AgentProgress = {
		index,
		id,
		agent,
		agentSource,
		status,
		task,
		recentTools,
		recentOutput,
		toolCount,
		requests,
		tokens,
		cost,
		durationMs,
	};
	const assignment = typeof record.assignment === "string" ? record.assignment : undefined;
	if (assignment !== undefined) progress.assignment = assignment;
	const description = typeof record.description === "string" ? record.description : undefined;
	if (description !== undefined) progress.description = description;
	const resultText = typeof record.resultText === "string" ? record.resultText : undefined;
	if (resultText !== undefined) progress.resultText = resultText;
	const deliveryStatus = record.deliveryStatus;
	if (
		deliveryStatus === "pending" ||
		deliveryStatus === "delivering" ||
		deliveryStatus === "delivered" ||
		deliveryStatus === "dead-letter"
	) {
		progress.deliveryStatus = deliveryStatus;
	}
	const activity = parseActivityState(record.activity);
	if (activity) progress.activity = activity;
	const lastIntent = typeof record.lastIntent === "string" ? record.lastIntent : undefined;
	if (lastIntent !== undefined) progress.lastIntent = lastIntent;
	const resolvedModel = nonEmptyString(record.resolvedModel);
	if (resolvedModel) progress.resolvedModel = resolvedModel;
	if (typeof record.resolvedModelIsFallback === "boolean")
		progress.resolvedModelIsFallback = record.resolvedModelIsFallback;
	const retryState = parseRetryState(record.retryState);
	if (retryState) progress.retryState = retryState;
	const retryFailure = parseRetryFailure(record.retryFailure);
	if (retryFailure) progress.retryFailure = retryFailure;
	return progress;
}

function lastToolActivity(entries: readonly SessionEntry[]): AgentActivityState | undefined {
	let latest: AgentActivityState | undefined;
	for (const candidate of entries) {
		const entry = objectRecord(candidate);
		if (entry?.type !== "custom" || entry.customType !== TOOL_EXECUTION_START_CUSTOM_TYPE) continue;
		const data = objectRecord(entry.data);
		const toolName = nonEmptyString(data?.toolName);
		const intent = nonEmptyString(data?.intent);
		const at = timestampMs(entry.timestamp);
		if (!toolName || at === undefined) continue;
		latest = {
			phase: "tool",
			label: toolName,
			...(intent ? { detail: intent } : {}),
			phaseStartedAtMs: at,
			lastActivityAtMs: at,
		};
	}
	return latest;
}

function ownSessionMetadata(
	entries: readonly SessionEntry[],
): Pick<
	PersistedAgentSessionSnapshot,
	"activityState" | "resolvedModel" | "resolvedModelIsFallback" | "terminalStatus"
> {
	let resolvedModel: string | undefined;
	let resolvedModelIsFallback: boolean | undefined;
	let terminalStatus: PersistedAgentSessionSnapshot["terminalStatus"];
	for (const candidate of entries) {
		const entry = objectRecord(candidate);
		if (!entry) continue;
		if (entry.type === "model_change") {
			const model = nonEmptyString(entry.model);
			if (model) {
				resolvedModel = model;
				resolvedModelIsFallback = entry.role === EPHEMERAL_MODEL_CHANGE_ROLE;
			}
			continue;
		}
		if (entry.type !== "message") continue;
		const message = objectRecord(entry.message);
		if (!message) continue;
		if (message.role === "toolResult") {
			const yieldStatus = terminalYieldStatus(message);
			if (yieldStatus) terminalStatus = yieldStatus;
			continue;
		}
		if (message.role !== "assistant") continue;
		const model = nonEmptyString(message.model);
		if (model) {
			const provider = nonEmptyString(message.provider);
			resolvedModel = model.includes("/") ? model : provider ? `${provider}/${model}` : model;
			resolvedModelIsFallback = undefined;
		}
		if (message.stopReason === "error") terminalStatus = "failed";
		else if (message.stopReason === "aborted" && terminalStatus !== "completed") terminalStatus = "aborted";
	}
	return {
		activityState: lastToolActivity(entries),
		...(resolvedModel ? { resolvedModel } : {}),
		...(resolvedModelIsFallback !== undefined ? { resolvedModelIsFallback } : {}),
		...(terminalStatus ? { terminalStatus } : {}),
	};
}

function mergeObservation(
	current: PersistedAgentObservation | undefined,
	next: PersistedAgentObservation,
): PersistedAgentObservation {
	return {
		...(current ?? { id: next.id }),
		...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)),
		id: next.id,
	};
}

function observationFromProgress(
	value: unknown,
	lastUpdate: number | undefined,
): PersistedAgentObservation | undefined {
	const record = objectRecord(value);
	const id = nonEmptyString(record?.id);
	if (!record || !id) return undefined;
	const observation: PersistedAgentObservation = { id };
	const index = finiteNumber(record.index);
	if (index !== undefined) observation.index = index;
	const displayName = nonEmptyString(record.displayName);
	if (displayName) observation.displayName = displayName;
	const agent = nonEmptyString(record.agent);
	if (agent) observation.agent = agent;
	const agentSource = parseAgentSource(record.agentSource);
	if (agentSource) observation.agentSource = agentSource;
	const status = parseProgressStatus(record.status);
	if (status) observation.status = status;
	if (typeof record.task === "string") observation.task = record.task;
	if (typeof record.assignment === "string") observation.assignment = record.assignment;
	if (typeof record.description === "string") observation.description = record.description;
	const activityState = parseActivityState(record.activity);
	if (activityState) observation.activityState = activityState;
	const resolvedModel = nonEmptyString(record.resolvedModel);
	if (resolvedModel) observation.resolvedModel = resolvedModel;
	if (typeof record.resolvedModelIsFallback === "boolean")
		observation.resolvedModelIsFallback = record.resolvedModelIsFallback;
	const retryState = parseRetryState(record.retryState);
	if (retryState) observation.retryState = retryState;
	const retryFailure = parseRetryFailure(record.retryFailure);
	if (retryFailure) observation.retryFailure = retryFailure;
	if (lastUpdate !== undefined) observation.lastUpdate = lastUpdate;
	const progress = parseCompleteProgress(value);
	if (progress) observation.progress = progress;
	return observation;
}

function observationFromResult(value: unknown, lastUpdate: number | undefined): PersistedAgentObservation | undefined {
	const record = objectRecord(value);
	const id = nonEmptyString(record?.id);
	if (!record || !id) return undefined;
	const observation: PersistedAgentObservation = { id };
	const index = finiteNumber(record.index);
	if (index !== undefined) observation.index = index;
	const displayName = nonEmptyString(record.displayName);
	if (displayName) observation.displayName = displayName;
	const agent = nonEmptyString(record.agent);
	if (agent) observation.agent = agent;
	const agentSource = parseAgentSource(record.agentSource);
	if (agentSource) observation.agentSource = agentSource;
	if (typeof record.task === "string") observation.task = record.task;
	if (typeof record.assignment === "string") observation.assignment = record.assignment;
	if (typeof record.description === "string") observation.description = record.description;
	const exitCode = finiteNumber(record.exitCode);
	if (exitCode !== undefined)
		observation.status = record.aborted === true ? "aborted" : exitCode === 0 ? "completed" : "failed";
	const resolvedModel = nonEmptyString(record.resolvedModel);
	if (resolvedModel) observation.resolvedModel = resolvedModel;
	if (typeof record.resolvedModelIsFallback === "boolean")
		observation.resolvedModelIsFallback = record.resolvedModelIsFallback;
	const retryFailure = parseRetryFailure(record.retryFailure);
	if (retryFailure) observation.retryFailure = retryFailure;
	if (lastUpdate !== undefined) observation.lastUpdate = lastUpdate;
	return observation;
}

function taskObservations(entries: readonly SessionEntry[]): ReadonlyMap<string, PersistedAgentObservation> {
	const observations = new Map<string, PersistedAgentObservation>();
	for (const candidate of entries) {
		const entry = objectRecord(candidate);
		if (entry?.type !== "message") continue;
		const message = objectRecord(entry.message);
		if (message?.role !== "toolResult" || message.toolName !== "task") continue;
		const details = objectRecord(message.details);
		if (!details) continue;
		const lastUpdate = timestampMs(entry.timestamp);
		const progress = Array.isArray(details.progress) ? details.progress : [];
		for (const value of progress) {
			const observation = observationFromProgress(value, lastUpdate);
			if (observation)
				observations.set(observation.id, mergeObservation(observations.get(observation.id), observation));
		}
		const results = Array.isArray(details.results) ? details.results : [];
		for (const value of results) {
			const observation = observationFromResult(value, lastUpdate);
			if (observation)
				observations.set(observation.id, mergeObservation(observations.get(observation.id), observation));
		}
	}
	return observations;
}

function parsePrefix(content: string): {
	header?: SessionHeader;
	titleSlot?: SessionTitleSlotEntry;
	sessionInit?: Record<string, unknown>;
} {
	const newline = content.indexOf("\n");
	const firstLine = newline >= 0 ? content.slice(0, newline) : content;
	const titleSlot = parseTitleSlotLine(firstLine.trim());
	const entries = parseJsonlLenient<unknown>(content);
	const header = entries.find(value => {
		const entry = objectRecord(value);
		return entry?.type === "session" && typeof entry.id === "string";
	}) as SessionHeader | undefined;
	return { header, titleSlot, sessionInit: latestSessionInit(entries) };
}

function parseTailEntries(content: string): SessionEntry[] {
	const firstNewline = content.indexOf("\n");
	if (firstNewline < 0) return [];
	const entries = parseJsonlLenient<SessionEntry>(content.slice(firstNewline + 1));
	try {
		const first = JSON.parse(content.slice(0, firstNewline));
		if (objectRecord(first)?.type) entries.unshift(first as SessionEntry);
	} catch {
		// Tail can begin in the middle of a JSONL record; ignore only that fragment.
	}
	return entries;
}

/** Build a snapshot from entries already held by a live SessionManager. */
export function snapshotPersistedSessionEntries(
	entries: readonly SessionEntry[],
	identity?: { sessionTitle?: string; sessionId?: string },
): PersistedAgentSessionSnapshot {
	const sessionTitle = nonEmptyString(identity?.sessionTitle);
	const sessionId = nonEmptyString(identity?.sessionId);
	const displayName = nonEmptyString(latestSessionInit(entries)?.agentDisplayName);
	return {
		...(sessionTitle ? { sessionTitle } : {}),
		...(sessionId ? { sessionId } : {}),
		...(displayName ? { displayName } : {}),
		...ownSessionMetadata(entries),
		observations: taskObservations(entries),
		entries,
	};
}

/**
 * Read durable observer metadata from fixed head/tail windows. Malformed,
 * truncated, and pre-feature JSONL records are ignored rather than guessed.
 */
export async function readPersistedAgentSessionSnapshot(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<PersistedAgentSessionSnapshot> {
	try {
		const [prefix, suffix] = await storage.readTextSlices(
			filePath,
			PERSISTED_AGENT_SNAPSHOT_HEAD_BYTES,
			PERSISTED_AGENT_SNAPSHOT_TAIL_BYTES,
		);
		const { header, titleSlot, sessionInit } = parsePrefix(prefix);
		const title = titleSlot ? nonEmptyString(titleSlot.title) : nonEmptyString(header?.title);
		const sessionId = nonEmptyString(header?.id);
		const entries = parseTailEntries(suffix);
		const displayName = nonEmptyString((latestSessionInit(entries) ?? sessionInit)?.agentDisplayName);
		return {
			...(title ? { sessionTitle: title } : {}),
			...(sessionId ? { sessionId } : {}),
			...(displayName ? { displayName } : {}),
			...ownSessionMetadata(entries),
			observations: taskObservations(entries),
			entries,
		};
	} catch {
		return { observations: new Map(), entries: [] };
	}
}

/** Merge parent task lifecycle data with the child transcript's bounded snapshot. */
export function mergePersistedAgentSnapshot(
	child: PersistedAgentSessionSnapshot,
	parent: PersistedAgentObservation | undefined,
): PersistedAgentSessionSnapshot {
	const activityState = parent?.activityState ?? child.activityState;
	const displayName = child.displayName ?? parent?.displayName;
	const resolvedModel = parent?.resolvedModel ?? child.resolvedModel;
	const resolvedModelIsFallback = parent?.resolvedModelIsFallback ?? child.resolvedModelIsFallback;
	const parentTerminalStatus =
		parent?.status === "completed" || parent?.status === "failed" || parent?.status === "aborted"
			? parent.status
			: undefined;
	// Parent finalization includes merge/schema/isolation outcomes that the child
	// transcript cannot observe. It wins whenever it is explicitly terminal;
	// child evidence only repairs stale pending/running/missing parent metadata.
	const terminalStatus = parentTerminalStatus ?? child.terminalStatus;
	const observations = new Map(child.observations);
	if (parent) observations.set(parent.id, parent);
	return {
		...(child.sessionTitle ? { sessionTitle: child.sessionTitle } : {}),
		...(child.sessionId ? { sessionId: child.sessionId } : {}),
		...(displayName ? { displayName } : {}),
		...(activityState ? { activityState } : {}),
		...(resolvedModel ? { resolvedModel } : {}),
		...(resolvedModelIsFallback !== undefined ? { resolvedModelIsFallback } : {}),
		...(terminalStatus ? { terminalStatus } : {}),
		observations,
		entries: child.entries,
	};
}
