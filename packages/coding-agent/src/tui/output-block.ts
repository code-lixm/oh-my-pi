/**
 * Bordered output container with optional header and sections.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import {
	anchorRightBorder,
	ImageProtocol,
	padding,
	sliceByColumn,
	TERMINAL,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { theme as activeTheme, getThemeEpoch, type Theme, type ThemeColor } from "../modes/theme/theme";
import { getSixelLineMask } from "../utils/sixel";
import type { State } from "./types";
import type { RenderCache } from "./utils";
import { getStateBgColor, getTreeContinuePrefix, Hasher, padToWidth, truncateToWidth } from "./utils";

export interface OutputBlockOptions {
	header?: string;
	headerMeta?: string;
	state?: State;
	sections?: Array<{ label?: string; lines: readonly string[]; separator?: boolean }>;
	width: number;
	applyBg?: boolean;
	/** Accent-mode surface tint strength. Omit for the standard subtle tool-card tint. */
	accentTintOpacity?: number;
	contentPaddingLeft?: number;
	/** Override the state-derived border color. Used for muted "legacy" tool
	 * frames that should not visually compete with framed-output tools. */
	borderColor?: ThemeColor;
	/** Per-block layout override. Omit to use the configured global style. */
	borderStyle?: OutputBlockBorderStyle;
}

const FRAMED_BLOCK_COMPONENT = Symbol("framedBlockComponent");

export type OutputBlockBorderStyle = "full" | "none" | "accent";

/** Width reserved for the half-cell accent glyph plus one plain gap. */
export const OUTPUT_BLOCK_ACCENT_GUTTER_WIDTH = 2;
/** Keep accent surfaces one cell shy of the terminal edge. */
export const OUTPUT_BLOCK_ACCENT_RIGHT_INSET = 1;
export const OUTPUT_BLOCK_ACCENT_GLYPH = "▌";

/** Opacity shared by accent content and edge padding so the card has one surface tone. */
export const ACCENT_PAD_TINT_OPACITY = 0.06;
/** Layout modes whose surface draws no box frame. `accent` uses a half-cell
 * `▌` glyph over a translucent-looking tint derived from the same semantic
 * color; `none` stays bare. */
const BORDERLESS_OUTPUT_STYLES: Record<OutputBlockBorderStyle, boolean> = {
	full: false,
	none: true,
	accent: true,
};

export function isBorderlessOutputStyle(style: OutputBlockBorderStyle): boolean {
	return BORDERLESS_OUTPUT_STYLES[style];
}

let outputBlockBorderStyle: OutputBlockBorderStyle = "accent";

export function setOutputBlockBorderStyle(style: OutputBlockBorderStyle): void {
	outputBlockBorderStyle = style;
}
export function getOutputBlockBorderStyle(): OutputBlockBorderStyle {
	return outputBlockBorderStyle;
}

/** Keep observation surfaces bare under the accent layout while preserving explicit full/none selections. */
export function resolveBareOutputBlockBorderStyle(): OutputBlockBorderStyle {
	return outputBlockBorderStyle === "accent" ? "none" : outputBlockBorderStyle;
}

/**
 * Borderless output layouts use Markdown's borderless table layout so tables
 * mirror their surrounding blocks instead of reintroducing a container frame.
 */
export function resolveMarkdownTableBorderStyle(style: OutputBlockBorderStyle): "full" | "none" {
	return style === "full" ? "full" : "none";
}

export type FramedBlockComponent = Component & { [FRAMED_BLOCK_COMPONENT]?: true };

export function markFramedBlockComponent<T extends Component>(component: T): T & FramedBlockComponent {
	(component as T & FramedBlockComponent)[FRAMED_BLOCK_COMPONENT] = true;
	return component as T & FramedBlockComponent;
}

export function isFramedBlockComponent(component: Component): boolean {
	return (component as FramedBlockComponent)[FRAMED_BLOCK_COMPONENT] === true;
}

