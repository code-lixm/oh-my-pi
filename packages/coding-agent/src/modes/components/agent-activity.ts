import { stripVTControlCharacters } from "node:util";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type {
	AgentActivityHealth,
	AgentActivityPhase,
	AgentActivityState,
	DeterminateActivityProgress,
} from "../../registry/agent-activity";

/** Real work may be quiet for a while; this is a visible cue, not a timeout. */
export const AGENT_ACTIVITY_QUIET_AFTER_MS = 15_000;
/** A minute without an update remains quiet unless a caller supplies concrete stall evidence. */
export const AGENT_ACTIVITY_NO_ACTIVITY_AFTER_MS = 60_000;

export const AGENT_ACTIVITY_DETAIL_MAX_WIDTH = 120;
export const AGENT_ACTIVITY_TOOL_ARGS_MAX_WIDTH = 96;

const DEFAULT_PHASE_LABEL = "Working";

const PHASE_LABELS: Readonly<Record<AgentActivityPhase, string>> = {
	queued: "Queued",
	requesting: "Requesting model",
	thinking: "Thinking",
	streaming: "Streaming response",
	tool: "Using tool",
	delegating: "Delegating work",
	retrying: "Retrying request",
	compacting: "Compacting context",
	"waiting-user": "Waiting for user",
	"waiting-peer": "Waiting for peer",
	finishing: "Finishing response",
	idle: "Idle",
};

const HEALTH_LABELS: Readonly<Record<AgentActivityHealth, string>> = {
	active: "Active",
	quiet: "Quiet",
	"suspected-stall": "Suspected stall",
	blocked: "Blocked",
};

export interface FormatAgentActivityOptions {
	/** Explicit evidence such as a missed deadline or disconnected transport. */
	stallReason?: string;
	/** Current tool arguments, if the caller has them available. */
	toolArgs?: unknown;
	detailMaxWidth?: number;
	toolArgsMaxWidth?: number;
}

/** Single-line activity data safe to place in any TUI surface. */
export interface FormattedAgentActivity {
	health: AgentActivityHealth;
	healthLabel: string;
	phase: AgentActivityPhase | undefined;
	phaseLabel: string;
	phaseElapsed: string;
	quietElapsed: string;
	elapsed: string;
	detail: string;
	stallReason: string;
	toolArgs: string;
}

