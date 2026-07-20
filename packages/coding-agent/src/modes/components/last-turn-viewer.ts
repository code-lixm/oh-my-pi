import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Component, matchesKey, routeSgrMouseInput, ScrollView, type TUI } from "@oh-my-pi/pi-tui";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import { tSettingsUi } from "../../i18n/settings-locale";
import type { SessionMessageEntry } from "../../session/session-entries";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { ChatTranscriptBuilder } from "./chat-transcript-builder";
import { DynamicBorder } from "./dynamic-border";

export interface LastTurnViewerDeps {
	entries: SessionMessageEntry[];
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	requestRender: () => void;
	onClose: () => void;
}

/** Read-only fullscreen view of the latest user turn in the active session. */
export class LastTurnViewer implements Component {
	#builder: ChatTranscriptBuilder;
	#scrollView = new ScrollView([], {
		height: 10,
		scrollbar: "auto",
		theme: { track: text => theme.fg("dim", text), thumb: text => theme.fg("accent", text) },
	});

	constructor(private readonly deps: LastTurnViewerDeps) {
		this.#builder = new ChatTranscriptBuilder({
			ui: deps.ui,
			getTool: deps.getTool,
			getMessageRenderer: deps.getMessageRenderer,
			cwd: deps.cwd,
			hideThinkingBlock: deps.hideThinkingBlock,
			proseOnlyThinking: deps.proseOnlyThinking,
			requestRender: deps.requestRender,
		});
		this.#builder.rebuild(deps.entries);
	}

	dispose(): void {
		this.#builder.dispose();
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel === null) return false;
				this.#scrollView.scroll(event.wheel * 3);
				this.deps.requestRender();
				return true;
			});
			return;
		}
		if (matchesKey(data, "escape")) {
			this.deps.onClose();
			return;
		}
		if (this.#scrollView.handleScrollKey(data)) {
			this.deps.requestRender();
			return;
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
			return;
		}
		this.deps.requestRender();
	}

	render(width: number): readonly string[] {
		const header = tSettingsUi("Last turn");
		const footer = tSettingsUi("Esc:close  j/k:scroll  g/G:top/bottom");
		const viewportHeight = Math.max(3, (process.stdout.rows || 40) - 5);
		const contentWidth = Math.max(1, width - 1);
		this.#scrollView.setLines(this.#builder.container.render(contentWidth));
		this.#scrollView.setHeight(viewportHeight);

		return [
			...new DynamicBorder().render(width),
			` ${theme.bold(theme.fg("accent", header))}`,
			...new DynamicBorder().render(width),
			...this.#scrollView.render(width),
			` ${theme.fg("dim", footer)}`,
			...new DynamicBorder().render(width),
		];
	}
}
