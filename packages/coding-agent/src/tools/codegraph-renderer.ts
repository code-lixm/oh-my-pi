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
import { Ellipsis, fileHyperlink, renderStatusLine, truncateToWidth } from "../tui";
import type { CodeGraphToolDetails } from "./codegraph";
import {
	createCachedComponent,
	formatEmptyMessage,
	formatErrorMessage,
	PREVIEW_LIMITS,
	replaceTabs,
	shortenPath,
} from "./render-utils";

const COLLAPSED_ENTRY_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;
const COLLAPSED_FILE_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;

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
		const metaBase: string[] = [];
		if (details) {
			metaBase.push(
				`${details.fileCount} file${details.fileCount === 1 ? "" : "s"}`,
				`${details.entryCount} entr${details.entryCount === 1 ? "y" : "ies"}`,
			);
			if (details.pathScope) metaBase.push(`sync: ${shortenPath(details.pathScope)}`);
			if (details.truncated) metaBase.push(theme.fg("warning", "truncated"));
			if (details.confidence) metaBase.push(`confidence: ${details.confidence}`);
		}

		const fallbackText =
			result.isError && details?.fallback
				? (() => {
						const textBlock = result.content.find(block => block.type === "text");
						return typeof textBlock?.text === "string" && textBlock.text.length > 0
							? textBlock.text
							: details.fallback;
					})()
				: undefined;

		const headerText = renderStatusLine(
			{
				...(fallbackText
					? { icon: "warning" as const }
					: { iconOverride: theme.fg("toolTitle", theme.symbol("icon.search")) }),
				title: "CodeGraph",
				titleColor: "toolTitle",
				description: details?.query ?? "?",
				meta: metaBase,
			},
			theme,
		);

		return createCachedComponent(
			() => options.expanded,
			width => {
				const lines: string[] = [truncateToWidth(headerText, width, Ellipsis.Omit)];

				if (fallbackText) {
					lines.push(formatErrorMessage(fallbackText, theme));
					return lines.map(line => truncateToWidth(line, width, Ellipsis.Omit));
				}

				if (!details || (details.fileCount === 0 && details.entryCount === 0)) {
					lines.push(formatEmptyMessage("No semantic matches found", theme));
					return lines.map(line => truncateToWidth(line, width, Ellipsis.Omit));
				}

				const entries = details.entries;
				if (entries.length > 0) {
					const entryLimit = options.expanded ? entries.length : Math.min(entries.length, COLLAPSED_ENTRY_LIMIT);
					for (const entry of entries.slice(0, entryLimit)) {
						const node = entry.node;
						const pathLabel = shortenPath(node.filePath);
						const header = `• ${node.qualifiedName || node.name} [${node.kind}] — ${pathLabel}:${node.startLine}`;
						lines.push(fileHyperlink(pathLabel, theme.fg("accent", truncateToWidth(replaceTabs(header), width))));
					}
					if (!options.expanded && entries.length > entryLimit) {
						lines.push(theme.fg("dim", `…${entries.length - entryLimit} more entries`));
					}
				}

				const files = details.files;
				if (files.length > 0) {
					lines.push(theme.fg("dim", "File coverage:"));
					const fileLimit = options.expanded ? files.length : Math.min(files.length, COLLAPSED_FILE_LIMIT);
					for (const file of files.slice(0, fileLimit)) {
						const pathLabel = shortenPath(file.filePath);
						const label = `• ${pathLabel} (${file.language}, ${file.nodeCount} nodes)`;
						lines.push(fileHyperlink(pathLabel, theme.fg("muted", truncateToWidth(replaceTabs(label), width))));
					}
					if (!options.expanded && files.length > fileLimit) {
						lines.push(theme.fg("dim", `…${files.length - fileLimit} more files`));
					}
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
