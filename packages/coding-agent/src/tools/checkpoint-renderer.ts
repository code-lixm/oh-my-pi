import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { Ellipsis, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import { replaceTabs } from "./render-utils";

type CheckpointRendererName = "Checkpoint" | "Rewind";
type CheckpointRendererArgs = { goal?: unknown; report?: unknown };

function argumentSummary(name: CheckpointRendererName, args: CheckpointRendererArgs | undefined): string | undefined {
	const value = name === "Checkpoint" ? args?.goal : args?.report;
	if (typeof value !== "string") return undefined;
	const normalized = replaceTabs(value.trim()).replace(/[\r\n]+/g, " ");
	return normalized ? truncateToWidth(normalized, 100, Ellipsis.Unicode) : undefined;
}

function resultLines(result: { content?: Array<{ type: string; text?: string }> }): string[] {
	return (
		result.content
			?.flatMap(block => (block.type === "text" && block.text ? replaceTabs(block.text).split("\n") : []))
			.map(line => line.trimEnd())
			.filter(line => line.trim().length > 0) ?? []
	);
}

export function createCheckpointToolRenderer(name: CheckpointRendererName) {
	return {
		inline: true,
		mergeCallAndResult: true,
		transcriptSurface: "bare" as const,
		renderCall(args: CheckpointRendererArgs, options: RenderResultOptions, theme: Theme): Component {
			const header = renderStatusLine(
				{
					icon: options.spinnerFrame === undefined ? "pending" : "running",
					spinnerFrame: options.spinnerFrame,
					title: name,
					description: argumentSummary(name, args),
				},
				theme,
			);
			return new Text(header, 0, 0);
		},
		renderResult(
			result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
			_options: RenderResultOptions,
			theme: Theme,
			args?: CheckpointRendererArgs,
		): Component {
			const lines = resultLines(result);
			const header = renderStatusLine(
				{
					icon: result.isError ? "error" : "success",
					iconOverride:
						!result.isError && name === "Rewind" ? theme.fg("toolTitle", theme.icon.rewind) : undefined,
					title: name,
					description: argumentSummary(name, args),
				},
				theme,
			);
			const body = renderTreeList(
				{
					items: lines.length > 0 ? lines : [result.isError ? "Operation failed" : "Completed"],
					expanded: true,
					renderItem: line => theme.fg(result.isError ? "error" : "toolOutput", line),
				},
				theme,
			);
			return new Text([header, ...body].join("\n"), 0, 0);
		},
	};
}
