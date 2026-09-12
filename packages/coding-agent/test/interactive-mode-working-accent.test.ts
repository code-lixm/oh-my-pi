import { afterAll, afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as sessionColor from "@oh-my-pi/pi-coding-agent/utils/session-color";
import { type Container, type NativeScrollbackLiveRegion, Text } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getSettingsUiLocale, setSettingsUiLocale } from "../src/i18n/settings-locale";

type Harness = {
	mode: InteractiveMode;
	sessionManager: SessionManager;
	tempDir: TempDir;
	/**
	 * Mutable agent state the stub session exposes; tests drive streaming from
	 * here. `isStreaming` is intentionally absent by default so the reconcile
	 * path keeps its pre-existing no-op behavior for tests that never set it.
	 */
	agentState: {
		tools: unknown[];
		isStreaming?: boolean;
		messages: unknown[];
		streamMessage: Record<string, unknown> | null;
		requestStartedAt?: number;
		firstByteAt?: number;
	};
};

let harness: Harness | undefined;

function defined<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Expected value to be defined");
	return value;
}

async function createHarness(sessionName: string): Promise<Harness> {
	if (harness) {
		harness.mode.loadingAnimation?.stop();
		harness.mode.loadingAnimation = undefined;
		harness.mode.statusContainer.disposeChildren();
		await harness.sessionManager.setSessionName(sessionName, "user");
		return harness;
	}

	const tempDir = TempDir.createSync("@pi-working-accent-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
	const sessionManager = SessionManager.inMemory(tempDir.path());
	await sessionManager.setSessionName(sessionName, "user");
	const agentState: Harness["agentState"] = { tools: [], messages: [], streamMessage: null };
	const session = {
		sessionManager,
		settings,
		getAgentId: () => MAIN_AGENT_ID,
		agent: {
			state: agentState,
			metadataForProvider: () => undefined,
		},
		customCommands: [],
		skills: [],
		autoCompactionEnabled: true,
		messages: [],
		systemPrompt: [],
		state: agentState,
		model: undefined,
		thinkingLevel: undefined,
	} as unknown as AgentSession;
	const mode = new InteractiveMode(session, "test");
	harness = { mode, sessionManager, tempDir, agentState };
	return harness;
}

function startStableLoader(mode: InteractiveMode): void {
	mode.ensureLoadingAnimation();
	mode.loadingAnimation?.stop();
}

function renderLoader(mode: InteractiveMode): string {
	return mode.statusContainer.render(120).join("\n");
}

function shadowAccentSurfaceLuminance(value: number | undefined): () => void {
	Object.defineProperty(theme, "accentSurfaceLuminance", {
		configurable: true,
		get: () => value,
	});
	return () => {
		delete (theme as unknown as { accentSurfaceLuminance?: number }).accentSurfaceLuminance;
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	harness?.mode.stop();
	harness?.tempDir.removeSync();
	harness = undefined;
	resetSettingsForTest();
});

describe("InteractiveMode working-message session accent cache", () => {
	it("reports a live seam only while status content is mounted", async () => {
		const { mode } = await createHarness("Live status");
		const statusContainer = mode.statusContainer as Container & NativeScrollbackLiveRegion;

		// Empty: no seam — the engine may commit freely past the container.
		expect(statusContainer.getNativeScrollbackLiveRegionStart()).toBeUndefined();
		// Loader mounted: every row is live, so the seam sits at 0 and keeps
		// the animating loader out of immutable native scrollback.
		startStableLoader(mode);
		expect(statusContainer.getNativeScrollbackLiveRegionStart()).toBe(0);
	});

	it("reuses one computed accent across loader spinner and message colorizers", async () => {
		const { mode } = await createHarness("Cached session");
		const getHex = vi.spyOn(sessionColor, "getSessionAccentHex");
		const getAnsi = vi.spyOn(sessionColor, "getSessionAccentAnsi");

		// Colorizers run lazily at render time (loader layout cache); the accent
		// computation is observable only after a render.
		startStableLoader(mode);
		renderLoader(mode);
		expect(getHex).toHaveBeenCalledTimes(1);
		expect(getAnsi).toHaveBeenCalledTimes(2);

		mode.loadingAnimation?.setMessage("Still working");
		renderLoader(mode);
		expect(getHex).toHaveBeenCalledTimes(1);
		expect(getAnsi).toHaveBeenCalledTimes(2);
	});

	it("recomputes for session renames and keeps the main ANSI path status-line equivalent", async () => {
		const initialName = "Alpha session";
		const renamedName = "Beta session";
		const { mode, sessionManager } = await createHarness(initialName);
		const initialAnsi = defined(
			sessionColor.getSessionAccentAnsi(
				sessionColor.getSessionAccentHex(
					initialName,
					theme.getMajorThemeColorHexes(),
					theme.accentSurfaceLuminance,
				),
			),
		);
		const renamedAnsi = defined(
			sessionColor.getSessionAccentAnsi(
				sessionColor.getSessionAccentHex(
					renamedName,
					theme.getMajorThemeColorHexes(),
					theme.accentSurfaceLuminance,
				),
			),
		);
		const getHex = vi.spyOn(sessionColor, "getSessionAccentHex");

		startStableLoader(mode);
		expect(renderLoader(mode)).toContain(initialAnsi);
		expect(getHex).toHaveBeenCalledTimes(1);

		await sessionManager.setSessionName(renamedName, "user");
		mode.loadingAnimation?.setMessage("Renamed session");
		expect(renderLoader(mode)).toContain(renamedAnsi);
		expect(getHex).toHaveBeenCalledTimes(2);
	});

	it("keys cached accents by theme accent-surface luminance", async () => {
		const sessionName = "Luminance session";
		const { mode } = await createHarness(sessionName);
		const restoreInitial = shadowAccentSurfaceLuminance(undefined);
		const getHex = vi.spyOn(sessionColor, "getSessionAccentHex");

		try {
			startStableLoader(mode);
			renderLoader(mode);
			expect(getHex).toHaveBeenCalledTimes(1);
			expect(getHex.mock.calls[0]).toEqual([sessionName, theme.getMajorThemeColorHexes(), undefined]);

			restoreInitial();
			const restoreLight = shadowAccentSurfaceLuminance(0.72);
			try {
				mode.loadingAnimation?.setMessage("Light theme");
				renderLoader(mode);
				expect(getHex).toHaveBeenCalledTimes(2);
				expect(getHex.mock.calls[1]).toEqual([sessionName, theme.getMajorThemeColorHexes(), 0.72]);
			} finally {
				restoreLight();
			}
		} finally {
			restoreInitial();
		}
	});

	it("caches disabled session accents and recomputes when the setting is enabled again", async () => {
		const sessionName = "Toggle session";
		const { mode } = await createHarness(sessionName);
		const accentAnsi = defined(
			sessionColor.getSessionAccentAnsi(
				sessionColor.getSessionAccentHex(
					sessionName,
					theme.getMajorThemeColorHexes(),
					theme.accentSurfaceLuminance,
				),
			),
		);
		const getHex = vi.spyOn(sessionColor, "getSessionAccentHex");

		startStableLoader(mode);
		expect(renderLoader(mode)).toContain(accentAnsi);
		expect(getHex).toHaveBeenCalledTimes(1);

		settings.set("statusLine.sessionAccent", false);
		mode.loadingAnimation?.setMessage("Accent disabled");
		expect(renderLoader(mode)).not.toContain(accentAnsi);
		expect(getHex).toHaveBeenCalledTimes(1);

		settings.set("statusLine.sessionAccent", true);
		expect(renderLoader(mode)).toContain(accentAnsi);
		expect(getHex).toHaveBeenCalledTimes(2);
	});

	it("advances the visible active working spinner after 80ms without changing its semantic status", async () => {
		const { mode } = await createHarness("Active working spinner");
		const activityAtMs = 1_700_000_000_000;
		const activeActivity = {
			phase: "thinking" as const,
			label: "Thinking",
			phaseStartedAtMs: activityAtMs,
			lastActivityAtMs: activityAtMs,
		};

		vi.useFakeTimers();
		setSystemTime(activityAtMs);
		let perfNow = 1_000;
		const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => perfNow);
		try {
			settings.set("display.shimmer", "classic");
			settings.set("statusLine.sessionAccent", false);
			mode.ensureLoadingAnimation();
			mode.refreshWorkingActivitySummary(activeActivity);
			const before = renderLoader(mode);
			expect(Bun.stripANSI(before)).toContain("Thinking · phase 0ms");

			perfNow += 80;
			vi.advanceTimersByTime(80);
			const after = renderLoader(mode);
			expect(Bun.stripANSI(after)).not.toBe(Bun.stripANSI(before));
			expect(Bun.stripANSI(after)).toContain("Thinking · phase 0ms");
		} finally {
			mode.stop();
			perfSpy.mockRestore();
			vi.useRealTimers();
			setSystemTime();
		}
	});
});

