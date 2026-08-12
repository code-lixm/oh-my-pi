import { Container, Text } from "@oh-my-pi/pi-tui";
import { tSettingsUi } from "../../i18n/settings-locale";
import { formatDiagnostics } from "../../tools/render-utils";
import {
	getOutputBlockBorderStyle,
	OUTPUT_BLOCK_ACCENT_GUTTER_WIDTH,
	OUTPUT_BLOCK_ACCENT_RIGHT_INSET,
	renderOutputAccentLine,
	renderOutputAccentPadLine,
} from "../../tui";
import { getLanguageFromPath, theme } from "../theme/theme";

/** One file's worth of late LSP diagnostics, as carried on the transcript message. */
export interface LateDiagnosticsFile {
	path?: string;
	summary?: string;
	errored?: boolean;
	messages?: string[];
}

/**
 * Renders late LSP diagnostics (arrived after edit/write returned) in the
 * transcript, reusing the same tree renderer the edit/write tools use so the
 * styling stays consistent. Supports the global tool-output expand toggle.
 */
export class LateDiagnosticsMessageComponent extends Container {
	#expanded = false;
	#toolActivityVisible = true;
	constructor(private readonly files: LateDiagnosticsFile[]) {
		super();
		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#rebuild();
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		this.invalidate();
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible) return [];
		if (getOutputBlockBorderStyle() !== "accent") return super.render(width);

		const safeWidth = Math.max(1, width);
		const innerWidth = Math.max(1, safeWidth - OUTPUT_BLOCK_ACCENT_GUTTER_WIDTH - OUTPUT_BLOCK_ACCENT_RIGHT_INSET);
		const body = super.render(innerWidth);
		if (body.length === 0) return body;

		const color = this.files.some(file => file.errored) ? "error" : "warning";
		return [
			renderOutputAccentPadLine(safeWidth, theme, color),
			...body.map(line => renderOutputAccentLine(line, safeWidth, theme, color)),
			renderOutputAccentPadLine(safeWidth, theme, color),
		];
	}

	#rebuild(): void {
		this.clear();

		const messages: string[] = [];
		const summaries: string[] = [];
		let errored = false;
		for (const file of this.files) {
			if (file.messages?.length) messages.push(...file.messages);
			if (file.summary) summaries.push(file.summary);
			if (file.errored) errored = true;
		}
		if (messages.length === 0) return;

		const text = formatDiagnostics(
			{ errored, summary: summaries.join(", "), messages },
			this.#expanded,
			theme,
			fp => theme.getLangIcon(getLanguageFromPath(fp)),
			{ title: tSettingsUi("Late diagnostics") },
		);
		const body = text.replace(/^\n+/, "");
		if (body) this.addChild(new Text(body, 1, 0));
	}
}
