import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { renderCodeCell, renderMarkdownCell } from "@oh-my-pi/pi-coding-agent/tui";

const WIDTH = 72;
let theme: Theme;

beforeAll(async () => {
	const loadedTheme = await getThemeByName("dark");
	expect(loadedTheme).toBeDefined();
	theme = loadedTheme!;
	setThemeInstance(theme);
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
	expect(lines[contentIndex + 1]).toMatch(/^│\s*│$/);
}

function expectNoOutputDivider(lines: readonly string[]): void {
	for (const line of lines) {
		expect(line).not.toContain("Output");
	}

	const internalHorizontalBars = lines
		.slice(1, -1)
		.filter(line => line.includes(theme.boxRound.horizontal));
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
});
