import type { Component } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { tSettingsUi } from "../i18n/settings-locale";
import type { Theme } from "../modes/theme/theme";
import { framedBlock, renderStatusLine } from "../tui";
import type { YieldDetails } from "./yield";

type YieldRenderResult = {
	content: Array<{ type: string; text?: string }>;
	details?: YieldDetails;
	isError?: boolean;
};

const SCHEMA_OVERRIDE_MESSAGE = /^Result submitted \(schema validation overridden after (\d+) failed attempt\(s\)\)\.$/;

function displayResultText(result: YieldRenderResult): string {
	const fallback = result.content.find(part => part.type === "text")?.text?.trimEnd() ?? "";
	if (result.isError) return fallback;

	const details = result.details;
	const overrideAttempts = SCHEMA_OVERRIDE_MESSAGE.exec(fallback)?.[1];
	if (details?.status === "success" || fallback === "Result submitted." || overrideAttempts) {
		if (!details?.schemaOverridden && !overrideAttempts) return tSettingsUi("Result submitted.");
		return overrideAttempts
			? tSettingsUi("Result submitted (schema validation overridden after {count} failed attempt(s)).", {
					count: overrideAttempts,
				})
			: tSettingsUi("Result submitted (schema validation overridden).");
	}

	if (details?.status === "aborted") {
		return tSettingsUi("Task aborted: {error}", {
			error: details.error ?? fallback.replace(/^Task aborted:\s*/, ""),
		});
	}

	return fallback;
}

/** TUI renderer for subagent result submission cards. */
export const yieldToolRenderer = {
	mergeCallAndResult: true,

	renderCall(_args: unknown, _options: RenderResultOptions, uiTheme: Theme): Component {
		const header = renderStatusLine({ icon: "pending", title: tSettingsUi("Submit Result") }, uiTheme);
		return framedBlock(uiTheme, width => ({
			header,
			sections: [],
			state: "pending",
			borderColor: "borderMuted",
			width,
		}));
	},

	renderResult(result: YieldRenderResult, _options: RenderResultOptions, uiTheme: Theme): Component {
		const state = result.isError || result.details?.status === "aborted" ? "error" : "success";
		const header = renderStatusLine(
			{ icon: state === "error" ? "error" : "done", title: tSettingsUi("Submit Result") },
			uiTheme,
		);
		const text = displayResultText(result);
		const color = state === "error" ? "error" : "toolOutput";

		return framedBlock(uiTheme, width => ({
			header,
			sections: text ? [{ lines: text.split("\n").map(line => uiTheme.fg(color, line)) }] : [],
			state,
			borderColor: state === "error" ? "error" : "borderMuted",
			width,
		}));
	},
};
