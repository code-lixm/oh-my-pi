/**
 * Contract: the anchored subagent HUD is a terse task list for active detached
 * task subagents, ordered by descending observable update while preserving input
 * order for ties. Re-rendering an unchanged snapshot must not age-sort rows.
 * Rows show task identity, lifecycle state, model, context use, and cost—not task
 * prose, feedback, IRC content, or tool activity.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode, renderSubagentHudLines } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { ObservableSession } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type AgentProgress,
	type SubagentProgressPayload,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getSettingsUiLocale, setSettingsUiLocale } from "../src/i18n/settings-locale";

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

function makeProgressPayload(
	id: string,
	overrides: Partial<AgentProgress> = {},
	detached = true,
): SubagentProgressPayload {
	const progress = makeProgress({ id, description: `Task ${id}`, ...overrides });
	return {
		index: progress.index,
		agent: progress.agent,
		agentSource: progress.agentSource,
		task: progress.task,
		detached,
		progress,
	};
}

interface ColumnsStub {
	setColumns(columns: number): void;
	restore(): void;
}

function stubStdoutColumns(initialColumns: number): ColumnsStub {
	const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	let columns = initialColumns;
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => columns, set: () => {} });
	return {
		setColumns(nextColumns: number) {
			columns = nextColumns;
		},
		restore() {
			if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
			else
				Object.defineProperty(process.stdout, "columns", { configurable: true, value: undefined, writable: true });
		},
	};
}

function renderLines(sessions: ObservableSession[], columns = 120): string[] {
	return renderSubagentHudLines(sessions, columns).map(line => Bun.stripANSI(line));
}

function renderedRows(sessions: ObservableSession[], columns = 120): string[] {
	return renderLines(sessions, columns).filter(line => line.trimStart().startsWith("•"));
}

describe("subagent HUD lines", () => {
	let previousLocale: string;

	beforeAll(async () => {
		await initTheme();
		previousLocale = getSettingsUiLocale();
	});

	beforeEach(() => {
		setSettingsUiLocale("zh-CN");
	});

	afterEach(() => {
		setSettingsUiLocale(previousLocale);
	});

	it("renders Chinese task state with model, context, and cost without dynamic task content", () => {
		const rows = renderedRows([
			makeSession({
				id: "Builder.Checker",
				status: "active",
				detached: true,
				lastUpdate: 200,
				description: "IRC_FEEDBACK_LEAK_MARKER",
				progress: makeProgress({
					id: "Builder.Checker",
					status: "running",
					task: "TASK_LEAK_MARKER",
					description: "PROGRESS_DESCRIPTION_LEAK_MARKER",
					resolvedModel: "anthropic/claude-test",
					contextTokens: 4_000,
					contextWindow: 8_000,
					cost: 0.25,
					recentTools: ["RECENT_TOOL_LEAK_MARKER"] as never,
					recentOutput: ["RECENT_OUTPUT_LEAK_MARKER"] as never,
					activity: {
						phase: "tool",
						label: "TOOL_ACTIVITY_LEAK_MARKER",
						detail: "ACTIVITY_DETAIL_LEAK_MARKER",
						phaseStartedAtMs: 200,
						lastActivityAtMs: 200,
					},
				}),
			}),
			makeSession({
				id: "WaitingForInput",
				status: "active",
				detached: true,
				lastUpdate: 100,
				progress: makeProgress({
					id: "WaitingForInput",
					status: "running",
					activity: {
						phase: "waiting-user",
						label: "Requesting decision",
						phaseStartedAtMs: 100,
						lastActivityAtMs: 100,
					},
				}),
			}),
		]);

		expect(rows).toHaveLength(2);
		const builder = rows.find(row => row.includes("Builder>Checker"))!;
		const waiting = rows.find(row => row.includes("WaitingForInput"))!;
		expect(builder).toContain("运行中");
		expect(builder).toContain("anthropic/claude-test");
		expect(builder).toContain("4k/8k");
		expect(builder).toContain("$0.25");
		expect(waiting).toContain("等待用户");
		for (const leakedDetail of [
			"IRC_FEEDBACK_LEAK_MARKER",
			"TASK_LEAK_MARKER",
			"PROGRESS_DESCRIPTION_LEAK_MARKER",
			"RECENT_TOOL_LEAK_MARKER",
			"RECENT_OUTPUT_LEAK_MARKER",
			"TOOL_ACTIVITY_LEAK_MARKER",
			"ACTIVITY_DETAIL_LEAK_MARKER",
		]) {
			expect(builder).not.toContain(leakedDetail);
		}
	});

	it("orders active detached rows by last update and only reorders after snapshot updates", () => {
		const older = makeSession({
			id: "OlderUpdate",
			status: "active",
			detached: true,
			lastUpdate: 100,
		});
		const newerFirst = makeSession({
			id: "NewerFirst",
			status: "active",
			detached: true,
			lastUpdate: 200,
		});
		const newerSecond = makeSession({
			id: "NewerSecond",
			status: "active",
			detached: true,
			lastUpdate: 200,
		});
		const ids = ["OlderUpdate", "NewerFirst", "NewerSecond"] as const;
		const initialSnapshot = [older, newerFirst, newerSecond];
		const initialOrder: Array<(typeof ids)[number] | undefined> = ["NewerFirst", "NewerSecond", "OlderUpdate"];
		const initialRows = renderedRows(initialSnapshot);
		const repeatedRows = renderedRows(initialSnapshot);
		expect(initialRows.map(row => ids.find(id => row.includes(id)))).toEqual(initialOrder);
		expect(repeatedRows.map(row => ids.find(id => row.includes(id)))).toEqual(initialOrder);

		const refreshedSnapshot = [
			{ ...older, lastUpdate: 900 },
			{ ...newerFirst, lastUpdate: 50 },
			{ ...newerSecond, lastUpdate: 50 },
		];
		expect(renderedRows(refreshedSnapshot).map(row => ids.find(id => row.includes(id)))).toEqual([
			"OlderUpdate",
			"NewerFirst",
			"NewerSecond",
		]);
	});
});

describe("InteractiveMode subagent HUD repainting", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;
	let previousLocale: string;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		previousLocale = getSettingsUiLocale();
		setSettingsUiLocale("en");
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-subagent-hud-render-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, eventBus);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
	});

	function enableSubagentHud(): void {
		session.settings.set("display.showSubagentList", true);
		mode.refreshSubagentList();
	}

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		setSettingsUiLocale(previousLocale);
		resetSettingsForTest();
	});

	it("keeps the detached subagent HUD hidden by default until explicitly enabled", () => {
		vi.useFakeTimers();
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("OptInWorker"));
		vi.advanceTimersByTime(100);

		expect(Bun.stripANSI(mode.subagentContainer.render(160).join("\n"))).toBe("");

		enableSubagentHud();

		const hud = Bun.stripANSI(mode.subagentContainer.render(160).join("\n"));
		expect(hud).toContain("Subagents");
		expect(hud).toContain("OptInWorker");
	});

	it("does not repaint for progress with no visible HUD surface", () => {
		enableSubagentHud();
		vi.useFakeTimers();
		const fullRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const scopedRender = vi.spyOn(mode.ui, "requestComponentRender").mockImplementation(() => {});

		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("InlineWorker", { description: "Inline task" }, false),
		);
		vi.advanceTimersByTime(100);

		expect(scopedRender).not.toHaveBeenCalled();
		expect(fullRender).not.toHaveBeenCalled();
	});

	it("repaints only the subagent root for visible cost, context, waiting, and order changes", () => {
		enableSubagentHud();
		vi.useFakeTimers();
		const fullRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const scopedRender = vi.spyOn(mode.ui, "requestComponentRender").mockImplementation(() => {});

		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("EarlierWorker", {
				resolvedModel: "anthropic/claude-earlier",
				contextTokens: 2_000,
				contextWindow: 4_000,
				cost: 0.1,
			}),
		);
		vi.advanceTimersByTime(100);
		scopedRender.mockClear();
		fullRender.mockClear();

		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("NewestWorker", {
				resolvedModel: "anthropic/claude-visible",
				contextTokens: 7_000,
				contextWindow: 14_000,
				cost: 0.71,
				activity: {
					phase: "waiting-user",
					label: "Need input",
					phaseStartedAtMs: 0,
					lastActivityAtMs: 0,
				},
			}),
		);
		vi.advanceTimersByTime(100);

		const hud = Bun.stripANSI(mode.subagentContainer.render(160).join("\n"));
		expect(hud).toContain("Waiting for user");
		expect(hud).toContain("anthropic/claude-visible");
		expect(hud).toContain("7k/14k");
		expect(hud).toContain("$0.71");
		expect(hud.indexOf("NewestWorker")).toBeLessThan(hud.indexOf("EarlierWorker"));
		expect(scopedRender).toHaveBeenCalledTimes(1);
		expect(scopedRender).toHaveBeenLastCalledWith(mode.subagentContainer);
		expect(fullRender).not.toHaveBeenCalled();
	});

	it("repaints the editor only when the running badge count changes", () => {
		const fullRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const scopedRender = vi.spyOn(mode.ui, "requestComponentRender").mockImplementation(() => {});
		const registry = AgentRegistry.global();
		registry.register({
			id: "BadgeWorker",
			displayName: "Badge worker",
			kind: "sub",
			session: null,
			status: "running",
		});

		expect(mode.statusLine.subagentCount).toBe(1);
		expect(scopedRender).toHaveBeenCalledTimes(1);
		expect(scopedRender).toHaveBeenLastCalledWith(mode.editor);
		expect(fullRender).not.toHaveBeenCalled();

		scopedRender.mockClear();
		registry.updateMetadata("BadgeWorker", { displayName: "Renamed badge worker" });
		expect(mode.statusLine.subagentCount).toBe(1);
		expect(scopedRender).not.toHaveBeenCalled();
		expect(fullRender).not.toHaveBeenCalled();
	});

	it("recomputes subagent HUD text after a terminal column change", () => {
		enableSubagentHud();
		const columns = stubStdoutColumns(160);
		try {
			vi.useFakeTimers();
			vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
			const tailMarker = "TailMarker";
			eventBus.emit(
				TASK_SUBAGENT_PROGRESS_CHANNEL,
				makeProgressPayload(`WidthProbe-abcdefghijklmnopqrstuvwxyz-${tailMarker}`, {
					resolvedModel: "anthropic/claude-width",
					contextTokens: 7_000,
					contextWindow: 14_000,
					cost: 0.71,
				}),
			);
			vi.advanceTimersByTime(100);
			expect(Bun.stripANSI(mode.subagentContainer.render(160).join("\n"))).toContain(tailMarker);

			columns.setColumns(24);
			process.stdout.emit("resize");
			const narrowHud = Bun.stripANSI(mode.subagentContainer.render(24).join("\n"));
			expect(narrowHud).toContain("WidthProbe");
			expect(narrowHud).not.toContain(tailMarker);
		} finally {
			columns.restore();
		}
	});
});
