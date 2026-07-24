import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { renderCodeCell, renderMarkdownCell } from "@oh-my-pi/pi-coding-agent/tui";
import {
	getOutputBlockBorderStyle,
	type OutputBlockBorderStyle,
	setOutputBlockBorderStyle,
} from "@oh-my-pi/pi-coding-agent/tui/output-block";

const WIDTH = 72;
let theme: Theme;
let previousBorderStyle: OutputBlockBorderStyle;

beforeAll(async () => {
	const loadedTheme = await getThemeByName("dark");
	expect(loadedTheme).toBeDefined();
	theme = loadedTheme!;
	setThemeInstance(theme);
});

beforeEach(() => {
	previousBorderStyle = getOutputBlockBorderStyle();
	setOutputBlockBorderStyle("accent");
});

afterEach(() => {
	setOutputBlockBorderStyle(previousBorderStyle);
});

function plain(lines: readonly string[]): string[] {
	return lines.map(line => Bun.stripANSI(line));
}

function lineContaining(lines: readonly string[], needle: string): number {
	const index = lines.findIndex(line => line.includes(needle));
	expect(index, `missing rendered line containing ${needle}`).toBeGreaterThanOrEqual(0);
	return index;
}

function expectExactlyOneBlankLineBetweenContentAndOutput(
	lines: readonly string[],
	contentNeedle: string,
	outputNeedle: string,
): void {
	const contentIndex = lineContaining(lines, contentNeedle);
	const outputIndex = lineContaining(lines, outputNeedle);

	expect(outputIndex).toBe(contentIndex + 2);
	expect(lines[contentIndex + 1]).toMatch(/^▌\s*$/);
}

function expectNoOutputDivider(lines: readonly string[]): void {
	for (const line of lines) {
		expect(line).not.toContain("Output");
	}

	const internalHorizontalBars = lines.slice(1, -1).filter(line => line.includes(theme.boxRound.horizontal));
	expect(internalHorizontalBars).toEqual([]);
}

describe("code cell output gap", () => {
	it("renders code output after one blank row without an Output divider", () => {
		const lines = plain(
			renderCodeCell(
				{
					code: "const answer = 42;",
					language: "text",
					output: "answer: 42",
					status: "complete",
					width: WIDTH,
				},
				theme,
			),
		);

		expectExactlyOneBlankLineBetweenContentAndOutput(lines, "const answer = 42;", "answer: 42");
		expectNoOutputDivider(lines);
	});

	it("renders markdown output after one blank row without an Output divider", () => {
		const lines = plain(
			renderMarkdownCell(
				{
					content: "markdown body",
					output: "rendered output",
					status: "complete",
					width: WIDTH,
				},
				theme,
			),
		);

		expectExactlyOneBlankLineBetweenContentAndOutput(lines, "markdown body", "rendered output");
		expectNoOutputDivider(lines);
	});

	it("drops the body↔output blank line when the code body is empty", () => {
		const lines = plain(
			renderCodeCell(
				{
					code: "",
					language: "text",
					output: "Resolved path: /tmp/x.md",
					status: "complete",
					width: WIDTH,
				},
				theme,
			),
		);
		// Output must NOT be preceded by a blank separator row when no body is
		// present — readers expect the indicator to sit directly under the title.
		expect(lines).not.toContain("");
		expect(lineContaining(lines, "Resolved path")).toBeLessThan(lines.length);
	});

	it("drops the body↔output blank line when the markdown body is empty", () => {
		const lines = plain(
			renderMarkdownCell(
				{
					content: "",
					output: "Resolved path: /tmp/x.md",
					status: "complete",
					width: WIDTH,
				},
				theme,
			),
		);
		expect(lines).not.toContain("");
		expect(lineContaining(lines, "Resolved path")).toBeLessThan(lines.length);
	});

	it("compacts a code cell whose code is empty and has no output", () => {
		const lines = plain(
			renderCodeCell(
				{
					code: "",
					language: "text",
					status: "complete",
					width: WIDTH,
				},
				theme,
			),
		);
		// No body, no output → only the title between the leading and trailing
		// accent padding rows; no internal separator row is introduced.
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatch(/^▌\s*$/);
		expect(lines[2]).toMatch(/^▌\s*$/);
	});

	it("compacts a code cell even when the caller passes codeLineNumbers: []", () => {
		// Mirrors the read tool's displayContent path for an empty read body:
		// lineNumbers is built from `Array.from({ length: lineCount }, ...)` so an
		// empty body produces `[]`. The renderer must still drop the body rather
		// than treating the empty array as a populated body.
		const lines = plain(
			renderCodeCell(
				{
					code: "",
					language: "text",
					output: "Resolved path: /tmp/x.md",
					status: "complete",
					codeStartLine: 1,
					codeLineNumbers: [],
					width: WIDTH,
				},
				theme,
			),
		);
		expect(lines).not.toContain("");
		expect(lineContaining(lines, "Resolved path")).toBeLessThan(lines.length);
	});
});
