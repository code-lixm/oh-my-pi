import { type Component, matchesKey, routeSgrMouseInput, ScrollView } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import { tSettingsUi } from "../../i18n/settings-locale";
import type { AgentRef, AgentRegistry } from "../../registry/agent-registry";
import type { AgentProgress } from "../../task";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";
import type { TranscriptContainer } from "./transcript-container";

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
			scrollbar: "auto",
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
		const innerWidth = Math.max(20, width - 2);
		const ref = this.deps.registry.get(this.#agentId);
		const progress = this.deps.getProgress(this.#agentId);
		const header = this.#header(ref, progress, innerWidth);
		const stats = this.#stats(progress, innerWidth);
		const alert = this.deps.mainNeedsInput()
			? theme.fg("warning", tSettingsUi("Main needs input · Esc return"))
			: undefined;
		const hint = this.#hint(innerWidth);
		const chromeRows = 6 + (alert ? 1 : 0);
		const viewportHeight = Math.max(3, terminalRows - chromeRows);
		const contentLines = this.deps.transcript.render(Math.max(1, width - 1));
		this.#scrollView.setLines(
			contentLines.length > 0 ? contentLines : [theme.fg("dim", tSettingsUi("No messages yet."))],
		);
		this.#scrollView.setHeight(viewportHeight);
		if (this.#followBottom) this.#scrollView.scrollToBottom();

		const border = new DynamicBorder().render(width);
		const lines: string[] = [...border, ` ${header}`, ...border, ...this.#scrollView.render(width)];
		if (alert) lines.push(` ${truncateToWidth(alert, innerWidth)}`);
		lines.push(` ${stats}`, ` ${hint}`, ...border);
		return lines;
	}

	#header(ref: AgentRef | undefined, progress: AgentProgress | undefined, width: number): string {
		const ids = this.deps.getViewableAgentIds();
		const index = Math.max(0, ids.indexOf(this.#agentId));
		const ordinal = ids.length > 0 ? `${index + 1}/${ids.length}` : "1/1";
		const displayName = replaceTabs(ref?.displayName ?? this.#agentId);
		const status = ref?.status ?? progress?.status ?? "running";
		const resolvedModel = progress?.resolvedModel;
		const liveModel = ref?.session?.model?.id;
		const thinking = ref?.session?.thinkingLevel;
		const modelLabel = replaceTabs(
			resolvedModel ??
				[liveModel, thinking && thinking !== "off" && thinking !== "inherit" ? thinking : ""]
					.filter(Boolean)
					.join(theme.sep.dot),
		);
		const content = [
			theme.fg("accent", `${tSettingsUi("Subagent")} ${ordinal}`),
			theme.bold(displayName),
			theme.fg(status === "aborted" ? "error" : status === "running" ? "success" : "muted", tSettingsUi(status)),
			modelLabel ? theme.fg("muted", modelLabel) : "",
		]
			.filter(Boolean)
			.join(theme.sep.dot);
		return truncateToWidth(content, width);
	}

	#stats(progress: AgentProgress | undefined, width: number): string {
		if (!progress) return theme.fg("dim", tSettingsUi("Waiting for progress…"));
		const parts: string[] = [];
		if (progress.retryState) {
			parts.push(
				theme.fg(
					"warning",
					tSettingsUi("retry {attempt}/{max} · {delay}", {
						attempt: progress.retryState.attempt,
						max: progress.retryState.maxAttempts,
						delay: formatDuration(progress.retryState.delayMs),
					}),
				),
			);
		} else if (progress.retryFailure) {
			parts.push(
				theme.fg("error", tSettingsUi("retry failed after {attempt}", { attempt: progress.retryFailure.attempt })),
			);
		} else if (progress.currentTool) {
			const toolElapsed = progress.currentToolStartMs ? Date.now() - progress.currentToolStartMs : 0;
			parts.push(
				theme.fg(
					"accent",
					`${replaceTabs(progress.currentTool)}${toolElapsed > 0 ? ` ${formatDuration(toolElapsed)}` : ""}`,
				),
			);
		}
		if (progress.tokensPerSecond && progress.tokensPerSecond > 0) {
			const label = `${progress.tokensPerSecond.toFixed(1)} tok/s`;
			parts.push(
				theme.fg(
					"statusLineOutput",
					progress.tokensPerSecondLive ? label : tSettingsUi("last {rate}", { rate: label }),
				),
			);
		}
		if (progress.durationMs > 0) parts.push(theme.fg("dim", formatDuration(progress.durationMs)));
		if (progress.tokens > 0) parts.push(theme.fg("dim", `${formatNumber(progress.tokens)} tok`));
		if (progress.contextTokens && progress.contextWindow) {
			parts.push(
				theme.fg(
					"dim",
					`ctx ${Math.min(999, Math.round((progress.contextTokens / progress.contextWindow) * 100))}%`,
				),
			);
		}
		if (progress.toolCount > 0) {
			parts.push(theme.fg("dim", tSettingsUi("{count} tools", { count: formatNumber(progress.toolCount) })));
		}
		if (progress.cost > 0) parts.push(theme.fg("statusLineCost", `$${progress.cost.toFixed(2)}`));
		if (parts.length === 0) parts.push(theme.fg("dim", tSettingsUi(progress.status)));
		while (parts.length > 1 && Bun.stringWidth(parts.join(theme.sep.dot)) > width) parts.pop();
		return truncateToWidth(parts.join(theme.sep.dot), width);
	}

	#hint(width: number): string {
		const previous = this.deps.previousKeys[0] ?? "alt+k";
		const next = this.deps.nextKeys[0] ?? "alt+j";
		const expand = this.deps.expandKeys[0] ?? "ctrl+o";
		return theme.fg(
			"dim",
			truncateToWidth(
				tSettingsUi("{previous}:previous · {next}:next · Esc:Main · j/k:scroll · {expand}:expand", {
					previous,
					next,
					expand,
				}),
				width,
			),
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
