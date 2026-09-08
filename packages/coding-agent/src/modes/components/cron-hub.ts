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
import { tSettingsUi } from "../../i18n/settings-locale";
import type { ScheduleJob, ScheduleManagementAction } from "../../scheduling/types";
import { replaceTabs } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { rawKeyHint } from "./keybinding-hints";
import { bottomBorder, divider, row, topBorder } from "./overlay-box";

const REFRESH_MS = 5_000;
const CLOSE_DOUBLE_TAP_MIN_GAP_MS = 40;
const CLOSE_DOUBLE_TAP_MAX_GAP_MS = 500;
const LABEL_WIDTH = 28;
const LABEL_MIN_WIDTH = 12;
const SCHEDULE_WIDTH = 18;
const STATUS_WIDTH = 14;
const NEXT_RUN_WIDTH = 14;
const RUNS_WIDTH = 6;
const COLUMN_GAP = " ";
/** Minimum content width for the aligned column layout (frame adds 4 gutter cells). */
const CRON_WIDE_MIN_CONTENT_WIDTH =
	3 + LABEL_MIN_WIDTH + SCHEDULE_WIDTH + STATUS_WIDTH + NEXT_RUN_WIDTH + RUNS_WIDTH + COLUMN_GAP.length * 4 + 6;
const DETAIL_LABEL_WIDTH = 14;

const STATUS_ORDER: Record<ScheduleJob["status"], number> = {
	active: 0,
	paused: 1,
	completed: 2,
	failed: 3,
	cancelled: 4,
};

export interface CronHubDeps {
	listJobs: () => Promise<ScheduleJob[]>;
	manageJob: (id: string, action: ScheduleManagementAction) => Promise<ScheduleJob | undefined>;
	/** Deliver one fired prompt through the scheduler's normal delivery gates. */
	runNow: (job: ScheduleJob) => Promise<void>;
	onDone: () => void;
	requestRender: () => void;
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

function statusGlyph(job: ScheduleJob): string {
	if (job.status === "active") return theme.fg("success", theme.status.enabled);
	if (job.status === "paused") return theme.fg("warning", "◌");
	if (job.status === "failed") return theme.fg("error", theme.status.error);
	return theme.fg("dim", theme.status.disabled);
}

function statusLabel(job: ScheduleJob): string {
	return tSettingsUi(job.status);
}

function formatNextRun(job: ScheduleJob): string {
	if (!job.nextRunAt) return "—";
	const at = Date.parse(job.nextRunAt);
	if (!Number.isFinite(at)) return "—";
	const deltaMs = at - Date.now();
	if (deltaMs <= 0) return tSettingsUi("due");
	return tSettingsUi("in {age}", { age: formatAge(Math.max(1, Math.round(deltaMs / 1000))) });
}

function formatLastRun(job: ScheduleJob): string {
	if (!job.lastRunAt) return "—";
	const at = Date.parse(job.lastRunAt);
	if (!Number.isFinite(at)) return "—";
	return tSettingsUi("{age} ago", { age: formatAge(Math.max(1, Math.round((Date.now() - at) / 1000))) });
}

function fixedCell(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(1, width), Ellipsis.Unicode);
	return `${clipped}${padding(Math.max(0, width - visibleWidth(clipped)))}`;
}

function detailLine(label: string, value: string, width: number): string {
	const labelCell = fixedCell(theme.fg("dim", label), DETAIL_LABEL_WIDTH);
	return ` ${labelCell}${truncateToWidth(value, Math.max(1, width - DETAIL_LABEL_WIDTH - 1), Ellipsis.Unicode)}`;
}

/**
 * Fullscreen management list for the current session's cron jobs. The listed
 * jobs share the session's lifecycle — the frame states that explicitly so the
 * list doubles as the documentation of the scope boundary.
 */
export class CronHubOverlayComponent extends Container {
	#selected = 0;
	#detail = false;
	#notice: string | undefined;
	#rows: ScheduleJob[] = [];
	#rowAtScreenLine = new Map<number, number>();
	#timer: NodeJS.Timeout | undefined;
	#lastLeftTapTime = 0;
	#lastRightTapTime = 0;
	#leftTapCount = 0;
	#rightTapCount = 0;

