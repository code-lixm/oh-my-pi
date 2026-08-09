import * as path from "node:path";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { tSettingsUi } from "../i18n/settings-locale";
import { getLanguageFromPath, type Theme } from "../modes/theme/theme";
import {
	fileHyperlink,
	getBasicToolDetailsVisible,
	renderCodeCell,
	renderMarkdownCell,
	renderStatusLine,
	tryResolveInternalUrlSync,
	urlHyperlink,
} from "../tui";
import { CachedOutputBlock, getOutputBlockBorderStyle, markFramedBlockComponent } from "../tui/output-block";
import { type ReadUrlToolDetails, renderReadUrlCall, renderReadUrlResult } from "./fetch";
import { formatFullOutputReference, formatStyledTruncationWarning, stripOutputNotice } from "./output-meta";
import { isReadableUrlPath, splitInternalUrlSel, splitPathAndSel } from "./path-utils";
import type { ReadToolDetails } from "./read";
import { isRawSelector, parseSel } from "./read-selector";
import { formatBytes, replaceTabs, shortenPath, wrapBrackets } from "./render-utils";

// =============================================================================
// TUI Renderer
// =============================================================================

interface ReadRenderArgs {
	path?: unknown;
	file_path?: unknown;
	selector?: unknown;
	// Legacy fields from old schema — tolerated for in-flight tool calls during transition
	offset?: number;
	limit?: number;
	raw?: boolean;
}

const INTERNAL_URL_LIKE_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function splitReadRenderPath(rawPath: string): { path: string; sel?: string } {
	if (INTERNAL_URL_LIKE_RE.test(rawPath)) {
		const internal = splitInternalUrlSel(rawPath);
		if (internal.sel) return internal;
	}
	return splitPathAndSel(rawPath);
}

function readRenderPath(args: ReadRenderArgs | undefined): string {
	const rawPath =
		typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
	if (typeof args?.selector !== "string" || args.selector.length === 0 || splitReadRenderPath(rawPath).sel) {
		return rawPath;
	}
	return `${rawPath}:${args.selector}`;
}

function firstReadSelectorLine(sel: string | undefined): number | undefined {
	if (!sel) return undefined;
	try {
		const parsed = parseSel(sel);
		if (parsed.kind !== "lines") return undefined;
		return parsed.ranges[0].startLine;
	} catch {
		return undefined;
	}
}

/** Absolute fs path the read result actually resolved to, used as the OSC 8 link
 * target when the structured `resolvedPath` isn't set (the common plain-file and
 * image reads only record the path in `meta.source`). URL/internal sources are
 * not fs paths, so only `type: "path"` qualifies. */
function readSourceFsPath(details: ReadToolDetails | undefined): string | undefined {
	const source = details?.meta?.source;
	return source?.type === "path" ? source.value : undefined;
}

function formatReadPathLink(
	rawPath: string,
	options: {
		resolvedPath?: string;
		sourcePath?: string;
		suffixResolution?: { from: string; to: string };
		offset?: number;
		fallbackLabel?: string;
	},
): string {
	const split = splitReadRenderPath(rawPath);
	const basePath = split.path || rawPath;
	const selectorSuffix = split.sel ? `:${split.sel}` : "";
	const plainDisplayPath = options.suffixResolution
		? shortenPath(options.suffixResolution.to)
		: shortenPath(basePath || options.resolvedPath || options.fallbackLabel || rawPath);
	const absoluteInputPath = path.isAbsolute(basePath) ? basePath : undefined;
	const target =
		options.resolvedPath ?? options.sourcePath ?? tryResolveInternalUrlSync(basePath) ?? absoluteInputPath;
	const line = firstReadSelectorLine(split.sel) ?? options.offset;
	const linkOptions = line !== undefined ? { line } : undefined;
	const linkedPath = target ? fileHyperlink(target, plainDisplayPath, linkOptions) : plainDisplayPath;
	return `${linkedPath}${selectorSuffix}`;
}

