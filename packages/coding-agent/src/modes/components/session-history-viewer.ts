import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	type Component,
	Input,
	matchesKey,
	padding,
	routeSgrMouseInput,
	ScrollView,
	type TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import { tSettingsUi } from "../../i18n/settings-locale";
import type { SessionMessageEntry } from "../../session/session-entries";
import { truncateToWidth } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { ChatTranscriptBuilder } from "./chat-transcript-builder";
import { DynamicBorder } from "./dynamic-border";
import { UserMessageComponent } from "./user-message";

export interface SessionHistoryViewerDeps {
	entries: SessionMessageEntry[];
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	getTerminalRows?: () => number;
	proseOnlyThinking?: () => boolean;
	requestRender: () => void;
	onClose: () => void;
	/** Forwarded to {@link ChatTranscriptBuilder} for Markdown link cells. */
	openLink?: (href: string) => void;
	/** Forwarded to {@link ChatTranscriptBuilder} for rendered image cells. */
	openImage?: (image: ImageContent) => void;
}

interface TurnAnchor {
	entryId: string;
	component: Component | undefined;
	fallbackComponent: Component | undefined;
}

const NON_WHITESPACE = /\S/;

function isRealUserTurn(entry: SessionMessageEntry): boolean {
	return entry.message.role === "user" && entry.message.synthetic !== true;
}

function hasRenderableUserContent(entry: SessionMessageEntry): boolean {
	const { message } = entry;
	if (message.role !== "user") return false;
	if (typeof message.content === "string") return message.content.length > 0;
	return message.content.some(block => block.type === "text" && block.text.length > 0);
}

function stripPlainBlankEdges(lines: readonly string[]): readonly string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && !NON_WHITESPACE.test(lines[start]!)) start++;
	while (end > start && !NON_WHITESPACE.test(lines[end - 1]!)) end--;
	return start === 0 && end === lines.length ? lines : lines.slice(start, end);
}

function searchableText(line: string): string {
	return Bun.stripANSI(sanitizeText(line)).toLowerCase();
}

