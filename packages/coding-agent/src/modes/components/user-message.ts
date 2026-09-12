import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	type Component,
	Container,
	Image,
	type ImageBudget,
	ImageProtocol,
	Markdown,
	type MouseRoutable,
	type SgrMouseEvent,
	Spacer,
	TERMINAL,
} from "@oh-my-pi/pi-tui";
import { formatBytes, sanitizeText } from "@oh-my-pi/pi-utils";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { resolveImageOptions } from "../../tools/render-utils";
import { applyStableBackground } from "../../tui";
import { imageReferenceHyperlink, kittyTransmittableImage, renderPlaceholders } from "../image-references";
import { highlightMagicKeywords } from "../magic-keywords";

// OSC 133 shell integration: marks prompt zones for terminal multiplexers.
//
// The zone must be *closed* within the same render. `133;B` sets a sticky
// cursor semantic of `.input` in Ghostty (and Ghostty-derived terminals such
// as cmux) that only a command-start marker clears; leaving it latched makes
// `cursorIsAtPrompt()` permanently true and tags every subsequently painted
// cell as `.input`. Combined with `cursor-click-to-move = true` (Ghostty's
// default) that turns every left-click inside the pane into a burst of
// synthesized arrow keys on omp's pty, slamming the editor caret to column 0
// (#8030, #6115).
//
// `133;C` is therefore emitted immediately followed by `133;D;0` at the end of
// the bubble. That clears the input state without reintroducing the grouping
// problem the marker was originally omitted to avoid: the command zone opens
// and finishes inside this component, so later assistant/tool output can never
// be grouped under the first submitted prompt.
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_COMMAND_START = "\x1b]133;C\x07";
const OSC133_COMMAND_DONE = "\x1b]133;D;0\x07";
const OSC133_ZONE_CLOSE = OSC133_ZONE_END + OSC133_COMMAND_START + OSC133_COMMAND_DONE;

/**
 * Image-preview wiring for a submitted user prompt: the message's image parts plus
 * the host hooks a deferred render needs. Images render below the bubble through the
 * same terminal-graphics path as assistant and tool images, while the `[Image #N]`
 * markers in the bubble text stay the clickable, hyperlinked references.
 */
export interface UserMessageImagePreview {
	images: readonly ImageContent[];
	/** Shared TUI image budget (stable graphics ids + transmit-once). */
	budget?: ImageBudget;
	/** `terminal.showImages`; `false` leaves the markers as the whole representation. */
	visible?: boolean;
	/** Repaint hook for a late Kitty PNG conversion (non-PNG bytes convert async). */
	onImageUpdate?: () => void;
	/** Click target: open the original bytes in the host's viewer. */
	openImage?: (image: ImageContent) => void;
}

/** Per-instance preview identity, so {@link ImageBudget} hands back the same graphics
 *  ids when this component rebuilds its own preview block. */
let nextUserImagePreviewKey = 0;

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	// Memoized OSC 133 zone wrapping keyed on the underlying container render
	// (same source ref ⇒ identical rows ⇒ reuse the wrapped copy). Keeps this
	// component reference-stable for the transcript's incremental assembly and
	// never mutates the container's cached array.
	#zoneSource: readonly string[] | undefined;
	#zoneLines: string[] | undefined;
	#imagePreview: UserMessageImagePreview | undefined;
	#imageSlot: Container | undefined;
	readonly #previewKey: number;

	constructor(
		text: string,
		synthetic = false,
		imageLinks?: readonly (string | undefined)[],
		onOpenLink?: (href: string) => void,
		imagePreview?: UserMessageImagePreview,
	) {
		super();
		this.#previewKey = ++nextUserImagePreviewKey;
		// Paint magic keywords inside the rendered bubble, matching the live editor.
		// Markdown code spans and fenced blocks own their foreground styling; the bubble
		// background is reapplied separately so syntax resets cannot punch holes through it.
		const keywordReset = theme.getFgAnsi("userMessageText") || "\x1b[39m";
		const baseText = synthetic
			? (value: string) => theme.fg("dim", value)
			: (value: string) => theme.fg("userMessageText", highlightMagicKeywords(value, keywordReset));
		const imageLabel = (value: string) => theme.fg("accent", `\x1b[1m\x1b[4m${value}\x1b[24m\x1b[22m`);
		const color = (value: string) =>
			renderPlaceholders(value, {
				renderText: baseText,
				renderReference: (label, kind, index) =>
					kind === "image"
						? imageReferenceHyperlink(label, index, imageLinks, imageLabel)
						: theme.fg("accent", `\x1b[1m${label}\x1b[22m`),
			});
		const background = synthetic
			? undefined
			: (value: string) => applyStableBackground(value, theme.getBgAnsi("userMessageBg"));
		const padding = synthetic ? 0 : 1;
		const md = new Markdown(sanitizeText(text), padding, padding, getMarkdownTheme(), { color, bgColor: background });
		if (!synthetic) {
			md.setCodeBlockDisplayOptions({
				frame: false,
				cacheKey: "user-message:code-block:v1",
				getCollapsedBudget: () => Number.MAX_SAFE_INTEGER,
				expandKeyLabel: "",
				omitHintTemplate: "",
				plainPaddingX: 0,
			});
		}
		md.setIgnoreTight(true);
		if (onOpenLink) md.setLinkHandler(onOpenLink);
		this.addChild(md);
		if (!synthetic && imagePreview) {
			this.#imagePreview = imagePreview;
			this.#imageSlot = new Container();
			this.addChild(this.#imageSlot);
			this.#rebuildImagePreviews();
		}
	}

	/**
	 * (Re)build the preview block below the bubble. Runs at construction and again when
	 * a deferred Kitty PNG conversion lands; the converted bytes are cached on the image
	 * object, so rebuilds never re-encode.
	 */
	#rebuildImagePreviews(): void {
		const preview = this.#imagePreview;
		const slot = this.#imageSlot;
		if (!preview || !slot) return;
		slot.clear();
		// No image protocol (or images hidden): the `[Image #N]` marker is already the
		// whole representation, and the graphics text fallback would only restate it.
		if (preview.visible === false || !TERMINAL.imageProtocol) return;
		const images = preview.images.filter(image => image.data && image.mimeType);
		if (images.length === 0) return;
		slot.addChild(new Spacer(1));
		for (const [index, image] of images.entries()) {
			// Kitty's `f=100` transmit accepts only PNG; non-PNG sources report undefined
			// until the conversion lands, and the marker stays the fallback until then.
			const displayImage =
				TERMINAL.imageProtocol === ImageProtocol.Kitty
					? kittyTransmittableImage(image, () => this.#handlePreviewImageReady())
					: image;
			if (!displayImage) continue;
			const component = new Image(
				displayImage.data,
				displayImage.mimeType,
				{ fallbackColor: (value: string) => theme.fg("toolOutput", value) },
				{ ...resolveImageOptions(), budget: preview.budget, imageKey: `user:${this.#previewKey}:${index}` },
			);
			if (preview.openImage) component.setClickHandler(() => preview.openImage?.(image));
			slot.addChild(component);
		}
	}

	#handlePreviewImageReady(): void {
		this.#rebuildImagePreviews();
		this.#imagePreview?.onImageUpdate?.();
	}

	override render(width: number): readonly string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}
		if (this.#zoneSource === lines && this.#zoneLines !== undefined) {
			return this.#zoneLines;
		}
		const wrapped = lines.slice();
		wrapped[0] = OSC133_ZONE_START + wrapped[0];
		wrapped[wrapped.length - 1] = wrapped[wrapped.length - 1] + OSC133_ZONE_CLOSE;
		this.#zoneSource = lines;
		this.#zoneLines = wrapped;
		return wrapped;
	}
}

