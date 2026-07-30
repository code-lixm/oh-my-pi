import {
	Container,
	Ellipsis,
	matchesKey,
	padding,
	routeSgrMouseInput,
	type SgrMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobManager } from "../../async/job-manager";
import { tSettingsUi } from "../../i18n/settings-locale";
import type { AgentProgress } from "../../task/types";
import { replaceTabs } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { formatAgentDuration } from "./agent-activity-display";
import { DynamicBorder } from "./dynamic-border";
import { rawKeyHint } from "./keybinding-hints";

const REFRESH_MS = 1_000;
const LIST_PREVIEW_WIDTH = 72;
const DETAIL_LABEL_WIDTH = 16;
const STATUS_ORDER: Record<AsyncJob["status"], number> = {
	running: 0,
	failed: 1,
	completed: 2,
	cancelled: 3,
};

interface TaskDetails {
	progress?: unknown;
}

export interface JobsHubDeps {
	manager: AsyncJobManager;
	onDone: () => void;
	requestRender: () => void;
	focusAgent?: (id: string) => Promise<void>;
	cancelJob?: (job: AsyncJob) => Promise<boolean>;
}

interface JobRow {
	job: AsyncJob;
	progress?: AgentProgress;
}

function oneLine(value: string, width: number): string {
	return truncateToWidth(
		sanitizeText(replaceTabs(value).replace(/[\r\n]+/g, " ")).trim(),
		Math.max(1, width),
		Ellipsis.Unicode,
	);
}

function safeLines(value: string): string[] {
	return sanitizeText(replaceTabs(value)).replace(/\r/g, "").split("\n");
}

function lastOutputLine(value: string): string {
	let end = value.length;
	while (end > 0 && (value.charCodeAt(end - 1) === 10 || value.charCodeAt(end - 1) === 13)) end--;
	if (end === 0) return "";
	const lf = value.lastIndexOf("\n", end - 1);
	const cr = value.lastIndexOf("\r", end - 1);
	return value.slice(Math.max(lf, cr) + 1, end);
}

function isAgentProgress(value: unknown): value is AgentProgress {
	return Boolean(
		value &&
			typeof value === "object" &&
			"id" in value &&
			typeof value.id === "string" &&
			"status" in value &&
			typeof value.status === "string",
	);
}

function taskProgress(job: AsyncJob): AgentProgress | undefined {
	if (job.type !== "task") return undefined;
	const value = (job.latestDetails as TaskDetails | undefined)?.progress;
	if (!Array.isArray(value)) return undefined;
	let first: AgentProgress | undefined;
	for (const candidate of value) {
		if (!isAgentProgress(candidate)) continue;
		first ??= candidate;
		if (candidate.id === (job.agentId ?? job.id)) return candidate;
	}
	return first;
}

function statusLabel(job: AsyncJob): string {
	if (job.status === "running" && job.queued) return tSettingsUi("queued");
	return tSettingsUi(job.status);
}

function statusGlyph(job: AsyncJob): string {
	if (job.status === "running" && job.queued) return theme.fg("warning", "◌");
	if (job.status === "running") return theme.fg("accent", theme.status.running);
	if (job.status === "completed") return theme.fg("success", theme.status.enabled);
	if (job.status === "failed") return theme.fg("error", theme.status.error);
	return theme.fg("dim", theme.status.disabled);
}

function taskWork(progress: AgentProgress | undefined): string | undefined {
	return (
		progress?.lastIntent ??
		progress?.activity?.detail ??
		progress?.currentToolArgs ??
		progress?.assignment ??
		progress?.task
	);
}

function jobPreview(row: JobRow): string {
	if (row.job.type === "bash") {
		const output = row.job.latestProgressText ?? row.job.errorText ?? row.job.resultText ?? "";
		return oneLine(lastOutputLine(output), LIST_PREVIEW_WIDTH);
	}
	return oneLine(
		taskWork(row.progress) ?? row.job.description ?? row.job.errorText ?? row.job.resultText ?? "",
		LIST_PREVIEW_WIDTH,
	);
}

function jobDuration(job: AsyncJob): string {
	return formatAgentDuration(Math.max(0, (job.endedAt ?? Date.now()) - job.startTime));
}

function fixedCell(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(1, width), Ellipsis.Unicode);
	return `${clipped}${padding(Math.max(0, width - visibleWidth(clipped)))}`;
}

function detailLine(label: string, value: string, width: number): string {
	const labelCell = fixedCell(theme.fg("dim", label), DETAIL_LABEL_WIDTH);
	return ` ${labelCell}${truncateToWidth(value, Math.max(1, width - DETAIL_LABEL_WIDTH - 1), Ellipsis.Unicode)}`;
}