describe("InteractiveMode working activity refresh", () => {
	it("schedules a fallback component repaint for unsafe 80ms active spinner frames", async () => {
		const { mode } = await createHarness("Active spinner direct write");
		const activityAtMs = 1_700_000_000_000;
		const activeActivity = {
			phase: "thinking" as const,
			label: "Thinking",
			phaseStartedAtMs: activityAtMs,
			lastActivityAtMs: activityAtMs,
		};

		vi.useFakeTimers();
		setSystemTime(activityAtMs);
		let perfNow = 1_000;
		const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => perfNow);
		const directWrite = vi.spyOn(mode.ui, "tryDirectWrite").mockReturnValue(false);
		const componentRender = vi.spyOn(mode.ui, "requestComponentRender").mockImplementation(() => {});

		try {
			settings.set("display.shimmer", "classic");
			mode.ensureLoadingAnimation();
			mode.refreshWorkingActivitySummary(activeActivity);
			directWrite.mockClear();
			componentRender.mockClear();

			perfNow += 79;
			vi.advanceTimersByTime(79);
			expect(directWrite).not.toHaveBeenCalled();
			expect(componentRender).not.toHaveBeenCalled();

			perfNow += 1;
			vi.advanceTimersByTime(1);
			expect(directWrite).toHaveBeenCalledTimes(1);
			expect(componentRender).toHaveBeenCalledTimes(1);
			expect(componentRender).toHaveBeenCalledWith(defined(mode.loadingAnimation));
		} finally {
			mode.stop();
			perfSpy.mockRestore();
			vi.useRealTimers();
			setSystemTime();
		}
	});

	it("publishes elapsed active status every second through a component fallback when direct writes fail", async () => {
		const { mode } = await createHarness("Elapsed status fallback");
		const activityAtMs = 1_700_000_000_000;
		const activeActivity = {
			phase: "thinking" as const,
			label: "Thinking",
			phaseStartedAtMs: activityAtMs,
			lastActivityAtMs: activityAtMs,
		};

		vi.useFakeTimers();
		let now = activityAtMs;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
		const perfSpy = vi.spyOn(performance, "now").mockReturnValue(1_000);
		const directWrite = vi.spyOn(mode.ui, "tryDirectWrite").mockReturnValue(false);
		const componentRender = vi.spyOn(mode.ui, "requestComponentRender").mockImplementation(() => {});

		try {
			settings.set("display.shimmer", "classic");
			mode.ensureLoadingAnimation();
			mode.refreshWorkingActivitySummary(activeActivity);
			directWrite.mockClear();
			componentRender.mockClear();

			// performance.now is frozen, so the spinner frame never advances and
			// the 80ms animation ticks have nothing new to paint: no fallbacks.
			vi.advanceTimersByTime(999);
			expect(directWrite).not.toHaveBeenCalled();
			expect(componentRender).not.toHaveBeenCalled();

			// The one-second working-activity refresh updates the elapsed label;
			// with direct writes failing it must fall back to a component render.
			now += 1_000;
			vi.advanceTimersByTime(1_000);
			expect(directWrite).toHaveBeenCalledWith(defined(mode.loadingAnimation));
			expect(componentRender).toHaveBeenCalledTimes(1);
			expect(componentRender).toHaveBeenCalledWith(defined(mode.loadingAnimation));
			expect(Bun.stripANSI(renderLoader(mode))).toContain("Thinking · phase 1.0s");
		} finally {
			mode.stop();
			perfSpy.mockRestore();
			nowSpy.mockRestore();
			vi.useRealTimers();
		}
	});
});

