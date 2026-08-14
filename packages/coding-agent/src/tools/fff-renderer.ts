import * as path from "node:path";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { tSettingsUi } from "../i18n/settings-locale";
import type { Theme } from "../modes/theme/theme";
import {
	Ellipsis,
	fileHyperlink,
	getBasicToolDetailsVisible,
	renderFileList,
	renderStatusLine,
	renderTreeList,
	truncateToWidth,
} from "../tui";
import { createCachedComponent, formatErrorMessage, toolDetailMaxLines } from "./render-utils";
import type { FindToolDetails, GrepToolDetails } from "./search-details";

interface FindArgs {
	pattern?: string;
	path?: string;
	limit?: number;
	cursor?: string;
}

interface SearchArgs {
	pattern?: string;
	patterns?: string[];
	path?: string;
	constraints?: string;
	limit?: number;
	cursor?: string;
}

function title(uiTheme: Theme, value: string): string {
	return uiTheme.fg("toolTitle", value);
}

export const fffFindToolRenderer = {
	inline: true,
	transcriptSurface: "bare" as const,
	mergeCallAndResult: true,
	renderCall(args: FindArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.path) meta.push(tSettingsUi("in {paths}", { paths: sanitizeText(args.path) }));
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);
		if (args.cursor) meta.push(tSettingsUi("page"));
		return new Text(
			renderStatusLine(
				{
					icon: "pending",
					title: tSettingsUi("Find"),
					titleColor: "toolTitle",
					description: sanitizeText(args.pattern || "*"),
					meta,
				},
				uiTheme,
			),
			0,
			0,
		);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: FindToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: FindArgs,
	): Component {
		const details = result.details;
		if (result.isError || details?.error) {
			return new Text(
				formatErrorMessage(
					sanitizeText(details?.error ?? result.content[0]?.text ?? tSettingsUi("Unknown error")),
					uiTheme,
				),
				0,
				0,
			);
		}
		const files = details?.files ?? [];
		const truncated = Boolean(details?.truncated);
		const meta = [tSettingsUi(files.length === 1 ? "{count} file" : "{count} files", { count: files.length })];
		if (truncated) meta.push(uiTheme.fg("warning", tSettingsUi("truncated")));
		const header = renderStatusLine(
			{
				iconOverride: title(uiTheme, uiTheme.symbol("icon.search")),
				title: tSettingsUi("Find"),
				titleColor: "toolTitle",
				description: sanitizeText(args?.pattern || "*"),
				meta,
			},
			uiTheme,
		);
		if (!getBasicToolDetailsVisible()) return new Text(header, 0, 0);
		return createCachedComponent(
			() => options.expanded,
			width => {
				const list = renderFileList(
					{
						files: files.map(file => ({
							path: sanitizeText(file),
							absPath: details?.cwd ? path.resolve(details.cwd, file) : undefined,
						})),
						expanded: options.expanded,
						maxCollapsedLines: toolDetailMaxLines(),
						truncateFrom: "middle",
					},
					uiTheme,
				);
				const empty =
					files.length === 0
						? renderTreeList(
								{ items: [tSettingsUi("No files found")], expanded: true, renderItem: item => item },
								uiTheme,
							)
						: [];
				return [header, ...list, ...empty].map(line => truncateToWidth(line, width, Ellipsis.Omit));
			},
		);
	},
};

function createSearchRenderer(toolTitle: string) {
	return {
		inline: true,
		transcriptSurface: "bare" as const,
		mergeCallAndResult: true,
		renderCall(args: SearchArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
			const description = args.pattern ?? args.patterns?.join(", ") ?? "?";
			const meta: string[] = [];
			if (args.path) meta.push(tSettingsUi("in {paths}", { paths: sanitizeText(args.path) }));
			if (args.constraints) meta.push(sanitizeText(args.constraints));
			if (args.cursor) meta.push(tSettingsUi("page"));
			return new Text(
				renderStatusLine(
					{
						icon: "pending",
						title: tSettingsUi(toolTitle),
						titleColor: "toolTitle",
						description: sanitizeText(description),
						meta,
					},
					uiTheme,
				),
				0,
				0,
			);
		},
		renderResult(
			result: { content: Array<{ type: string; text?: string }>; details?: GrepToolDetails; isError?: boolean },
			options: RenderResultOptions,
			uiTheme: Theme,
		): Component {
			const details = result.details;
			if (result.isError || details?.error) {
				return new Text(
					formatErrorMessage(
						sanitizeText(details?.error ?? result.content[0]?.text ?? tSettingsUi("Unknown error")),
						uiTheme,
					),
					0,
					0,
				);
			}
			const files = details?.fileLocations ?? [];
			const matchCount = details?.matchCount ?? 0;
			const fileCount = details?.fileCount ?? 0;
			const header = renderStatusLine(
				{
					iconOverride: title(uiTheme, uiTheme.symbol("icon.search")),
					title: tSettingsUi(toolTitle),
					titleColor: "toolTitle",
					meta: [
						tSettingsUi(matchCount === 1 ? "{count} match" : "{count} matches", { count: matchCount }),
						tSettingsUi(fileCount === 1 ? "{count} file" : "{count} files", { count: fileCount }),
					],
				},
				uiTheme,
			);
			if (!getBasicToolDetailsVisible()) return new Text(header, 0, 0);
			return createCachedComponent(
				() => options.expanded,
				width => {
					const list = renderFileList(
						{
							files: files.map(file => ({
								path: sanitizeText(file.path),
								absPath: details?.cwd ? path.resolve(details.cwd, file.path) : undefined,
								line: file.lineNumbers[0],
								meta: file.lineNumbers.join(","),
							})),
							expanded: options.expanded,
							maxCollapsedLines: toolDetailMaxLines(),
							truncateFrom: "middle",
							hyperlinkFn: fileHyperlink,
						},
						uiTheme,
					);
					const empty =
						files.length === 0
							? renderTreeList(
									{ items: [tSettingsUi("No matches found")], expanded: true, renderItem: item => item },
									uiTheme,
								)
							: [];
					return [header, ...list, ...empty].map(line => truncateToWidth(line, width, Ellipsis.Omit));
				},
			);
		},
	};
}

export const fffGrepToolRenderer = createSearchRenderer("Grep");
export const fffMultiGrepToolRenderer = createSearchRenderer("Multi Grep");
