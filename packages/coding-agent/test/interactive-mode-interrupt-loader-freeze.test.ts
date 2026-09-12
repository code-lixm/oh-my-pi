import { afterEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { tSettingsUi } from "../src/i18n/settings-locale";

type Harness = {
	mode: InteractiveMode;
	tempDir: TempDir;
	agentState: {
		tools: unknown[];
		isStreaming?: boolean;
		messages: unknown[];
		streamMessage: Record<string, unknown> | null;
	};
};

let harness: Harness | undefined;

function defined<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Expected value to be defined");
	return value;
}

async function createHarness(): Promise<Harness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-interrupt-loader-freeze-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
	const sessionManager = SessionManager.inMemory(tempDir.path());
	await sessionManager.setSessionName("Interrupt loader freeze", "user");
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
	return { mode, tempDir, agentState };
}

function activeActivity() {
	const now = Date.now();
	return {
		phase: "thinking" as const,
		label: "Thinking",
		phaseStartedAtMs: now,
		lastActivityAtMs: now,
	};
}

function renderLoader(mode: InteractiveMode): string {
	return Bun.stripANSI(defined(mode.loadingAnimation).render(120).join("\n")).trim();
}

async function startLiveActivity(): Promise<{ mode: InteractiveMode; agentState: Harness["agentState"] }> {
	harness = await createHarness();
	harness.agentState.isStreaming = true;
	harness.mode.ensureLoadingAnimation();
	return harness;
}

afterEach(() => {
	harness?.mode.stop();
	harness?.tempDir.removeSync();
	harness = undefined;
	vi.useRealTimers();
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("InteractiveMode confirmed interrupt activity row", () => {
	it("freezes the activity row immediately on a confirmed interrupt even while the agent still reports streaming", async () => {
		vi.useFakeTimers();
		const { mode } = await startLiveActivity();
		const loader = defined(mode.loadingAnimation);
		const setAnimationEnabled = vi.spyOn(loader, "setAnimationEnabled");
		const setSpinnerVisible = vi.spyOn(loader, "setSpinnerVisible");

		mode.scheduleLoaderTeardownAfterInterrupt();

		expect(setAnimationEnabled).toHaveBeenCalledWith(false);
		expect(setSpinnerVisible).toHaveBeenCalledWith(false);
		expect(renderLoader(mode)).toBe(tSettingsUi("Interrupted."));

		setAnimationEnabled.mockClear();
		setSpinnerVisible.mockClear();
		mode.refreshWorkingActivitySummary(activeActivity());
		vi.advanceTimersByTime(1_000);

		expect(setAnimationEnabled).not.toHaveBeenCalled();
		expect(setSpinnerVisible).not.toHaveBeenCalled();
		expect(renderLoader(mode)).toBe(tSettingsUi("Interrupted."));
	});

	it("lets the next submission restore the animated activity row after an interrupted streaming turn", async () => {
		vi.useFakeTimers();
		const { mode } = await startLiveActivity();
		const loader = defined(mode.loadingAnimation);
		const setAnimationEnabled = vi.spyOn(loader, "setAnimationEnabled");
		const setSpinnerVisible = vi.spyOn(loader, "setSpinnerVisible");

		mode.scheduleLoaderTeardownAfterInterrupt();
		setAnimationEnabled.mockClear();
		setSpinnerVisible.mockClear();

		mode.startPendingSubmission({ text: "try again" });
		mode.refreshWorkingActivitySummary(activeActivity());

		expect(mode.loadingAnimation).toBe(loader);
		expect(setAnimationEnabled).toHaveBeenCalledWith(true);
		expect(setSpinnerVisible).toHaveBeenCalledWith(true);
		expect(renderLoader(mode)).toContain("Thinking");
		expect(renderLoader(mode)).not.toContain(tSettingsUi("Interrupted."));
	});

	it("removes the interrupted loader after fallback teardown and leaves later activity heartbeats inert", async () => {
		vi.useFakeTimers();
		const { mode } = await startLiveActivity();

		mode.scheduleLoaderTeardownAfterInterrupt();
		vi.advanceTimersByTime(1_500);

		expect(mode.loadingAnimation).toBeUndefined();
		expect(mode.statusContainer.children).toHaveLength(0);

		mode.refreshWorkingActivitySummary(activeActivity());

		expect(mode.loadingAnimation).toBeUndefined();
		expect(mode.statusContainer.children).toHaveLength(0);
	});
});