type BlockRow =
	| { kind: "bar"; leftChar: string; rightChar: string; label?: string; meta?: string }
	| { kind: "bottom"; leftChar: string; rightChar: string }
	| { kind: "content"; inner: string }
	| { kind: "sixel"; raw: string };

function normalizeContentPaddingLeft(value: number | undefined, borderStyle: OutputBlockBorderStyle): number {
	if (value === undefined || !Number.isFinite(value)) {
		return borderStyle === "accent" ? 0 : isBorderlessOutputStyle(borderStyle) ? 2 : 1;
	}
	return Math.max(0, Math.floor(value));
}

/**
 * Content width used by {@link renderOutputBlock}. Full borders reserve one
 * outer-left gutter cell plus one cell on each side of the inner frame;
 * `none` uses a two-cell content indent; `accent` reserves its painted-space
 * rail and gap independently from optional content padding. Renderers that
 * size a tail window MUST use this helper so their visual-row budget matches
 * the active layout.
 */
export function outputBlockContentWidth(
	width: number,
	contentPaddingLeft?: number,
	borderStyle: OutputBlockBorderStyle = outputBlockBorderStyle,
): number {
	const outerLeftGutter = borderStyle === "full" && width > 0 ? 1 : 0;
	const borderWidth = borderStyle === "full" ? 2 : 0;
	const accentGutterWidth = borderStyle === "accent" ? OUTPUT_BLOCK_ACCENT_GUTTER_WIDTH : 0;
	const accentRightInset = borderStyle === "accent" ? OUTPUT_BLOCK_ACCENT_RIGHT_INSET : 0;
	return Math.max(
		1,
		width -
			outerLeftGutter -
			borderWidth -
			accentGutterWidth -
			accentRightInset -
			normalizeContentPaddingLeft(contentPaddingLeft, borderStyle),
	);
}