describe("InteractiveMode loading activity summary", () => {
	it("keeps event-backed Main activity visible beside a subagent card", async () => {
		const { mode } = await createHarness("Working activity summary");
		const marker = "UNIQUE_MAIN_ACTIVITY_DETAIL";
		const now = Date.now();
		const mainActivity = {
			phase: "tool" as const,
			label: "Read",
			detail: marker,
			phaseStartedAtMs: now,
			lastActivityAtMs: now,
		};
		startStableLoader(mode);
		mode.refreshWorkingActivitySummary(mainActivity);
		expect(Bun.stripANSI(renderLoader(mode))).toContain(marker);

		mode.subagentContainer.addChild(new Text("visible activity card"));
		mode.refreshWorkingActivitySummary(mainActivity);
		const alongsideCard = Bun.stripANSI(renderLoader(mode));
		expect(alongsideCard).toContain(marker);
		expect(alongsideCard).not.toContain("Working…");
	});

	it("renders waiting-user as localized static activity without periodic paints", async () => {
		const { mode } = await createHarness("waiting-user static activity");
		const previousLocale = getSettingsUiLocale();
		const phaseStartedAtMs = 1_700_000_000_000;
		const detail = "UNIQUE_WAITING_USER_DETAIL";
		const activeActivity = {
			phase: "thinking" as const,
			label: "Thinking",
			phaseStartedAtMs,
			lastActivityAtMs: phaseStartedAtMs,
		};
		const waitingActivity = {
			phase: "waiting-user" as const,
			label: "Waiting for user",
			detail,
			phaseStartedAtMs,
			lastActivityAtMs: phaseStartedAtMs,
		};

		setSettingsUiLocale("zh-CN");
		vi.useFakeTimers();
		let perfNow = 1_000;
		const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => perfNow);
		try {
			setSystemTime(phaseStartedAtMs);
			mode.ensureLoadingAnimation();
			mode.refreshWorkingActivitySummary(activeActivity);
			perfNow += 80;
			vi.advanceTimersByTime(80);

			const directWrite = vi.spyOn(mode.ui, "tryDirectWrite").mockReturnValue(false);
			const componentRender = vi.spyOn(mode.ui, "requestComponentRender").mockImplementation(() => {});
			mode.refreshWorkingActivitySummary(waitingActivity);
			const rendered = Bun.stripANSI(renderLoader(mode));
			expect(rendered).toContain("等待用户");
			expect(rendered).toContain("esc");
			expect(rendered).not.toContain(detail);
			expect(rendered).not.toContain("阶段");

			directWrite.mockClear();
			componentRender.mockClear();
			perfNow += 2_000;
			vi.advanceTimersByTime(2_000);
			expect(directWrite).not.toHaveBeenCalled();
			expect(componentRender).not.toHaveBeenCalled();
		} finally {
			mode.stop();
			perfSpy.mockRestore();
			vi.useRealTimers();
			setSystemTime();
			setSettingsUiLocale(previousLocale);
		}
	});

	it("keeps waiting-peer localized while the loader repaints on timer ticks", async () => {
		const { mode } = await createHarness("waiting-peer animated activity");
		const previousLocale = getSettingsUiLocale();
		const phaseStartedAtMs = 1_700_000_000_000;
		const detail = "UNIQUE_WAITING_PEER_DETAIL";
		const activeActivity = {
			phase: "thinking" as const,
			label: "Thinking",
			phaseStartedAtMs,
			lastActivityAtMs: phaseStartedAtMs,
		};
		const waitingActivity = {
			phase: "waiting-peer" as const,
			label: "Waiting for peer",
			detail,
			phaseStartedAtMs,
			lastActivityAtMs: phaseStartedAtMs,
		};

		setSettingsUiLocale("zh-CN");
		vi.useFakeTimers();
		let perfNow = 1_000;
		const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => perfNow);
		try {
			setSystemTime(phaseStartedAtMs);
			mode.ensureLoadingAnimation();
			mode.refreshWorkingActivitySummary(activeActivity);
			perfNow += 80;
			vi.advanceTimersByTime(80);

			const directWrite = vi.spyOn(mode.ui, "tryDirectWrite").mockReturnValue(false);
			const componentRender = vi.spyOn(mode.ui, "requestComponentRender").mockImplementation(() => {});
			mode.refreshWorkingActivitySummary(waitingActivity);
			const rendered = Bun.stripANSI(renderLoader(mode));
			expect(rendered).toContain("等待协作者");
			expect(rendered).toContain("esc");
			expect(rendered).not.toContain(detail);
			expect(rendered).not.toContain("阶段");

			directWrite.mockClear();
			componentRender.mockClear();
			perfNow += 2_000;
			vi.advanceTimersByTime(2_000);
			expect(directWrite.mock.calls.length + componentRender.mock.calls.length).toBeGreaterThan(0);
		} finally {
			mode.stop();
			perfSpy.mockRestore();
			vi.useRealTimers();
			setSystemTime();
			setSettingsUiLocale(previousLocale);
		}
	});

	it("keeps the phase elapsed label visible after 15 seconds without a new event", async () => {
		const { mode } = await createHarness("Thinking activity summary");
		const previousLocale = getSettingsUiLocale();
		const phaseStartedAtMs = 1_700_000_000_000;
		const thinkingActivity = {
			phase: "thinking" as const,
			label: "Thinking",
			phaseStartedAtMs,
			lastActivityAtMs: phaseStartedAtMs + 135_000,
		};

		setSettingsUiLocale("en");
		vi.useFakeTimers();
		try {
			setSystemTime(thinkingActivity.lastActivityAtMs);
			startStableLoader(mode);
			mode.refreshWorkingActivitySummary(thinkingActivity);
			const active = Bun.stripANSI(renderLoader(mode));
			expect(active).toContain("Thinking · phase 2m15s");
			expect(active).not.toContain("Active");

			setSystemTime(thinkingActivity.lastActivityAtMs + 15_000);
			mode.refreshWorkingActivitySummary(thinkingActivity);
			const afterThreshold = Bun.stripANSI(renderLoader(mode));
			expect(afterThreshold).toContain("Thinking · phase 2m30s");
			expect(afterThreshold).not.toContain("quiet");
			expect(afterThreshold).not.toContain("Quiet");
		} finally {
			vi.useRealTimers();
			setSystemTime();
			setSettingsUiLocale(previousLocale);
		}
	});
});

