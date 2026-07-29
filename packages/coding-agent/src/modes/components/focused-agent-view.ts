import { type Component, matchesKey, padding, routeSgrMouseInput, ScrollView, visibleWidth } from "@oh-my-pi/pi-tui";
import type { KeyId } from "../../config/keybindings";
import { tSettingsUi } from "../../i18n/settings-locale";
import type { AgentRef, AgentRegistry } from "../../registry/agent-registry";
import type { AgentProgress } from "../../task";
import { renderCompactNestedTaskTree } from "../../task/render";
import { replaceTabs, truncateMiddleLines, truncateToWidth } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import {
	renderAgentActivityDisplay,
	renderAgentStatusBadge,
	selectAgentActivity,
	truncateAgentActivityLine,
} from "./agent-activity-display";
import { DynamicBorder } from "./dynamic-border";
import type { TranscriptContainer } from "./transcript-container";

const HEADER_CONTROL_GAP = 2;
const MIN_HEADER_IDENTITY_WIDTH = 24;
const HEADER_METADATA_GAP = 2;
const MAX_NESTED_TASK_LINES = 4;

export interface FocusedAgentViewDeps {
	agentId: string;
	registry: AgentRegistry;
	transcript: TranscriptContainer;
	getProgress: (id: string) => AgentProgress | undefined;
	getViewableAgentIds: () => string[];
	mainNeedsInput: () => boolean;
	nextKeys: KeyId[];
	previousKeys: KeyId[];
	expandKeys: KeyId[];
	onCycle: (direction: "next" | "previous") => void;
	onClose: () => void;
	onToggleExpanded: () => void;
	requestRender: () => void;
}

/** Fullscreen, read-only view over the live focused subagent transcript. */
export class FocusedAgentView implements Component {
	#agentId: string;
	#scrollView: ScrollView;
	#followBottom = true;