/** Keep a background fill active across nested SGR resets in styled content. */
export function applyStableBackground(text: string, bgAnsi: string): string {
	const stabilized = text
		.replace(/\x1b\[(?:0)?m/g, match => `${match}${bgAnsi}`)
		.replace(/\x1b\[49m/g, match => `${match}${bgAnsi}`);
	return `${bgAnsi}${stabilized}\x1b[49m`;
}

/**
 * Prefix one row with a half-cell `▌` accent glyph. The body background is a
 * low-opacity preblend of the same semantic color over the theme surface.
 */
export function renderOutputAccentLine(
	line: string,
	width: number,
	theme: Theme,
	color: ThemeColor,
	tintOpacity = 0.06,
): string {
	const surfaceWidth = Math.max(0, width - OUTPUT_BLOCK_ACCENT_RIGHT_INSET);
	const rightInset = padding(Math.min(width, OUTPUT_BLOCK_ACCENT_RIGHT_INSET));
	if (surfaceWidth === 0) return rightInset;
	const tintedBgAnsi = theme.getSurfaceTintBgAnsi(color, tintOpacity);
	const railFgAnsi = color === "borderMuted" ? theme.getSurfaceTintFgAnsi(color) : theme.getFgAnsi(color);
	const rail = applyStableBackground(`${railFgAnsi}${OUTPUT_BLOCK_ACCENT_GLYPH}\x1b[39m`, tintedBgAnsi);
	if (surfaceWidth === 1) return `${rail}${rightInset}`;
	const contentWidth = Math.max(0, surfaceWidth - OUTPUT_BLOCK_ACCENT_GUTTER_WIDTH);
	const content = contentWidth > 0 ? padToWidth(truncateToWidth(line, contentWidth), contentWidth) : "";
	const tintedBody = applyStableBackground(` ${content}`, tintedBgAnsi);
	return `${rail}${tintedBody}${rightInset}`;
}

/**
 * Render a block-internal padding row (leading or trailing breathing row
 * inside an accent card). The rail glyph and ANSI prefix match
 * `renderOutputAccentLine` so block edges stay visually anchored, but the
 * tinted surface background drops to a near-zero opacity so the row reads as
 * part of the margin rather than a second tinted block — small intra-card
 * padding. Inter-block plain margins remain owned by the transcript
 * container.
 */
export function renderOutputAccentPadLine(width: number, theme: Theme, color: ThemeColor): string {
	const surfaceWidth = Math.max(0, width - OUTPUT_BLOCK_ACCENT_RIGHT_INSET);
	const rightInset = padding(Math.min(width, OUTPUT_BLOCK_ACCENT_RIGHT_INSET));
	if (surfaceWidth === 0) return rightInset;
	const tintedBgAnsi = theme.getSurfaceTintBgAnsi(color, ACCENT_PAD_TINT_OPACITY);
	const railFgAnsi = color === "borderMuted" ? theme.getSurfaceTintFgAnsi(color) : theme.getFgAnsi(color);
	const rail = applyStableBackground(`${railFgAnsi}${OUTPUT_BLOCK_ACCENT_GLYPH}\x1b[39m`, tintedBgAnsi);
	if (surfaceWidth === 1) return `${rail}${rightInset}`;
	const contentWidth = Math.max(0, surfaceWidth - OUTPUT_BLOCK_ACCENT_GUTTER_WIDTH);
	const tintedBody = applyStableBackground(` ${" ".repeat(contentWidth)}`, tintedBgAnsi);
	return `${rail}${tintedBody}${rightInset}`;
}

export function renderOutputBlock(options: OutputBlockOptions, theme: Theme): string[] {
	const { header, headerMeta, state, sections = [], width } = options;
	const applyBg = options.applyBg ?? false;
	const borderStyle = options.borderStyle ?? outputBlockBorderStyle;
	const borderless = isBorderlessOutputStyle(borderStyle);
	const accentMode = borderStyle === "accent";
	const h = theme.boxRound.horizontal;
	const v = theme.boxRound.vertical;
	const cap = h;
	const lineWidth = Math.max(0, width);
	// Border colors remain semantic while pending/running blocks stay unfilled;
	// callers can still opt into state backgrounds through `applyBg`.
	const borderColor: ThemeColor =
		options.borderColor ?? (state === "error" ? "error" : state === "warning" ? "warning" : "borderMuted");
	const border = (text: string) => theme.fg(borderColor, text);
	const bgFn = (() => {
		if (!state || !applyBg) return undefined;
		const bgAnsi = theme.getBgAnsi(getStateBgColor(state));
		return (text: string) => applyStableBackground(text, bgAnsi);
	})();

	const outerLeftGutter = borderStyle === "full" && lineWidth > 0 ? 1 : 0;
	const frameLineWidth = Math.max(0, lineWidth - outerLeftGutter);
	const contentPaddingLeft = normalizeContentPaddingLeft(options.contentPaddingLeft, borderStyle);
	const borderWidth = borderStyle === "full" ? visibleWidth(v) * 2 : 0;
	const accentGutterWidth = accentMode ? OUTPUT_BLOCK_ACCENT_GUTTER_WIDTH : 0;
	const accentRightInset = accentMode ? OUTPUT_BLOCK_ACCENT_RIGHT_INSET : 0;
	const contentWidth = Math.max(
		0,
		frameLineWidth - borderWidth - accentGutterWidth - accentRightInset - contentPaddingLeft,
	);
	const contentLeftPadding = contentPaddingLeft > 0 ? padding(contentPaddingLeft) : "";
	const outerLeftPadding = outerLeftGutter > 0 ? padding(outerLeftGutter) : "";

	if (borderless) {
		const lines: string[] = [];
		const borderlessLineWidth = Math.max(0, lineWidth - accentGutterWidth - accentRightInset);
		// Block-internal padding rows render with the same tinted surface as the
		// body, but the rail glyph uses the low-emphasis surface tint foreground
		// instead of the full semantic color — visually lighter so the leading
		// and trailing breathing rows read as part of the margin rather than a
		// second tinted block. Inter-block plain margins remain owned by the
		// transcript container.
		const pushLine = (line: string): void => {
			if (accentMode) {
				if (line === "") {
					lines.push(renderOutputAccentPadLine(lineWidth, theme, borderColor));
					return;
				}
				lines.push(renderOutputAccentLine(line, lineWidth, theme, borderColor, options.accentTintOpacity));
				return;
			}
			lines.push(padToWidth(truncateToWidth(line, lineWidth), lineWidth, bgFn));
		};
		const pushContent = (line: string, prefix: string, alignTreeRoot: boolean): void => {
			const plain = Bun.stripANSI(line);
			const treePrefixes = [
				{ glyph: theme.tree.branch, isLast: false },
				{ glyph: theme.tree.last, isLast: true },
			];
			const tree = treePrefixes.find(candidate => plain.startsWith(`${candidate.glyph} `));
			const rootAligned =
				alignTreeRoot &&
				(tree !== undefined ||
					plain.startsWith(getTreeContinuePrefix(false, theme)) ||
					plain.startsWith(getTreeContinuePrefix(true, theme)));
			const effectivePrefix = rootAligned ? "" : prefix;
			const availableWidth = Math.max(1, borderlessLineWidth - visibleWidth(effectivePrefix));
			if (tree) {
				const branchWidth = visibleWidth(`${tree.glyph} `);
				const afterBranch = plain.slice(`${tree.glyph} `.length);
				let hangingWidth = branchWidth;
				for (const checkbox of [theme.checkbox.checked, theme.checkbox.unchecked]) {
					if (afterBranch.startsWith(`${checkbox} `)) {
						hangingWidth += visibleWidth(`${checkbox} `);
						break;
					}
				}
				if (hangingWidth < availableWidth) {
					const head = sliceByColumn(line, 0, hangingWidth, true);
					const body = sliceByColumn(line, hangingWidth, Math.max(0, visibleWidth(line) - hangingWidth), true);
					const wrapped = wrapTextWithAnsi(body, Math.max(1, availableWidth - hangingWidth));
					const continuation = tree.isLast
						? padding(hangingWidth)
						: `${theme.fg("dim", getTreeContinuePrefix(false, theme))}${padding(
								Math.max(0, hangingWidth - branchWidth),
							)}`;
					pushLine(`${effectivePrefix}${head}${wrapped[0] ?? ""}`);
					for (let i = 1; i < wrapped.length; i++) pushLine(`${effectivePrefix}${continuation}${wrapped[i]}`);
					return;
				}
			}
			const wrapped = wrapTextWithAnsi(line.trimEnd(), availableWidth);
			if (wrapped.length === 0) {
				pushLine(effectivePrefix);
				return;
			}
			for (const wrappedLine of wrapped) pushLine(`${effectivePrefix}${wrappedLine}`);
		};

		const title = [header, headerMeta].filter(Boolean).join(theme.sep.dot);
		const normalizedSections = sections.length > 0 ? sections : [{ lines: [] as string[] }];
		// Drop the leading accent pad so the title hugs the top of the card;
		// a title-vs-body breathing row replaces the old top pad.
		if (title) pushLine(title);
		const hasBody = normalizedSections.some(section => section.label !== undefined || section.lines.length > 0);
		if (accentMode && hasBody) pushLine("");
		let lastLabeledSection = -1;
		for (let i = 0; i < normalizedSections.length; i++) {
			if (normalizedSections[i]!.label) lastLabeledSection = i;
		}
		for (let sectionIndex = 0; sectionIndex < normalizedSections.length; sectionIndex++) {
			const section = normalizedSections[sectionIndex]!;
			let linePrefix = contentLeftPadding;
			if (section.label) {
				const isLast = sectionIndex === lastLabeledSection;
				const branch = isLast ? theme.tree.last : theme.tree.branch;
				pushLine(`${contentLeftPadding}${border(branch)} ${section.label}`);
				linePrefix = `${contentLeftPadding}${border(getTreeContinuePrefix(isLast, theme))}`;
			} else if (section.separator && sectionIndex > 0 && lines.length > 0) {
				pushLine("");
			}

			const allLines = section.lines.flatMap(line => line.split("\n"));
			const sixelLineMask = TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(allLines) : undefined;
			const sectionHasRootTree = allLines.some(line => {
				const plain = Bun.stripANSI(line);
				return plain.startsWith(`${theme.tree.branch} `) || plain.startsWith(`${theme.tree.last} `);
			});
			for (let lineIndex = 0; lineIndex < allLines.length; lineIndex++) {
				const line = allLines[lineIndex]!;
				if (sixelLineMask?.[lineIndex]) {
					lines.push(line);
					continue;
				}
				pushContent(line, linePrefix, !section.label && sectionHasRootTree);
			}
		}
		if (accentMode && (hasBody || title)) pushLine("");
		return lines;
	}

	// ── Layout pass: collect row descriptors before emitting the bordered lines. ──
	const rows: BlockRow[] = [];
	rows.push({
		kind: "bar",
		leftChar: theme.boxRound.topLeft,
		rightChar: theme.boxRound.topRight,
		label: header,
		meta: headerMeta,
	});

	const normalizedSections = sections.length > 0 ? sections : [{ lines: [] as string[] }];
	for (let sectionIndex = 0; sectionIndex < normalizedSections.length; sectionIndex++) {
		const section = normalizedSections[sectionIndex]!;
		// A labeled section always draws its titled separator bar. A label-less
		// section can still request a plain divider via `separator`, but only
		// between sections — leading with one would just double the header bar.
		if (section.label) {
			rows.push({
				kind: "bar",
				leftChar: theme.boxRound.teeRight,
				rightChar: theme.boxRound.teeLeft,
				label: section.label,
			});
		} else if (section.separator && sectionIndex > 0) {
			rows.push({
				kind: "bar",
				leftChar: theme.boxRound.teeRight,
				rightChar: theme.boxRound.teeLeft,
			});
		}
		const allLines = section.lines.flatMap(l => l.split("\n"));
		const sixelLineMask = TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(allLines) : undefined;
		for (let lineIndex = 0; lineIndex < allLines.length; lineIndex++) {
			const line = allLines[lineIndex]!;
			if (sixelLineMask?.[lineIndex]) {
				rows.push({ kind: "sixel", raw: line });
				continue;
			}
			const wrappedLines = wrapTextWithAnsi(line.trimEnd(), contentWidth);
			for (const wrappedLine of wrappedLines) {
				const innerPadding = padding(Math.max(0, contentWidth - visibleWidth(wrappedLine)));
				rows.push({ kind: "content", inner: `${wrappedLine}${innerPadding}` });
			}
		}
	}

	rows.push({ kind: "bottom", leftChar: theme.boxRound.bottomLeft, rightChar: theme.boxRound.bottomRight });

	const H = rows.length;

	const renderBar = (row: { leftChar: string; rightChar: string; label?: string; meta?: string }): string => {
		const leftGlyphs = `${row.leftChar}${cap}`;
		const rightGlyph = row.rightChar;
		if (frameLineWidth <= 0) return border(leftGlyphs) + border(rightGlyph);
		const labelText = [row.label, row.meta].filter(Boolean).join(theme.sep.dot);
		if (!labelText) {
			const fillCount = Math.max(0, frameLineWidth - visibleWidth(leftGlyphs) - visibleWidth(rightGlyph));
			return `${border(leftGlyphs)}${border(h.repeat(fillCount))}${border(rightGlyph)}`;
		}
		const rawLabel = ` ${labelText} `;
		const leftWidth = visibleWidth(leftGlyphs);
		const rightWidth = visibleWidth(rightGlyph);
		const maxLabelWidth = Math.max(0, frameLineWidth - leftWidth - rightWidth);
		const trimmedLabel = truncateToWidth(rawLabel, maxLabelWidth);
		const labelWidth = visibleWidth(trimmedLabel);
		const fillCount = Math.max(0, frameLineWidth - leftWidth - labelWidth - rightWidth);
		const fillGlyphs = h.repeat(fillCount);
		return `${border(leftGlyphs)}${trimmedLabel}${border(fillGlyphs)}${border(rightGlyph)}`;
	};

	const renderBottom = (row: { leftChar: string; rightChar: string }): string => {
		const leftGlyphs = `${row.leftChar}${cap}`;
		const rightGlyph = row.rightChar;
		const fillCount = Math.max(0, frameLineWidth - visibleWidth(leftGlyphs) - visibleWidth(rightGlyph));
		const fillGlyphs = h.repeat(fillCount);
		return `${border(leftGlyphs)}${border(fillGlyphs)}${border(rightGlyph)}`;
	};

	const renderContent = (inner: string): string =>
		anchorRightBorder(`${border(v)}${contentLeftPadding}${inner}`, border(v), frameLineWidth);

	const lines: string[] = [];
	for (let r = 0; r < H; r++) {
		const row = rows[r]!;
		if (row.kind === "sixel") {
			lines.push(row.raw);
			continue;
		}
		const frameLine =
			row.kind === "bar" ? renderBar(row) : row.kind === "bottom" ? renderBottom(row) : renderContent(row.inner);
		lines.push(padToWidth(outerLeftPadding ? `${outerLeftPadding}${frameLine}` : frameLine, lineWidth, bgFn));
	}

	return lines;
}

/**
 * Cached wrapper around `renderOutputBlock`.
 *
 * Since output blocks are re-rendered on every frame (via `render(width)` closures),
 * but their content rarely changes, this cache avoids redundant `visibleWidth()` and
 * `padding()` computations on ~99% of render calls.
 */
export class CachedOutputBlock {
	#cache?: RenderCache;
	#theme?: Theme;

	/** Render with caching. Returns the cached (shared, caller-immutable) lines if options haven't changed. */
	render(options: OutputBlockOptions, theme: Theme): readonly string[] {
		const key = this.#buildKey(options);
		if (this.#cache?.key === key && this.#theme === theme) return this.#cache.lines;
		const lines = renderOutputBlock(options, theme);
		this.#cache = { key, lines };
		this.#theme = theme;
		return lines;
	}

	/** Invalidate the cache, forcing a rebuild on next render. */
	invalidate(): void {
		this.#cache = undefined;
		this.#theme = undefined;
	}

	#buildKey(options: OutputBlockOptions): bigint {
		const effectiveStyle = options.borderStyle ?? outputBlockBorderStyle;
		const h = new Hasher();
		h.u32(getThemeEpoch());
		h.u32(options.width);
		h.u32(normalizeContentPaddingLeft(options.contentPaddingLeft, effectiveStyle));
		h.optional(options.header);
		h.optional(options.headerMeta);
		h.optional(options.state);
		h.optional(options.borderColor);
		h.bool(options.applyBg ?? false);
		h.str(effectiveStyle);
		h.u32(Math.round((options.accentTintOpacity ?? 0.06) * 10_000));
		if (options.sections) {
			for (const s of options.sections) {
				h.optional(s.label);
				h.bool(s.separator ?? false);
				for (const line of s.lines) {
					h.str(line);
				}
			}
		}
		return h.digest();
	}
}

/**
 * Build a self-framing tool component backed by a cached output block. The
 * `build` callback returns the block options for a given width; the cache
 * dedupes re-renders. Pass `borderColor: "borderMuted"` for the dim "legacy"
 * look that does not compete with the state-colored framed tools.
 */
export function framedBlock(theme: Theme, build: (width: number) => OutputBlockOptions): Component {
	const block = new CachedOutputBlock();
	const followsActiveTheme = theme === activeTheme;
	// Marked so the tool-execution container treats it as self-framing (renders
	// flush, no extra padding/background) the same way `markFramedBlockComponent`
	// blocks are treated.
	return markFramedBlockComponent({
		render: (width: number): readonly string[] =>
			block.render(build(width), followsActiveTheme ? activeTheme : theme),
		invalidate: () => block.invalidate(),
	});
}
