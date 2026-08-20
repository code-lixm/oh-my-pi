import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
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
};

let harnesses: Harness[] = [];

function defined<T>(value: T | undefined): T {
	expect(value).toBeDefined();
	return value as T;
}

async function createHarness(sessionName: string): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-working-accent-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
	const sessionManager = SessionManager.inMemory(tempDir.path());
	await sessionManager.setSessionName(sessionName, "user");
	const session = {
		sessionManager,
		settings,
		getAgentId: () => MAIN_AGENT_ID,
		agent: {
			state: { tools: [] },
			metadataForProvider: () => undefined,
		},
		customCommands: [],
		skills: [],
		autoCompactionEnabled: true,
		messages: [],
		systemPrompt: [],
		state: { model: undefined },
		model: undefined,
		thinkingLevel: undefined,
	} as unknown as AgentSession;
	const mode = new InteractiveMode(session, "test");
	const harness = { mode, sessionManager, tempDir };
	harnesses.push(harness);
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
	for (const harness of harnesses) {
		harness.mode.stop();
		harness.tempDir.removeSync();
	}
	harnesses = [];
	vi.restoreAllMocks();
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

	it("keeps active working-status ANSI bytes stable across external renders", async () => {
		const { mode } = await createHarness("Stable active working status");
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

			const baseline = renderLoader(mode);
			expect(Bun.stripANSI(baseline)).toContain("Thinking · Active");

			perfNow += 80;
			vi.advanceTimersByTime(80);
			expect(renderLoader(mode)).toBe(baseline);

			perfNow += 1_920;
			vi.advanceTimersByTime(1_920);
			expect(renderLoader(mode)).toBe(baseline);
		} finally {
			mode.stop();
			perfSpy.mockRestore();
			vi.useRealTimers();
			setSystemTime();
		}
	});
});

describe("InteractiveMode working activity refresh", () => {
	it("keeps active loader paints quiet and defers unsafe elapsed updates to the next render", async () => {
		const { mode } = await createHarness("Working loader stability");
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
		const directWrite = vi.spyOn(mode.ui, "tryDirectWrite").mockReturnValue(true);
		const componentRender = vi.spyOn(mode.ui, "requestComponentRender").mockImplementation(() => {});

		try {
			settings.set("display.shimmer", "classic");
			mode.ensureLoadingAnimation();
			mode.refreshWorkingActivitySummary(activeActivity);
			directWrite.mockClear();
			componentRender.mockClear();

			perfNow += 2_000;
			vi.advanceTimersByTime(2_000);
			expect(directWrite).not.toHaveBeenCalled();
			expect(componentRender).not.toHaveBeenCalled();

			setSystemTime(activityAtMs + 3_000);
			directWrite.mockReturnValue(false);
			mode.refreshWorkingActivitySummary(activeActivity);
			expect(directWrite).toHaveBeenCalledTimes(1);
			expect(componentRender).not.toHaveBeenCalled();
			expect(Bun.stripANSI(renderLoader(mode))).toContain("Thinking · Active · phase 3.0s");
		} finally {
			mode.stop();
			perfSpy.mockRestore();
			vi.useRealTimers();
			setSystemTime();
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

	it("renders waiting-peer as a localized static activity without periodic paints", async () => {
		const { mode } = await createHarness("Waiting peer static activity");
		const previousLocale = getSettingsUiLocale();
		const phaseStartedAtMs = 1_700_000_000_000;
		const detail = "UNIQUE_WAITING_PEER_DETAIL";
		const waitingPeer = {
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
			setSystemTime(phaseStartedAtMs + 125_000);
			mode.ensureLoadingAnimation();
			const directWrite = vi.spyOn(mode.ui, "tryDirectWrite").mockReturnValue(false);
			const componentRender = vi.spyOn(mode.ui, "requestComponentRender").mockImplementation(() => {});

			mode.refreshWorkingActivitySummary(waitingPeer);
			const rendered = Bun.stripANSI(renderLoader(mode));
			expect(rendered).toContain("等待协作者");
			expect(rendered).toContain("esc");
			expect(rendered).not.toContain(detail);
			expect(rendered).not.toContain("阶段");

			directWrite.mockClear();
			componentRender.mockClear();
			perfNow += 2_000;
			vi.advanceTimersByTime(2_000);
			expect(directWrite).toHaveBeenCalledTimes(0);
			expect(componentRender).toHaveBeenCalledTimes(0);
		} finally {
			mode.stop();
			perfSpy.mockRestore();
			vi.useRealTimers();
			setSystemTime();
			setSettingsUiLocale(previousLocale);
		}
	});

	it("renders a real thinking snapshot as active, then quiet after 15 seconds without a new event", async () => {
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
			expect(active).toContain("Thinking · Active · phase 2m15s");

			setSystemTime(thinkingActivity.lastActivityAtMs + 15_000);
			mode.refreshWorkingActivitySummary(thinkingActivity);
			const quiet = Bun.stripANSI(renderLoader(mode));
			expect(quiet).toContain("Quiet · Thinking · phase 2m30s");
			expect(quiet).not.toContain("Thinking · Active");
		} finally {
			vi.useRealTimers();
			setSystemTime();
			setSettingsUiLocale(previousLocale);
		}
	});
});