function displayWidth(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

function elapsedSince(now: number, startedAtMs: number): number | undefined {
	if (!Number.isFinite(now) || !Number.isFinite(startedAtMs)) return undefined;
	return Math.max(0, now - startedAtMs);
}

function formatDisplayText(value: string | undefined, maxWidth: number): string {
	if (!value) return "";
	const singleLine = replaceTabs(stripVTControlCharacters(value))
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ")
		.replace(/ +/g, " ")
		.trim();
	return singleLine ? truncateToWidth(singleLine, maxWidth) : "";
}

function hasExplicitStallReason(reason: string | undefined): boolean {
	return formatDisplayText(reason, AGENT_ACTIVITY_DETAIL_MAX_WIDTH).length > 0;
}
function getAgentActivityHealthForReason(
	activity: AgentActivityState | undefined,
	now: number,
	hasStallReason: boolean,
): AgentActivityHealth {
	if (activity?.phase === "waiting-user" || activity?.phase === "waiting-peer") return "blocked";
	if (hasStallReason) return "suspected-stall";
	const quietForMs = activity ? elapsedSince(now, activity.lastActivityAtMs) : undefined;
	return quietForMs !== undefined && quietForMs >= AGENT_ACTIVITY_QUIET_AFTER_MS ? "quiet" : "active";
}

function formatProgress(progress: DeterminateActivityProgress | undefined, maxWidth: number): string {
	if (!progress || !Number.isFinite(progress.completed) || !Number.isFinite(progress.total) || progress.total <= 0) {
		return "";
	}
	const completed = Math.max(0, Math.floor(progress.completed));
	const total = Math.floor(progress.total);
	const unit = formatDisplayText(progress.unit, maxWidth);
	return `${completed}/${total}${unit ? ` ${unit}` : ""}`;
}

function formatToolArgValue(value: unknown, maxWidth: number): string {
	if (typeof value === "string") return formatDisplayText(value, maxWidth);
	if (value === null) return "null";
	if (typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") return String(value);
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (value && typeof value === "object") return "{…}";
	return "";
}

/** Build a bounded inline record without serializing an arbitrarily large tool payload. */
function formatToolArgsSource(value: unknown, maxWidth: number): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return formatToolArgValue(value, maxWidth);

	const record = value as Record<string, unknown>;
	let result = "";
	let count = 0;
	for (const key in record) {
		if (!Object.hasOwn(record, key)) continue;
		const separator = result ? ", " : "";
		const remaining = maxWidth - Bun.stringWidth(result) - Bun.stringWidth(separator);
		if (remaining <= 0) return result;
		const name = formatDisplayText(key, Math.max(1, remaining - 1));
		if (!name) continue;
		const valueWidth = Math.max(1, remaining - Bun.stringWidth(name) - 1);
		const formattedValue = formatToolArgValue(record[key], valueWidth);
		const pair = formattedValue ? `${name}=${formattedValue}` : name;
		result += `${separator}${truncateToWidth(pair, remaining)}`;
		if (++count === 8 || Bun.stringWidth(result) >= maxWidth) return truncateToWidth(`${result}…`, maxWidth);
	}
	return result;
}

/** Canonical status text for an activity phase; missing snapshots remain safely generic. */
export function formatAgentActivityPhase(phase: AgentActivityPhase | undefined): string {
	return phase ? PHASE_LABELS[phase] : DEFAULT_PHASE_LABEL;
}

/** Canonical human-readable health text for a status badge or secondary row. */
export function formatAgentActivityHealth(health: AgentActivityHealth): string {
	return HEALTH_LABELS[health];
}

/**
 * Classify observable activity without inventing a timeout. Intentional user/peer
 * waits are blocked, and a suspected stall requires an explicit caller-provided
 * reason (for example, a deadline or confirmed disconnect).
 */
export function getAgentActivityHealth(
	activity: AgentActivityState | undefined,
	now: number,
	stallReason?: string,
): AgentActivityHealth {
	return getAgentActivityHealthForReason(activity, now, hasExplicitStallReason(stallReason));
}

/** Time in the current phase. A missing or malformed snapshot intentionally has no elapsed label. */
export function formatAgentActivityPhaseElapsed(activity: AgentActivityState | undefined, now: number): string {
	const elapsedMs = activity ? elapsedSince(now, activity.phaseStartedAtMs) : undefined;
	return elapsedMs === undefined ? "" : formatDuration(elapsedMs);
}

/** Duration since the most recent real update, once it has crossed the quiet threshold. */
export function formatAgentActivityQuietElapsed(activity: AgentActivityState | undefined, now: number): string {
	if (!activity || activity.phase === "waiting-user" || activity.phase === "waiting-peer") return "";
	const quietForMs = elapsedSince(now, activity.lastActivityAtMs);
	return quietForMs === undefined || quietForMs < AGENT_ACTIVITY_QUIET_AFTER_MS ? "" : formatDuration(quietForMs);
}

function formatElapsedSummary(phaseElapsed: string, quietElapsed: string): string {
	if (!phaseElapsed) return quietElapsed ? `quiet ${quietElapsed}` : "";
	return quietElapsed ? `phase ${phaseElapsed} · quiet ${quietElapsed}` : `phase ${phaseElapsed}`;
}

/** Canonical inline elapsed summary; use phaseElapsed/quietElapsed when localized labels are needed. */
export function formatAgentActivityElapsed(activity: AgentActivityState | undefined, now: number): string {
	const phaseElapsed = formatAgentActivityPhaseElapsed(activity, now);
	const quietElapsed = formatAgentActivityQuietElapsed(activity, now);
	return formatElapsedSummary(phaseElapsed, quietElapsed);
}

/** Detail plus determinate progress, normalized to one safe, width-bounded line. */
export function formatAgentActivityDetail(activity: AgentActivityState | undefined, maxWidth?: number): string {
	const width = displayWidth(maxWidth, AGENT_ACTIVITY_DETAIL_MAX_WIDTH);
	const detail = formatDisplayText(activity?.detail, width);
	const progress = formatProgress(activity?.progress, width);
	if (!detail) return progress;
	if (!progress) return detail;
	return truncateToWidth(`${detail} · ${progress}`, width);
}

/**
 * Format current tool arguments for an inline row. Both raw strings and rendered
 * object arguments pass through replaceTabs and display-width truncation here.
 */
export function formatAgentActivityToolArgs(value: unknown, maxWidth?: number): string {
	const width = displayWidth(maxWidth, AGENT_ACTIVITY_TOOL_ARGS_MAX_WIDTH);
	return formatDisplayText(formatToolArgsSource(value, width), width);
}

/** Assemble the central display model used by loaders, HUDs, hubs, and transcript views. */
export function formatAgentActivity(
	activity: AgentActivityState | undefined,
	now: number,
	options?: FormatAgentActivityOptions,
): FormattedAgentActivity {
	const detailWidth = displayWidth(options?.detailMaxWidth, AGENT_ACTIVITY_DETAIL_MAX_WIDTH);
	const stallReason = formatDisplayText(options?.stallReason, detailWidth);
	const health = getAgentActivityHealthForReason(activity, now, stallReason.length > 0);
	const phaseElapsed = formatAgentActivityPhaseElapsed(activity, now);
	const quietElapsed = formatAgentActivityQuietElapsed(activity, now);
	return {
		health,
		healthLabel: formatAgentActivityHealth(health),
		phase: activity?.phase,
		phaseLabel: formatAgentActivityPhase(activity?.phase),
		phaseElapsed,
		quietElapsed,
		elapsed: formatElapsedSummary(phaseElapsed, quietElapsed),
		detail: formatAgentActivityDetail(activity, detailWidth),
		stallReason,
		toolArgs: formatAgentActivityToolArgs(options?.toolArgs, options?.toolArgsMaxWidth),
	};
}
