import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { TUI } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../config/settings";
import type { SessionMessageEntry } from "../../../session/session-entries";
import { getThemeByName, setThemeInstance } from "../../theme/theme";
import { LastTurnViewer } from "../last-turn-viewer";

const strip = (lines: readonly string[]): string => Bun.stripANSI(lines.join("\n")).replace(/\x1b\]133;[AB]\x07/g, "");

const ui = {
	requestRender() {},
	setFocus() {},
	terminal: { rows: 40 },
} as unknown as TUI;

let nextId = 0;
const nextEntryId = (): string => `message-${++nextId}`;
const entryTimestamp = (): string => new Date().toISOString();
const messageTimestamp = (): number => Date.now();
const assistantUsage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userEntry(text: string): SessionMessageEntry {
	return {
		type: "message",
		id: nextEntryId(),
		parentId: null,
		timestamp: entryTimestamp(),
		message: { role: "user", content: text, timestamp: messageTimestamp() },
	};
}

function assistantEntry(text: string): SessionMessageEntry {
	return {
		type: "message",
		id: nextEntryId(),
		parentId: null,
		timestamp: entryTimestamp(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: assistantUsage,
			stopReason: "stop",
			timestamp: messageTimestamp(),
		},
	};
}

function makeViewer(
	entries: SessionMessageEntry[],
	overrides: Partial<ConstructorParameters<typeof LastTurnViewer>[0]> = {},
): LastTurnViewer {
	return new LastTurnViewer({
		entries,
		ui,
		cwd: process.cwd(),
		requestRender() {},
		onClose() {},
		...overrides,
	});
}

describe("LastTurnViewer", () => {
	const viewers: LastTurnViewer[] = [];

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

	it("renders only the passed-in latest turn when earlier entries are omitted", () => {
		const entries = [
			userEntry("earlier-question"),
			assistantEntry("earlier-reply"),
			userEntry("latest-question"),
			assistantEntry("latest-reply"),
		];
		const fullViewer = makeViewer(entries);
		const latestOnlyViewer = makeViewer(entries.slice(2));
		viewers.push(fullViewer, latestOnlyViewer);

		const fullText = strip(fullViewer.render(80));
		const latestOnlyText = strip(latestOnlyViewer.render(80));

		expect(fullText).toContain("earlier-question");
		expect(fullText).toContain("earlier-reply");
		expect(latestOnlyText).toContain("latest-question");
		expect(latestOnlyText).toContain("latest-reply");
		expect(latestOnlyText).not.toContain("earlier-question");
		expect(latestOnlyText).not.toContain("earlier-reply");
	});

	it("closes on Esc without requesting a rerender", () => {
		let closeCalls = 0;
		let renderCalls = 0;
		const viewer = makeViewer([userEntry("latest-question"), assistantEntry("latest-reply")], {
			onClose: () => {
				closeCalls++;
			},
			requestRender: () => {
				renderCalls++;
			},
		});
		viewers.push(viewer);

		viewer.handleInput("\x1b");

		expect(closeCalls).toBe(1);
		expect(renderCalls).toBe(0);
	});

	it("requests a rerender for transcript scroll keys", () => {
		let renderCalls = 0;
		const viewer = makeViewer([userEntry("latest-question"), assistantEntry("latest-reply")], {
			requestRender: () => {
				renderCalls++;
			},
		});
		viewers.push(viewer);

		for (const key of ["j", "k", "g", "G"] as const) {
			viewer.handleInput(key);
		}

		expect(renderCalls).toBe(4);
	});
});
