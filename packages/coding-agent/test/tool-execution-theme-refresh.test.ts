import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { getThemeByName, initTheme, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	getOutputBlockBorderStyle,
	type OutputBlockBorderStyle,
	setOutputBlockBorderStyle,
} from "@oh-my-pi/pi-coding-agent/tui/output-block";
import { TUI, type TUI as TUIType } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const WIDTH = 100;
const created: ToolExecutionComponent[] = [];
const uiStub = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
} as unknown as TUIType;

let darkTheme: Theme;
let lightTheme: Theme;

let previousBorderStyle: OutputBlockBorderStyle;
type ToolResult = {
	content: Array<{ type: string; text?: string }>;
	details?: Record<string, unknown>;
	isError?: boolean;
};

type Scenario = {
	name: string;
	toolName: string;
	args: Record<string, unknown>;
	result: ToolResult;
};

const scenarios: Scenario[] = [
	{
		name: "bash",
		toolName: "bash",
		args: { command: "printf 'done\\n'" },
		result: {
			content: [{ type: "text", text: "done" }],
			details: { exitCode: 1, wallTimeMs: 120 },
			isError: true,
		},
	},
	{
		name: "edit",
		toolName: "edit",
		args: { path: "src/demo.ts", oldText: "before", newText: "after" },
		result: {
			content: [{ type: "text", text: "Updated src/demo.ts" }],
			details: {
				path: "src/demo.ts",
				op: "update",
				firstChangedLine: 1,
				diff: "-before\n+after",
			},
			isError: true,
		},
	},
];

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Expected dark theme");
	const light = await getThemeByName("light");
	if (!light) throw new Error("Expected light theme");
	darkTheme = dark;
	lightTheme = light;
});

beforeEach(() => {
	previousBorderStyle = getOutputBlockBorderStyle();
	setOutputBlockBorderStyle("accent");
	setThemeInstance(darkTheme);
});

afterEach(async () => {
	for (const component of created.splice(0)) component.stopAnimation();
	setOutputBlockBorderStyle(previousBorderStyle);
	await initTheme();
});

function surfaceTintBg(theme: Theme, color: "error" | "borderMuted"): string {
	const ansi = theme.getSurfaceTintBgAnsi(color, 0.06);
	expect(ansi).toMatch(/\x1b\[48;/);
	return ansi;
}

function borderMutedRailFg(theme: Theme): string {
	const ansi = theme.getSurfaceTintFgAnsi("borderMuted");
	expect(ansi).toMatch(/\x1b\[38;/);
	return ansi;
}

function renderCommittedTranscriptThemeFlip(scenario: Scenario): { initial: string; afterFlip: string } {
	const term = new VirtualTerminal(WIDTH, 20);
	const ui = new TUI(term);
	const transcript = new TranscriptContainer();
	const component = new ToolExecutionComponent(scenario.toolName, scenario.args, {}, undefined, uiStub);
	created.push(component);
	component.updateResult(scenario.result, false);
	transcript.addChild(component);
	ui.addChild(transcript);

	const initialLines = ui.render(WIDTH);
	const initial = initialLines.join("\n");
	transcript.setNativeScrollbackCommittedRows(initialLines.length);

	setThemeInstance(lightTheme);
	ui.invalidate();
	const afterFlip = ui.render(WIDTH).join("\n");

	return { initial, afterFlip };
}

describe("ToolExecutionComponent theme refresh after transcript commit", () => {
	for (const scenario of scenarios) {
		it(`rebuilds committed ${scenario.name} cards with the active light error accent surface`, () => {
			const darkErrorTint = surfaceTintBg(darkTheme, "error");
			const lightErrorTint = surfaceTintBg(lightTheme, "error");
			expect(lightErrorTint).not.toBe(darkErrorTint);

			const { initial, afterFlip } = renderCommittedTranscriptThemeFlip(scenario);

			expect(initial).toContain(darkErrorTint);
			expect(initial).not.toContain(lightErrorTint);

			expect(afterFlip).toContain(lightErrorTint);
			expect(afterFlip).not.toContain(darkErrorTint);
		});
	}

	it("rebuilds committed generic success output with the active muted accent surface", () => {
		const genericSuccess: Scenario = {
			name: "generic-success",
			toolName: "generic_success_tool",
			args: { path: "logs/run.txt" },
			result: {
				content: [{ type: "text", text: "Completed without custom renderer" }],
			},
		};
		const darkMutedTint = surfaceTintBg(darkTheme, "borderMuted");
		const lightMutedTint = surfaceTintBg(lightTheme, "borderMuted");
		const darkRailFg = borderMutedRailFg(darkTheme);
		const lightRailFg = borderMutedRailFg(lightTheme);
		expect(lightMutedTint).not.toBe(darkMutedTint);
		expect(lightRailFg).not.toBe(darkRailFg);

		const { initial, afterFlip } = renderCommittedTranscriptThemeFlip(genericSuccess);

		expect(initial).toContain("Completed without custom renderer");
		expect(initial).toContain(darkMutedTint);
		expect(initial).toContain(darkRailFg);
		expect(initial).not.toContain(lightMutedTint);
		expect(initial).not.toContain(lightRailFg);

		expect(afterFlip).toContain("Completed without custom renderer");
		expect(afterFlip).toContain(lightMutedTint);
		expect(afterFlip).toContain(lightRailFg);
		expect(afterFlip).not.toContain(darkMutedTint);
		expect(afterFlip).not.toContain(darkRailFg);
	});
});
