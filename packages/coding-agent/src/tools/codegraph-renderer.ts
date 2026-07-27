import * as path from "node:path";
/**
 * TUI renderer for the built-in `codegraph` tool.
 *
 * The tool returns semantic exploration results (or a fallback note when
 * the runtime is unavailable). The renderer mirrors the search-tool layout:
 * a status header with query/scope/maxFiles meta, expandable entry list
 * with short code previews, and an explicit fallback panel when the
 * runtime could not run.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { getLanguageFromPath } from "../modes/theme/theme";
import {
	Ellipsis,
	fileHyperlink,
	getBasicToolDetailsVisible,
	renderStatusLine,
	renderTreeList,
	truncateToWidth,
} from "../tui";
import type { CodeGraphToolDetails } from "./codegraph";
import {
	createCachedComponent,
	formatEmptyMessage,
	formatErrorMessage,
	replaceTabs,
	shortenPath,
	toolDetailMaxLines,
} from "./render-utils";

function resolveResultPath(filePath: string, sourceRoot: string | undefined): string | undefined {
	if (path.isAbsolute(filePath)) return filePath;
	return sourceRoot ? path.resolve(sourceRoot, filePath) : undefined;
}

export const codegraphToolRenderer = {
	inline: true,
	transcriptSurface: "bare" as const,
	mergeCallAndResult: true,

	renderCall(args: Record<string, unknown> | undefined, options: RenderResultOptions, theme: Theme): Component {
		const safeArgs = isArgs(args);
		const meta: string[] = [];
		const description = safeArgs?.query?.trim() ?? "";
		if (safeArgs?.path) meta.push(`sync: ${safeArgs.path}`);
		if (typeof safeArgs?.maxFiles === "number") meta.push(`maxFiles: ${safeArgs.maxFiles}`);
		const header = renderStatusLine(
			{
				icon: options.spinnerFrame !== undefined ? "running" : "pending",
				spinnerFrame: options.spinnerFrame,
				title: "CodeGraph",
				description: description.length > 0 ? description : "?",
				meta,
			},
			theme,
		);
		return new Text(header, 0, 0);
	},

	renderResult(
		result: {
			content: Array<{ type: string; text?: string }>;
			details?: CodeGraphToolDetails;
			isError?: boolean;
		},
		options: RenderResultOptions,
		theme: Theme,
	): Component {
		const details = result.details;
		const meta: string[] = [];
		if (details) {
			meta.push(
				`${details.fileCount} file${details.fileCount === 1 ? "" : "s"}`,
				`${details.entryCount} entr${details.entryCount === 1 ? "y" : "ies"}`,
			);
			if (details.pathScope) meta.push(`sync: ${shortenPath(details.pathScope)}`);
			if (details.truncated) meta.push(theme.fg("warning", "truncated"));
			if (details.confidence) meta.push(`confidence: ${details.confidence}`);
		}

		const errorText = result.isError
			? result.content.find(block => block.type === "text")?.text || details?.fallback || "Unknown error"
			: undefined;
		const fallbackText = details?.fallback;
		const empty = !details || (details.fileCount === 0 && details.entryCount === 0);
		const headerText = renderStatusLine(
			{
				...(errorText || (empty && !fallbackText)
					? { icon: "warning" as const }
					: { iconOverride: theme.fg("toolTitle", theme.symbol("icon.search")) }),
				title: "CodeGraph",
				titleColor: "toolTitle",
				description: details?.query ?? "?",
				meta,
			},
			theme,
		);

		if (!getBasicToolDetailsVisible() && !errorText) {
			return createCachedComponent(
				() => false,
				width => [truncateToWidth(headerText, width, Ellipsis.Omit)],
			);
		}

		return createCachedComponent(
			() => options.expanded,
			width => {
				const lines: string[] = [headerText];

				if (errorText) {
					lines.push(formatErrorMessage(errorText, theme));
					return lines.map(line => truncateToWidth(line, width, Ellipsis.Omit));
				}

				if (fallbackText) {
					lines.push(formatEmptyMessage(fallbackText, theme));
					return lines.map(line => truncateToWidth(line, width, Ellipsis.Omit));
				}

				if (empty) {
					lines.push(formatEmptyMessage("No semantic matches found", theme));
					return lines.map(line => truncateToWidth(line, width, Ellipsis.Omit));
				}

				if (details.entries.length > 0) {
					lines.push(
						...renderTreeList(
							{
								items: details.entries,
								expanded: options.expanded,
								maxCollapsedLines: toolDetailMaxLines(),
								truncateFrom: "middle",
								itemType: "entry",
								renderItem: entry => {
									const node = entry.node;
									const pathLabel = shortenPath(node.filePath);
									const absolutePath = resolveResultPath(node.filePath, details.sourceRoot);
									const icon = theme.fg("muted", theme.getLangIcon(getLanguageFromPath(node.filePath)));
									const styledPath = theme.fg("toolOutput", `${icon} ${pathLabel}`);
									const linkedPath = absolutePath
										? fileHyperlink(absolutePath, styledPath, { line: node.startLine })
										: styledPath;
									return `${linkedPath}${theme.fg(
										"dim",
										` :${node.startLine} · ${node.qualifiedName || node.name} [${node.kind}]`,
									)}`;
								},
							},
							theme,
						),
					);
				} else if (details.files.length > 0) {
					lines.push(
						...renderTreeList(
							{
								items: details.files,
								expanded: options.expanded,
								maxCollapsedLines: toolDetailMaxLines(),
								truncateFrom: "middle",
								itemType: "file",
								renderItem: file => {
									const pathLabel = shortenPath(file.filePath);
									const absolutePath = resolveResultPath(file.filePath, details.sourceRoot);
									const label = `${theme.getLangIcon(getLanguageFromPath(file.filePath))} ${pathLabel} (${file.language}, ${file.nodeCount} nodes)`;
									const styled = theme.fg("toolOutput", replaceTabs(label));
									return absolutePath ? fileHyperlink(absolutePath, styled) : styled;
								},
							},
							theme,
						),
					);
				}

				return lines.map(line => truncateToWidth(line, width, Ellipsis.Omit));
			},
		);
	},
};

function isArgs(value: unknown): { query?: string; path?: string; maxFiles?: number } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const obj = value as Record<string, unknown>;
	const result: { query?: string; path?: string; maxFiles?: number } = {};
	if (typeof obj.query === "string") result.query = obj.query;
	if (typeof obj.path === "string") result.path = obj.path;
	if (typeof obj.maxFiles === "number") result.maxFiles = obj.maxFiles;
	return result;
}