function readSummaryMeta(
	details: ReadToolDetails | undefined,
	uiTheme: Theme,
	options: { imageMimeType?: string } = {},
): string[] {
	const meta: string[] = [];
	const contentType = details?.contentType ?? options.imageMimeType;
	if (contentType) meta.push(contentType);
	if (details?.summary) {
		meta.push(
			tSettingsUi(details.summary.lines === 1 ? "{count} line" : "{count} lines", { count: details.summary.lines }),
		);
		meta.push(
			tSettingsUi(
				details.summary.elidedSpans === 1 ? "(summary: {count} elided span)" : "(summary: {count} elided spans)",
				{ count: details.summary.elidedSpans },
			),
		);
		if (details.summary.elidedLines > 0) meta.push(`${details.summary.elidedLines.toLocaleString()}ln elided`);
	}
	if (details?.conflictCount && details.conflictCount > 0) {
		const n = details.conflictCount;
		meta.push(
			uiTheme.fg("warning", tSettingsUi(n === 1 ? "(⚠ {count} conflict)" : "(⚠ {count} conflicts)", { count: n })),
		);
	}
	if (details?.meta?.truncation || details?.truncation) {
		meta.push(uiTheme.fg("warning", tSettingsUi("truncated")));
	}
	return meta;
}

function renderReadUrlSummaryStatusLine(
	rawPath: string,
	details: ReadUrlToolDetails | undefined,
	uiTheme: Theme,
): string {
	const split = splitReadRenderPath(rawPath);
	const target = split.path || rawPath || details?.finalUrl || details?.url || "…";
	const descriptionBase = urlHyperlink(target, shortenPath(target));
	const description = split.sel ? `${descriptionBase}:${split.sel}` : descriptionBase;
	const truncated = Boolean(details?.truncated || details?.meta?.truncation);
	const meta = [details?.contentType, details?.method].filter((value): value is string => Boolean(value?.trim()));
	if (truncated) meta.push(uiTheme.fg("warning", tSettingsUi("truncated")));
	return renderStatusLine(
		{ icon: truncated ? "warning" : "success", title: tSettingsUi("read"), description, meta },
		uiTheme,
	);
}