	constructor(private readonly deps: CronHubDeps) {
		super();
		void this.#refreshRows();
		this.#timer = setInterval(() => {
			void this.#refreshRows();
			this.deps.requestRender();
		}, REFRESH_MS);
		this.#timer.unref?.();
	}

	override dispose(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
	}

	override render(width: number): readonly string[] {
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
				this.deps.requestRender();
			}
			return;
		}
		if (matchesKey(data, "p")) {
			this.#togglePauseSelected();
			return;
		}
		if (matchesKey(data, "x")) {
			this.#cancelSelected();
			return;
		}
		if (matchesKey(data, "r")) {
			this.#runSelectedNow();
			return;
		}
		if (matchesKey(data, "j") || matchesSelectDown(data)) {
			this.#selected = Math.min(this.#selected + 1, Math.max(0, this.#rows.length - 1));
			this.deps.requestRender();
			return;
		}
		if (matchesKey(data, "k") || matchesSelectUp(data)) {
			this.#selected = Math.max(0, this.#selected - 1);
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
				this.#selected = Math.max(0, Math.min(this.#selected + event.wheel, this.#rows.length - 1));
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

	async #refreshRows(): Promise<void> {
		let jobs: ScheduleJob[];
		try {
			jobs = await this.deps.listJobs();
		} catch (error) {
			this.#notice = error instanceof Error ? error.message : String(error);
			this.deps.requestRender();
			return;
		}
		const selectedId = this.#rows[this.#selected]?.id;
		this.#rows = [...jobs].sort(
			(left, right) =>
				STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
				(left.nextRunAt ?? "").localeCompare(right.nextRunAt ?? "") ||
				left.id.localeCompare(right.id),
		);
		const kept = selectedId ? this.#rows.findIndex(row => row.id === selectedId) : -1;
		this.#selected = kept >= 0 ? kept : Math.min(this.#selected, Math.max(0, this.#rows.length - 1));
		this.deps.requestRender();
	}

	#renderList(width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		this.#rowAtScreenLine.clear();
		const active = this.#rows.filter(job => job.status === "active").length;
		const paused = this.#rows.filter(job => job.status === "paused").length;
		const terminal = this.#rows.length - active - paused;
		const summary = [
			tSettingsUi("{count} active", { count: active }),
			tSettingsUi("{count} paused", { count: paused }),
			tSettingsUi("{count} finished", { count: terminal }),
		].join(theme.sep.dot);
		const wide = innerWidth >= CRON_WIDE_MIN_CONTENT_WIDTH - 4;
		const lines = [
			topBorder(width, tSettingsUi("Cron Jobs — this session's lifecycle")),
			row(theme.fg("dim", summary), width),
		];

		if (wide && this.#rows.length > 0) lines.push(row(this.#columnHeader(), width));

		if (this.#rows.length === 0) {
			lines.push(row(theme.fg("dim", tSettingsUi("No scheduled prompts for this session.")), width));
			lines.push(
				row(theme.fg("dim", tSettingsUi("Create one with /cron add, /schedule add, or the cron tool.")), width),
			);
		} else {
			for (let rowIndex = 0; rowIndex < this.#rows.length; rowIndex++) {
				const entryLines = this.#renderRow(this.#rows[rowIndex]!, rowIndex === this.#selected, innerWidth);
				const lineStart = lines.length;
				for (const content of entryLines) lines.push(row(content, width));
				for (let offset = 0; offset < entryLines.length; offset++) {
					this.#rowAtScreenLine.set(lineStart + offset, rowIndex);
				}
			}
		}

		if (this.#notice) lines.push(row(theme.fg("warning", oneLine(this.#notice, innerWidth)), width));
		lines.push(divider(width));
		lines.push(row(this.#footer(innerWidth), width));
		lines.push(bottomBorder(width));
		return lines;
	}

	#columnHeader(): string {
		const cells = [
			fixedCell(tSettingsUi("Job"), LABEL_WIDTH),
			fixedCell(tSettingsUi("Schedule"), SCHEDULE_WIDTH),
			fixedCell(tSettingsUi("Status"), STATUS_WIDTH),
			fixedCell(tSettingsUi("Next run"), NEXT_RUN_WIDTH),
			fixedCell(tSettingsUi("Runs"), RUNS_WIDTH),
		];
		return theme.fg("dim", `   ${cells.join(COLUMN_GAP)}`);
	}

	#footer(width: number): string {
		const separator = theme.fg("dim", theme.sep.dot);
		const controls = [
			rawKeyHint("j/k", tSettingsUi("select")),
			rawKeyHint("Enter", tSettingsUi("open details")),
			rawKeyHint("p", tSettingsUi("pause/resume")),
			rawKeyHint("r", tSettingsUi("run now")),
			rawKeyHint("x", tSettingsUi("cancel")),
			rawKeyHint("Esc/←←/→→", tSettingsUi("close")),
		];
		return theme.fg("dim", truncateToWidth(controls.join(separator), Math.max(1, width)));
	}

	#renderRow(job: ScheduleJob, selected: boolean, width: number): string[] {
		const max = Math.max(1, width);
		const schedule = oneLine(job.schedule.expression, SCHEDULE_WIDTH);
		const status = `${statusGlyph(job)} ${statusLabel(job)}`;
		const nextRun = formatNextRun(job);
		const runs = String(job.runCount);
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		let line: string;
		if (width >= CRON_WIDE_MIN_CONTENT_WIDTH - 4) {
			const cells = [
				fixedCell(theme.bold(oneLine(job.label || job.prompt, LABEL_WIDTH)), LABEL_WIDTH),
				fixedCell(theme.fg("muted", schedule), SCHEDULE_WIDTH),
				fixedCell(status, STATUS_WIDTH),
				fixedCell(theme.fg("dim", nextRun), NEXT_RUN_WIDTH),
				fixedCell(theme.fg("dim", runs), RUNS_WIDTH),
			];
			line = ` ${cursor} ${cells.join(COLUMN_GAP)}`;
		} else {
			const suffix = `  ${theme.fg("muted", `[${schedule}]`)}${theme.sep.dot}${status}`;
			const labelWidth = Math.max(8, max - 3 - visibleWidth(suffix));
			line = ` ${cursor} ${fixedCell(theme.bold(oneLine(job.label || job.prompt, labelWidth)), labelWidth)}${suffix}`;
		}
		const clipped = truncateToWidth(line, max);
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
		const content = [
			detailLine(tSettingsUi("Status"), statusLabel(selected), inner),
			detailLine(tSettingsUi("Schedule"), selected.schedule.expression, inner),
			detailLine(tSettingsUi("Delivery"), selected.deliveryMode ?? "follow_up", inner),
			detailLine(tSettingsUi("Next run"), selected.nextRunAt ?? "—", inner),
			detailLine(tSettingsUi("Last run"), formatLastRun(selected), inner),
			detailLine(tSettingsUi("Runs"), String(selected.runCount), inner),
		];
		if (selected.lastError) content.push(detailLine(tSettingsUi("Last error"), selected.lastError, inner));
		content.push(theme.bold(tSettingsUi("Prompt")));
		const promptLines = safeLines(selected.prompt).map(line => truncateToWidth(line, inner, Ellipsis.Omit));
		const viewport = Math.max(3, (process.stdout.rows || 40) - content.length - 4);
		content.push(...promptLines.slice(0, viewport));
		if (promptLines.length > viewport) {
			content.push(theme.fg("dim", tSettingsUi("{count} more lines", { count: promptLines.length - viewport })));
		}
		if (this.#notice) content.push(theme.fg("warning", oneLine(this.#notice, inner)));
		const footer = [
			rawKeyHint("j/k", tSettingsUi("scroll")),
			rawKeyHint("Enter/Esc", tSettingsUi("back")),
			rawKeyHint("p", tSettingsUi("pause/resume")),
			rawKeyHint("r", tSettingsUi("run now")),
			rawKeyHint("x", tSettingsUi("cancel")),
		].join(theme.sep.dot);
		return [
			topBorder(width, `${tSettingsUi("Cron Job")}${theme.sep.dot}${selected.id}`),
			...content.map(line => row(line, width)),
			divider(width),
			row(theme.fg("dim", truncateToWidth(footer, inner)), width),
			bottomBorder(width),
		];
	}

	#withNotice(notice: string | undefined): void {
		this.#notice = notice;
		void this.#refreshRows();
	}

	#togglePauseSelected(): void {
		const job = this.#rows[this.#selected];
		if (!job || (job.status !== "active" && job.status !== "paused")) {
			this.#notice = tSettingsUi("Only active or paused jobs can be paused or resumed.");
			this.deps.requestRender();
			return;
		}
		const action: ScheduleManagementAction = job.status === "active" ? "pause" : "resume";
		void this.deps
			.manageJob(job.id, action)
			.then(() => this.#withNotice(undefined))
			.catch(error => this.#withNotice(error instanceof Error ? error.message : String(error)));
	}

	#cancelSelected(): void {
		const job = this.#rows[this.#selected];
		if (!job || (job.status !== "active" && job.status !== "paused")) {
			this.#notice = tSettingsUi("The selected job cannot be cancelled.");
			this.deps.requestRender();
			return;
		}
		void this.deps
			.manageJob(job.id, "cancel")
			.then(() => this.#withNotice(undefined))
			.catch(error => this.#withNotice(error instanceof Error ? error.message : String(error)));
	}

	#runSelectedNow(): void {
		const job = this.#rows[this.#selected];
		if (job?.status !== "active") {
			this.#notice = tSettingsUi("Only active jobs can be run now.");
			this.deps.requestRender();
			return;
		}
		void this.deps
			.runNow(job)
			.then(() => this.#withNotice(tSettingsUi("Job prompt delivered into the session.")))
			.catch(error => this.#withNotice(error instanceof Error ? error.message : String(error)));
	}
}
