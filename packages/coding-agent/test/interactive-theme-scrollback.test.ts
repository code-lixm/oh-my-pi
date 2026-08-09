import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	enableAutoTheme,
	getCurrentThemeName,
	getThemeEpoch,
	initTheme,
	previewTheme,
	setTheme,
	stopThemeWatcher,
	theme,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TUI } from "@oh-my-pi/pi-tui";
import type { TerminalAppearance, TerminalAppearanceRequestToken } from "@oh-my-pi/pi-tui/terminal";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const MULTIPLEXER_ENV_KEYS = [
	"TMUX",
	"STY",
	"ZELLIJ",
	"HERDR_ENV",
	"CMUX_WORKSPACE_ID",
	"CMUX_SURFACE_ID",
	"TERM",
] as const;
const FULL_SCROLLBACK_CLEAR = "\x1b[H\x1b[3J";

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	let from = 0;
	while (from <= text.length) {
		const index = text.indexOf(needle, from);
		if (index < 0) return count;
		count++;
		from = index + needle.length;
	}
	return count;
}

function expectMarkersExactlyOnce(text: string, markers: readonly string[]): void {
	let lastIndex = -1;
	for (const marker of markers) {
		expect(countOccurrences(text, marker)).toBe(1);
		const index = text.indexOf(marker);
		expect(index).toBeGreaterThan(lastIndex);
		lastIndex = index;
	}
}

function extractMarkerRows(rows: readonly string[], markers: readonly string[]): string[] {
	const matched: string[] = [];
	for (const row of rows) {
		if (markers.some(marker => row.includes(marker))) matched.push(row);
	}
	return matched;
}

