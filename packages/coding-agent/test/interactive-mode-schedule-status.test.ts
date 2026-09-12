import { afterEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ScheduleJob } from "@oh-my-pi/pi-coding-agent/scheduling/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { setSettingsUiLocale } from "../src/i18n/settings-locale";

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

async function createHarness(jobs: readonly ScheduleJob[]): Promise<Harness> {
	resetSettingsForTest();
	setSettingsUiLocale("en");
	const tempDir = TempDir.createSync("@pi-activity-row-schedule-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
	const sessionManager = SessionManager.inMemory(tempDir.path());
	await sessionManager.setSessionName("Schedule status", "user");
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
		getScheduleRuntime: () => ({ list: async () => jobs }),
	} as unknown as AgentSession;
	const mode = new InteractiveMode(session, "test");
	return { mode, tempDir, agentState };
}

function renderActivityRow(mode: InteractiveMode): string {
	return Bun.stripANSI(mode.statusContainer.render(120).join("\n"));
}
async function settleScheduleStatusCache(): Promise<void> {
	// The harness resolves list() immediately; drain its fulfillment and the
	// cache continuation before composing the next activity-row frame.
	await Promise.resolve();
	await Promise.resolve();
}

function scheduledJob(id: string, status: ScheduleJob["status"], nextRunAt: string): ScheduleJob {
	return {
		id,
		source: "cron",
		status,
		sessionId: "session",
		sessionFile: "/session.jsonl",
		cwd: "/workspace",
		prompt: "check the queue",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-09-12T00:00:00.000Z",
		updatedAt: "2026-09-12T00:00:00.000Z",
		nextRunAt,
		runCount: 0,
	};
}

afterEach(() => {
	harness?.mode.stop();
	harness?.tempDir.removeSync();
	harness = undefined;
	resetSettingsForTest();
	setSettingsUiLocale("en");
});

describe("InteractiveMode activity-row schedule status", () => {
	it("renders the next active scheduled run after the async cache refresh", async () => {
		harness = await createHarness([scheduledJob("job-1", "active", new Date(Date.now() + 90_000).toISOString())]);
		const { mode, agentState } = harness;
		settings.set("display.persistentActivityRow", true);
		setSettingsUiLocale("en");
		agentState.isStreaming = false;

		mode.keepLoadingAnimationIdle();
		await settleScheduleStatusCache();
		mode.keepLoadingAnimationIdle();

		expect(renderActivityRow(mode)).toContain("from now");
	});

	it("does not render a schedule suffix when every job is paused", async () => {
		harness = await createHarness([scheduledJob("job-1", "paused", new Date(Date.now() + 90_000).toISOString())]);
		const { mode, agentState } = harness;
		settings.set("display.persistentActivityRow", true);
		agentState.isStreaming = false;

		mode.keepLoadingAnimationIdle();
		await settleScheduleStatusCache();
		mode.keepLoadingAnimationIdle();

		expect(renderActivityRow(mode)).not.toContain("from now");
	});

	it("does not append schedule status when the persistent activity row is disabled", async () => {
		harness = await createHarness([scheduledJob("job-1", "active", new Date(Date.now() + 90_000).toISOString())]);
		const { mode } = harness;
		settings.set("display.persistentActivityRow", false);

		mode.ensureLoadingAnimation();
		await settleScheduleStatusCache();
		mode.ensureLoadingAnimation();

		expect(renderActivityRow(mode)).not.toContain("from now");
	});

	it("shows the number of additional active scheduled jobs", async () => {
		harness = await createHarness([
			scheduledJob("job-1", "active", new Date(Date.now() + 90_000).toISOString()),
			scheduledJob("job-2", "active", new Date(Date.now() + 120_000).toISOString()),
		]);
		const { mode, agentState } = harness;
		settings.set("display.persistentActivityRow", true);
		agentState.isStreaming = false;

		mode.keepLoadingAnimationIdle();
		await settleScheduleStatusCache();
		mode.keepLoadingAnimationIdle();

		const rendered = renderActivityRow(mode);
		expect(rendered).toContain("from now");
		expect(rendered).toContain("+1");
	});
});
