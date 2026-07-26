import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { tSettingsUi } from "../i18n/settings-locale";
import type { Theme } from "../modes/theme/theme";
import { framedBlock, renderStatusLine, resolveBareOutputBlockBorderStyle } from "../tui";
import {
	formatErrorDetail,
	replaceTabs,
	shortenPath,
	toolDetailMaxLines,
	truncateMiddleLines,
	truncateToWidth,
} from "./render-utils";

interface InspectImageRenderArgs {
	path?: string;
	question?: string;
}

interface InspectImageRendererDetails {
	model: string;
	imagePath: string;
	mimeType: string;
}

interface InspectImageRendererResult {
	content: Array<{ type: string; text?: string }>;
	details?: InspectImageRendererDetails;
	isError?: boolean;
}

const INSPECT_QUESTION_PREVIEW_WIDTH = 100;
const INSPECT_OUTPUT_LINE_WIDTH = 120;

function questionLine(question: string, uiTheme: Theme): string {
	return `${uiTheme.fg("dim", tSettingsUi("Question:"))} ${uiTheme.fg("accent", truncateToWidth(replaceTabs(question), INSPECT_QUESTION_PREVIEW_WIDTH))}`;
}

export const inspectImageToolRenderer = {
	transcriptSurface: "bare" as const,
	renderCall(args: InspectImageRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const rawPath = typeof args.path === "string" ? args.path : "";
		const pathDisplay = rawPath ? shortenPath(rawPath) : "…";
		const header = renderStatusLine(
			{ icon: "pending", title: tSettingsUi("Inspect"), description: pathDisplay },
			uiTheme,
		);
		const question = typeof args.question === "string" ? args.question.trim() : "";
		if (!question) return new Text(header, 0, 0);
		const tree = ` ${uiTheme.fg("dim", uiTheme.tree.last)} ${questionLine(question, uiTheme)}`;
		return new Text(`${header}\n${tree}`, 0, 0);
	},

	renderResult(
		result: InspectImageRendererResult,
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: InspectImageRenderArgs,
	): Component {
		const details = result.details;
		const rawPath =
			typeof details?.imagePath === "string" ? details.imagePath : typeof args?.path === "string" ? args.path : "";
		const pathDisplay = rawPath ? shortenPath(rawPath) : tSettingsUi("image");
		const success = !result.isError;
		const header = renderStatusLine(
			success
				? {
						iconOverride: uiTheme.styledSymbol("tool.inspectImage", "accent"),
						title: tSettingsUi("Inspect"),
						description: pathDisplay,
					}
				: {
						icon: "error",
						title: tSettingsUi("Inspect"),
						description: pathDisplay,
					},
			uiTheme,
		);

		const question = typeof args?.question === "string" ? args.question.trim() : "";
		const outputText = result.content.find(content => content.type === "text")?.text?.trimEnd() ?? "";

		if (result.isError) {
			return framedBlock(uiTheme, width => {
				const bodyLines: string[] = [];
				if (question) bodyLines.push(questionLine(question, uiTheme));
				bodyLines.push(formatErrorDetail(outputText || tSettingsUi("inspect failed"), uiTheme));
				return {
					header,
					sections: [{ lines: bodyLines }],
					state: "error",
					borderColor: "error",
					applyBg: false,
					borderStyle: resolveBareOutputBlockBorderStyle(),
					width,
				};
			});
		}

		const metaParts: string[] = [];
		if (details?.model) metaParts.push(details.model);
		if (details?.mimeType) metaParts.push(details.mimeType);
		const metaLine = metaParts.length > 0 ? uiTheme.fg("dim", metaParts.join(" · ")) : "";

		// No answer text: nothing worth boxing — keep it to a clean status line
		// (plus a trailing meta line, when present).
		if (!outputText) {
			return new Text(metaLine ? `${header}\n${metaLine}` : header, 0, 0);
		}

		return framedBlock(uiTheme, width => {
			const bodyLines: string[] = [];
			if (question) {
				bodyLines.push(questionLine(question, uiTheme));
				bodyLines.push("");
			}

			const outputLines = replaceTabs(outputText).split("\n");
			for (const line of outputLines) {
				bodyLines.push(uiTheme.fg("toolOutput", truncateToWidth(line, INSPECT_OUTPUT_LINE_WIDTH)));
			}
			const detailLines = options.expanded ? bodyLines : truncateMiddleLines(bodyLines, toolDetailMaxLines());

			return {
				header,
				headerMeta: metaLine || undefined,
				sections: [{ lines: detailLines }],
				state: "success",
				borderColor: "borderMuted",
				applyBg: false,
				borderStyle: resolveBareOutputBlockBorderStyle(),
				width,
			};
		});
	},
	mergeCallAndResult: true,
};
