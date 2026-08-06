import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../src/config/settings";
import { getSettingsUiLocale, type SettingsUiLocale, setSettingsUiLocale } from "../../../src/i18n/settings-locale";
import {
	SessionHistoryViewer,
	type SessionHistoryViewerDeps,
} from "../../../src/modes/components/session-history-viewer";
import { getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";
import type { SessionMessageEntry } from "../../../src/session/session-entries";

const SCROLLBAR_THUMB = "█";
const ALT_J = "\x1bj";
const ALT_K = "\x1bk";

const strip = (lines: readonly string[]): string => Bun.stripANSI(lines.join("\n")).replace(/\x1b\]133;[AB]\x07/g, "");

function withLocale<T>(locale: SettingsUiLocale, fn: () => T): T {
	const previousLocale = getSettingsUiLocale();
	setSettingsUiLocale(locale);
	try {
		return fn();
	} finally {
		setSettingsUiLocale(previousLocale);
	}
}

const terminalRowsByViewer = new WeakMap<SessionHistoryViewer, { value: number }>();

function renderWithRows(viewer: SessionHistoryViewer, width: number, rows: number): readonly string[] {
	const terminalRows = terminalRowsByViewer.get(viewer);
	if (!terminalRows) throw new Error("missing terminal-row seam for viewer");
	terminalRows.value = rows;
	return viewer.render(width);
}

function renderText(viewer: SessionHistoryViewer, width: number, rows: number): string {
	return strip(renderWithRows(viewer, width, rows));
}

function typeInto(viewer: SessionHistoryViewer, text: string): void {
	for (const character of text) viewer.handleInput(character);
}

function wheel(direction: "up" | "down"): string {
	return `\x1b[<${direction === "down" ? 65 : 64};1;1M`;
}

function scrollToTurnStart(viewer: SessionHistoryViewer, width: number, rows: number, marker: string): void {
	viewer.handleInput("g");
	for (let steps = 0; steps < 256; steps++) {
		const firstViewportLine = strip(renderWithRows(viewer, width, rows).slice(3, 4));
		if (firstViewportLine.includes(marker)) return;
		viewer.handleInput("j");
	}
	throw new Error(`could not scroll ${marker} to the top of the viewport`);
}

const ui = {
	requestRender() {},
	setFocus() {},
	terminal: { rows: 40 },
} as unknown as TUI;

const assistantUsage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userEntry(id: string, text: string, synthetic = false): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2025-01-01T00:00:00.000Z",
		message: { role: "user", content: text, synthetic, timestamp: 1_735_689_600_000 },
	};
}

function assistantEntry(id: string, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2025-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: assistantUsage,
			stopReason: "stop",
			timestamp: 1_735_689_600_000,
		},
	};
}

function longMessage(marker: string): string {
	return `${marker} ${"wrapped-cell ".repeat(48)}`;
}

function anchorEntries(): SessionMessageEntry[] {
	return [
		userEntry("real-user-one", longMessage("REAL_TURN_ONE")),
		assistantEntry("assistant-one", "reply after the first real turn"),
		userEntry("real-user-two", longMessage("REAL_TURN_TWO")),
		assistantEntry("assistant-two", "reply after the second real turn"),
		userEntry("real-user-three", longMessage("REAL_TURN_THREE")),
		assistantEntry("assistant-three", "reply after the third real turn"),
		userEntry("synthetic-user", "SYNTHETIC_TURN_MUST_NOT_BE_AN_ANCHOR", true),
	];
}

function makeViewer(
	entries: SessionMessageEntry[],
	overrides: Partial<SessionHistoryViewerDeps> = {},
): SessionHistoryViewer {
	const terminalRows = { value: 40 };
	const viewer = new SessionHistoryViewer({
		entries,
		ui,
		cwd: process.cwd(),
		requestRender() {},
		onClose() {},
		...overrides,
		getTerminalRows: () => terminalRows.value,
	});
	terminalRowsByViewer.set(viewer, terminalRows);
	return viewer;
}