export const readToolRenderer = {
	renderCall(args: ReadRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const rawPath = readRenderPath(args);
		if (isReadableUrlPath(rawPath)) {
			return renderReadUrlCall({ path: rawPath, raw: args.raw }, _options, uiTheme);
		}

		const offset = args.offset;
		const limit = args.limit;

		let pathDisplay = formatReadPathLink(rawPath, { offset, fallbackLabel: "…" }) || "…";
		if (offset !== undefined || limit !== undefined) {
			const startLine = offset ?? 1;
			const endLine = limit !== undefined ? startLine + limit - 1 : "";
			pathDisplay += `:${startLine}${endLine ? `-${endLine}` : ""}`;
		}

		const text = renderStatusLine(
			{ icon: "pending", title: tSettingsUi("Read"), titleColor: "toolTitle", description: pathDisplay },
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ReadToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: ReadRenderArgs,
	): Component {
		const urlDetails = result.details as ReadUrlToolDetails | undefined;
		const baseRawPathForKind =
			typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
		if (
			!result.isError &&
			!getBasicToolDetailsVisible() &&
			(urlDetails?.kind === "url" || isReadableUrlPath(baseRawPathForKind))
		) {
			return new Text(
				renderReadUrlSummaryStatusLine(
					readRenderPath(args) || baseRawPathForKind,
					urlDetails?.kind === "url" ? urlDetails : undefined,
					uiTheme,
				),
				0,
				0,
			);
		}
		if (urlDetails?.kind === "url" || isReadableUrlPath(baseRawPathForKind)) {
			return renderReadUrlResult(
				result as {
					content: Array<{ type: string; text?: string }>;
					details?: ReadUrlToolDetails;
					isError?: boolean;
				},
				options,
				uiTheme,
			);
		}

		if (result.isError) {
			const rawErrorText = result.content?.find(c => c.type === "text")?.text ?? "";
			const errorText = (rawErrorText || tSettingsUi("Unknown error")).replace(/^Error:\s*/, "");
			const rawPath = readRenderPath(args);
			const filePath =
				formatReadPathLink(rawPath, { offset: args?.offset, sourcePath: readSourceFsPath(result.details) }) ||
				shortenPath(rawPath);
			let title = filePath ? tSettingsUi("Read {path}", { path: filePath }) : tSettingsUi("Read");
			if (args?.offset !== undefined || args?.limit !== undefined) {
				const startLine = args.offset ?? 1;
				const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
				title += `:${startLine}${endLine ? `-${endLine}` : ""}`;
			}
			const header = renderStatusLine({ icon: "error", title }, uiTheme);
			const errorLines = errorText.split("\n").map(line => uiTheme.fg("error", replaceTabs(line)));
			const outputBlock = new CachedOutputBlock();
			return markFramedBlockComponent({
				render: (width: number) =>
					outputBlock.render(
						{
							header,
							state: "error",
							sections: [{ lines: errorLines }],
							width,
						},
						uiTheme,
					),
				invalidate: () => outputBlock.invalidate(),
			});
		}
		const details = result.details;
		const rawText = result.content?.find(c => c.type === "text")?.text ?? "";
		// Prefer structured `displayContent` from details when available so the TUI
		// shows clean file content (no model-only hashline anchors) without parsing the formatted text.
		// Fall back to the raw text, but strip the LLM-facing notice so it doesn't
		// echo next to the styled warning line below.
		const contentText = details?.displayContent?.text ?? stripOutputNotice(rawText, details?.meta);
		const imageContent = result.content?.find(c => c.type === "image");
		const rawPath = readRenderPath(args);
		const renderPath = splitReadRenderPath(rawPath);
		const lang = getLanguageFromPath(renderPath.path);

		const warningLines: string[] = [];
		const truncation = details?.meta?.truncation;
		const fallback = details?.truncation;
		if (details?.resolvedPath) {
			warningLines.push(
				uiTheme.fg(
					"dim",
					wrapBrackets(tSettingsUi("Resolved path: {path}", { path: details.resolvedPath }), uiTheme),
				),
			);
		}
		if (truncation) {
			if (fallback?.firstLineExceedsLimit) {
				let warning = tSettingsUi("First line exceeds {limit} limit", {
					limit: formatBytes(fallback.outputBytes ?? fallback.totalBytes),
				});
				if (truncation.artifactId) {
					warning += `. ${formatFullOutputReference(truncation.artifactId)}`;
				}
				warningLines.push(uiTheme.fg("warning", wrapBrackets(warning, uiTheme)));
			} else {
				const warning = formatStyledTruncationWarning(details?.meta, uiTheme);
				if (warning) warningLines.push(warning);
			}
		}

		if (imageContent) {
			const suffix = details?.suffixResolution;
			const displayPath = formatReadPathLink(rawPath, {
				resolvedPath: details?.resolvedPath,
				sourcePath: readSourceFsPath(details),
				suffixResolution: suffix,
				fallbackLabel: tSettingsUi("image"),
			});
			const correction = suffix
				? ` ${uiTheme.fg("dim", tSettingsUi("(corrected from {path})", { path: shortenPath(suffix.from) }))}`
				: "";
			const header = renderStatusLine(
				{
					icon: suffix ? "warning" : undefined,
					iconOverride: suffix ? undefined : uiTheme.fg("toolTitle", uiTheme.symbol("icon.file")),
					title: tSettingsUi("Read"),
					description: `${displayPath}${correction}`,
				},
				uiTheme,
			);
			if (!getBasicToolDetailsVisible()) {
				let imageMimeType: string | undefined;
				if (imageContent && typeof imageContent === "object" && "mimeType" in imageContent) {
					imageMimeType = typeof imageContent.mimeType === "string" ? imageContent.mimeType : undefined;
				}
				const meta = readSummaryMeta(details, uiTheme, { imageMimeType });
				const summaryHeader = renderStatusLine(
					{
						icon: suffix ? "warning" : undefined,
						iconOverride: suffix ? undefined : uiTheme.fg("toolTitle", uiTheme.symbol("icon.file")),
						title: tSettingsUi("Read"),
						description: `${displayPath}${correction}`,
						meta,
					},
					uiTheme,
				);
				return new Text(summaryHeader, 0, 0);
			}
			const detailLines = contentText ? contentText.split("\n").map(line => uiTheme.fg("toolOutput", line)) : [];
			const lines = [...detailLines, ...warningLines];
			const outputBlock = new CachedOutputBlock();
			return markFramedBlockComponent({
				render: (width: number) =>
					outputBlock.render(
						{
							header,
							state: "success",
							sections: [
								{
									label: uiTheme.fg("toolTitle", tSettingsUi("Details")),
									lines: lines.length > 0 ? lines : [uiTheme.fg("dim", tSettingsUi("(image)"))],
								},
							],
							width,
						},
						uiTheme,
					),
				invalidate: () => outputBlock.invalidate(),
			});
		}

		const suffix = details?.suffixResolution;
		// resolvedPath is the absolute fs path when a read resolved/corrected the
		// input (suffix match, internal URL, archive/sqlite/notebook); plain file
		// reads only record the absolute path in meta.source, so fall back to that
		// (and then to a sync internal-URL resolver) to keep the title clickable.
		const displayPath = formatReadPathLink(rawPath, {
			resolvedPath: details?.resolvedPath,
			sourcePath: readSourceFsPath(details),
			suffixResolution: suffix,
			offset: args?.offset,
		});
		const correction = suffix
			? ` ${uiTheme.fg("dim", tSettingsUi("(corrected from {path})", { path: shortenPath(suffix.from) }))}`
			: "";
		if (!getBasicToolDetailsVisible()) {
			let description = displayPath ? `${displayPath}${correction}` : shortenPath(rawPath);
			if (args?.offset !== undefined || args?.limit !== undefined) {
				const startLine = args.offset ?? 1;
				const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
				description += `:${startLine}${endLine ? `-${endLine}` : ""}`;
			}
			const truncated = Boolean(details?.meta?.truncation || details?.truncation);
			const header = renderStatusLine(
				{
					icon: truncated ? "warning" : "success",
					title: tSettingsUi("Read"),
					titleColor: "toolTitle",
					description: description || undefined,
					meta: readSummaryMeta(details, uiTheme),
				},
				uiTheme,
			);
			return new Text(header, 0, 0);
		}
		let title = displayPath
			? tSettingsUi("Read {path}", { path: `${displayPath}${correction}` })
			: tSettingsUi("Read");
		if (args?.offset !== undefined || args?.limit !== undefined) {
			const startLine = args.offset ?? 1;
			const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
			title += `:${startLine}${endLine ? `-${endLine}` : ""}`;
		}
		if (details?.summary) {
			title += ` ${tSettingsUi(details.summary.elidedSpans === 1 ? "(summary: {count} elided span)" : "(summary: {count} elided spans)", { count: details.summary.elidedSpans })}`;
		}
		if (details?.conflictCount && details.conflictCount > 0) {
			const n = details.conflictCount;
			title += ` ${uiTheme.fg("warning", tSettingsUi(n === 1 ? "(⚠ {count} conflict)" : "(⚠ {count} conflicts)", { count: n }))}`;
		}
		const rawRequested = args?.raw === true || isRawSelector(parseSel(renderPath.sel));
		const isMarkdown = details?.contentType === "text/markdown" && !rawRequested;
		let cachedWidth: number | undefined;
		let cachedExpanded: boolean | undefined;
		let cachedLines: string[] | undefined;
		return markFramedBlockComponent({
			render: (width: number) => {
				const expanded = options.expanded;
				if (cachedLines && cachedWidth === width && cachedExpanded === expanded) return cachedLines;
				cachedLines = isMarkdown
					? renderMarkdownCell(
							{
								content: contentText,
								title,
								status: "complete",
								output: warningLines.length > 0 ? warningLines.join("\n") : undefined,
								expanded,
								width,
								borderStyle: getOutputBlockBorderStyle(),
							},
							uiTheme,
						)
					: renderCodeCell(
							{
								code: contentText,
								language: lang,
								title,
								status: "complete",
								output: warningLines.length > 0 ? warningLines.join("\n") : undefined,
								expanded,
								codeStartLine: details?.displayContent?.startLine,
								codeLineNumbers: details?.displayContent?.lineNumbers,
								width,
								borderStyle: getOutputBlockBorderStyle(),
							},
							uiTheme,
						);
				cachedWidth = width;
				cachedExpanded = expanded;
				return cachedLines;
			},
			invalidate: () => {
				cachedWidth = undefined;
				cachedExpanded = undefined;
				cachedLines = undefined;
			},
		});
	},
	mergeCallAndResult: true,
};