/**
 * Collapsed placeholder for a synthetic (agent-attributed) user input in the
 * file/remote-backed transcript viewer — chiefly the advisor's `Session update`
 * replay dumps, which can each be hundreds of KiB of Markdown and, on cold open,
 * blocked the TUI for tens of seconds while every historical body was laid out
 * before the viewport clip (issue #6308).
 *
 * Collapsed by default: renders one dim summary row (label · size · line count ·
 * expand hint) and builds NO Markdown. The heavy {@link UserMessageComponent} is
 * constructed lazily only when expanded via `ctrl+o`, so blocks above the
 * viewport never pay layout cost until the reader asks to see them. The raw
 * observability data stays intact in `__advisor.jsonl`.
 */
export class CollapsedSyntheticMessageComponent implements Component, MouseRoutable {
	#expanded = false;
	#cache?: { width: number; lines: readonly string[] };
	#body?: UserMessageComponent;
	readonly #summary: string;

	constructor(
		private readonly text: string,
		private readonly imageLinks?: readonly (string | undefined)[],
		private readonly onOpenLink?: (href: string) => void,
	) {
		this.#summary = summarizeSyntheticInput(text);
	}

	/** ctrl+o toggle: reveal/hide the full Markdown body. */
	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#cache = undefined;
	}

	invalidate(): void {
		this.#cache = undefined;
		this.#body?.invalidate?.();
	}

	dispose(): void {
		this.#body?.dispose?.();
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) return this.#cache.lines;
		const lines = this.#expanded ? this.#renderExpanded(width) : [` ${this.#summaryRow(width)}`];
		this.#cache = { width, lines };
		return lines;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): boolean | void {
		if (!this.#expanded || line <= 0 || !this.#body) return false;
		return this.#body.routeMouse(event, line - 1, col);
	}

	#renderExpanded(width: number): readonly string[] {
		if (!this.#body) this.#body = new UserMessageComponent(this.text, true, this.imageLinks, this.onOpenLink);
		return [` ${this.#summaryRow(width)}`, ...this.#body.render(width)];
	}

	#summaryRow(width: number): string {
		const hint = `${theme.sep.dot.trim()} ctrl+o`;
		return theme.fg("dim", truncateSummary(`${this.#summary} ${hint}`, Math.max(10, width - 1)));
	}
}

/** Truncate a plain summary label to `maxWidth` display columns, appending `…`. */
function truncateSummary(text: string, maxWidth: number): string {
	if (Bun.stringWidth(text, { countAnsiEscapeCodes: false }) <= maxWidth) return text;
	let out = "";
	let w = 0;
	for (const ch of text) {
		const cw = Bun.stringWidth(ch, { countAnsiEscapeCodes: false });
		if (w + cw > maxWidth - 1) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
}

/**
 * One-line summary for a collapsed synthetic input: `<label> · <size> · <n>
 * lines`. The label is the first Markdown heading's text (e.g. `Session
 * update`), falling back to `Synthetic input` when the body opens with none.
 */
function summarizeSyntheticInput(text: string): string {
	const size = formatBytes(Buffer.byteLength(text, "utf-8"));
	const lineCount = text === "" ? 0 : text.split("\n").length;
	const dot = theme.sep.dot.trim();
	return `${syntheticInputLabel(sanitizeText(text))} ${dot} ${size} ${dot} ${lineCount} line${lineCount === 1 ? "" : "s"}`;
}

/** First Markdown heading text in `text`, else `Synthetic input`. */
function syntheticInputLabel(text: string): string {
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		return heading ? heading[1]!.trim() || "Synthetic input" : "Synthetic input";
	}
	return "Synthetic input";
}