function captureWrites(terminal: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = terminal.write.bind(terminal);
	vi.spyOn(terminal, "write").mockImplementation(data => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

async function seedStyledHistory(
	mode: InteractiveMode,
	terminal: VirtualTerminal,
): Promise<{
	markers: string[];
	markerRows: string[];
	baseY: number;
}> {
	const beforeBaseY = terminal.getBufferPosition().baseY;
	const markers = Array.from({ length: 8 }, (_, i) => `THEME_SCROLLBACK_ROW_${i}`);
	for (const [i, marker] of markers.entries()) {
		mode.addMessageToChat({
			role: "user",
			content: `${marker} Keep this replayed exactly once.`,
			timestamp: 1_730_000_000_000 + i,
		});
	}
	mode.ui.requestRender(true);
	await terminal.waitForRender();

	const { baseY } = terminal.getBufferPosition();
	expect(baseY).toBeGreaterThan(beforeBaseY);
	const bufferRows = terminal.getScrollBuffer();
	const markerRows = extractMarkerRows(bufferRows, markers);
	expect(markerRows).toHaveLength(markers.length);
	expectMarkersExactlyOnce(bufferRows.join("\n"), markers);
	return { markers, markerRows, baseY };
}

class AppearanceVirtualTerminal extends VirtualTerminal {
	#appearance?: TerminalAppearance;
	#appearanceChangeCallbacks = new Set<
		(appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void
	>();
	#appearanceReportCallbacks = new Set<
		(appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void
	>();
	#nextAppearanceRequestToken = 0;
	appearanceOnRefresh?: TerminalAppearance;
	returnRefreshToken = true;
	deferRefreshReport = true;
	override get appearance(): TerminalAppearance | undefined {
		return this.#appearance;
	}

	override onAppearanceChange(
		callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void,
	): () => void {
		this.#appearanceChangeCallbacks.add(callback);
		return () => this.#appearanceChangeCallbacks.delete(callback);
	}

	onAppearanceReport(
		callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void,
	): () => void {
		this.#appearanceReportCallbacks.add(callback);
		return () => this.#appearanceReportCallbacks.delete(callback);
	}

	refreshAppearance(requestToken?: TerminalAppearanceRequestToken): TerminalAppearanceRequestToken | void {
		const token = requestToken ?? ++this.#nextAppearanceRequestToken;
		if (token > this.#nextAppearanceRequestToken) {
			this.#nextAppearanceRequestToken = token;
		}
		const appearance = this.appearanceOnRefresh;
		if (appearance !== undefined) {
			const emit = () => this.emitAppearanceReport(appearance, this.returnRefreshToken ? token : undefined);
			if (this.deferRefreshReport) {
				queueMicrotask(emit);
			} else {
				emit();
			}
		}
		return this.returnRefreshToken ? token : undefined;
	}

	emitAppearanceReport(appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken): void {
		for (const callback of this.#appearanceReportCallbacks) callback(appearance, requestToken);
		if (appearance === this.#appearance) return;
		this.#appearance = appearance;
		for (const callback of this.#appearanceChangeCallbacks) callback(appearance, requestToken);
	}
}

async function waitForThemeEpochToAdvance(previousEpoch: number): Promise<void> {
	for (let attempts = 0; attempts < 1_000; attempts++) {
		if (getThemeEpoch() > previousEpoch) return;
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
	}
	throw new Error(`Theme epoch did not advance from ${previousEpoch}`);
}

// Adaptive TUI backpressure uses real scheduling, so fake timers cannot observe the committed write.
async function waitForCapturedWrite(writes: readonly string[], needle: string): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!writes.join("").includes(needle)) {
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for captured write containing ${JSON.stringify(needle)}`);
		}
		await Bun.sleep(5);
	}
}

let originalMultiplexerEnv: Partial<Record<(typeof MULTIPLEXER_ENV_KEYS)[number], string | undefined>>;
describe("InteractiveMode theme scrollback refresh", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let terminal: AppearanceVirtualTerminal;

	beforeEach(async () => {
		originalMultiplexerEnv = {};
		for (const key of MULTIPLEXER_ENV_KEYS) {
			originalMultiplexerEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-theme-scrollback-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
		await initTheme();
		await setTheme("dark");

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		terminal = new AppearanceVirtualTerminal(100, 20);
		mode.ui = new TUI(terminal);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		mode?.stop();
		stopThemeWatcher();
		await setTheme("dark");
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		for (const key of MULTIPLEXER_ENV_KEYS) {
			const value = originalMultiplexerEnv[key];
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("clears physical history and fully replays the transcript when a theme is committed outside terminal multiplexers", async () => {
		await terminal.waitForRender();
		const { markers, markerRows, baseY } = await seedStyledHistory(mode, terminal);
		const beforeRedraws = mode.ui.fullRedraws;
		const darkUserBg = theme.getBgAnsi("userMessageBg");
		const writes = captureWrites(terminal);

		await setTheme("light");
		await terminal.waitForRender();

		const lightUserBg = theme.getBgAnsi("userMessageBg");
		expect(lightUserBg).not.toBe(darkUserBg);
		expect(mode.ui.fullRedraws).toBeGreaterThan(beforeRedraws);

		const renderedWrites = writes.join("");
		expect(countOccurrences(renderedWrites, FULL_SCROLLBACK_CLEAR)).toBe(1);
		const clearIndex = renderedWrites.indexOf(FULL_SCROLLBACK_CLEAR);
		expect(clearIndex).toBeGreaterThanOrEqual(0);
		const replay = renderedWrites.slice(clearIndex + FULL_SCROLLBACK_CLEAR.length);
		expect(replay).toContain(lightUserBg);
		expect(replay).not.toContain(darkUserBg);
		expectMarkersExactlyOnce(replay, markers);

		const finalRows = terminal.getScrollBuffer();
		expect(extractMarkerRows(finalRows, markers)).toEqual(markerRows);
		expectMarkersExactlyOnce(finalRows.join("\n"), markers);
		expect(terminal.getBufferPosition().baseY).toBe(baseY);
	});
	it("preserves pane history and repaints with the committed theme inside terminal multiplexers", async () => {
		await terminal.waitForRender();
		Bun.env.TMUX = "/tmp/tmux-1000/default,1,0";
		Bun.env.TERM = "tmux-256color";
		await seedStyledHistory(mode, terminal);
		const paneHistoryMarker = "THEME_SCROLLBACK_PANE_HISTORY";
		// Pane-owned history cannot be reconstructed from the semantic transcript.
		terminal.write(`${paneHistoryMarker}\r\n${"\r\n".repeat(terminal.rows)}`);
		const paneHistoryBeforeCommit = terminal.getScrollBuffer().slice(0, -terminal.rows).join("\n");
		expect(paneHistoryBeforeCommit).toContain(paneHistoryMarker);
		const darkUserBg = theme.getBgAnsi("userMessageBg");
		const writes = captureWrites(terminal);

		await setTheme("light");
		const lightUserBg = theme.getBgAnsi("userMessageBg");
		await waitForCapturedWrite(writes, lightUserBg);

		expect(lightUserBg).not.toBe(darkUserBg);
		const commitWrites = writes.join("");
		expect(commitWrites).not.toContain(FULL_SCROLLBACK_CLEAR);
		expect(commitWrites).toContain(lightUserBg);
		expect(commitWrites).not.toContain(darkUserBg);

		const paneHistoryAfterCommit = terminal.getScrollBuffer().slice(0, -terminal.rows).join("\n");
		expect(paneHistoryAfterCommit).toContain(paneHistoryMarker);

		writes.length = 0;
		const postCommitMarker = "THEME_SCROLLBACK_LIGHT_APPEND";
		mode.addMessageToChat({
			role: "user",
			content: `${postCommitMarker} Uses the committed light theme.`,
			timestamp: 1_730_000_000_100,
		});
		mode.ui.requestRender();
		await terminal.waitForRender();

		const postCommitWrites = writes.join("");
		expect(postCommitWrites).toContain(postCommitMarker);
		expect(postCommitWrites).toContain(lightUserBg);
		expect(postCommitWrites).not.toContain(darkUserBg);
		expect(terminal.getViewport().join("\n")).toContain(postCommitMarker);
	});

	it("preserves the viewport on automatic appearance changes until Alt+L requests a full replay", async () => {
		terminal.emitAppearanceReport("dark");
		enableAutoTheme();
		await terminal.waitForRender();
		const fullRedraws = mode.ui.fullRedraws;
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});

		const epoch = getThemeEpoch();
		terminal.emitAppearanceReport("light");
		await waitForThemeEpochToAdvance(epoch);
		await terminal.waitForRender();
		expect(getCurrentThemeName()).toBe("light");

		expect(mode.ui.fullRedraws).toBe(fullRedraws);
		expect(writes.join("")).not.toContain("\x1b[3J");

		writes.length = 0;
		terminal.sendInput("\x1bl");
		await terminal.waitForRender();

		expect(mode.ui.fullRedraws).toBe(fullRedraws + 1);
		expect(writes.join("")).toContain("\x1b[3J");
	});
	it("keeps a queued Alt+L token correlated across an unrelated automatic report", async () => {
		terminal.emitAppearanceReport("dark");
		enableAutoTheme();
		await terminal.waitForRender();
		expect(getCurrentThemeName()).toBe("dark");

		const fullRedraws = mode.ui.fullRedraws;
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		terminal.appearanceOnRefresh = "light";

		const epoch = getThemeEpoch();
		terminal.sendInput("\x1bl");
		// A queued automatic response may arrive before the explicit probe. It must
		// neither consume the Alt+L correlation nor classify its own change as the
		// explicit response.
		terminal.emitAppearanceReport("dark");
		await waitForThemeEpochToAdvance(epoch);
		await terminal.waitForRender();

		expect(getCurrentThemeName()).toBe("light");
		expect(mode.ui.fullRedraws).toBe(fullRedraws + 2);
		expect(writes.join("").split("\x1b[3J")).toHaveLength(3);
	});

	it("replays with the new palette when an automatic response wins the queued Alt+L race", async () => {
		terminal.emitAppearanceReport("dark");
		enableAutoTheme();
		await terminal.waitForRender();
		const fullRedraws = mode.ui.fullRedraws;
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		terminal.appearanceOnRefresh = "light";

		const epoch = getThemeEpoch();
		terminal.sendInput("\x1bl");
		terminal.emitAppearanceReport("light");
		await waitForThemeEpochToAdvance(epoch);
		await terminal.waitForRender();
		await Promise.resolve();

		expect(getCurrentThemeName()).toBe("light");
		expect(mode.ui.fullRedraws).toBe(fullRedraws + 2);
		expect(writes.join("").split("\x1b[3J")).toHaveLength(3);
	});

	it("owns a synchronous refresh response before invoking the terminal", async () => {
		terminal.emitAppearanceReport("dark");
		enableAutoTheme();
		await terminal.waitForRender();
		expect(getCurrentThemeName()).toBe("dark");

		const fullRedraws = mode.ui.fullRedraws;
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		terminal.appearanceOnRefresh = "light";
		terminal.deferRefreshReport = false;

		const epoch = getThemeEpoch();
		terminal.sendInput("\x1bl");
		await waitForThemeEpochToAdvance(epoch);
		await terminal.waitForRender();

		expect(getCurrentThemeName()).toBe("light");
		expect(mode.ui.fullRedraws).toBe(fullRedraws + 2);
		expect(writes.join("").split("\x1b[3J")).toHaveLength(3);
	});

	it("consumes an unchanged Alt+L appearance report before a later automatic change", async () => {
		terminal.emitAppearanceReport("dark");
		enableAutoTheme();
		await terminal.waitForRender();
		expect(getCurrentThemeName()).toBe("dark");

		const fullRedraws = mode.ui.fullRedraws;
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		terminal.appearanceOnRefresh = "dark";

		terminal.sendInput("\x1bl");
		await terminal.waitForRender();
		await Promise.resolve();

		expect(mode.ui.fullRedraws).toBe(fullRedraws + 1);
		expect(writes.join("").split("\x1b[3J")).toHaveLength(2);

		const epoch = getThemeEpoch();
		terminal.emitAppearanceReport("light");
		await waitForThemeEpochToAdvance(epoch);
		await terminal.waitForRender();

		expect(getCurrentThemeName()).toBe("light");
		expect(mode.ui.fullRedraws).toBe(fullRedraws + 1);
		expect(writes.join("").split("\x1b[3J")).toHaveLength(2);
	});

	it("does not arm a committed replay when a custom terminal returns no token", async () => {
		terminal.emitAppearanceReport("dark");
		enableAutoTheme();
		await terminal.waitForRender();
		expect(getCurrentThemeName()).toBe("dark");

		const fullRedraws = mode.ui.fullRedraws;
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		terminal.returnRefreshToken = false;
		terminal.appearanceOnRefresh = "light";

		const epoch = getThemeEpoch();
		terminal.sendInput("\x1bl");
		await waitForThemeEpochToAdvance(epoch);
		await terminal.waitForRender();

		expect(getCurrentThemeName()).toBe("light");
		expect(mode.ui.fullRedraws).toBe(fullRedraws + 1);
		expect(writes.join("").split("\x1b[3J")).toHaveLength(2);
	});

	it("keeps theme previews as non-destructive viewport repaints", async () => {
		await terminal.waitForRender();
		const { markers, markerRows, baseY } = await seedStyledHistory(mode, terminal);
		const fullRedraws = mode.ui.fullRedraws;
		const writes = captureWrites(terminal);

		await previewTheme("light");
		await terminal.waitForRender();

		expect(mode.ui.fullRedraws).toBe(fullRedraws);
		expect(writes.join("")).not.toContain(FULL_SCROLLBACK_CLEAR);
		const finalRows = terminal.getScrollBuffer();
		expect(extractMarkerRows(finalRows, markers)).toEqual(markerRows);
		expectMarkersExactlyOnce(finalRows.join("\n"), markers);
		expect(terminal.getBufferPosition().baseY).toBe(baseY);
	});

	it("emits a clear-and-replay when a previewed theme is committed", async () => {
		await terminal.waitForRender();
		const { markers, markerRows, baseY } = await seedStyledHistory(mode, terminal);
		const darkUserBg = theme.getBgAnsi("userMessageBg");
		const writes = captureWrites(terminal);

		await previewTheme("light");
		await terminal.waitForRender();
		expect(writes.join("")).not.toContain(FULL_SCROLLBACK_CLEAR);
		writes.length = 0;

		const beforeCommitRedraws = mode.ui.fullRedraws;
		await previewTheme("light", { ephemeral: false });
		await terminal.waitForRender();

		const lightUserBg = theme.getBgAnsi("userMessageBg");
		expect(mode.ui.fullRedraws).toBeGreaterThan(beforeCommitRedraws);
		const commitWrites = writes.join("");
		expect(countOccurrences(commitWrites, FULL_SCROLLBACK_CLEAR)).toBe(1);
		const clearIndex = commitWrites.indexOf(FULL_SCROLLBACK_CLEAR);
		expect(clearIndex).toBeGreaterThanOrEqual(0);
		const replay = commitWrites.slice(clearIndex + FULL_SCROLLBACK_CLEAR.length);
		expect(replay).toContain(lightUserBg);
		expect(replay).not.toContain(darkUserBg);
		expectMarkersExactlyOnce(replay, markers);

		const finalRows = terminal.getScrollBuffer();
		expect(extractMarkerRows(finalRows, markers)).toEqual(markerRows);
		expectMarkersExactlyOnce(finalRows.join("\n"), markers);
		expect(terminal.getBufferPosition().baseY).toBe(baseY);
	});

	it("keeps auto-theme previews as non-destructive viewport repaints", async () => {
		await terminal.waitForRender();
		const { markers, markerRows, baseY } = await seedStyledHistory(mode, terminal);
		const originalColorFgBg = Bun.env.COLORFGBG;
		Bun.env.COLORFGBG = "0;15";
		const fullRedraws = mode.ui.fullRedraws;
		const writes = captureWrites(terminal);

		try {
			enableAutoTheme({ ephemeral: true });
			await terminal.waitForRender();
		} finally {
			if (originalColorFgBg === undefined) {
				delete Bun.env.COLORFGBG;
			} else {
				Bun.env.COLORFGBG = originalColorFgBg;
			}
		}

		expect(mode.ui.fullRedraws).toBe(fullRedraws);
		expect(writes.join("")).not.toContain(FULL_SCROLLBACK_CLEAR);
		const finalRows = terminal.getScrollBuffer();
		expect(extractMarkerRows(finalRows, markers)).toEqual(markerRows);
		expectMarkersExactlyOnce(finalRows.join("\n"), markers);
		expect(terminal.getBufferPosition().baseY).toBe(baseY);
	});
});
