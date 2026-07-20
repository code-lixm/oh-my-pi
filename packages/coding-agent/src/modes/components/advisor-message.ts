import { type Component, Markdown } from "@oh-my-pi/pi-tui";
import type { AdvisorMessageDetails, AdvisorSeverity } from "../../advisor";
import { tSettingsUi } from "../../i18n/settings-locale";
import { replaceTabs } from "../../tools/render-utils";
import { framedBlock, outputBlockContentWidth, renderStatusLine } from "../../tui";
import { getMarkdownTheme, type Theme, type ThemeColor } from "../theme/theme";

function severityColor(severity: AdvisorSeverity | undefined): ThemeColor {
	switch (severity ?? "nit") {
		case "blocker":
			return "error";
		case "concern":
			return "warning";
		case "nit":
			return "customMessageLabel";
	}
}

function dominantSeverity(notes: AdvisorMessageDetails["notes"]): AdvisorSeverity {
	let severity: AdvisorSeverity = "nit";
	for (const note of notes) {
		if (note.severity === "blocker") return "blocker";
		if (note.severity === "concern") severity = "concern";
	}
	return severity;
}
function hasMixedSeverities(notes: AdvisorMessageDetails["notes"]): boolean {
	const first = notes[0]?.severity ?? "nit";
	for (let index = 1; index < notes.length; index++) {
		if ((notes[index]?.severity ?? "nit") !== first) return true;
	}
	return false;
}

/**
 * Display-only transcript card for advisor notes injected into the primary
 * session. The shared framed-block chrome keeps it aligned with tool cards;
 * each note body uses the standard Markdown renderer so paragraph and list
 * continuation indentation stays consistent without a custom quote rail.
 */
export function createAdvisorMessageCard(details: AdvisorMessageDetails | undefined, uiTheme: Theme): Component {
	const notes = details?.notes ?? [];
	const blockers = notes.filter(note => note.severity === "blocker").length;
	const concerns = notes.filter(note => note.severity === "concern").length;
	const nits = notes.length - blockers - concerns;
	const cardSeverity = dominantSeverity(notes);
	const mixedSeverities = hasMixedSeverities(notes);
	let title = tSettingsUi("Advisor");
	if (notes.length > 0) {
		if (mixedSeverities) {
			title = tSettingsUi(notes.length === 1 ? "Advisor found {count} issue" : "Advisor found {count} issues", {
				count: notes.length,
			});
		} else if (blockers > 0) {
			title = tSettingsUi(blockers === 1 ? "Advisor found {count} blocker" : "Advisor found {count} blockers", {
				count: blockers,
			});
		} else if (concerns > 0) {
			title = tSettingsUi(concerns === 1 ? "Advisor found {count} concern" : "Advisor found {count} concerns", {
				count: concerns,
			});
		} else {
			title = tSettingsUi(nits === 1 ? "Advisor found {count} nit" : "Advisor found {count} nits", { count: nits });
		}
	}
	const header = renderStatusLine(
		{
			icon: "info",
			title,
			titleColor: "customMessageLabel",
		},
		uiTheme,
	);
	const state = mixedSeverities
		? undefined
		: cardSeverity === "blocker"
			? "error"
			: cardSeverity === "concern"
				? "warning"
				: "success";

	return framedBlock(uiTheme, width => {
		const contentWidth = outputBlockContentWidth(width);
		const sections = notes.map(entry => {
			const labelParts: string[] = [];
			if (entry.advisor && entry.advisor !== "default") {
				labelParts.push(uiTheme.fg("dim", `[${replaceTabs(entry.advisor)}]`));
			}
			const markdown = new Markdown(replaceTabs(entry.note), 0, 0, getMarkdownTheme(uiTheme), {
				color: line => uiTheme.fg(severityColor(entry.severity), line),
			});
			return {
				lines: [...(labelParts.length > 0 ? [labelParts.join(" ")] : []), ...markdown.render(contentWidth)],
			};
		});

		return {
			header,
			sections,
			state,
			borderColor: mixedSeverities ? "borderMuted" : severityColor(cardSeverity),
			width,
		};
	});
}
