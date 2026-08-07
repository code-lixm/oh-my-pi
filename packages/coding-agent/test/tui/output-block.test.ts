import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { renderMarkdownCell } from "@oh-my-pi/pi-coding-agent/tui/code-cell";
import {
	getOutputBlockBorderStyle,
	type OutputBlockBorderStyle,
	renderOutputBlock,
	setOutputBlockBorderStyle,
} from "@oh-my-pi/pi-coding-agent/tui/output-block";

describe("renderOutputBlock", () => {
	let previousBorderStyle: OutputBlockBorderStyle;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		previousBorderStyle = getOutputBlockBorderStyle();
		setOutputBlockBorderStyle("full");
	});

	afterEach(() => {
		setOutputBlockBorderStyle(previousBorderStyle);
	});

	it("reserves symmetric default padding inside content borders", async () => {
		const theme = (await getThemeByName("dark"))!;
		const lines = renderOutputBlock(
			{
				borderStyle: "full",
				width: 16,
				applyBg: false,
				sections: [{ lines: ["abcdefghijklmnop"] }],
			},
			theme,
		).map(line => stripVTControlCharacters(line));

		expect(lines.filter(line => line.startsWith(" │"))).toEqual([" │ abcdefghijk │", ` │ lmnop${" ".repeat(7)}│`]);
	});

	it("keeps explicitly flush content flush on both sides", async () => {
		const theme = (await getThemeByName("dark"))!;
		const lines = renderOutputBlock(
			{
				borderStyle: "full",
				width: 16,
				applyBg: false,
				contentPaddingLeft: 0,
				sections: [{ lines: ["abcdefghijklmn"] }],
			},
			theme,
		).map(line => stripVTControlCharacters(line));

		expect(lines.filter(line => line.startsWith(" │"))).toEqual([" │abcdefghijklm│", ` │n${" ".repeat(12)}│`]);
	});

	it("budgets collapsed Markdown rows against the padded block width", async () => {
		const theme = (await getThemeByName("dark"))!;
		const lines = renderMarkdownCell(
			{
				borderStyle: "full",
				content: "x".repeat(27),
				contentMaxLines: 1,
				status: "complete",
				title: "Read",
				width: 30,
			},
			theme,
		).map(line => stripVTControlCharacters(line));

		expect(lines[1]).toBe(` │ ${"x".repeat(25)} │`);
		expect(lines[2]).toStartWith(" │ … 1 more line");
	});
});