export class JobsHubOverlayComponent extends Container {
	#selected = 0;
	#detail = false;
	#detailOffset = 0;
	#notice: string | undefined;
	#rows: JobRow[] = [];
	#rowAtScreenLine = new Map<number, number>();
	#timer: NodeJS.Timeout | undefined;

	constructor(private readonly deps: JobsHubDeps) {
		super();
		this.#refreshRows();
		this.#timer = setInterval(() => {
			this.#refreshRows();
			this.deps.requestRender();
		}, REFRESH_MS);
		this.#timer.unref?.();
	}

	get isEmpty(): boolean {
		return this.deps.manager.getAllJobs().length === 0;
	}

	dispose(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
	}

	override render(width: number): readonly string[] {
		this.#refreshRows();
		return this.#detail ? this.#renderDetail(width) : this.#renderList(width);
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			this.#handleMouseInput(data);
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.#detail) {
				this.#detail = false;
				this.#detailOffset = 0;
				this.deps.requestRender();
				return;
			}
			this.deps.onDone();
			return;
		}
		if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
			if (this.#rows[this.#selected]) {
				this.#detail = !this.#detail;
				this.#detailOffset = 0;
				this.deps.requestRender();
			}
			return;
		}
		if (matchesKey(data, "f")) {
			this.#focusSelected();
			return;
		}
		if (matchesKey(data, "x")) {
			this.#cancelSelected();
			return;
		}
		if (matchesKey(data, "j") || matchesSelectDown(data)) {
			if (this.#detail) this.#detailOffset++;
			else this.#selected = Math.min(this.#selected + 1, Math.max(0, this.#rows.length - 1));
			this.deps.requestRender();
			return;
		}
		if (matchesKey(data, "k") || matchesSelectUp(data)) {
			if (this.#detail) this.#detailOffset = Math.max(0, this.#detailOffset - 1);
			else this.#selected = Math.max(0, this.#selected - 1);
			this.deps.requestRender();
		}
	}

	#handleMouseInput(data: string): void {
		routeSgrMouseInput(data, (event: SgrMouseEvent) => {
			if (event.wheel !== null) {
				if (this.#detail) this.#detailOffset = Math.max(0, this.#detailOffset + event.wheel);
				else this.#selected = Math.max(0, Math.min(this.#selected + event.wheel, this.#rows.length - 1));
				this.deps.requestRender();
				return true;
			}
			if (!event.leftClick) return true;
			const rowIndex = this.#rowAtScreenLine.get(event.row);
			if (rowIndex === undefined) return true;
			this.#selected = rowIndex;
			this.deps.requestRender();
			return true;
		});
	}

	#refreshRows(): void {
		const selectedId = this.#rows[this.#selected]?.job.id;
		this.#rows = this.deps.manager
			.getAllJobs()
			.map(job => ({ job, progress: taskProgress(job) }))
			.sort((left, right) => {
				const leftOrder = left.job.status === "running" && left.job.queued ? 1 : STATUS_ORDER[left.job.status] * 2;
				const rightOrder =
					right.job.status === "running" && right.job.queued ? 1 : STATUS_ORDER[right.job.status] * 2;
				return leftOrder - rightOrder || right.job.startTime - left.job.startTime;
			});
		const kept = selectedId ? this.#rows.findIndex(row => row.job.id === selectedId) : -1;
		this.#selected = kept >= 0 ? kept : Math.min(this.#selected, Math.max(0, this.#rows.length - 1));
	}

	#renderList(width: number): string[] {
		const inner = Math.max(1, width - 2);
		this.#rowAtScreenLine.clear();
		const jobs = this.#rows.map(row => row.job);
		const running = jobs.filter(job => job.status === "running" && !job.queued).length;
		const queued = jobs.filter(job => job.status === "running" && job.queued).length;
		const completed = jobs.filter(job => job.status === "completed").length;
		const failed = jobs.filter(job => job.status === "failed").length;
		const cancelled = jobs.filter(job => job.status === "cancelled").length;
		const capacity = this.deps.manager.getConcurrencySnapshot();
		const summary = [
			tSettingsUi("{count} running", { count: running }),
			tSettingsUi("{count} queued", { count: queued }),
			tSettingsUi("{count} done", { count: completed }),
			tSettingsUi("{count} failed", { count: failed }),
			tSettingsUi("{count} cancelled", { count: cancelled }),
			`${capacity.running}/${capacity.limit}`,
		].join(theme.sep.dot);
		const lines = [
			...new DynamicBorder().render(width),
			` ${truncateToWidth(`${theme.fg("accent", tSettingsUi("Jobs Hub"))}${theme.fg("dim", `${theme.sep.dot}${summary}`)}`, inner)}`,
			` ${truncateToWidth(
				[
					rawKeyHint("j/k", tSettingsUi("select")),
					rawKeyHint("Enter", tSettingsUi("open details")),
					rawKeyHint("f", tSettingsUi("focus agent")),
					rawKeyHint("x", tSettingsUi("cancel job")),
					rawKeyHint("Esc", tSettingsUi("close")),
				].join(theme.sep.dot),
				inner,
			)}`,
		];
		const terminalRows = process.stdout.rows || 40;
		const chromeRows = 6 + (this.#notice ? 1 : 0);
		const maxVisibleItems = Math.max(1, Math.floor((terminalRows - chromeRows) / 2));
		const maxStart = Math.max(0, this.#rows.length - maxVisibleItems);
		const visibleStart = Math.max(0, Math.min(this.#selected - Math.floor(maxVisibleItems / 2), maxStart));
		const visibleEnd = Math.min(this.#rows.length, visibleStart + maxVisibleItems);
		if (this.#rows.length === 0) lines.push(` ${theme.fg("dim", tSettingsUi("No retained background jobs."))}`);
		if (visibleStart > 0)
			lines.push(` ${theme.fg("dim", tSettingsUi("{count} earlier jobs", { count: visibleStart }))}`);
		for (const [offset, row] of this.#rows.slice(visibleStart, visibleEnd).entries()) {
			const index = visibleStart + offset;
			const selected = index === this.#selected;
			const job = row.job;
			const model = row.progress?.resolvedModel
				? ` ${theme.fg("dim", oneLine(row.progress.resolvedModel, 28))}`
				: "";
			const owner = job.ownerId ? ` ${theme.fg("dim", `← ${oneLine(job.ownerId, 20)}`)}` : "";
			const head = ` ${selected ? theme.fg("accent", theme.nav.cursor) : " "} ${statusGlyph(job)} ${theme.fg("muted", `[${job.type}]`)} ${oneLine(job.label || job.id, Math.max(12, inner - 55))} ${theme.fg("dim", statusLabel(job))} ${theme.fg("dim", jobDuration(job))}${model}${owner}`;
			const preview = jobPreview(row);
			const block = [head, ...(preview ? [`     ${theme.fg("dim", preview)}`] : [])];
			if (selected) {
				for (let i = 0; i < block.length; i++) {
					const clipped = truncateToWidth(block[i]!, inner, Ellipsis.Omit);
					block[i] =
						` ${theme.bg("selectedBg", `${clipped.trimStart()}${padding(Math.max(0, inner - visibleWidth(clipped)))}`)}`;
				}
			}
			const lineStart = lines.length;
			lines.push(...block.map(line => truncateToWidth(line, inner + 1, Ellipsis.Omit)));
			for (let lineOffset = 0; lineOffset < block.length; lineOffset++) {
				this.#rowAtScreenLine.set(lineStart + lineOffset, index);
			}
		}
		if (visibleEnd < this.#rows.length) {
			lines.push(
				` ${theme.fg("dim", tSettingsUi("{count} later jobs", { count: this.#rows.length - visibleEnd }))}`,
			);
		}
		if (this.#notice) lines.push(` ${theme.fg("warning", oneLine(this.#notice, inner))}`);
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}

	#renderDetail(width: number): string[] {
		const row = this.#rows[this.#selected];
		this.#rowAtScreenLine.clear();
		if (!row) {
			this.#detail = false;
			return this.#renderList(width);
		}
		const inner = Math.max(1, width - 2);
		const job = row.job;
		const lines = [
			...new DynamicBorder().render(width),
			` ${truncateToWidth(`${theme.fg("accent", tSettingsUi("Job Details"))}${theme.fg("dim", `${theme.sep.dot}${job.id}`)}`, inner)}`,
			` ${truncateToWidth(`${rawKeyHint("j/k", tSettingsUi("scroll"))}${theme.sep.dot}${rawKeyHint("Enter/Esc", tSettingsUi("back"))}${theme.sep.dot}${rawKeyHint("f", tSettingsUi("focus agent"))}${theme.sep.dot}${rawKeyHint("x", tSettingsUi("cancel job"))}`, inner)}`,
			detailLine(tSettingsUi("Status"), statusLabel(job), inner),
			detailLine(tSettingsUi("Type"), job.type, inner),
			detailLine(tSettingsUi("Duration"), jobDuration(job), inner),
			detailLine(tSettingsUi("Owner"), job.ownerId ?? "—", inner),
			detailLine(tSettingsUi("Agent"), job.agentId ?? "—", inner),
			detailLine(
				tSettingsUi("Last update"),
				job.lastProgressAt ? new Date(job.lastProgressAt).toLocaleTimeString() : "—",
				inner,
			),
		];
		if (row.progress) lines.push(...this.#taskDetailLines(row.progress, inner));
		else if (job.description) lines.push(detailLine(tSettingsUi("Work"), oneLine(job.description, inner), inner));
		const rawOutput = job.type === "bash" ? job.latestProgressText : (job.errorText ?? job.resultText);
		if (rawOutput) {
			lines.push(` ${theme.bold(tSettingsUi(job.type === "bash" ? "Live output tail" : "Result"))}`);
			const outputLines = safeLines(rawOutput).map(line => ` ${truncateToWidth(line, inner - 1, Ellipsis.Omit)}`);
			const viewport = Math.max(3, (process.stdout.rows || 40) - lines.length - 2);
			const maxOffset = Math.max(0, outputLines.length - viewport);
			this.#detailOffset = Math.min(this.#detailOffset, maxOffset);
			lines.push(...outputLines.slice(this.#detailOffset, this.#detailOffset + viewport));
			if (outputLines.length > viewport) {
				lines.push(
					` ${theme.fg("dim", tSettingsUi("lines {start}-{end} of {total}", { start: this.#detailOffset + 1, end: Math.min(outputLines.length, this.#detailOffset + viewport), total: outputLines.length }))}`,
				);
			}
		}
		if (this.#notice) lines.push(` ${theme.fg("warning", oneLine(this.#notice, inner))}`);
		lines.push(...new DynamicBorder().render(width));
		return lines.map(line => truncateToWidth(line, width, Ellipsis.Omit));
	}

	#taskDetailLines(progress: AgentProgress, width: number): string[] {
		const lines: string[] = [];
		const work = progress.assignment ?? progress.task;
		if (work) lines.push(detailLine(tSettingsUi("Work"), oneLine(work, width), width));
		if (progress.activity?.label)
			lines.push(detailLine(tSettingsUi("Activity"), tSettingsUi(progress.activity.label), width));
		if (progress.lastIntent)
			lines.push(detailLine(tSettingsUi("Intent"), oneLine(progress.lastIntent, width), width));
		if (progress.currentTool) {
			const tool = [progress.currentTool, progress.currentToolArgs].filter(Boolean).join(" · ");
			lines.push(detailLine(tSettingsUi("Current tool"), oneLine(tool, width), width));
		}
		if (progress.resolvedModel)
			lines.push(detailLine(tSettingsUi("Model"), oneLine(progress.resolvedModel, width), width));
		lines.push(detailLine(tSettingsUi("Requests"), String(progress.requests), width));
		lines.push(detailLine(tSettingsUi("Tokens"), progress.tokens.toLocaleString(), width));
		if (progress.contextTokens !== undefined) {
			const context = progress.contextWindow
				? `${progress.contextTokens.toLocaleString()} / ${progress.contextWindow.toLocaleString()}`
				: progress.contextTokens.toLocaleString();
			lines.push(detailLine(tSettingsUi("Context"), context, width));
		}
		lines.push(detailLine(tSettingsUi("Cost"), `$${progress.cost.toFixed(4)}`, width));
		if (progress.retryState) {
			lines.push(
				detailLine(
					tSettingsUi("Retry"),
					`${progress.retryState.attempt}/${progress.retryState.maxAttempts} · ${oneLine(progress.retryState.errorMessage, width)}`,
					width,
				),
			);
		}
		if (progress.recentTools.length > 0) {
			lines.push(
				detailLine(
					tSettingsUi("Recent tools"),
					progress.recentTools
						.slice(-3)
						.map(tool => tool.tool)
						.join(" → "),
					width,
				),
			);
		}
		return lines;
	}

	#focusSelected(): void {
		const job = this.#rows[this.#selected]?.job;
		if (!job?.agentId || !this.deps.focusAgent) {
			this.#notice = tSettingsUi("The selected job has no focusable agent.");
			this.deps.requestRender();
			return;
		}
		void this.deps.focusAgent(job.agentId).catch(error => {
			this.#notice = error instanceof Error ? error.message : String(error);
			this.deps.requestRender();
		});
	}

	#cancelSelected(): void {
		const job = this.#rows[this.#selected]?.job;
		if (job?.status !== "running" || !this.deps.cancelJob) {
			this.#notice = tSettingsUi("The selected job cannot be cancelled.");
			this.deps.requestRender();
			return;
		}
		void this.deps
			.cancelJob(job)
			.then(cancelled => {
				this.#notice = cancelled
					? tSettingsUi("Cancellation requested.")
					: tSettingsUi("The selected job is no longer running.");
				this.#refreshRows();
				this.deps.requestRender();
			})
			.catch(error => {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.deps.requestRender();
			});
	}
}