	constructor(private readonly deps: FocusedAgentViewDeps) {
		this.#agentId = deps.agentId;
		this.#scrollView = new ScrollView([], {
			height: 10,
			scrollbar: "always",
			theme: { track: text => theme.fg("dim", text), thumb: text => theme.fg("accent", text) },
		});
	}

	setAgentId(id: string): void {
		if (id === this.#agentId) return;
		this.#agentId = id;
		this.#followBottom = true;
		this.#scrollView.scrollToBottom();
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel === null) return false;
				this.#scrollView.scroll(event.wheel * 3);
				this.#syncFollow();
				this.deps.requestRender();
				return true;
			});
			return;
		}
		if (matchesKey(data, "escape")) {
			this.deps.onClose();
			return;
		}
		for (const key of this.deps.nextKeys) {
			if (!matchesKey(data, key)) continue;
			this.deps.onCycle("next");
			return;
		}
		for (const key of this.deps.previousKeys) {
			if (!matchesKey(data, key)) continue;
			this.deps.onCycle("previous");
			return;
		}
		for (const key of this.deps.expandKeys) {
			if (!matchesKey(data, key)) continue;
			this.deps.onToggleExpanded();
			return;
		}
		if (this.#handleScroll(data)) this.deps.requestRender();
	}

	render(width: number): readonly string[] {
		const terminalRows = process.stdout.rows || 40;
		const innerWidth = Math.max(1, width - 2);
		const ref = this.deps.registry.get(this.#agentId);
		const progress = this.deps.getProgress(this.#agentId);
		const titleContent = this.#title(ref);
		const hint = this.#hint();
		const hintWidth = visibleWidth(hint);
		const titleWidth = innerWidth - hintWidth - HEADER_CONTROL_GAP;
		const hintInHeader = titleWidth >= MIN_HEADER_IDENTITY_WIDTH;
		let header = truncateToWidth(titleContent, innerWidth);
		if (hintInHeader) {
			header = truncateToWidth(titleContent, titleWidth);
			header += `${padding(innerWidth - visibleWidth(header) - hintWidth)}${hint}`;
		}
		const detailLines = this.#headerDetails(ref, progress, innerWidth);
		const alert = this.deps.mainNeedsInput()
			? theme.fg("warning", tSettingsUi("Main needs input · Esc return"))
			: undefined;
		const footerLines = [
			...(alert ? [truncateToWidth(alert, innerWidth)] : []),
			...(!hintInHeader ? [truncateToWidth(hint, innerWidth)] : []),
		];
		const chromeRows = 4 + detailLines.length + footerLines.length;
		const viewportHeight = Math.max(3, terminalRows - chromeRows);
		const contentLines = this.deps.transcript.render(Math.max(1, width - 1));
		this.#scrollView.setLines(
			contentLines.length > 0 ? contentLines : [theme.fg("dim", tSettingsUi("No messages yet."))],
		);
		this.#scrollView.setHeight(viewportHeight);
		if (this.#followBottom) this.#scrollView.scrollToBottom();

		const border = new DynamicBorder().render(width);
		const lines: string[] = [...border, ` ${header}`];
		for (const detailLine of detailLines) lines.push(` ${truncateToWidth(detailLine, innerWidth)}`);
		lines.push(...border, ...this.#scrollView.render(width));
		for (const footerLine of footerLines) lines.push(` ${footerLine}`);
		lines.push(...border);
		return lines;
	}

	#title(ref: AgentRef | undefined): string {
		const ids = this.deps.getViewableAgentIds();
		const index = Math.max(0, ids.indexOf(this.#agentId));
		const ordinal = ids.length > 0 ? `${index + 1}/${ids.length}` : "1/1";
		const displayName = replaceTabs(ref?.displayName ?? this.#agentId);
		return [theme.fg("accent", `${tSettingsUi("Subagent")} ${ordinal}`), theme.bold(displayName)].join(theme.sep.dot);
	}

	#headerDetails(ref: AgentRef | undefined, progress: AgentProgress | undefined, width: number): string[] {
		const activity = selectAgentActivity(ref?.activityState, progress);
		const display = renderAgentActivityDisplay({ activity, progress, width });
		const lines = this.#alignHeaderFields(this.#metadata(ref, progress), display.statsLine, width);
		if (display.activityLine) lines.push(truncateAgentActivityLine(display.activityLine, width));
		lines.push(...this.#nestedTaskLines(progress, width));
		return lines;
	}

	#metadata(ref: AgentRef | undefined, progress: AgentProgress | undefined): string {
		const status = ref?.status ?? progress?.status ?? "running";
		const resolvedModel = progress?.resolvedModel;
		const liveModel = ref?.session?.model?.id;
		const thinking = ref?.session?.thinkingLevel;
		const model = replaceTabs(
			resolvedModel ??
				[liveModel, thinking && thinking !== "off" && thinking !== "inherit" ? thinking : ""]
					.filter(Boolean)
					.join(theme.sep.dot),
		);
		return [renderAgentStatusBadge(status), model ? theme.fg("muted", model) : ""]
			.filter(Boolean)
			.join(theme.sep.dot);
	}

	#alignHeaderFields(primary: string, secondary: string | undefined, width: number): string[] {
		const maxWidth = Math.max(1, width);
		const left = truncateToWidth(primary, maxWidth);
		if (!secondary) return [left];
		const leftWidth = visibleWidth(left);
		const rightWidth = visibleWidth(secondary);
		if (leftWidth + HEADER_METADATA_GAP + rightWidth <= maxWidth) {
			return [`${left}${padding(maxWidth - leftWidth - rightWidth)}${secondary}`];
		}
		return [left, truncateToWidth(secondary, maxWidth)];
	}

	#nestedTaskLines(progress: AgentProgress | undefined, width: number): string[] {
		if (!progress) return [];
		const lines = renderCompactNestedTaskTree(progress, theme);
		return truncateMiddleLines(lines, MAX_NESTED_TASK_LINES).map(line => truncateAgentActivityLine(line, width));
	}

	#hint(): string {
		const previous = this.deps.previousKeys[0] ?? "alt+k";
		const next = this.deps.nextKeys[0] ?? "alt+j";
		const expand = this.deps.expandKeys[0] ?? "ctrl+o";
		return theme.fg(
			"dim",
			tSettingsUi("{previous}:previous · {next}:next · Esc:Main · j/k:scroll · {expand}:expand", {
				previous,
				next,
				expand,
			}),
		);
	}

	#handleScroll(data: string): boolean {
		if (this.#scrollView.handleScrollKey(data)) {
			this.#syncFollow();
			return true;
		}
		if (matchesKey(data, "j") || matchesSelectDown(data)) {
			this.#scrollView.scroll(1);
		} else if (matchesKey(data, "k") || matchesSelectUp(data)) {
			this.#scrollView.scroll(-1);
		} else if (data === "g") {
			this.#scrollView.scrollToTop();
		} else if (data === "G") {
			this.#scrollView.scrollToBottom();
		} else {
			return false;
		}
		this.#syncFollow();
		return true;
	}

	#syncFollow(): void {
		this.#followBottom = this.#scrollView.getScrollOffset() >= this.#scrollView.getMaxScrollOffset();
	}
}
