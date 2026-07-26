import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { enableAutoTheme, initTheme, previewTheme, setTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TUI } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const MULTIPLEXER_ENV_KEYS = ["TMUX", "STY", "ZELLIJ", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "TERM"] as const;
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

let originalMultiplexerEnv: Partial<Record<(typeof MULTIPLEXER_ENV_KEYS)[number], string | undefined>>;
describe("InteractiveMode theme scrollback refresh", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let terminal: VirtualTerminal;

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
		terminal = new VirtualTerminal(80, 10);
		mode.ui = new TUI(terminal);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		mode?.stop();
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

	for (const scenario of [
		{
			name: "outside terminal multiplexers",
			setup: () => {},
		},
		{
			name: "inside terminal multiplexers",
			setup: () => {
				Bun.env.TMUX = "/tmp/tmux-1000/default,1,0";
				Bun.env.TERM = "tmux-256color";
			},
		},
	] as const) {
		it(`clears physical history and fully replays the transcript when a theme is committed ${scenario.name}`, async () => {
			await terminal.waitForRender();
			scenario.setup();
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
	}

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
