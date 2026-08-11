import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { SessionScheduleRuntime } from "../src/scheduling/runtime";
import type { ScheduleJob } from "../src/scheduling/types";

type SchedulingHarness = {
	session: AgentSession;
	manager: SessionManager;
	runtime: SessionScheduleRuntime;
};

function scheduledPrompts(manager: SessionManager): string[] {
	return manager.getEntries().flatMap(entry => {
		if (entry.type !== "custom_message" || entry.customType !== "scheduled-prompt") return [];
		return typeof entry.content === "string" ? [entry.content] : [];
	});
}

describe("AgentSession scheduling lifecycle bindings", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let currentSession: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-schedule-lifecycle-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			await currentSession?.dispose();
		} finally {
			authStorage.close();
			await tempDir.remove();
		}
	});

	async function createHarness(): Promise<SchedulingHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const mock = createMockModel({ handler: () => ({ content: ["scheduled prompt handled"] }) });
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
			}),
			sessionManager: manager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"schedule.enabled": true,
				"heartbeat.enabled": true,
			}),
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			agentKind: "main",
		});
		currentSession = session;
		const runtime = session.getScheduleRuntime();
		if (!runtime) throw new Error("Expected scheduling runtime for a main session");
		await runtime.ready();
		return { session, manager, runtime };
	}

	async function createSchedule(runtime: SessionScheduleRuntime, prompt: string): Promise<ScheduleJob> {
		return await runtime.createSchedule({
			schedule: "in 1h",
			prompt,
			deliveryMode: "steer",
		});
	}

	it("invalidates an old job across newSession and delivers only a replacement-session job", async () => {
		const { session, manager, runtime } = await createHarness();
		const oldPrompt = "OLD NEW-SESSION SCHEDULE";
		const oldJob = await createSchedule(runtime, oldPrompt);
		const oldSessionFile = manager.getSessionFile();

		expect(await session.newSession()).toBe(true);
		expect(manager.getSessionFile()).not.toBe(oldSessionFile);
		await expect(runtime.deliverScheduledPrompt(oldJob)).rejects.toThrow(
			"Scheduling requires a persisted session and artifacts",
		);
		expect(scheduledPrompts(manager)).not.toContain(oldPrompt);

		const replacementPrompt = "NEW SESSION SCHEDULE";
		await runtime.deliverScheduledPrompt(await createSchedule(runtime, replacementPrompt));
		expect(scheduledPrompts(manager)).toContain(replacementPrompt);
	});

	it("does not carry a source-session job into a successfully switched session", async () => {
		const { session, manager, runtime } = await createHarness();
		const sourcePrompt = "SOURCE SWITCH SCHEDULE";
		const sourceJob = await createSchedule(runtime, sourcePrompt);
		const targetSessionFile = tempDir.join("target-switch.jsonl");

		expect(await session.switchSession(targetSessionFile)).toBe(true);
		await expect(runtime.deliverScheduledPrompt(sourceJob)).rejects.toThrow(
			"Scheduling requires a persisted session and artifacts",
		);
		expect(scheduledPrompts(manager)).not.toContain(sourcePrompt);

		const targetPrompt = "TARGET SWITCH SCHEDULE";
		await runtime.deliverScheduledPrompt(await createSchedule(runtime, targetPrompt));
		expect(scheduledPrompts(manager)).toContain(targetPrompt);
	});

	it("rejects a stale delivery while a failed switch is unbound, then resumes the restored session", async () => {
		const { session, manager, runtime } = await createHarness();
		const oldPrompt = "FAILED SWITCH SCHEDULE";
		const oldJob = await createSchedule(runtime, oldPrompt);
		const originalSessionFile = manager.getSessionFile();
		const targetSessionFile = tempDir.join("target-failed-switch.jsonl");
		const failure = new Error("synthetic switch failure");
		const setSessionFile = manager.setSessionFile.bind(manager);
		let staleDeliveryError: unknown;

		vi.spyOn(manager, "setSessionFile").mockImplementation(async sessionFile => {
			await setSessionFile(sessionFile);
			try {
				await runtime.deliverScheduledPrompt(oldJob);
			} catch (error) {
				staleDeliveryError = error;
			}
			throw failure;
		});

		await expect(session.switchSession(targetSessionFile)).rejects.toThrow(failure);
		expect(manager.getSessionFile()).toBe(originalSessionFile);
		expect(staleDeliveryError).toMatchObject({
			message: "Scheduling requires a persisted session and artifacts",
		});
		expect(scheduledPrompts(manager)).not.toContain(oldPrompt);

		await runtime.deliverScheduledPrompt(oldJob);
		expect(scheduledPrompts(manager)).toContain(oldPrompt);
	});

	it("refuses a retained job after dispose without appending its prompt", async () => {
		const { manager, runtime } = await createHarness();
		const prompt = "DISPOSED SESSION SCHEDULE";
		const job = await createSchedule(runtime, prompt);

		await currentSession?.dispose();
		currentSession = undefined;

		await expect(runtime.deliverScheduledPrompt(job)).rejects.toThrow(
			"Scheduling requires a persisted session and artifacts",
		);
		expect(scheduledPrompts(manager)).not.toContain(prompt);
	});
});
