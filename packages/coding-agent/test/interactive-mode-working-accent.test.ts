import { afterEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import * as shimmerModule from "@oh-my-pi/pi-coding-agent/modes/theme/shimmer";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as sessionColor from "@oh-my-pi/pi-coding-agent/utils/session-color";
import type { Container, NativeScrollbackLiveRegion } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

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

	it("does not let the shimmer band race after a long event-loop stall", async () => {
		vi.spyOn(Date, "now").mockReturnValue(5000);
		let perfNow = 1000;
		const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => perfNow);
		// Capture the real `shimmerText` output at the four expected animationTime
		// values the per-loader capped clock should reach — these are the baselines
		// each `renderLoader(mode)` call must match. With the cap removed, the
		// first post-stall render would jump 300 ms (~9 cells) and land on the
		const message = "Working on the project documentation update";
		const expectedTimes = [5000, 5080, 5113, 5146] as const;
		const { mode } = await createHarness("Shimmer stability");
		settings.set("display.shimmer", "classic");
		settings.set("statusLine.sessionAccent", false);
		const expectedBaselines = expectedTimes.map(t => shimmerModule.shimmerText(message, theme, undefined, t));
		startStableLoader(mode);
		mode.loadingAnimation?.setMessage(message);
		// wall 1000: animationTime seeded at 5000 + 0 → 5000
		perfNow = 1000;
		const r0 = renderLoader(mode);
		// wall 1300: 300 ms stall capped to 80 ms → 5080
		perfNow = 1300;
		const r1 = renderLoader(mode);
		// wall 1333: +33 → 5113
		perfNow = 1333;
		const r2 = renderLoader(mode);
		// wall 1366: +33 → 5146
		perfNow = 1366;
		const r3 = renderLoader(mode);
		// Each render must contain the real shimmerText output for the *capped* time
		// the per-loader clock should reach. With the cap broken, wall 1300/1333/1366
		// would advance the band by 300/33/33 ms and the renders would contain the
		// uncapped baselines (5300/5333/5366) instead — the toContain below fails.
		// The four baselines are guaranteed distinct (shimmer band moves ≥1 cell
		// per 33 ms tick); assert that to lock the contract.
		const renders = [r0, r1, r2, r3];
		const uniqueBaselines = new Set(expectedBaselines);
		expect(uniqueBaselines.size).toBe(4);
		for (let i = 0; i < renders.length; i++) {
			expect(renders[i]).toContain(expectedBaselines[i]);
		}
		perfSpy.mockRestore();
	});
});
