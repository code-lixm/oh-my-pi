import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../config/settings";
import { getThemeByName, setThemeInstance, type Theme } from "../modes/theme/theme";
import { renderResult } from "./render";
import { taskToolRenderer } from "./renderer";
import type { AgentProgress, SingleResult, TaskToolDetails } from "./types";

function stripAnsi(text: string): string {
	const withoutLinks = text.replace(/\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g, "");
	return withoutLinks.replace(/\x1b\[[0-9;]*m/g, "");
}

const originalRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");

function setViewportRows(rows: number): void {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
}

function restoreViewportRows(): void {
	if (originalRowsDescriptor) {
		Object.defineProperty(process.stdout, "rows", originalRowsDescriptor);
		return;
	}
	Reflect.deleteProperty(process.stdout, "rows");
}

function makeProgress(recentOutput: string[]): AgentProgress {
	return {
		index: 0,
		id: "NoisySubagent",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "produce noisy output",
		recentTools: [],
		recentOutput,
		toolCount: 1,
		requests: 1,
		tokens: 0,
		cost: 0,
		durationMs: 0,
	};
}

function makeParentWithNestedProgress(childCount: number): AgentProgress {
	const children = Array.from(
		{ length: childCount },
		(_, index): AgentProgress => ({
			...makeProgress([]),
			index,
			id: `Nested${index + 1}`,
			task: `nested child ${index + 1}`,
		}),
	);
	return {
		...makeProgress([]),
		id: "Parent",
		task: "parent task",
		inflightTaskDetails: {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 1,
			progress: children,
		},
	};
}

function makeSingleResult(index: number, overrides?: Partial<SingleResult>): SingleResult {
	return {
		index,
		id: `Done${index + 1}`,
		agent: "task",
		agentSource: "bundled",
		task: `finished child ${index + 1}`,
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function makeParentWithNestedResults(childCount: number): TaskToolDetails {
	const nested: TaskToolDetails = {
		projectAgentsDir: null,
		// Failure on the LAST child in display order (equal durations, index tiebreak):
		// a plain head-of-list pick would elide it, so its visibility proves the
		// failure-first selection of `selectCollapsedResults`.
		results: Array.from({ length: childCount }, (_, index) =>
			makeSingleResult(index, index === childCount - 1 ? { exitCode: 1, error: "boom" } : undefined),
		),
		totalDurationMs: 1,
	};
	const parent = makeSingleResult(0, { id: "Parent", extractedToolData: { task: [nested] } });
	return { projectAgentsDir: null, results: [parent], totalDurationMs: 1 };
}

function renderResultLines(details: TaskToolDetails, expanded: boolean, uiTheme: Theme): string[] {
	const component = renderResult(
		{ content: [{ type: "text", text: "Ran 1 agent" }], details },
		{ expanded, isPartial: false },
		uiTheme,
	);
	return component.render(120).map(stripAnsi);
}

function renderResultText(details: TaskToolDetails, expanded: boolean, uiTheme: Theme): string {
	return renderResultLines(details, expanded, uiTheme).join("\n");
}

function renderProgressText(progress: AgentProgress, expanded: boolean, uiTheme: Theme): string {
	const details: TaskToolDetails = {
		projectAgentsDir: null,
		results: [],
		totalDurationMs: 1,
		progress: [progress],
	};
	const component = renderResult(
		{ content: [{ type: "text", text: "Running 1 agent..." }], details },
		{ expanded, isPartial: true },
		uiTheme,
	);
	return stripAnsi(component.render(120).join("\n"));
}

describe("task live progress rendering", () => {
	let uiTheme: Theme;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
	});

	afterEach(() => {
		restoreViewportRows();
	});

	it("caps subagent recent output with the viewport budget instead of a fixed six lines", () => {
		setViewportRows(40);
		const chronological = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`);
		const text = renderProgressText(makeProgress([...chronological].reverse()), true, uiTheme);

		expect(text).toContain("line 1");
		expect(text).toContain("line 8");
		expect(text).not.toContain("more lines");
	});

	it("keeps the newest subagent output when the viewport cap truncates", () => {
		setViewportRows(24);
		const chronological = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`);
		const text = renderProgressText(makeProgress([...chronological].reverse()), true, uiTheme);

		expect(text).toContain("… 3 earlier lines");
		expect(text).not.toContain("line 1");
		expect(text).not.toContain("line 3");
		expect(text).toContain("line 4");
		expect(text).toContain("line 8");
	});

	it("strips bash footer notices from expanded subagent recent output", () => {
		setViewportRows(40);
		const chronological = [
			"line 1",
			"line 2",
			"line 3",
			"line 4",
			"line 5",
			"line 6",
			"Wall time: 0.03 seconds",
			"[raw output: artifact://123]",
		];
		const progress = makeProgress([...chronological].reverse());

		const expandedText = renderProgressText(progress, true, uiTheme);
		expect(expandedText).toContain("line 1");
		expect(expandedText).toContain("line 6");
		expect(expandedText).not.toContain("Wall time:");
		expect(expandedText).not.toContain("raw output:");

		const collapsedText = renderProgressText(progress, false, uiTheme);
		expect(collapsedText).not.toContain("line 1");
		expect(collapsedText).not.toContain("raw output:");
	});
	it("sanitizes control sequences from expanded subagent recent output", () => {
		setViewportRows(40);
		const progress = makeProgress(["safe after \x1b[2Kclear", "raw\rprompt"]);

		const text = renderProgressText(progress, true, uiTheme);

		expect(text).toContain("safe after clear");
		expect(text).toContain("rawprompt");
		expect(text).not.toContain("\x1b[2K");
		expect(text).not.toContain("\r");
	});
	it("sanitizes control sequences from finalized subagent results", () => {
		const output = JSON.stringify({ "\x1b[2Kkey": "safe value" });
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [
				makeSingleResult(0, {
					id: "Final\x1b[2KAgent",
					description: "description\rtext",
					aborted: true,
					abortReason: "aborted \x1b[2Kreason",
					output,
				}),
			],
			totalDurationMs: 1,
		};

		const text = renderResultText(details, true, uiTheme);

		expect(text).toContain("FinalAgent");
		expect(text).toContain("descriptiontext");
		expect(text).toContain("aborted reason");
		expect(text).toContain("key");
		expect(text).not.toContain("\x1b[2K");
		expect(text).not.toContain("\r");
	});

	it("suppresses completed structured output envelopes only in collapsed result previews", () => {
		const completedEnvelope = JSON.stringify({
			status: "completed",
			files: ["packages/coding-agent/src/task/render.ts"],
			summary: "structured completion kept for expanded inspection",
		});
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [makeSingleResult(0, { id: "StructuredEnvelope", output: completedEnvelope })],
			totalDurationMs: 1,
		};

		const collapsed = renderResultText(details, false, uiTheme);
		expect(collapsed).toContain("StructuredEnvelope");
		expect(collapsed).not.toContain("status");
		expect(collapsed).not.toContain("completed");
		expect(collapsed).not.toContain("files");
		expect(collapsed).not.toContain("structured completion kept");

		const expanded = renderResultText(details, true, uiTheme);
		expect(expanded).toContain("status");
		expect(expanded).toContain("completed");
		expect(expanded).toContain("files");
		expect(expanded).toContain("packages/coding-agent/src/task/render.ts");
		expect(expanded).toContain("structured completion kept for expanded inspection");
	});

	it("keeps collapsed non-completed JSON and plain output summaries visible", () => {
		const jsonDetails: TaskToolDetails = {
			projectAgentsDir: null,
			results: [
				makeSingleResult(0, {
					id: "RunningEnvelope",
					output: JSON.stringify({ status: "running", files: ["still-visible.ts"], summary: "not done yet" }),
				}),
			],
			totalDurationMs: 1,
		};

		const collapsedJson = renderResultText(jsonDetails, false, uiTheme);
		expect(collapsedJson).toContain("RunningEnvelope");
		expect(collapsedJson).toContain("status");
		expect(collapsedJson).toContain("running");
		expect(collapsedJson).toContain("files");

		const plainDetails: TaskToolDetails = {
			projectAgentsDir: null,
			results: [makeSingleResult(0, { id: "PlainSummary", output: "plain summary text stays visible" })],
			totalDurationMs: 1,
		};
		const collapsedPlain = renderResultText(plainDetails, false, uiTheme);
		expect(collapsedPlain).toContain("PlainSummary");
		expect(collapsedPlain).toContain("plain summary text stays visible");
	});

	it("keeps missing-yield warnings while hiding completed envelopes in collapsed output", () => {
		const output = [
			"SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.",
			JSON.stringify({ status: "completed", files: ["hidden-after-warning.ts"], summary: "hide this envelope" }),
		].join("\n");
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [makeSingleResult(0, { id: "WarningEnvelope", output })],
			totalDurationMs: 1,
		};

		const collapsed = renderResultText(details, false, uiTheme);
		expect(collapsed).toContain("WarningEnvelope");
		expect(collapsed).toContain("SYSTEM WARNING: Subagent exited without calling yield tool");
		expect(collapsed).not.toContain("hidden-after-warning.ts");
		expect(collapsed).not.toContain("hide this envelope");
		expect(collapsed).not.toContain("files");
	});

	it("renders finalized task result frames on the shared one-column gutter", () => {
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [makeSingleResult(0, { id: "FrameAgent", task: "verify frame gutter", output: "frame result" })],
			totalDurationMs: 1,
		};
		const lines = renderResultLines(details, true, uiTheme);
		const frameBorderGlyphs = [uiTheme.boxRound.topLeft, uiTheme.boxRound.bottomLeft];
		const frameRows = lines.filter(line => frameBorderGlyphs.includes(line.trimStart()[0] ?? ""));

		expect(frameRows).toHaveLength(2);
		for (const row of frameRows) {
			expect(row.length - row.trimStart().length, JSON.stringify(row)).toBe(1);
		}
		expect(lines.join("\n")).toContain("FrameAgent");
	});

	it("caps collapsed nested task progress at four rows plus an elision line", () => {
		setViewportRows(40);
		const text = renderProgressText(makeParentWithNestedProgress(6), false, uiTheme);

		expect(text).not.toContain("Nested1");
		expect(text).not.toContain("Nested2");
		expect(text).toContain("Nested3");
		expect(text).toContain("Nested4");
		expect(text).toContain("Nested5");
		expect(text).toContain("Nested6");
		expect(text).toContain("2 more agents");
	});

	it("shows every nested task progress row when expanded", () => {
		setViewportRows(40);
		const text = renderProgressText(makeParentWithNestedProgress(6), true, uiTheme);

		for (let index = 1; index <= 6; index++) {
			expect(text).toContain(`Nested${index}`);
		}
		expect(text).not.toContain("more agents");
	});

	it("caps collapsed finalized nested task results and keeps the failed child visible", () => {
		setViewportRows(40);
		const text = renderResultText(makeParentWithNestedResults(6), false, uiTheme);

		expect(text).toContain("Done6"); // failed child wins a slot despite sorting last
		expect(text).toContain("2 more agents");
		const visibleChildren = [1, 2, 3, 4, 5, 6].filter(index => text.includes(`Done${index}`));
		expect(visibleChildren).toHaveLength(4);
	});

	it("shows every finalized nested task result when expanded", () => {
		setViewportRows(40);
		const text = renderResultText(makeParentWithNestedResults(6), true, uiTheme);

		for (let index = 1; index <= 6; index++) {
			expect(text).toContain(`Done${index}`);
		}
		expect(text).not.toContain("more agents");
	});

	it("does not request spinner ticks for static partial progress", () => {
		expect("animatedPartialResult" in taskToolRenderer).toBe(false);
	});

	it("renders running progress identically across spinner frames", () => {
		const progress = makeProgress([]);
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 1,
			progress: [progress],
		};
		const render = (spinnerFrame: number) =>
			stripAnsi(
				renderResult(
					{ content: [{ type: "text", text: "Running 1 agent..." }], details },
					{ expanded: false, isPartial: true, spinnerFrame },
					uiTheme,
				)
					.render(120)
					.join("\n"),
			);

		expect(render(0)).toBe(render(1));
	});
});
