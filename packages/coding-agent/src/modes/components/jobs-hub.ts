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
import { formatAge, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobManager } from "../../async/job-manager";
import { tSettingsUi } from "../../i18n/settings-locale";
import type { AgentProgress } from "../../task/types";
import { replaceTabs } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { formatAgentDuration } from "./agent-activity-display";
import { rawKeyHint } from "./keybinding-hints";
import { bottomBorder, divider, row, topBorder } from "./overlay-box";

const REFRESH_MS = 1_000;
const CLOSE_DOUBLE_TAP_MIN_GAP_MS = 40;
const CLOSE_DOUBLE_TAP_MAX_GAP_MS = 500;
const JOB_MIN_JOB_WIDTH = 18;
const JOB_WIDTH = 32;
const JOB_MAX_JOB_WIDTH = 40;
const JOB_TYPE_WIDTH = 8;
const JOB_STATUS_WIDTH = 14;
const JOB_DURATION_WIDTH = 8;
const JOB_MODEL_WIDTH = 20;
const JOB_MODEL_MIN_WIDTH = 12;
const JOB_OWNER_WIDTH = 12;
const JOB_OWNER_MIN_WIDTH = 8;
const JOB_UPDATE_WIDTH = 11;
const JOB_UPDATE_MIN_WIDTH = 8;
const JOB_COLUMN_GAP = " ";
const JOB_WIDE_BREATHING_WIDTH = 6;
/**
 * Minimum content width for the aligned column layout. The fullscreen frame
 * contributes four gutter cells, so the observable outer threshold is 95.
 * The extra breathing cells keep the minimum layout readable after every
 * elastic column reaches its floor.
 */
const JOBS_WIDE_MIN_CONTENT_WIDTH =
	3 +
	JOB_MIN_JOB_WIDTH +
	JOB_TYPE_WIDTH +
	JOB_STATUS_WIDTH +
	JOB_DURATION_WIDTH +
	JOB_MODEL_MIN_WIDTH +
	JOB_OWNER_MIN_WIDTH +
	JOB_UPDATE_MIN_WIDTH +
	JOB_COLUMN_GAP.length * 6 +
	JOB_WIDE_BREATHING_WIDTH;
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

interface RenderedJobEntry {
	lines: string[];
	rowIndex?: number;
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
	#lastLeftTapTime = 0;
	#lastRightTapTime = 0;
	#leftTapCount = 0;
	#rightTapCount = 0;

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