/** Fullscreen, application-scrolled transcript for the active session branch. */
export class SessionHistoryViewer implements Component {
	#builder: ChatTranscriptBuilder;
	#turnAnchors: TurnAnchor[] = [];
	#turnOffsets = new Map<string, number>();
	#selectedTurnIndex = -1;
	#pendingTurnJump = false;
	#initialFollow = true;
	#searchInput = new Input();
	#searching = false;
	#searchQuery = "";
	#searchMatchRows: number[] = [];
	#activeMatchIndex = -1;
	#pendingSearchJump = false;
	#scrollView = new ScrollView([], {
		height: 10,
		scrollbar: "always",
		theme: { track: text => theme.fg("dim", text), thumb: text => theme.fg("accent", text) },
	});

	constructor(private readonly deps: SessionHistoryViewerDeps) {
		this.#builder = new ChatTranscriptBuilder({
			ui: deps.ui,
			getTool: deps.getTool,
			getMessageRenderer: deps.getMessageRenderer,
			cwd: deps.cwd,
			hideThinkingBlock: deps.hideThinkingBlock,
			proseOnlyThinking: deps.proseOnlyThinking,
			requestRender: deps.requestRender,
			openLink: deps.openLink,
			openImage: deps.openImage,
		});
		this.#builder.rebuild(deps.entries);
		const userComponents = this.#builder.container.children.filter(
			(child): child is UserMessageComponent => child instanceof UserMessageComponent,
		);
		let userComponentIndex = 0;
		let fallbackComponent: Component | undefined;
		for (const entry of deps.entries) {
			if (entry.message.role !== "user") continue;
			const component = hasRenderableUserContent(entry) ? userComponents[userComponentIndex++] : undefined;
			if (component) fallbackComponent = component;
			if (isRealUserTurn(entry)) this.#turnAnchors.push({ entryId: entry.id, component, fallbackComponent });
		}
		this.#selectedTurnIndex = this.#turnAnchors.length - 1;
		this.#searchInput.prompt = tSettingsUi("Search: ");
		this.#searchInput.onSubmit = value => {
			this.#searchQuery = value;
			this.#activeMatchIndex = -1;
			this.#pendingSearchJump = true;
			this.#searching = false;
			this.#searchInput.focused = false;
		};
		this.#searchInput.onEscape = () => this.#clearSearch();
	}

	dispose(): void {
		this.#searchInput.onSubmit = undefined;
		this.#searchInput.onEscape = undefined;
		this.#turnAnchors = [];
		this.#turnOffsets.clear();
		this.#searchMatchRows = [];
		this.#builder.dispose();
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel === null) return false;
				this.#scrollView.scroll(event.wheel * 3);
				this.#syncSelectedTurnToScroll();
				this.deps.requestRender();
				return true;
			});
			return;
		}

		if (matchesKey(data, "alt+k")) {
			this.#moveTurn(-1);
			return;
		}
		if (matchesKey(data, "alt+j")) {
			this.#moveTurn(1);
			return;
		}

		if (this.#searching) {
			this.#searchInput.handleInput(data);
			this.deps.requestRender();
			return;
		}

		if (matchesKey(data, "escape")) {
			if (this.#searchQuery) {
				this.#clearSearch();
				this.deps.requestRender();
				return;
			}
			this.deps.onClose();
			return;
		}
		if (data === "/") {
			this.#searching = true;
			this.#searchInput.focused = true;
			this.#searchInput.setValue(this.#searchQuery);
			this.deps.requestRender();
			return;
		}
		if (data === "n" && this.#searchQuery) {
			this.#moveSearchMatch(1);
			return;
		}
		if (data === "N" && this.#searchQuery) {
			this.#moveSearchMatch(-1);
			return;
		}
		if (this.#scrollView.handleScrollKey(data)) {
			this.#syncSelectedTurnToScroll();
			this.deps.requestRender();
			return;
		}
		if (matchesKey(data, "j") || matchesSelectDown(data)) {
			this.#scrollView.scroll(1);
			this.#syncSelectedTurnToScroll();
		} else if (matchesKey(data, "k") || matchesSelectUp(data)) {
			this.#scrollView.scroll(-1);
			this.#syncSelectedTurnToScroll();
		} else if (data === "g") {
			this.#scrollView.scrollToTop();
			this.#selectedTurnIndex = this.#turnAnchors.length > 0 ? 0 : -1;
		} else if (data === "G") {
			this.#scrollView.scrollToBottom();
			this.#selectedTurnIndex = this.#turnAnchors.length - 1;
		} else {
			return;
		}
		this.deps.requestRender();
	}

	render(width: number): readonly string[] {
		const contentWidth = Math.max(1, width - 1);
		const transcriptLines = this.#renderTranscript(contentWidth);
		this.#updateSearchMatches(transcriptLines, this.#builder.isEmpty);
		const controls = this.#renderControls(width);
		const terminalRows = this.deps.getTerminalRows?.() ?? process.stdout.rows ?? 40;
		const viewportHeight = Math.max(1, terminalRows - (4 + controls.length));
		this.#scrollView.setLines(transcriptLines);
		this.#scrollView.setHeight(viewportHeight);
		this.#applyPendingNavigation();

		const title = theme.bold(theme.fg("accent", tSettingsUi("Session history")));
		const hint = theme.fg(
			"dim",
			tSettingsUi("Esc:close  j/k:scroll  Alt+J/K:turn  /:search  n/N:match  g/G:top/bottom"),
		);
		const headerWidth = Math.max(1, width - 2);
		const hintWidth = Math.max(headerWidth - visibleWidth(title) - 2, 0);
		const visibleHint = hintWidth > 0 ? truncateToWidth(hint, hintWidth) : "";
		const header = visibleHint
			? `${title}${padding(headerWidth - visibleWidth(title) - visibleWidth(visibleHint))}${visibleHint}`
			: truncateToWidth(title, headerWidth);

		return [
			...new DynamicBorder().render(width),
			` ${header}`,
			...controls,
			...new DynamicBorder().render(width),
			...this.#scrollView.render(width),
			...new DynamicBorder().render(width),
		];
	}

	#renderTranscript(contentWidth: number): readonly string[] {
		if (this.#builder.isEmpty) {
			const offsets = new Map<string, number>();
			for (const anchor of this.#turnAnchors) offsets.set(anchor.entryId, 0);
			this.#turnOffsets = offsets;
			return [` ${theme.fg("dim", tSettingsUi("No history yet"))}`];
		}
		const lines = this.#builder.container.render(contentWidth);
		this.#recomputeTurnOffsets(contentWidth, lines.length);
		return lines;
	}

	#recomputeTurnOffsets(contentWidth: number, lineCount: number): void {
		const starts = new Map<Component, number>();
		const ends = new Map<Component, number>();
		let row = 0;
		for (const child of this.#builder.container.children) {
			const contribution = stripPlainBlankEdges(child.render(contentWidth));
			if (contribution.length === 0) continue;
			if (row > 0) row++;
			starts.set(child, row);
			row += contribution.length;
			ends.set(child, row);
		}

		const offsets = new Map<string, number>();
		for (const anchor of this.#turnAnchors) {
			const offset =
				(anchor.component === undefined ? undefined : starts.get(anchor.component)) ??
				(anchor.fallbackComponent === undefined ? undefined : ends.get(anchor.fallbackComponent)) ??
				0;
			offsets.set(anchor.entryId, Math.max(0, Math.min(offset, lineCount)));
		}
		this.#turnOffsets = offsets;
	}

	#updateSearchMatches(lines: readonly string[], isEmpty: boolean): void {
		const query = searchableText(this.#searchQuery);
		const matches: number[] = [];
		if (query && !isEmpty) {
			for (let row = 0; row < lines.length; row++) {
				if (searchableText(lines[row]!).includes(query)) matches.push(row);
			}
		}
		this.#searchMatchRows = matches;
		if (this.#pendingSearchJump) {
			this.#activeMatchIndex = matches.length > 0 ? 0 : -1;
			return;
		}
		if (this.#activeMatchIndex >= matches.length) this.#activeMatchIndex = matches.length - 1;
	}

	#renderControls(width: number): string[] {
		const innerWidth = Math.max(1, width - 1);
		const controls: string[] = [];
		if (this.#searching) {
			controls.push(` ${this.#searchInput.render(innerWidth)[0] ?? ""}`);
		}
		const status = this.#searchStatus();
		if (status) controls.push(` ${truncateToWidth(status, innerWidth)}`);
		return controls;
	}

	#searchStatus(): string | undefined {
		if (!this.#searchQuery) return undefined;
		const query = tSettingsUi("Search: {query}", { query: this.#searchQuery });
		if (this.#searchMatchRows.length === 0) return `${query} ${theme.fg("dim", tSettingsUi("No matches"))}`;
		const ordinal = Math.max(0, this.#activeMatchIndex) + 1;
		return `${query} ${theme.fg("dim", `${tSettingsUi("match")} ${ordinal}/${this.#searchMatchRows.length}`)}`;
	}

	#applyPendingNavigation(): void {
		if (this.#initialFollow) {
			this.#scrollView.scrollToBottom();
			this.#initialFollow = false;
		}
		if (this.#pendingTurnJump) {
			const anchor = this.#turnAnchors[this.#selectedTurnIndex];
			const offset = anchor ? this.#turnOffsets.get(anchor.entryId) : undefined;
			if (offset !== undefined) this.#scrollView.setScrollOffset(offset);
			this.#pendingTurnJump = false;
		}
		if (!this.#pendingSearchJump) return;
		const offset = this.#activeMatchIndex >= 0 ? this.#searchMatchRows[this.#activeMatchIndex] : undefined;
		if (offset !== undefined) this.#scrollView.setScrollOffset(offset);
		this.#pendingSearchJump = false;
	}

	#moveTurn(delta: -1 | 1): void {
		if (this.#turnAnchors.length === 0) return;
		const current = this.#selectedTurnIndex < 0 ? this.#turnAnchors.length - 1 : this.#selectedTurnIndex;
		const next = Math.max(0, Math.min(this.#turnAnchors.length - 1, current + delta));
		if (next === current) return;
		this.#selectedTurnIndex = next;
		this.#pendingTurnJump = true;
		this.deps.requestRender();
	}

	#syncSelectedTurnToScroll(): void {
		if (this.#turnAnchors.length === 0 || this.#turnOffsets.size === 0) return;
		const offset = this.#scrollView.getScrollOffset();
		let selected = 0;
		for (let index = 0; index < this.#turnAnchors.length; index++) {
			const anchorOffset = this.#turnOffsets.get(this.#turnAnchors[index]!.entryId);
			if (anchorOffset === undefined || anchorOffset > offset) break;
			selected = index;
		}
		this.#selectedTurnIndex = selected;
	}

	#clearSearch(): void {
		this.#searching = false;
		this.#searchInput.focused = false;
		this.#searchInput.setValue("");
		this.#searchQuery = "";
		this.#searchMatchRows = [];
		this.#activeMatchIndex = -1;
		this.#pendingSearchJump = false;
	}

	#moveSearchMatch(delta: -1 | 1): void {
		const count = this.#searchMatchRows.length;
		if (count === 0) {
			this.deps.requestRender();
			return;
		}
		if (this.#activeMatchIndex < 0) {
			this.#activeMatchIndex = delta < 0 ? count - 1 : 0;
		} else {
			this.#activeMatchIndex = (this.#activeMatchIndex + delta + count) % count;
		}
		const offset = this.#searchMatchRows[this.#activeMatchIndex];
		if (offset !== undefined) this.#scrollView.setScrollOffset(offset);
		this.deps.requestRender();
	}
}