describe("SessionHistoryViewer", () => {
	const viewers: SessionHistoryViewer[] = [];

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterEach(() => {
		for (const viewer of viewers) viewer.dispose();
		viewers.length = 0;
	});

	it("renders every active-branch message and draws an application scrollbar for overflow", () => {
		withLocale("en", () => {
			const viewer = makeViewer([
				userEntry("first-user", "HISTORY_FIRST_USER"),
				assistantEntry("first-assistant", "HISTORY_FIRST_ASSISTANT"),
				userEntry("second-user", "HISTORY_SECOND_USER"),
				assistantEntry("second-assistant", "HISTORY_SECOND_ASSISTANT"),
				userEntry("third-user", "HISTORY_THIRD_USER"),
				assistantEntry("third-assistant", "HISTORY_THIRD_ASSISTANT"),
			]);
			viewers.push(viewer);

			const completeTranscript = renderText(viewer, 100, 40);
			for (const marker of [
				"HISTORY_FIRST_USER",
				"HISTORY_FIRST_ASSISTANT",
				"HISTORY_SECOND_USER",
				"HISTORY_SECOND_ASSISTANT",
				"HISTORY_THIRD_USER",
				"HISTORY_THIRD_ASSISTANT",
			]) {
				expect(completeTranscript).toContain(marker);
			}

			expect(renderText(viewer, 80, 8)).toContain(SCROLLBAR_THUMB);
		});
	});

	it("starts at the bottom while ordinary scroll controls move the transcript window", () => {
		withLocale("en", () => {
			const viewer = makeViewer([
				userEntry("scroll-top", "SCROLL_TOP_MARKER"),
				assistantEntry("scroll-one", "SCROLL_ONE_MARKER"),
				userEntry("scroll-two", "SCROLL_TWO_MARKER"),
				assistantEntry("scroll-bottom", "SCROLL_BOTTOM_MARKER"),
			]);
			viewers.push(viewer);

			const bottom = renderText(viewer, 80, 7);
			expect(bottom).toContain("SCROLL_BOTTOM_MARKER");
			expect(bottom).not.toContain("SCROLL_TOP_MARKER");

			viewer.handleInput("g");
			expect(renderText(viewer, 80, 7)).toContain("SCROLL_TOP_MARKER");

			typeInto(viewer, "j".repeat(8));
			expect(renderText(viewer, 80, 7)).not.toContain("SCROLL_TOP_MARKER");
			typeInto(viewer, "k".repeat(8));
			expect(renderText(viewer, 80, 7)).toContain("SCROLL_TOP_MARKER");

			viewer.handleInput("\x1b[6~");
			expect(renderText(viewer, 80, 7)).not.toContain("SCROLL_TOP_MARKER");
			viewer.handleInput("\x1b[5~");
			expect(renderText(viewer, 80, 7)).toContain("SCROLL_TOP_MARKER");

			viewer.handleInput(wheel("down"));
			expect(renderText(viewer, 80, 7)).not.toContain("SCROLL_TOP_MARKER");
			viewer.handleInput(wheel("up"));
			expect(renderText(viewer, 80, 7)).toContain("SCROLL_TOP_MARKER");

			viewer.handleInput("G");
			expect(renderText(viewer, 80, 7)).toContain("SCROLL_BOTTOM_MARKER");
		});
	});

	for (const width of [28, 96]) {
		it(`jumps only between real user turns at ${width} columns`, () => {
			withLocale("en", () => {
				const viewer = makeViewer(anchorEntries());
				viewers.push(viewer);

				renderText(viewer, width, 10);
				viewer.handleInput(ALT_K);
				expect(renderText(viewer, width, 10)).toContain("REAL_TURN_TWO");
				viewer.handleInput(ALT_K);
				expect(renderText(viewer, width, 10)).toContain("REAL_TURN_ONE");
				viewer.handleInput(ALT_J);
				expect(renderText(viewer, width, 10)).toContain("REAL_TURN_TWO");
				viewer.handleInput(ALT_J);
				expect(renderText(viewer, width, 10)).toContain("REAL_TURN_THREE");
			});
		});
	}

	it("navigates real user turns with Ghostty macOS Option+J/K text sequences", () => {
		withLocale("en", () => {
			const viewer = makeViewer(anchorEntries());
			viewers.push(viewer);

			renderText(viewer, 96, 10);
			for (const [input, marker] of [
				["\u02da", "REAL_TURN_TWO"],
				["\u02da", "REAL_TURN_ONE"],
				["\u2206", "REAL_TURN_TWO"],
				["\u2206", "REAL_TURN_THREE"],
			] as const) {
				viewer.handleInput(input);
				expect(renderText(viewer, 96, 10)).toContain(marker);
			}
		});
	});

	it("keeps Ghostty macOS Option+J/K text sequences in the focused search input", () => {
		withLocale("en", () => {
			const viewer = makeViewer(anchorEntries());
			viewers.push(viewer);

			renderText(viewer, 96, 10);
			viewer.handleInput(ALT_K);
			viewer.handleInput(ALT_K);
			expect(renderText(viewer, 96, 10)).toContain("REAL_TURN_ONE");

			viewer.handleInput("/");
			viewer.handleInput("˚");
			viewer.handleInput("∆");
			const searching = renderText(viewer, 96, 10);
			expect(searching).toContain("Search: ˚∆");

			viewer.handleInput("\x1b");
			expect(renderText(viewer, 96, 10)).toContain("REAL_TURN_ONE");
		});
	});

	for (const width of [28, 96]) {
		it(`anchors Alt+J/K at the manually scrolled middle turn at ${width} columns`, () => {
			withLocale("en", () => {
				const viewer = makeViewer(anchorEntries());
				viewers.push(viewer);

				renderText(viewer, width, 10);
				scrollToTurnStart(viewer, width, 10, "REAL_TURN_TWO");
				expect(renderText(viewer, width, 10)).toContain("REAL_TURN_TWO");
				viewer.handleInput(ALT_J);
				expect(renderText(viewer, width, 10)).toContain("REAL_TURN_THREE");

				scrollToTurnStart(viewer, width, 10, "REAL_TURN_TWO");
				expect(renderText(viewer, width, 10)).toContain("REAL_TURN_TWO");
				viewer.handleInput(ALT_K);
				expect(renderText(viewer, width, 10)).toContain("REAL_TURN_ONE");
			});
		});
	}

	it("recomputes user-turn row anchors after a width-dependent reflow", () => {
		withLocale("en", () => {
			for (const [initialWidth, width] of [
				[28, 96],
				[96, 28],
			] as const) {
				const viewer = makeViewer(anchorEntries());
				viewers.push(viewer);

				renderText(viewer, initialWidth, 10);
				renderText(viewer, width, 10);
				viewer.handleInput(ALT_K);
				expect(renderText(viewer, width, 10)).toContain("REAL_TURN_TWO");
			}
		});
	});

	it("accepts slash search input and Enter jumps to a case-insensitive transcript match", () => {
		withLocale("en", () => {
			const viewer = makeViewer([
				userEntry("lookup-first", "UPPERCASE_LOOKUP_TARGET"),
				assistantEntry("lookup-gap-one", longMessage("LOOKUP_GAP_ONE")),
				userEntry("lookup-last", "LOOKUP_UNRELATED_BOTTOM"),
				assistantEntry("lookup-gap-two", longMessage("LOOKUP_GAP_TWO")),
			]);
			viewers.push(viewer);

			expect(renderText(viewer, 72, 8)).not.toContain("UPPERCASE_LOOKUP_TARGET");
			viewer.handleInput("/");
			typeInto(viewer, "lookup_target");
			expect(renderText(viewer, 72, 8)).toContain("lookup_target");
			viewer.handleInput("\n");
			expect(renderText(viewer, 72, 8)).toContain("UPPERCASE_LOOKUP_TARGET");
		});
	});

	it("treats lower- and upper-case n as search text until Enter, then navigates matches", () => {
		withLocale("en", () => {
			const viewer = makeViewer([
				userEntry("query-first", "QUERYnN_FIRST"),
				assistantEntry("query-gap-one", longMessage("FILLER_ONE")),
				userEntry("query-second", "QUERYnN_SECOND"),
				assistantEntry("query-gap-two", longMessage("FILLER_TWO")),
				userEntry("query-third", "QUERYnN_THIRD"),
				assistantEntry("query-gap-three", longMessage("FILLER_THREE")),
			]);
			viewers.push(viewer);

			renderText(viewer, 72, 8);
			viewer.handleInput("/");
			typeInto(viewer, "query");
			viewer.handleInput("\n");
			expect(renderText(viewer, 72, 8)).toContain("QUERYnN_FIRST");
			viewer.handleInput("n");
			expect(renderText(viewer, 72, 8)).toContain("QUERYnN_SECOND");

			viewer.handleInput("/");
			typeInto(viewer, "nN");
			expect(renderText(viewer, 72, 8)).toContain("Search: querynN");
			viewer.handleInput("\n");
			expect(renderText(viewer, 72, 8)).toContain("QUERYnN_FIRST");

			viewer.handleInput("n");
			expect(renderText(viewer, 72, 8)).toContain("QUERYnN_SECOND");
			viewer.handleInput("N");
			expect(renderText(viewer, 72, 8)).toContain("QUERYnN_FIRST");
		});
	});

	it("wraps n and N through case-insensitive visible transcript matches", () => {
		withLocale("en", () => {
			const viewer = makeViewer([
				userEntry("match-first", "MATCH_FIRST"),
				assistantEntry("match-gap-one", longMessage("FILLER_ONE")),
				userEntry("match-second", "mAtCh_SECOND"),
				assistantEntry("match-gap-two", longMessage("FILLER_TWO")),
				userEntry("match-third", "match_THIRD"),
				assistantEntry("match-gap-three", longMessage("FILLER_THREE")),
			]);
			viewers.push(viewer);

			renderText(viewer, 72, 8);
			viewer.handleInput("/");
			typeInto(viewer, "match");
			viewer.handleInput("\n");
			expect(renderText(viewer, 72, 8)).toContain("MATCH_FIRST");

			viewer.handleInput("n");
			expect(renderText(viewer, 72, 8)).toContain("mAtCh_SECOND");
			viewer.handleInput("n");
			expect(renderText(viewer, 72, 8)).toContain("match_THIRD");
			viewer.handleInput("n");
			expect(renderText(viewer, 72, 8)).toContain("MATCH_FIRST");
			viewer.handleInput("N");
			expect(renderText(viewer, 72, 8)).toContain("match_THIRD");
		});
	});

	it("exits an unmatched search before Esc closes the viewer", () => {
		withLocale("en", () => {
			let closeCalls = 0;
			const viewer = makeViewer([userEntry("searchable-user", "ordinary transcript text")], {
				onClose: () => {
					closeCalls++;
				},
			});
			viewers.push(viewer);

			renderText(viewer, 72, 8);
			viewer.handleInput("/");
			typeInto(viewer, "missing-transcript-value");
			viewer.handleInput("\n");
			expect(renderText(viewer, 72, 8)).toContain("No matches");

			viewer.handleInput("\x1b");
			expect(closeCalls).toBe(0);
			expect(renderText(viewer, 72, 8)).not.toContain("No matches");

			viewer.handleInput("\x1b");
			expect(closeCalls).toBe(1);
		});
	});

	it("keeps the history header and empty state within both wide and narrow widths", () => {
		withLocale("en", () => {
			const viewer = makeViewer([]);
			viewers.push(viewer);

			const fullHint = "Esc:close  j/k:scroll  Alt+J/K:turn  /:search  n/N:match  g/G:top/bottom";
			const wide = renderText(viewer, 100, 8);
			expect(wide).toContain("Session history");
			expect(wide).toContain("No history yet");
			expect(wide).toContain(fullHint);

			const narrowLines = renderText(viewer, 24, 8).split("\n");
			expect(narrowLines.some(line => line.includes("Session history"))).toBe(true);
			expect(narrowLines.join("\n")).toContain("No history yet");
			expect(narrowLines.every(line => visibleWidth(line) <= 24)).toBe(true);
		});
	});
});
