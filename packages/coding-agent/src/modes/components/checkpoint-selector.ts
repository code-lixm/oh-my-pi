/**
 * Fullscreen workspace-checkpoint picker used by `/rewind` in the interactive
 * TUI. The flow is deliberately explicit:
 *
 * 1. pick a checkpoint from history
 * 2. choose restore scope (code / conversation / all)
 * 3. inspect the preview summary
 * 4. explicitly confirm the apply
 *
 * This keeps the interaction consistent with the acceptance criteria: every
 * restore shows a preview first, conflicts and partial checkpoints require an
 * explicit confirmation path, and filtered selection always restores the row
 * that is actually highlighted on screen.
 */
import {
	type Component,
	Ellipsis,
	extractPrintableText,
	matchesKey,
	replaceTabs,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { formatBytes, formatDuration } from "@oh-my-pi/pi-utils";
import { tSettingsUi } from "../../i18n/settings-locale";
import { theme } from "../../modes/theme/theme";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import type { WorkspaceCheckpointAccessResult } from "../../session/workspace-checkpoint-coordinator";
import { PREVIEW_LIMITS } from "../../tools/render-utils";
import type {
	WorkspaceCheckpointCompleteness,
	WorkspaceCheckpointRecord,
	WorkspaceRestoreConflict,
	WorkspaceRestorePlan,
	WorkspaceRestoreResult,
} from "../../workspace-checkpoints";
import { rawKeyHint } from "./keybinding-hints";
import { bottomBorder, divider, row, topBorder } from "./overlay-box";
import { centeredWindow } from "./selector-helpers";

const MAX_VISIBLE = 10;
const SCOPE_OPTIONS = ["code", "conversation", "all"] as const;
type RestoreScope = (typeof SCOPE_OPTIONS)[number];
type Stage = "list" | "scope" | "preview";
type PreviewAction = "apply" | "back" | "cancel";

function sanitizeOneLine(value: string): string {
	return replaceTabs(value.replace(/[\r\n]+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, " ")).trim();
}

function relativeCheckpointAge(iso: string): string {
	const ts = Date.parse(iso);
	if (!Number.isFinite(ts)) return iso;
	const delta = Math.max(0, Date.now() - ts);
	if (delta < 60_000) return tSettingsUi("just now");
	return `${formatDuration(delta)} ${tSettingsUi("ago")}`;
}

function completenessBadge(completeness: WorkspaceCheckpointCompleteness): string {
	switch (completeness) {
		case "complete":
			return theme.fg("success", tSettingsUi("checkpoint complete"));
		case "partial":
			return theme.fg("warning", tSettingsUi("checkpoint partial"));
		case "corrupt":
			return theme.fg("error", tSettingsUi("checkpoint corrupt"));
	}
}

function reasonBadge(reason: WorkspaceCheckpointRecord["reason"]): string {
	switch (reason) {
		case "manual":
			return theme.fg("accent", tSettingsUi("manual"));
		case "turn":
			return theme.fg("muted", tSettingsUi("auto"));
		case "user_bash":
			return theme.fg("muted", tSettingsUi("bash"));
		case "task_merge":
			return theme.fg("muted", tSettingsUi("merge"));
		case "restore_guard":
			return theme.fg("muted", tSettingsUi("guard"));
	}
}

function renderOptionLine(label: string, selected: boolean): string {
	const cursor = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
	const body = selected ? theme.bold(label) : label;
	const line = `${cursor}${body}`;
	return selected ? theme.bg("selectedBg", line) : line;
}

function previewActionLabel(
	action: PreviewAction,
	plan: WorkspaceRestorePlan,
	checkpoint: WorkspaceCheckpointRecord,
): string {
	if (action === "apply") {
		if (plan.conflicts.length > 0) return tSettingsUi("Apply anyway");
		if (checkpoint.completeness !== "complete") return tSettingsUi("Apply partial restore");
		return tSettingsUi("Apply restore");
	}
	if (action === "back") return tSettingsUi("Back");
	return tSettingsUi("Cancel");
}

function blockingConflict(conflict: WorkspaceRestoreConflict): boolean {
	return conflict.kind === "active_mutator" || conflict.kind === "missing_object";
}

export interface CheckpointSelectorDeps {
	promptPreviews?: ReadonlyMap<string, string>;
	checkpoints: readonly WorkspaceCheckpointRecord[];
	initialCheckpointId?: string;
	onPick: (request: {
		checkpoint: WorkspaceCheckpointRecord;
		scope: RestoreScope;
		plan: WorkspaceRestorePlan;
		result: WorkspaceRestoreResult;
	}) => void | Promise<void>;
	onCancel: () => void;
	preview: (
		checkpointId: string,
		scope: RestoreScope,
	) => Promise<WorkspaceCheckpointAccessResult<WorkspaceRestorePlan>>;
	apply: (
		planId: string,
		options?: { allowConflicts?: boolean },
	) => Promise<WorkspaceCheckpointAccessResult<WorkspaceRestoreResult>>;
	isMutatorActive: () => boolean;
	requestRender: () => void;
}

export class CheckpointSelectorComponent implements Component {
	#deps: CheckpointSelectorDeps;
	#allRows: WorkspaceCheckpointRecord[];
	#filteredRows: WorkspaceCheckpointRecord[];
	#selectedIndex = 0;
	#query = "";
	#stage: Stage = "list";
	#scopeIndex = 0;
	#previewActionIndex = 0;
	#pendingCheckpoint: WorkspaceCheckpointRecord | null = null;
	#pendingScope: RestoreScope | null = null;
	#pendingPlan: WorkspaceRestorePlan | null = null;
	#statusMessage = "";
	#statusTone: "muted" | "warning" | "error" = "muted";
	#building = false;
	#applying = false;
	#previewGeneration = 0;

	constructor(deps: CheckpointSelectorDeps) {
		this.#deps = deps;
		this.#allRows = [...deps.checkpoints];
		this.#filteredRows = [...deps.checkpoints];
		if (deps.initialCheckpointId) {
			const index = this.#allRows.findIndex(checkpoint => checkpoint.id === deps.initialCheckpointId);
			if (index >= 0) this.#selectedIndex = index;
		}
		this.#syncSelectionToFilteredRows();
		this.#refreshStatus();
	}

	invalidate(): void {
		// No cached render state.
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		lines.push(topBorder(width, tSettingsUi("Workspace checkpoints")));
		lines.push(row(this.#renderSearchLine(width), width));
		lines.push(divider(width));

		if (this.#stage === "list") {
			for (const inner of this.#renderListRows(Math.max(1, width - 4))) lines.push(row(inner, width));
		} else if (this.#stage === "scope") {
			for (const inner of this.#renderScopeRows()) lines.push(row(inner, width));
		} else {
			for (const inner of this.#renderPreviewRows(Math.max(1, width - 4))) lines.push(row(inner, width));
		}

		lines.push(divider(width));
		lines.push(row(this.#renderStatusLine(width), width));
		lines.push(row(this.#renderHintLine(), width));
		lines.push(bottomBorder(width));
		return lines;
	}

	handleInput(data: string): void {
		if (this.#applying) return;
		if (matchesAppInterrupt(data)) {
			this.#cancelPendingPreview();
			this.#deps.onCancel();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
			this.#cancelPendingPreview();
			if (this.#stage === "list") {
				this.#deps.onCancel();
				return;
			}
			if (this.#stage === "scope") {
				this.#stage = "list";
				this.#refreshStatus();
				return;
			}
			this.#stage = "scope";
			this.#refreshStatus();
			return;
		}
		if (this.#building) return;

		if (this.#stage === "list") {
			this.#handleListInput(data);
			return;
		}
		if (this.#stage === "scope") {
			this.#handleScopeInput(data);
			return;
		}
		this.#handlePreviewInput(data);
	}

	#handleListInput(data: string): void {
		if (matchesSelectUp(data)) {
			this.#moveListSelection(-1);
			return;
		}
		if (matchesSelectDown(data)) {
			this.#moveListSelection(1);
			return;
		}
		if (matchesKey(data, "home")) {
			this.#selectedIndex = 0;
			this.#refreshStatus();
			return;
		}
		if (matchesKey(data, "end")) {
			this.#selectedIndex = Math.max(0, this.#filteredRows.length - 1);
			this.#refreshStatus();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			if (this.#deps.isMutatorActive()) {
				this.#refreshStatus();
				return;
			}
			const selected = this.#selectedCheckpoint();
			if (!selected) return;
			this.#pendingCheckpoint = selected;
			this.#scopeIndex = 0;
			this.#stage = "scope";
			this.#refreshStatus();
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.#query.length === 0) return;
			const chars = [...this.#query];
			chars.pop();
			this.#query = chars.join("");
			this.#applyFilter();
			return;
		}
		const printable = extractPrintableText(data);
		if (printable === undefined) return;
		if (this.#query.length === 0 && printable.trim().length === 0) return;
		this.#query += printable;
		this.#applyFilter();
	}

	#handleScopeInput(data: string): void {
		if (matchesSelectUp(data)) {
			this.#scopeIndex = this.#scopeIndex === 0 ? SCOPE_OPTIONS.length - 1 : this.#scopeIndex - 1;
			return;
		}
		if (matchesSelectDown(data)) {
			this.#scopeIndex = this.#scopeIndex === SCOPE_OPTIONS.length - 1 ? 0 : this.#scopeIndex + 1;
			return;
		}
		if (!matchesKey(data, "enter") && !matchesKey(data, "return") && data !== "\n") return;
		const checkpoint = this.#pendingCheckpoint;
		if (!checkpoint) {
			this.#stage = "list";
			this.#refreshStatus();
			return;
		}
		void this.#buildPreview(checkpoint, SCOPE_OPTIONS[this.#scopeIndex]!);
	}

	#handlePreviewInput(data: string): void {
		const actions = this.#previewActions();
		if (matchesSelectUp(data)) {
			this.#previewActionIndex = this.#previewActionIndex === 0 ? actions.length - 1 : this.#previewActionIndex - 1;
			return;
		}
		if (matchesSelectDown(data)) {
			this.#previewActionIndex = this.#previewActionIndex === actions.length - 1 ? 0 : this.#previewActionIndex + 1;
			return;
		}
		if (!matchesKey(data, "enter") && !matchesKey(data, "return") && data !== "\n") return;
		const action = actions[this.#previewActionIndex];
		if (!action) return;
		if (action === "back") {
			this.#stage = "scope";
			this.#refreshStatus();
			return;
		}
		if (action === "cancel") {
			this.#deps.onCancel();
			return;
		}
		void this.#applyCurrent();
	}

	#moveListSelection(delta: number): void {
		const total = this.#filteredRows.length;
		if (total === 0) return;
		this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex + delta, total - 1));
		this.#refreshStatus();
	}

	#selectedCheckpoint(): WorkspaceCheckpointRecord | undefined {
		return this.#filteredRows[this.#selectedIndex];
	}

	#applyFilter(): void {
		const tokens = this.#query
			.trim()
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(token => token.length > 0);
		this.#filteredRows = this.#allRows.filter(checkpoint => {
			if (tokens.length === 0) return true;
			const haystack = [
				checkpoint.id,
				checkpoint.label ?? "",
				checkpoint.reason,
				checkpoint.completeness,
				checkpoint.sessionEntryId ?? "",
				checkpoint.promptEntryId ?? "",
				this.#deps.promptPreviews?.get(checkpoint.id) ?? "",
			]
				.join(" ")
				.toLowerCase();
			return tokens.every(token => haystack.includes(token));
		});
		this.#syncSelectionToFilteredRows();
		this.#refreshStatus();
	}

	#syncSelectionToFilteredRows(): void {
		if (this.#filteredRows.length === 0) {
			this.#selectedIndex = 0;
			return;
		}
		this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, this.#filteredRows.length - 1));
	}

	#renderSearchLine(width: number): string {
		const label = theme.fg("muted", `${tSettingsUi("Search")}: `);
		const value =
			this.#query.length > 0 ? sanitizeOneLine(this.#query) : theme.fg("dim", tSettingsUi("type to filter"));
		return truncateToWidth(`${label}${value}`, Math.max(1, width - 4), Ellipsis.Unicode, true);
	}

	#renderListRows(width: number): string[] {
		if (this.#filteredRows.length === 0) {
			return [theme.fg("muted", `${theme.status.info} ${tSettingsUi("No matching checkpoints")}`)];
		}
		const rows: string[] = [];
		const { startIndex, endIndex } = centeredWindow(this.#selectedIndex, this.#filteredRows.length, MAX_VISIBLE);
		for (let index = startIndex; index < endIndex; index += 1) {
			const checkpoint = this.#filteredRows[index]!;
			const selected = index === this.#selectedIndex;
			const age = relativeCheckpointAge(checkpoint.createdAt);
			const ageWidth = visibleWidth(age);
			const cursor = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const title = sanitizeOneLine(
				checkpoint.label?.trim() || this.#deps.promptPreviews?.get(checkpoint.id) || checkpoint.id,
			);
			const titleWidth = Math.max(8, width - visibleWidth(cursor) - ageWidth - 1);
			const titleLine = `${cursor}${truncateToWidth(title, titleWidth, Ellipsis.Unicode)} ${theme.fg("dim", age)}`;
			rows.push(selected ? theme.bg("selectedBg", titleLine) : titleLine);
			const meta = `${reasonBadge(checkpoint.reason)} ${theme.sep.dot} ${checkpoint.fileCount} ${tSettingsUi(
				checkpoint.fileCount === 1 ? "file" : "files",
			)} ${theme.sep.dot} ${formatBytes(checkpoint.totalBytes)} ${theme.sep.dot} ${completenessBadge(
				checkpoint.completeness,
			)}`;
			rows.push(theme.fg("muted", `  ${truncateToWidth(replaceTabs(meta), Math.max(8, width - 2))}`));
		}
		return rows;
	}

	#renderScopeRows(): string[] {
		const checkpoint = this.#pendingCheckpoint;
		const lines = [
			theme.bold(tSettingsUi("Choose restore scope")),
			checkpoint
				? theme.fg(
						"muted",
						sanitizeOneLine(
							checkpoint.label?.trim() || this.#deps.promptPreviews?.get(checkpoint.id) || checkpoint.id,
						),
					)
				: "",
		];
		for (let index = 0; index < SCOPE_OPTIONS.length; index += 1) {
			const scope = SCOPE_OPTIONS[index]!;
			const selected = index === this.#scopeIndex;
			const label =
				scope === "code"
					? tSettingsUi("Code only")
					: scope === "conversation"
						? tSettingsUi("Conversation only")
						: tSettingsUi("Both code and conversation");
			const description =
				scope === "code"
					? tSettingsUi("Restore files, keep the current conversation.")
					: scope === "conversation"
						? tSettingsUi("Restore the conversation entry, keep the current files.")
						: tSettingsUi("Restore both files and the linked conversation state.");
			lines.push(renderOptionLine(label, selected));
			lines.push(theme.fg("muted", `    ${description}`));
		}
		return lines;
	}

	#renderPreviewRows(width: number): string[] {
		const checkpoint = this.#pendingCheckpoint;
		const plan = this.#pendingPlan;
		if (!checkpoint || !plan) {
			return [theme.fg("warning", tSettingsUi("Preview unavailable."))];
		}
		const lines = [
			theme.bold(tSettingsUi("Preview restore")),
			theme.fg(
				"muted",
				sanitizeOneLine(checkpoint.label?.trim() || this.#deps.promptPreviews?.get(checkpoint.id) || checkpoint.id),
			),
			theme.fg("muted", `${tSettingsUi("Scope")}: ${plan.scope}`),
			theme.fg("muted", `${tSettingsUi("Operations")}: ${plan.operations.length}`),
			theme.fg("muted", `${tSettingsUi("Conflicts")}: ${plan.conflicts.length}`),
			theme.fg("muted", `${tSettingsUi("Completeness")}: ${checkpoint.completeness}`),
		];
		if (checkpoint.completeness !== "complete") {
			lines.push(
				theme.fg(
					"warning",
					`${theme.status.warning} ${tSettingsUi("This checkpoint is partial or corrupt; review before applying.")}`,
				),
			);
		}
		if (plan.operations.length > 0) {
			lines.push(theme.bold(tSettingsUi("Files to restore")));
			for (const operation of plan.operations.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS)) {
				const marker =
					operation.kind === "create"
						? "+"
						: operation.kind === "delete"
							? "-"
							: operation.kind === "update"
								? "~"
								: operation.kind === "chmod"
									? "m"
									: "l";
				const tone = operation.kind === "delete" ? "warning" : operation.kind === "create" ? "success" : "muted";
				const detail = `${marker} ${operation.kind}  ${sanitizeOneLine(operation.path)}`;
				lines.push(theme.fg(tone, truncateToWidth(detail, width, Ellipsis.Unicode)));
			}
			if (plan.operations.length > PREVIEW_LIMITS.COLLAPSED_ITEMS) {
				lines.push(
					theme.fg(
						"muted",
						tSettingsUi("… {count} more operation(s)", {
							count: plan.operations.length - PREVIEW_LIMITS.COLLAPSED_ITEMS,
						}),
					),
				);
			}
		}
		if (plan.conflicts.length > 0) {
			lines.push(theme.fg("warning", `${theme.status.warning} ${tSettingsUi("Conflicts")}:`));
			for (const conflict of plan.conflicts.slice(0, PREVIEW_LIMITS.COLLAPSED_LINES)) {
				const conflictPath = conflict.path ? `${sanitizeOneLine(conflict.path)}: ` : "";
				const conflictLine = `${conflictPath}${conflict.kind}: ${sanitizeOneLine(conflict.message)}`;
				lines.push(
					theme.fg(
						blockingConflict(conflict) ? "error" : "warning",
						truncateToWidth(conflictLine, width, Ellipsis.Unicode),
					),
				);
			}
			if (plan.conflicts.length > PREVIEW_LIMITS.COLLAPSED_LINES) {
				lines.push(
					theme.fg(
						"muted",
						tSettingsUi("… {count} more conflict(s)", {
							count: plan.conflicts.length - PREVIEW_LIMITS.COLLAPSED_LINES,
						}),
					),
				);
			}
		}
		const actions = this.#previewActions();
		for (let index = 0; index < actions.length; index += 1) {
			const action = actions[index]!;
			lines.push(renderOptionLine(previewActionLabel(action, plan, checkpoint), index === this.#previewActionIndex));
		}
		return lines;
	}

	#previewActions(): PreviewAction[] {
		const plan = this.#pendingPlan;
		if (!plan) return ["cancel"];
		if (plan.conflicts.some(blockingConflict)) return ["back", "cancel"];
		return ["apply", "back", "cancel"];
	}

	#renderStatusLine(width: number): string {
		const text = this.#statusMessage.length > 0 ? this.#statusMessage : this.#defaultStatusText();
		const decorated =
			this.#statusTone === "error"
				? theme.fg("error", `${theme.status.error} ${text}`)
				: this.#statusTone === "warning"
					? theme.fg("warning", `${theme.status.warning} ${text}`)
					: theme.fg("muted", text);
		return truncateToWidth(decorated, Math.max(1, width - 4), Ellipsis.Unicode, true);
	}

	#defaultStatusText(): string {
		if (this.#applying) return tSettingsUi("Applying restore…");
		if (this.#building) return tSettingsUi("Building restore preview…");
		if (this.#deps.isMutatorActive()) {
			return tSettingsUi("Active mutator: wait until the current tool finishes.");
		}
		if (this.#stage === "scope") return tSettingsUi("Pick the restore scope.");
		if (this.#stage === "preview") return tSettingsUi("Review the preview, then confirm the restore.");
		if (this.#allRows.length === 0) return tSettingsUi("No checkpoints recorded for this workspace yet.");
		if (this.#filteredRows.length === 0) return tSettingsUi("No matching checkpoints.");
		return tSettingsUi("Pick a checkpoint to inspect its restore preview.");
	}

	#renderHintLine(): string {
		const dot = theme.fg("dim", theme.sep.dot);
		return [
			rawKeyHint("↑↓", tSettingsUi("navigate")),
			rawKeyHint("enter", tSettingsUi("select")),
			rawKeyHint("esc", this.#stage === "list" ? tSettingsUi("cancel") : tSettingsUi("back")),
		].join(dot);
	}

	#refreshStatus(message?: string, tone: "muted" | "warning" | "error" = "muted"): void {
		this.#statusMessage = message ?? "";
		this.#statusTone = tone;
	}
	#cancelPendingPreview(): void {
		if (!this.#building) return;
		this.#previewGeneration += 1;
		this.#building = false;
	}

	async #buildPreview(checkpoint: WorkspaceCheckpointRecord, scope: RestoreScope): Promise<void> {
		if (this.#building || this.#applying) return;
		const generation = ++this.#previewGeneration;
		this.#building = true;
		this.#refreshStatus();
		this.#deps.requestRender();
		try {
			const preview = await this.#deps.preview(checkpoint.id, scope);
			if (generation !== this.#previewGeneration) return;
			if (!preview.available || !preview.value) {
				this.#refreshStatus(
					tSettingsUi("Cannot preview restore: {reason}", {
						reason: preview.reason ?? tSettingsUi("unavailable"),
					}),
					"error",
				);
				return;
			}
			this.#pendingCheckpoint = checkpoint;
			this.#pendingScope = scope;
			this.#pendingPlan = preview.value;
			this.#previewActionIndex = 0;
			this.#stage = "preview";
			this.#refreshStatus();
		} catch (error) {
			if (generation !== this.#previewGeneration) return;
			this.#refreshStatus(
				tSettingsUi("Cannot preview restore: {reason}", {
					reason: error instanceof Error ? error.message : String(error),
				}),
				"error",
			);
		} finally {
			if (generation === this.#previewGeneration) {
				this.#building = false;
				this.#deps.requestRender();
			}
		}
	}

	async #applyCurrent(): Promise<void> {
		const checkpoint = this.#pendingCheckpoint;
		const scope = this.#pendingScope;
		const plan = this.#pendingPlan;
		if (!checkpoint || !scope || !plan) {
			this.#refreshStatus(tSettingsUi("Restore preview is no longer available."), "error");
			return;
		}
		if (this.#applying) return;
		this.#applying = true;
		this.#refreshStatus();
		this.#deps.requestRender();
		try {
			const allowConflicts = plan.conflicts.length > 0;
			const resultEnvelope = await this.#deps.apply(plan.id, { allowConflicts });
			if (!resultEnvelope.available || !resultEnvelope.value) {
				this.#refreshStatus(
					tSettingsUi("Apply failed: {reason}", {
						reason: resultEnvelope.reason ?? tSettingsUi("unavailable"),
					}),
					"error",
				);
				return;
			}
			await this.#deps.onPick({ checkpoint, scope, plan, result: resultEnvelope.value });
		} catch (error) {
			this.#refreshStatus(
				tSettingsUi("Apply failed: {reason}", {
					reason: error instanceof Error ? error.message : String(error),
				}),
				"error",
			);
		} finally {
			this.#applying = false;
			this.#deps.requestRender();
		}
	}
}
