/**
 * Contract: the anchored subagent HUD (rendered above the editor, next to the
 * Todos block) lists detached active subagents plus any recent subagent
 * feedback, preferring the newest feedback text over the row description and
 * self-clearing once feedback expires and nothing active remains. Sync task
 * spawns and eval `agent()` spawns are excluded unless feedback temporarily
 * surfaces them.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { InteractiveMode, renderSubagentHudLines } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	type ObservableSession,
	SessionObserverRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SubagentFeedback } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type AgentProgress,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

function makeSession(overrides: Partial<ObservableSession> & { id: string }): ObservableSession {
	return {
		kind: "subagent",
		label: overrides.id,
		status: "active",
		detached: true,
		lastUpdate: Date.now(),
		...overrides,
	};
}

function makeProgress(overrides: Partial<AgentProgress> & { id: string }): AgentProgress {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function makeLiveTelemetryProgress(id: string): AgentProgress {
	const now = Date.now();
	return makeProgress({
		id,
		activity: {
			phase: "streaming",
			label: "Streaming response",
			detail: "Inspecting HUD density",
			phaseStartedAtMs: now,
			lastActivityAtMs: now,
		},
		tokensPerSecond: 12.3,
		tokensPerSecondLive: true,
		contextTokens: 4_000,
		contextWindow: 8_000,
		toolCount: 2,
		tokens: 1_234,
		cost: 0.25,
		durationMs: 5_000,
	});
}

function makeLifecycle(id: string, index: number, description: string, detached?: boolean): SubagentLifecyclePayload {
	return {
		id,
		index,
		agent: "task",
		agentSource: "bundled",
		description,
		status: "started",
		parentToolCallId: "tool-call",
		detached,
	};
}

function makeProgressPayload(
	id: string,
	index: number,
	description: string,
	detached?: boolean,
): SubagentProgressPayload {
	return {
		index,
		agent: "task",
		agentSource: "bundled",
		task: description,
		parentToolCallId: "tool-call",
		detached,
		progress: makeProgress({ id, index, description, task: description }),
	};
}

function renderLines(
	sessions: ObservableSession[],
	columns = 120,
	feedback: readonly SubagentFeedback[] = [],
): string[] {
	return renderSubagentHudLines(sessions, columns, feedback).map(line => Bun.stripANSI(line));
}

function render(sessions: ObservableSession[], columns = 120, feedback: readonly SubagentFeedback[] = []): string {
	return renderLines(sessions, columns, feedback).join("\n");
}

describe("subagent HUD lines", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders default-running subagents as one compact status-free row each", () => {
		const rows = renderLines([
			makeSession({ id: "AuthLoader", description: "Refactoring the auth flow" }),
			makeSession({ id: "SchemaMigrator", description: "Migrating the users table" }),
		]).filter(line => {
			const trimmed = line.trim();
			return trimmed !== "" && trimmed !== "Subagents";
		});

		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("• AuthLoader · Refactoring the auth flow");
		expect(rows[1]).toContain("• SchemaMigrator · Migrating the users table");
	});

	it.each([
		{ name: "running", id: "RunningWorker", status: "running", expected: "• RunningWorker · state detail" },
		{ name: "completed", id: "CompletedWorker", status: "completed", expected: "• CompletedWorker · state detail" },
		{ name: "pending", id: "PendingWorker", status: "pending", expected: "• PendingWorker · waiting · state detail" },
		{ name: "failed", id: "FailedWorker", status: "failed", expected: "• FailedWorker · failed · state detail" },
		{ name: "aborted", id: "AbortedWorker", status: "aborted", expected: "• AbortedWorker · aborted · state detail" },
	] as const)("renders $name state with the compact status contract", ({ id, status, expected }) => {
		const out = render([makeSession({ id, description: "state detail", progress: makeProgress({ id, status }) })]);

		expect(out).toContain(expected);
	});

	it("keeps a live activity and its stats in one compact row at wide and narrow widths", () => {
		const session = makeSession({
			id: "TelemetryWorker",
			progress: makeLiveTelemetryProgress("TelemetryWorker"),
		});
		const wideLines = renderLines([session], 120);
		const wideRows = wideLines.filter(line => {
			const trimmed = line.trim();
			return trimmed !== "" && trimmed !== "Subagents";
		});

		expect(wideRows).toHaveLength(1);
		expect(wideRows[0]).toContain("• TelemetryWorker · Streaming response");
		const wide = wideRows.join("\n");
		expect(wide).toContain("Inspecting HUD density");
		expect(wide).not.toContain("tok/s");
		expect(wide).not.toContain("ctx ");
		expect(wide).not.toMatch(/\btok\b/u);
		expect(wide).not.toContain("tools");
		expect(wide).not.toMatch(/\$\d/u);
		for (const line of wideLines) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(120);
		}

		const narrowLines = renderLines([session], 60);
		const narrowRows = narrowLines.filter(line => {
			const trimmed = line.trim();
			return trimmed !== "" && trimmed !== "Subagents";
		});

		expect(narrowRows).toHaveLength(1);
		expect(narrowRows[0]).toContain("• TelemetryWorker · Streaming response");
		for (const line of narrowLines) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	it("puts pending replies before normal agent rows", () => {
		const pendingReplies: readonly IrcMessage[] = [
			{
				id: "reply-1",
				from: "Reviewer",
				to: "Main",
				body: "Please review this handoff before the release candidate is published",
				ts: 1,
			},
		];
		const lines = renderSubagentHudLines(
			[makeSession({ id: "NormalWorker", description: "ordinary background work" })],
			60,
			[],
			pendingReplies,
		).map(line => Bun.stripANSI(line));

		const replyIndex = lines.findIndex(line => line.includes("needs reply"));
		const agentIndex = lines.findIndex(line => line.includes("• NormalWorker · ordinary background work"));
		expect(replyIndex).toBeGreaterThanOrEqual(0);
		expect(agentIndex).toBeGreaterThan(replyIndex);
		for (const line of lines) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	it("only shows active subagents and clears once everything finished", () => {
		const finishedStates = ["completed", "failed", "aborted"] as const;
		const sessions: ObservableSession[] = [
			{ id: "main", kind: "main", label: "Main Session", status: "active", lastUpdate: Date.now() },
			...finishedStates.map(status => makeSession({ id: `Done-${status}`, status, description: "old work" })),
		];
		expect(renderSubagentHudLines(sessions, 120)).toEqual([]);

		const out = render([...sessions, makeSession({ id: "StillRunning", description: "live work" })]);
		expect(out).toContain("• StillRunning · live work");
		expect(out).not.toContain("Done-");
		expect(out).not.toContain("Main Session");
	});

	it("prefers the latest feedback over the active description without duplicating the row", () => {
		const out = render([makeSession({ id: "AuthLoader", description: "Refactoring the auth flow" })], 120, [
			{ agentId: "AuthLoader", text: "Old feedback" },
			{ agentId: "AuthLoader", text: "Latest feedback" },
		]);

		expect(out).toContain("• AuthLoader · Latest feedback");
		expect(out).not.toContain("Refactoring the auth flow");
		expect(out).not.toContain("Old feedback");
		expect(out.match(/• AuthLoader ·/g)?.length ?? 0).toBe(1);
	});

	it("replaces description, task, live activity, and telemetry with feedback", () => {
		const feedbackRows = renderLines(
			[
				makeSession({
					id: "TelemetryWorker",
					description: "Fallback task detail",
					progress: {
						...makeLiveTelemetryProgress("TelemetryWorker"),
						task: "Lower-priority task",
					},
				}),
			],
			120,
			[{ agentId: "TelemetryWorker", text: "Handoff is ready" }],
		).filter(line => {
			const trimmed = line.trim();
			return trimmed !== "" && trimmed !== "Subagents";
		});

		expect(feedbackRows).toHaveLength(1);
		const feedback = feedbackRows.join("\n");
		expect(feedback).toContain("• TelemetryWorker · Handoff is ready");
		expect(feedback).not.toContain("Fallback task detail");
		expect(feedback).not.toContain("Lower-priority task");
		expect(feedback).not.toContain("Streaming response");
		expect(feedback).not.toContain("Inspecting HUD density");
		expect(feedback).not.toContain("tok/s");
		expect(feedback).not.toContain("ctx ");
		expect(feedback).not.toMatch(/\btok\b/u);
		expect(feedback).not.toContain("tools");
		expect(feedback).not.toMatch(/\$\d/u);
	});

	it("prefers description, then task, then activity", () => {
		const fromDescription = render([
			makeSession({
				id: "Worker",
				progress: {
					...makeLiveTelemetryProgress("Worker"),
					description: "From progress description",
					task: "Lower-priority task",
				},
			}),
		]);
		expect(fromDescription).toContain("• Worker · From progress description");
		expect(fromDescription).not.toContain("Lower-priority task");
		expect(fromDescription).not.toContain("Streaming response");

		const fromTask = render([
			makeSession({
				id: "Worker",
				progress: { ...makeLiveTelemetryProgress("Worker"), task: "Investigate flaky CI on macOS" },
			}),
		]);
		expect(fromTask).toContain("• Worker · Investigate flaky CI on macOS");
		expect(fromTask).not.toContain("Streaming response");
		expect(fromTask).not.toContain("Inspecting HUD density");

		const fromActivity = render([makeSession({ id: "Worker", progress: makeLiveTelemetryProgress("Worker") })]);
		expect(fromActivity).toContain("• Worker · Streaming response");
		expect(fromActivity).toContain("Inspecting HUD density");
	});

	it("hides non-detached spawns: sync task calls and eval agent() helpers", () => {
		// Sync task spawn (parent blocked on the call) and eval `agent()` spawn
		// (no detached flag at all) both stay off the HUD.
		const sessions = [
			makeSession({ id: "SyncSpawn", description: "inline task work", detached: false }),
			makeSession({ id: "EvalSpawn", description: "eval cell work", detached: undefined }),
		];
		expect(renderSubagentHudLines(sessions, 120)).toEqual([]);

		const out = render([...sessions, makeSession({ id: "BackgroundSpawn", description: "detached work" })]);
		expect(out).toContain("• BackgroundSpawn · detached work");
		expect(out).not.toContain("SyncSpawn");
		expect(out).not.toContain("EvalSpawn");
	});

	it("temporarily surfaces feedback for finished, inline, and observer-unknown agents", () => {
		const out = render(
			[
				makeSession({ id: "DoneWorker", status: "completed", description: "old work" }),
				makeSession({ id: "InlineWorker", detached: false, description: "inline task work" }),
			],
			120,
			[
				{ agentId: "DoneWorker", text: "handoff posted" },
				{ agentId: "InlineWorker", text: "inline follow-up" },
				{ agentId: "UnknownWorker", text: "observer catching up" },
			],
		);

		expect(out).toContain("• DoneWorker · handoff posted");
		expect(out).toContain("• InlineWorker · inline follow-up");
		expect(out).toContain("• UnknownWorker · observer catching up");
	});

	it("threads the detached flag from lifecycle and progress payloads", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus);

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Detached", 0, "background work", true));
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Inline", 1, "sync work"));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("FromProgress", 2, "background work", true));

		const out = render(registry.getSessions());
		expect(out).toContain("• Detached · background work");
		expect(out).toContain("• FromProgress · background work");
		expect(out).not.toContain("Inline");
	});

	it("renders nested ids as a breadcrumb and truncates long descriptions to the viewport", () => {
		const out = render([makeSession({ id: "Anna.Bob", description: `start ${"x".repeat(300)} end` })], 60);
		expect(out).toContain("• Anna>Bob ·");
		expect(out).not.toContain("end");
		for (const line of out.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	it("keeps subagent registry order stable while progress arrives out of order", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus);
		const activeIds = () =>
			registry
				.getSessions()
				.filter(session => session.kind === "subagent" && session.status === "active")
				.map(session => session.id);

		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("SelectorSurfaces", 0, "Map model-selector resolution surfaces"),
		);
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);

		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);
		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);
	});

	it("renders the first eight active detached subagents and summarizes the rest", () => {
		const active = Array.from({ length: 10 }, (_, index) =>
			makeSession({
				id: `Worker${index}`,
				description: `job ${index}`,
			}),
		);

		const out = render(active, 120);

		for (const session of active.slice(0, 8)) {
			expect(out).toContain(`• ${session.id} · ${session.description}`);
		}
		for (const session of active.slice(8)) {
			expect(out).not.toContain(`• ${session.id} · ${session.description}`);
		}
		expect(out).toContain("2 more running");
	});
});

describe("InteractiveMode subagent observer UI sync", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-subagent-observer-");
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		eventBus = new EventBus();
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
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, eventBus);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("coalesces a burst of progress observer changes into one HUD rebuild and render request", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const rebuildHud = vi.spyOn(mode.subagentContainer, "clear");
		vi.useFakeTimers();

		for (let index = 0; index < 6; index++) {
			eventBus.emit(
				TASK_SUBAGENT_PROGRESS_CHANNEL,
				makeProgressPayload(`BurstAgent${index}`, index, `Burst job ${index}`, true),
			);
		}

		await Promise.resolve();
		vi.runAllTimers();
		await Promise.resolve();

		const hud = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(hud).toContain("• BurstAgent0 · Burst job 0");
		expect(hud).toContain("• BurstAgent5 · Burst job 5");
		expect(rebuildHud).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("overwrites prior feedback for one agent and clears the HUD after the 10s TTL", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();

		mode.showSubagentFeedback({ agentId: "AuthLoader", text: "First reply", timestamp: 1 });
		let hud = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(hud).toContain("• AuthLoader · First reply");

		vi.advanceTimersByTime(9_000);
		mode.showSubagentFeedback({ agentId: "AuthLoader", text: "Latest reply", timestamp: 2 });
		hud = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(hud).toContain("• AuthLoader · Latest reply");
		expect(hud).not.toContain("First reply");
		expect(hud.match(/• AuthLoader ·/g)?.length ?? 0).toBe(1);

		vi.advanceTimersByTime(9_999);
		expect(Bun.stripANSI(mode.subagentContainer.render(120).join("\n"))).toContain("• AuthLoader · Latest reply");

		vi.advanceTimersByTime(1);
		expect(mode.subagentContainer.render(120)).toEqual([]);
		expect(requestRender).toHaveBeenCalled();
	});
});
