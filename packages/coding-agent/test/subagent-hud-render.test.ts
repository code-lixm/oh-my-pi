/**
 * Contract: the anchored subagent HUD is a terse first-observed task list. It
 * renders only active detached task subagents in first-observed order. Rows
 * show task identity, lifecycle state, model, context use, and cost—not task
 * prose, feedback, IRC content, or tool activity.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { renderSubagentHudLines } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { ObservableSession } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task";
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

	it("keeps active detached rows in first-observed order while telemetry refreshes", () => {
		const first = makeSession({
			id: "FirstObserved",
			status: "active",
			detached: true,
			lastUpdate: 200,
			progress: makeProgress({
				id: "FirstObserved",
				status: "running",
				contextTokens: 1_000,
				contextWindow: 8_000,
				activity: {
					phase: "streaming",
					label: "Initial first activity",
					phaseStartedAtMs: 200,
					lastActivityAtMs: 200,
				},
			}),
		});
		const second = makeSession({
			id: "SecondObserved",
			status: "active",
			detached: true,
			lastUpdate: 100,
			progress: makeProgress({
				id: "SecondObserved",
				status: "running",
				contextTokens: 7_000,
				contextWindow: 8_000,
				activity: {
					phase: "streaming",
					label: "Initial second activity",
					phaseStartedAtMs: 100,
					lastActivityAtMs: 100,
				},
			}),
		});
		const ids = ["FirstObserved", "SecondObserved"] as const;

		const initialRows = renderedRows([first, second]);
		expect(initialRows.map(row => ids.find(id => row.includes(id)))).toEqual([...ids]);
		expect(initialRows.find(row => row.includes("FirstObserved"))).toContain("1k/8k");
		expect(initialRows.find(row => row.includes("SecondObserved"))).toContain("7k/8k");

		const refreshedRows = renderedRows([
			{
				...first,
				lastUpdate: 50,
				progress: {
					...first.progress!,
					contextTokens: 7_000,
					activity: { ...first.progress!.activity!, lastActivityAtMs: 50 },
				},
			},
			{
				...second,
				lastUpdate: 900,
				progress: {
					...second.progress!,
					contextTokens: 1_000,
					activity: { ...second.progress!.activity!, lastActivityAtMs: 900 },
				},
			},
		]);
		expect(refreshedRows.map(row => ids.find(id => row.includes(id)))).toEqual([...ids]);
		expect(refreshedRows.find(row => row.includes("FirstObserved"))).toContain("7k/8k");
		expect(refreshedRows.find(row => row.includes("SecondObserved"))).toContain("1k/8k");
	});
});