	override dispose(): void {
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
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			if (this.#detectCloseDoubleTap(matchesKey(data, "left") ? "left" : "right")) this.deps.onDone();
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

	#detectCloseDoubleTap(direction: "left" | "right"): boolean {
		const now = Date.now();
		const lastTapTime = direction === "left" ? this.#lastLeftTapTime : this.#lastRightTapTime;
		const sinceLast = now - lastTapTime;
		if (direction === "left") this.#lastLeftTapTime = now;
		else this.#lastRightTapTime = now;
		if (sinceLast >= CLOSE_DOUBLE_TAP_MAX_GAP_MS) {
			if (direction === "left") this.#leftTapCount = 1;
			else this.#rightTapCount = 1;
			return false;
		}
		const count = direction === "left" ? ++this.#leftTapCount : ++this.#rightTapCount;
		if (count !== 2 || sinceLast < CLOSE_DOUBLE_TAP_MIN_GAP_MS) return false;
		if (direction === "left") {
			this.#leftTapCount = 0;
			this.#lastLeftTapTime = 0;
		} else {
			this.#rightTapCount = 0;
			this.#lastRightTapTime = 0;
		}
		return true;
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
		const innerWidth = Math.max(1, width - 4);
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
		const wide = innerWidth >= JOBS_WIDE_MIN_CONTENT_WIDTH;
		const lines = [topBorder(width, tSettingsUi("Jobs Hub")), row(theme.fg("dim", summary), width)];

		if (wide && this.#rows.length > 0) lines.push(row(this.#columnHeader(innerWidth), width));

		if (this.#rows.length === 0) {
			lines.push(row(theme.fg("dim", tSettingsUi("No retained background jobs.")), width));
		} else {
			const terminalRows = process.stdout.rows || 40;
			const chromeRows = 5 + (wide ? 1 : 0) + (this.#notice ? 1 : 0);
			const budget = Math.max(1, terminalRows - chromeRows);
			const entries = this.#renderEntries(innerWidth);
			const selectedEntry = Math.max(
				0,
				entries.findIndex(entry => entry.rowIndex === this.#selected),
			);
			const fitEntries = (entryBudget: number): { start: number; end: number; used: number } => {
				let start = selectedEntry;
				let end = Math.min(entries.length, start + 1);
				let used = entries[start]?.lines.length ?? 0;
				for (let grew = true; grew; ) {
					grew = false;
					if (end < entries.length && used + entries[end]!.lines.length <= entryBudget) {
						used += entries[end]!.lines.length;
						end++;
						grew = true;
					}
					if (start > 0 && used + entries[start - 1]!.lines.length <= entryBudget) {
						start--;
						used += entries[start]!.lines.length;
						grew = true;
					}
				}
				return { start, end, used };
			};
			let entryBudget = budget;
			let { start, end, used } = fitEntries(entryBudget);
			for (let pass = 0; pass < 3; pass++) {
				const markerRows = (start > 0 ? 1 : 0) + (end < entries.length ? 1 : 0);
				const nextBudget = Math.max(1, budget - markerRows);
				if (nextBudget === entryBudget) break;
				entryBudget = nextBudget;
				({ start, end, used } = fitEntries(entryBudget));
			}
			const markerCapacity = Math.max(0, budget - used);
			const showStartMarker = start > 0 && markerCapacity > 0;
			const showEndMarker = end < entries.length && markerCapacity > (showStartMarker ? 1 : 0);
			if (showStartMarker) {
				lines.push(row(theme.fg("dim", `… ${tSettingsUi("{count} more", { count: start })}`), width));
			}
			for (const entry of entries.slice(start, end)) {
				const lineStart = lines.length;
				for (const content of entry.lines) lines.push(row(content, width));
				if (entry.rowIndex !== undefined) {
					for (let offset = 0; offset < entry.lines.length; offset++) {
						this.#rowAtScreenLine.set(lineStart + offset, entry.rowIndex);
					}
				}
			}
			if (showEndMarker) {
				lines.push(
					row(theme.fg("dim", `… ${tSettingsUi("{count} more", { count: entries.length - end })}`), width),
				);
			}
		}

		if (this.#notice) lines.push(row(theme.fg("warning", oneLine(this.#notice, innerWidth)), width));
		lines.push(divider(width));
		lines.push(row(this.#footer(innerWidth), width));
		lines.push(bottomBorder(width));
		return lines;
	}

	#renderEntries(width: number): RenderedJobEntry[] {
		const entries: RenderedJobEntry[] = [];
		for (let rowIndex = 0; rowIndex < this.#rows.length; rowIndex++) {
			const row = this.#rows[rowIndex]!;
			entries.push({
				lines: this.#renderEntry(row, rowIndex === this.#selected, width),
				rowIndex,
			});
		}
		return entries;
	}

	/** Distribute aligned columns continuously while preserving each column floor. */
	#fixedColumnWidths(width: number): { job: number; model: number; owner: number; update: number } {
		const max = Math.max(1, width);
		let job = JOB_WIDTH;
		let model = JOB_MODEL_WIDTH;
		let owner = JOB_OWNER_WIDTH;
		let update = JOB_UPDATE_WIDTH;
		const available = max - 3 - JOB_TYPE_WIDTH - JOB_STATUS_WIDTH - JOB_DURATION_WIDTH - JOB_COLUMN_GAP.length * 6;
		const deficit = Math.max(0, job + model + owner + update - available);
		const updateReduction = Math.min(JOB_UPDATE_WIDTH - JOB_UPDATE_MIN_WIDTH, deficit);
		update -= updateReduction;
		const ownerReduction = Math.min(JOB_OWNER_WIDTH - JOB_OWNER_MIN_WIDTH, deficit - updateReduction);
		owner -= ownerReduction;
		const modelReduction = Math.min(
			JOB_MODEL_WIDTH - JOB_MODEL_MIN_WIDTH,
			deficit - updateReduction - ownerReduction,
		);
		model -= modelReduction;
		const jobReduction = Math.min(
			JOB_WIDTH - JOB_MIN_JOB_WIDTH,
			deficit - updateReduction - ownerReduction - modelReduction,
		);
		job -= jobReduction;
		const surplus = Math.max(0, available - job - model - owner - update);
		job += Math.min(JOB_MAX_JOB_WIDTH - job, surplus);
		return { job, model, owner, update };
	}

	#columnHeader(width: number): string {
		const {
			job: jobWidth,
			model: modelWidth,
			owner: ownerWidth,
			update: updateWidth,
		} = this.#fixedColumnWidths(width);
		const cells = [
			fixedCell(tSettingsUi("Job"), jobWidth),
			fixedCell(tSettingsUi("Type"), JOB_TYPE_WIDTH),
			fixedCell(tSettingsUi("Status"), JOB_STATUS_WIDTH),
			fixedCell(tSettingsUi("Duration"), JOB_DURATION_WIDTH),
			fixedCell(tSettingsUi("Model"), modelWidth),
			fixedCell(tSettingsUi("Owner"), ownerWidth),
			fixedCell(tSettingsUi("Last update"), updateWidth),
		];
		return theme.fg("dim", `   ${cells.join(JOB_COLUMN_GAP)}`);
	}

	#footer(width: number): string {
		const separator = theme.fg("dim", theme.sep.dot);
		const controls = [
			rawKeyHint("j/k", tSettingsUi("select")),
			rawKeyHint("Enter", tSettingsUi("open details")),
			rawKeyHint("Esc/←←/→→", tSettingsUi("close")),
			rawKeyHint("f", tSettingsUi("focus agent")),
			rawKeyHint("x", tSettingsUi("cancel job")),
		];
		return theme.fg("dim", truncateToWidth(controls.join(separator), Math.max(1, width)));
	}

	#renderEntry(row: JobRow, selected: boolean, width: number): string[] {
		const max = Math.max(1, width);
		const job = row.job;
		const label = oneLine(job.label || job.id, max);
		const type = oneLine(job.type, JOB_TYPE_WIDTH);
		const status = `${statusGlyph(job)} ${statusLabel(job)}`;
		const duration = jobDuration(job);
		const model = row.progress?.resolvedModel ? oneLine(row.progress.resolvedModel, JOB_MODEL_WIDTH) : "—";
		const owner = job.ownerId ? oneLine(job.ownerId, JOB_OWNER_WIDTH) : "—";
		const lastUpdate = job.lastProgressAt
			? formatAge(Math.max(1, Math.round((Date.now() - job.lastProgressAt) / 1000)))
			: "—";
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		const entry: string[] = [];

		if (width >= JOBS_WIDE_MIN_CONTENT_WIDTH) {
			const {
				job: jobWidth,
				model: modelWidth,
				owner: ownerWidth,
				update: updateWidth,
			} = this.#fixedColumnWidths(width);
			entry.push(
				` ${cursor} ${[
					fixedCell(theme.bold(oneLine(label, jobWidth)), jobWidth),
					fixedCell(theme.fg("muted", type), JOB_TYPE_WIDTH),
					fixedCell(status, JOB_STATUS_WIDTH),
					fixedCell(theme.fg("dim", duration), JOB_DURATION_WIDTH),
					fixedCell(theme.fg("dim", model), modelWidth),
					fixedCell(theme.fg("dim", owner), ownerWidth),
					fixedCell(theme.fg("dim", lastUpdate), updateWidth),
				].join(JOB_COLUMN_GAP)}`,
			);
		} else {
			const suffix = `  ${theme.fg("muted", `[${type}]`)}${theme.sep.dot}${status}`;
			const labelWidth = Math.max(8, max - 3 - visibleWidth(suffix));
			entry.push(` ${cursor} ${fixedCell(theme.bold(oneLine(label, labelWidth)), labelWidth)}${suffix}`);
		}

		const clipped = truncateToWidth(entry[0] ?? "", max);
		if (!selected) return [clipped];
		return [theme.bg("selectedBg", `${clipped}${padding(Math.max(0, max - visibleWidth(clipped)))}`)];
	}

	#renderDetail(width: number): string[] {
		const selected = this.#rows[this.#selected];
		this.#rowAtScreenLine.clear();
		if (!selected) {
			this.#detail = false;
			return this.#renderList(width);
		}
		const inner = Math.max(1, width - 4);
		const job = selected.job;
		const content = [
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
		if (selected.progress) content.push(...this.#taskDetailLines(selected.progress, inner));
		else if (job.description) content.push(detailLine(tSettingsUi("Work"), oneLine(job.description, inner), inner));
		const rawOutput = job.type === "bash" ? job.latestProgressText : (job.errorText ?? job.resultText);
		if (rawOutput) {
			content.push(theme.bold(tSettingsUi(job.type === "bash" ? "Live output tail" : "Result")));
			const outputLines = safeLines(rawOutput).map(line => truncateToWidth(line, inner, Ellipsis.Omit));
			const viewport = Math.max(3, (process.stdout.rows || 40) - content.length - 4);
			const maxOffset = Math.max(0, outputLines.length - viewport);
			this.#detailOffset = Math.min(this.#detailOffset, maxOffset);
			content.push(...outputLines.slice(this.#detailOffset, this.#detailOffset + viewport));
			if (outputLines.length > viewport) {
				content.push(
					theme.fg(
						"dim",
						tSettingsUi("lines {start}-{end} of {total}", {
							start: this.#detailOffset + 1,
							end: Math.min(outputLines.length, this.#detailOffset + viewport),
							total: outputLines.length,
						}),
					),
				);
			}
		}
		if (this.#notice) content.push(theme.fg("warning", oneLine(this.#notice, inner)));
		const footer = [
			rawKeyHint("j/k", tSettingsUi("scroll")),
			rawKeyHint("Enter/Esc", tSettingsUi("back")),
			rawKeyHint("←←/→→", tSettingsUi("close")),
			rawKeyHint("f", tSettingsUi("focus agent")),
			rawKeyHint("x", tSettingsUi("cancel job")),
		].join(theme.sep.dot);
		return [
			topBorder(width, `${tSettingsUi("Job Details")}${theme.sep.dot}${job.id}`),
			...content.map(line => row(line, width)),
			divider(width),
			row(theme.fg("dim", truncateToWidth(footer, inner)), width),
			bottomBorder(width),
		];
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
