/**
 * Inline TUI renderers for the long-term memory tools (`retain`, `recall`,
 * `reflect`).
 *
 * These keep the transcript terse — one status line plus root-level tree rows
 * for memory content — instead of the generic JSON arg tree, which exploded
 * multi-line memory blobs into an unreadable wall. The renderers own a bare
 * transcript surface so global accent-card styling never obscures their
 * semantic tool identity.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { tSettingsUi } from "../i18n/settings-locale";
import type { Theme } from "../modes/theme/theme";
import { Ellipsis, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import {
	createCachedComponent,
	formatExpandHint,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIStatus,
} from "./render-utils";

// Stored memories use the shared root-level tree layout used by search tools.

interface RetainRenderArgs {
	items?: unknown;
}

interface QueryRenderArgs {
	query?: string;
}

function retainContents(args: RetainRenderArgs | undefined): string[] {
	const items = args?.items;
	if (!Array.isArray(items)) return [];

	const contents: string[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object" || !("content" in item) || typeof item.content !== "string") continue;
		const content = replaceTabs(item.content.trim());
		if (content.length > 0) contents.push(content);
	}
	return contents;
}

function resultText(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content?.find(c => c.type === "text")?.text ?? "").trim();
}

const MEMORY_TITLE = "Memory";

/** Single-line operation header used by all memory calls and results. */
function memoryHeader(
	operation: "retain" | "recall" | "reflect",
	query: string | undefined,
	icon: ToolUIStatus,
	theme: Theme,
	meta?: string[],
	iconOverride?: string,
): string {
	const trimmed = replaceTabs((query ?? "").trim());
	const queryDisplay = trimmed ? truncateToWidth(trimmed, 80, Ellipsis.Unicode) : undefined;
	const description = queryDisplay ? `${operation} ${queryDisplay}` : operation;
	return renderStatusLine({ icon, iconOverride, title: MEMORY_TITLE, description, meta }, theme);
}

function memoryError(operation: "retain" | "recall" | "reflect", message: string, theme: Theme): Component {
	const header = memoryHeader(operation, undefined, "error", theme);
	const body = renderTreeList(
		{ items: [message], expanded: true, renderItem: item => theme.fg("error", item) },
		theme,
	);
	return new Text([header, ...body].join("\n"), 0, 0);
}

function retainComponent(contents: string[], header: string, getExpanded: () => boolean, theme: Theme): Component {
	return createCachedComponent(getExpanded, (width, expanded) => {
		const limit = expanded ? contents.length : PREVIEW_LIMITS.COLLAPSED_ITEMS;
		const shown = contents.slice(0, limit);
		const remaining = contents.length - shown.length;
		const overflow =
			remaining > 0
				? `${tSettingsUi(remaining === 1 ? "… 1 more retained item" : "… {count} more retained items", {
						count: remaining,
					})} ${formatExpandHint(theme, expanded, true)}`
				: "";
		const itemLines = renderTreeList(
			{
				items: shown,
				expanded,
				trailingSummary: expanded ? undefined : overflow,
				renderItem: content => theme.fg("toolOutput", truncateToWidth(content, Math.max(8, width - 4))),
			},
			theme,
		);
		return [header, ...itemLines].map(line => truncateToWidth(line, width, Ellipsis.Omit));
	});
}

export const retainToolRenderer = {
	inline: true,
	transcriptSurface: "bare" as const,
	mergeCallAndResult: true,
	renderCall(args: RetainRenderArgs, options: RenderResultOptions, theme: Theme): Component {
		const contents = retainContents(args);
		const header = memoryHeader("retain", undefined, "pending", theme);
		return retainComponent(contents, header, () => options.expanded, theme);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: { count?: number }; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: RetainRenderArgs,
	): Component {
		if (result.isError) {
			return memoryError("retain", resultText(result) || tSettingsUi("Retain failed"), theme);
		}
		const contents = retainContents(args);
		// `summary` is the tool's own "N memories stored/queued." line; drop the
		// trailing period so it reads cleanly as a status meta segment.
		const summary = resultText(result).replace(/\.$/, "");
		const header = memoryHeader(
			"retain",
			undefined,
			"success",
			theme,
			summary ? [summary] : undefined,
			theme.styledSymbol("tool.memory", "accent"),
		);
		return retainComponent(contents, header, () => options.expanded, theme);
	},
};

export const recallToolRenderer = {
	inline: true,
	transcriptSurface: "bare" as const,
	mergeCallAndResult: true,
	renderCall(args: QueryRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		return new Text(memoryHeader("recall", args.query, "pending", theme), 0, 0);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: QueryRenderArgs,
	): Component {
		if (result.isError) {
			return memoryError("recall", resultText(result) || tSettingsUi("Recall failed"), theme);
		}
		const text = resultText(result);
		const match = text.match(/^Found (\d+) relevant/);
		const found = match ? Number(match[1]) : 0;
		const meta = [found > 0 ? tSettingsUi("{count} found", { count: found }) : tSettingsUi("no matches")];
		const header =
			found > 0
				? memoryHeader("recall", args?.query, "success", theme, meta, theme.styledSymbol("tool.memory", "accent"))
				: memoryHeader("recall", args?.query, "warning", theme, meta);
		if (found === 0) {
			return new Text(header, 0, 0);
		}
		const body = text.replace(/^[^\n]*\n+/, "");
		return createCachedComponent(
			() => options.expanded,
			(width, expanded) => {
				const lines = [header];
				if (expanded) {
					const bodyLines = body.split("\n").slice(0, PREVIEW_LIMITS.OUTPUT_EXPANDED);
					lines.push(
						...renderTreeList(
							{ items: bodyLines, expanded: true, renderItem: line => theme.fg("muted", replaceTabs(line)) },
							theme,
						),
					);
				} else {
					lines.push(`${theme.tree.last} ${formatExpandHint(theme, false, true)}`);
				}
				return lines.map(line => truncateToWidth(line, width, Ellipsis.Omit));
			},
		);
	},
};

export const reflectToolRenderer = {
	inline: true,
	transcriptSurface: "bare" as const,
	mergeCallAndResult: true,
	renderCall(args: QueryRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		return new Text(memoryHeader("reflect", args.query, "pending", theme), 0, 0);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: QueryRenderArgs,
	): Component {
		if (result.isError) {
			return memoryError("reflect", resultText(result) || tSettingsUi("Reflect failed"), theme);
		}
		const header = memoryHeader(
			"reflect",
			args?.query,
			"success",
			theme,
			undefined,
			theme.styledSymbol("tool.memory", "accent"),
		);
		const answer = resultText(result);
		const answerLines = answer.split("\n").filter(line => line.trim().length > 0);
		return createCachedComponent(
			() => options.expanded,
			(width, expanded) => {
				const limit = expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
				const shown = answerLines.slice(0, limit);
				const remaining = answerLines.length - shown.length;
				const overflow =
					remaining > 0
						? `${tSettingsUi(remaining === 1 ? "… 1 more line" : "… {count} more lines", {
								count: remaining,
							})} ${formatExpandHint(theme, expanded, true)}`
						: "";
				const bodyLines = renderTreeList(
					{
						items: shown,
						expanded,
						trailingSummary: expanded ? undefined : overflow,
						renderItem: line => theme.fg("toolOutput", replaceTabs(line)),
					},
					theme,
				);
				return [header, ...bodyLines].map(line => truncateToWidth(line, width, Ellipsis.Omit));
			},
		);
	},
};
