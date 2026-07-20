import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { type CodeBlockDisplayOptions, Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { defaultMarkdownTheme } from "./test-themes.js";

function codeBlockDisplayOptions(budget: number): CodeBlockDisplayOptions {
	return {
		frame: true,
		cacheKey: `test:frame:${budget}`,
		getCollapsedBudget: () => budget,
		expandKeyLabel: "ctrl+o",
		omitHintTemplate: "… {count} more lines ({key} to expand)",
	};
}

function fence(lines: readonly string[], lang = "ts"): string {
	return [`\`\`\`${lang}`, ...lines, "```"].join("\n");
}

function renderPlain(markdown: Markdown, width: number): string[] {
	return markdown.render(width).map(line => stripVTControlCharacters(line));
}

function createFramedMarkdown(text: string, budget: number): Markdown {
	const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
	markdown.setCodeBlockDisplayOptions(codeBlockDisplayOptions(budget));
	return markdown;
}

function numberedRows(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `row-${String(i + 1).padStart(2, "0")}`);
}

describe("Markdown assistant code-frame opt-in", () => {
	it("renders a short fenced block as a rounded frame with the language on the top border", () => {
		const markdown = createFramedMarkdown(fence(["const answer = 42;"]), 6);
		const lines = renderPlain(markdown, 32).map(line => line.trimEnd());
		const joined = lines.join("\n");

		expect(joined).not.toContain("```");
		expect(lines[0]).toContain(defaultMarkdownTheme.symbols.boxRound.topLeft);
		expect(lines[0]).toContain(defaultMarkdownTheme.symbols.boxRound.topRight);
		expect(lines[0]).toContain("ts");
		expect(lines[1]).toContain(defaultMarkdownTheme.symbols.boxRound.vertical);
		expect(lines[1]).toContain("const answer = 42;");
		expect(lines[lines.length - 1]).toContain(defaultMarkdownTheme.symbols.boxRound.bottomLeft);
	});

	it("folds long blocks into head, omission hint, and tail rows", () => {
		const rows = numberedRows(8);
		const markdown = createFramedMarkdown(fence(rows), 5);
		const joined = renderPlain(markdown, 40).join("\n");

		expect(joined).toContain("row-01");
		expect(joined).toContain("row-02");
		expect(joined).toContain("row-07");
		expect(joined).toContain("row-08");
		expect(joined).not.toContain("row-03");
		expect(joined).not.toContain("row-06");
		expect(joined).toContain("4 more lines");
		expect(joined).toContain("ctrl+o");
	});

	it("shows the full body after setExpanded and removes the omission hint", () => {
		const rows = numberedRows(8);
		const markdown = createFramedMarkdown(fence(rows), 5);

		expect(renderPlain(markdown, 24).join("\n")).toContain("4 more lines");
		markdown.setExpanded(true);
		const expanded = renderPlain(markdown, 24).join("\n");

		for (const row of rows) {
			expect(expanded).toContain(row);
		}
		expect(expanded).not.toContain("more lines");
		expect(expanded).not.toContain("```");
	});

	it("degrades safely below eight columns without overflowing the width", () => {
		const markdown = createFramedMarkdown(fence(["abcdefghij", "klmnopqrst"]), 6);
		const lines = renderPlain(markdown, 7);
		const joined = lines.join("\n");

		expect(joined).not.toContain("```");
		expect(joined).not.toContain(defaultMarkdownTheme.symbols.boxRound.topLeft);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(7);
		}
		expect(joined).toContain("abcdefg");
		expect(joined).toContain("klmnopq");
	});

	it("keeps the collapsed tail pinned to the newest transient lines across updates", () => {
		const markdown = createFramedMarkdown(fence(numberedRows(7)), 5);
		markdown.transientRenderCache = true;

		let joined = renderPlain(markdown, 24).join("\n");
		expect(joined).toContain("row-06");
		expect(joined).toContain("row-07");

		markdown.setText(fence(numberedRows(8)));
		joined = renderPlain(markdown, 24).join("\n");
		expect(joined).toContain("row-07");
		expect(joined).toContain("row-08");
		expect(joined).not.toContain("row-06");

		markdown.setText(fence(numberedRows(9)));
		joined = renderPlain(markdown, 24).join("\n");
		expect(joined).toContain("row-08");
		expect(joined).toContain("row-09");
		expect(joined).not.toContain("row-07");
	});

	it("keeps the legacy fenced render when framing is not opted in", () => {
		const markdown = new Markdown(fence(["const x = 1;"]), 0, 0, defaultMarkdownTheme);
		const lines = renderPlain(markdown, 32).map(line => line.trimEnd());

		expect(lines).toEqual(["```ts", "  const x = 1;", "```"]);
	});
});