describe("persistent activity row", () => {
	it("stays mounted with the turn's throughput after the agent goes idle", async () => {
		const { mode, agentState } = await createHarness("Persistent activity");
		settings.set("display.persistentActivityRow", true);

		// Mid-turn: the row is the live working loader.
		agentState.isStreaming = true;
		startStableLoader(mode);
		expect(mode.loadingAnimation?.idle).toBe(false);

		// The turn ends. The row must survive the boundary instead of being
		// unmounted, and must stop advertising work.
		agentState.isStreaming = false;
		agentState.messages = [
			{
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				usage: {
					input: 10,
					output: 120,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 130,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now() - 2_000,
				duration: 2_000,
				ttft: 400,
			},
		];
		expect(mode.keepLoadingAnimationIdle()).toBe(true);

		const loader = mode.loadingAnimation;
		expect(loader).toBeDefined();
		expect(mode.statusContainer.children).toContain(defined(loader));
		expect(loader?.idle).toBe(true);
		const rendered = Bun.stripANSI(renderLoader(mode));
		expect(rendered).toContain("t/s");
		expect(rendered).toContain("0.4s");
	});

	it("reports a live rate and average while tokens stream, and keeps the average once idle", async () => {
		const { mode, agentState } = await createHarness("Live throughput");
		settings.set("display.persistentActivityRow", true);

		agentState.isStreaming = true;
		agentState.requestStartedAt = Date.now() - 900;
		agentState.firstByteAt = Date.now() - 500;
		agentState.streamMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "reasoning about the problem" }],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			stopReason: "stop",
		};
		startStableLoader(mode);
		mode.refreshWorkingActivitySummary();

		// The stream keeps producing tokens; the second reading gives the
		// windowed rate a delta to measure.
		await Bun.sleep(150);
		agentState.streamMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "reasoning about the problem ".repeat(20) }],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			stopReason: "stop",
		};
		mode.refreshWorkingActivitySummary();
		const live = Bun.stripANSI(renderLoader(mode));
		expect(live).toContain("t/s");
		expect(live).toContain("avg");
		// Request began 900ms ago, first byte 500ms in.
		expect(live).toContain("0.4s");

		// The turn ends: the average survives as the row's idle readout.
		agentState.isStreaming = false;
		agentState.streamMessage = null;
		expect(mode.keepLoadingAnimationIdle()).toBe(true);
		const idle = Bun.stripANSI(renderLoader(mode));
		expect(idle).toContain("t/s");
		expect(idle).not.toContain("Working…");
	});

	it("re-mounts the row after a transient overlay clears the status container", async () => {
		const { mode, agentState } = await createHarness("Overlay survives");
		settings.set("display.persistentActivityRow", true);
		agentState.isStreaming = false;

		mode.keepLoadingAnimationIdle();
		expect(mode.loadingAnimation).toBeDefined();

		// An overlay (compaction / retry) takes the container, then ends.
		mode.statusContainer.disposeChildren();
		expect(mode.keepLoadingAnimationIdle()).toBe(true);
		expect(mode.statusContainer.children).toContain(defined(mode.loadingAnimation));
	});

	it("does not keep a row when the setting is off", async () => {
		const { mode, agentState } = await createHarness("Persistent off");
		settings.set("display.persistentActivityRow", false);
		agentState.isStreaming = false;
		expect(mode.keepLoadingAnimationIdle()).toBe(false);
	});
});
