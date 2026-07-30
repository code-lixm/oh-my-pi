import { visibleWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { tSettingsUi } from "../../i18n/settings-locale";
import type { AgentActivityHealth, AgentActivityState } from "../../registry/agent-activity";
import type { AgentStatus } from "../../registry/agent-registry";
import type { AgentProgress } from "../../task";
import { previewLine, truncateToWidth } from "../../tools/render-utils";
import { type ThemeColor, theme } from "../theme/theme";
import { formatAgentActivity } from "./agent-activity";
import { formatContextUsage, getContextUsageLevel, getContextUsageThemeColor } from "./status-line/context-thresholds";

const MIN_ACTIVITY_DETAIL_WIDTH = 8;
const ACTIVITY_DETAIL_RESERVE = 24;

export type AgentActivityDisplayProgress = Pick<
	AgentProgress,
	| "activity"
	| "startedAtMs"
	| "completedAtMs"
	| "currentToolArgs"
	| "lastIntent"
	| "retryState"
	| "retryFailure"
	| "tokensPerSecond"
	| "tokensPerSecondLive"
	| "contextTokens"
	| "contextWindow"
	| "durationMs"
	| "tokens"
	| "toolCount"
	| "cost"
> & {
	status?: AgentProgress["status"];
};

export interface AgentActivityDisplay {
	/** Current phase, activity detail, and phase/quiet elapsed time. */
	activityLine?: string;
	/** Retry, task timing, and stable telemetry. */
	statsLine?: string;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function formatAgentClockTime(ms: number): string {
	const date = new Date(ms);
	if (Number.isNaN(date.getTime())) return "";
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Fixed-width wall-clock duration used by Agent Hub metadata columns. */
export function formatAgentDuration(durationMs: number): string {
	const totalSeconds = Math.floor(Math.max(0, durationMs) / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatTaskTiming(
	progress: AgentActivityDisplayProgress | undefined,
	now: number,
	terminal: boolean,
	frozenAtMs: number,
): string | undefined {
	const startedAtMs = progress?.startedAtMs;
	const completedAtMsFromProgress = progress?.completedAtMs;
	const durationMsFromProgress = progress?.durationMs;
	const storedDurationMs = isFiniteNumber(durationMsFromProgress) ? Math.max(0, durationMsFromProgress) : undefined;
	const completedAtMs = isFiniteNumber(completedAtMsFromProgress)
		? completedAtMsFromProgress
		: isFiniteNumber(startedAtMs) && storedDurationMs !== undefined
			? startedAtMs + storedDurationMs
			: undefined;
	const elapsedMs = isFiniteNumber(startedAtMs)
		? Math.max(0, (terminal ? (completedAtMs ?? frozenAtMs ?? startedAtMs) : now) - startedAtMs)
		: storedDurationMs !== undefined && storedDurationMs > 0
			? storedDurationMs
			: undefined;
	const parts: string[] = [];
	if (isFiniteNumber(startedAtMs)) {
		const time = formatAgentClockTime(startedAtMs);
		if (time) parts.push(tSettingsUi("Started {time}", { time }));
	}
	if (terminal && isFiniteNumber(completedAtMs ?? frozenAtMs)) {
		const time = formatAgentClockTime(completedAtMs ?? frozenAtMs);
		if (time) parts.push(tSettingsUi("Ended {time}", { time }));
	}
	if (elapsedMs !== undefined) {
		parts.push(tSettingsUi("Duration {duration}", { duration: formatAgentDuration(elapsedMs) }));
	}
	return parts.join(theme.sep.dot) || undefined;
}

function activityHealthColor(health: AgentActivityHealth): ThemeColor {
	switch (health) {
		case "quiet":
			return "muted";
		case "suspected-stall":
			return "warning";
		case "blocked":
			return "warning";
		case "active":
			return "accent";
	}
}

function joinFitted(parts: Array<{ text: string; optional?: boolean }>, width: number): string | undefined {
	const maxWidth = Math.max(1, width);
	const visible = [...parts];
	const render = (): string =>
		visible
			.map(part => part.text)
			.filter(Boolean)
			.join(theme.sep.dot);
	while (visibleWidth(render()) > maxWidth) {
		let removable = -1;
		for (let index = visible.length - 1; index >= 0; index--) {
			if (visible[index]?.optional) {
				removable = index;
				break;
			}
		}
		if (removable < 0) return truncateToWidth(render(), maxWidth);
		visible.splice(removable, 1);
	}
	return render() || undefined;
}

function formatRetry(progress: AgentActivityDisplayProgress | undefined, now: number): string | undefined {
	const retry = progress?.retryState;
	if (retry && isFiniteNumber(retry.attempt) && isFiniteNumber(retry.maxAttempts) && isFiniteNumber(retry.delayMs)) {
		const startedAt = isFiniteNumber(retry.startedAtMs) ? retry.startedAtMs : now;
		const remaining = Math.max(0, retry.delayMs - Math.max(0, now - startedAt));
		return theme.fg(
			"warning",
			tSettingsUi("retry {attempt}/{max} · {delay}", {
				attempt: retry.attempt,
				max: retry.maxAttempts,
				delay: formatDuration(remaining),
			}),
		);
	}
	const failed = progress?.retryFailure;
	if (failed && isFiniteNumber(failed.attempt)) {
		return theme.fg("error", tSettingsUi("retry failed after {attempt}", { attempt: failed.attempt }));
	}
	return undefined;
}

function formatContext(progress: AgentActivityDisplayProgress | undefined): string | undefined {
	const tokens = progress?.contextTokens;
	if (!isFiniteNumber(tokens) || tokens < 0) return undefined;
	const window = progress?.contextWindow;
	if (!isFiniteNumber(window) || window <= 0) {
		return theme.fg("dim", `ctx ${formatContextUsage(undefined, 0, tokens)}`);
	}
	const percent = (tokens / window) * 100;
	if (!Number.isFinite(percent)) return undefined;
	// Reuse the status-line gauge, only dropping its redundant decimal zero.
	const usage = formatContextUsage(percent, window, tokens).replace(/\.0%(?=\/)/, "%");
	return theme.fg(getContextUsageThemeColor(getContextUsageLevel(percent, window)), `ctx ${usage}`);
}

/** Maps registry and executor statuses to the same words and colors in both observer views. */
export function renderAgentStatusBadge(status: AgentStatus | AgentProgress["status"] | undefined): string {
	switch (status) {
		case "running":
			return theme.fg("success", tSettingsUi("running"));
		case "waiting":
		case "pending":
			return theme.fg("warning", tSettingsUi("waiting"));
		case "idle":
		case "completed":
			return theme.fg("accent", tSettingsUi("idle"));
		case "parked":
			return theme.fg("muted", tSettingsUi("parked"));
		case "failed":
		case "aborted":
			return theme.fg("error", tSettingsUi(status));
		default:
			return "";
	}
}

/** Prefer a live executor heartbeat unless this surface intentionally renders persisted history. */
export function selectAgentActivity(
	stored: AgentActivityState | undefined,
	progress: Pick<AgentProgress, "activity"> | undefined,
	preferStored = false,
): AgentActivityState | undefined {
	return preferStored ? (stored ?? progress?.activity) : (progress?.activity ?? stored);
}

/**
 * Render shared activity and telemetry rows. Both full-screen agent views call
 * this so phase wording, health color, elapsed labels, retry state, throughput,
 * and context usage stay identical.
 */
export function renderAgentActivityDisplay(options: {
	activity?: AgentActivityState;
	progress?: AgentActivityDisplayProgress;
	/** Registry status takes precedence when observer progress arrives stale. */
	registryStatus?: AgentStatus;
	/** Stable registry activity timestamp for terminal observer rows. */
	frozenAtMs?: number;
	width: number;
	now?: number;
}): AgentActivityDisplay {
	const now = options.now ?? Date.now();
	const width = Math.max(1, options.width);
	const progress = options.progress;
	const progressTerminal =
		progress?.status === "completed" || progress?.status === "failed" || progress?.status === "aborted";
	const registryTerminal =
		options.registryStatus === "idle" || options.registryStatus === "parked" || options.registryStatus === "aborted";
	const terminal = progressTerminal || registryTerminal;
	const completedAtMs = progress?.completedAtMs;
	const startedAtMs = progress?.startedAtMs;
	const durationMs = progress?.durationMs;
	const frozenAtMs = isFiniteNumber(completedAtMs)
		? completedAtMs
		: isFiniteNumber(startedAtMs) && isFiniteNumber(durationMs)
			? startedAtMs + Math.max(0, durationMs)
			: isFiniteNumber(options.frozenAtMs)
				? options.frozenAtMs
				: (options.activity?.lastActivityAtMs ?? options.activity?.phaseStartedAtMs ?? 0);
	const activityNow = terminal ? frozenAtMs : now;
	const formatted = formatAgentActivity(options.activity, activityNow, {
		detailMaxWidth: Math.max(MIN_ACTIVITY_DETAIL_WIDTH, width - ACTIVITY_DETAIL_RESERVE),
		toolArgs: progress?.lastIntent ?? progress?.currentToolArgs,
		toolArgsMaxWidth: Math.max(MIN_ACTIVITY_DETAIL_WIDTH, width - ACTIVITY_DETAIL_RESERVE),
	});

	let activityLine: string | undefined;
	if (formatted.phase) {
		const phaseLabel = tSettingsUi(formatted.phaseLabel);
		const healthLabel = tSettingsUi(formatted.healthLabel);
		const phaseText =
			formatted.health === "active" || healthLabel === phaseLabel
				? phaseLabel
				: `${healthLabel} ${theme.sep.dot} ${phaseLabel}`;
		const elapsed = [
			formatted.phaseElapsed ? tSettingsUi("phase {elapsed}", { elapsed: formatted.phaseElapsed }) : "",
			formatted.quietElapsed ? tSettingsUi("quiet {elapsed}", { elapsed: formatted.quietElapsed }) : "",
		]
			.filter(Boolean)
			.join(theme.sep.dot);
		activityLine = joinFitted(
			[
				{ text: theme.fg(activityHealthColor(formatted.health), phaseText) },
				{ text: formatted.detail ? theme.fg("muted", formatted.detail) : "", optional: true },
				{ text: formatted.toolArgs ? theme.fg("dim", formatted.toolArgs) : "", optional: true },
				{ text: elapsed ? theme.fg("dim", elapsed) : "" },
			],
			width,
		);
	}

	const stats: Array<{ text: string; optional?: boolean }> = [];
	const timing = formatTaskTiming(progress, now, terminal, frozenAtMs);
	if (timing) stats.push({ text: theme.fg("dim", timing) });
	const retry = formatRetry(progress, activityNow);
	if (retry) stats.push({ text: retry });
	const tokensPerSecond = progress?.tokensPerSecond;
	if (isFiniteNumber(tokensPerSecond) && tokensPerSecond > 0) {
		const rate = `${tokensPerSecond.toFixed(1)} tok/s`;
		stats.push({
			text: theme.fg(
				"statusLineOutput",
				progress?.tokensPerSecondLive ? rate : tSettingsUi("last {rate}", { rate }),
			),
		});
	}
	const context = formatContext(progress);
	if (context) stats.push({ text: context });
	const tokens = progress?.tokens;
	if (isFiniteNumber(tokens) && tokens > 0) {
		stats.push({ text: theme.fg("dim", `${formatNumber(tokens)} tok`), optional: true });
	}
	const toolCount = progress?.toolCount;
	if (isFiniteNumber(toolCount) && toolCount > 0) {
		stats.push({
			text: theme.fg("dim", tSettingsUi("{count} tools", { count: formatNumber(toolCount) })),
			optional: true,
		});
	}
	const cost = progress?.cost;
	if (isFiniteNumber(cost) && cost > 0) {
		stats.push({ text: theme.fg("statusLineCost", `$${cost.toFixed(2)}`), optional: true });
	}

	return { activityLine, statsLine: joinFitted(stats, width) };
}

/** Sanitize a one-line tree or activity detail to the available terminal cells. */
export function truncateAgentActivityLine(line: string, width: number): string {
	return truncateToWidth(previewLine(line, Math.max(1, width)), Math.max(1, width));
}
