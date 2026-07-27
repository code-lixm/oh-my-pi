import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "../../src/modes/components/tool-execution";
import { codegraphToolRenderer } from "../../src/tools/codegraph-renderer";
import { formatStatusIcon } from "../../src/tools/render-utils";

const uiStub = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI;
const rendererContract = codegraphToolRenderer as {
	transcriptSurface?: string;
	mergeCallAndResult?: boolean;
};
const osc8FileUriPattern = /\x1b\]8;id=[^;]+;([^\x1b]+)\x1b\\/;

type CodeGraphEntry = {
	node: {
		filePath: string;
		qualifiedName: string;
		name: string;
		kind: string;
		startLine: number;
	};
};
type CodeGraphResult = {
	content: Array<{ type: string; text: string }>;
	details: {
		query: string;
		maxFiles: number;
		scopeApplied: boolean;
		fileCount: number;
		entryCount: number;
		truncated: boolean;
		sourceRoot?: string;
		fallback?: string;
		files: Array<{ filePath: string; language: string; nodeCount: number }>;
		entries: CodeGraphEntry[];
	};
	isError?: boolean;
};

function makeEntry(index: number, filePath = "src/server/routes.ts"): CodeGraphEntry {
	return {
		node: {
			filePath,
			qualifiedName: `routes.symbol${index}`,
			name: `symbol${index}`,
			kind: index % 2 === 0 ? "function" : "method",
			startLine: 10 + index,
		},
	};
}

function makeResult(entries: CodeGraphEntry[], sourceRoot?: string): CodeGraphResult {
	const filePath = entries[0]?.node.filePath ?? "src/server/routes.ts";
	return {
		content: [{ type: "text", text: "semantic result" }],
		details: {
			query: "find request routing",
			maxFiles: 25,
			scopeApplied: false,
			fileCount: 1,
			entryCount: entries.length,
			truncated: false,
			sourceRoot,
			files: [{ filePath, language: "typescript", nodeCount: 4 }],
			entries,
		},
	};
}

function makeComponent(result: CodeGraphResult) {
	const component = new ToolExecutionComponent(
		"codegraph",
		{ query: "find request routing", maxFiles: 25 },
		{},
		undefined,
		uiStub,
		process.cwd(),
	);
	component.updateResult(result as never, false);
	return component;
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme(false, undefined, undefined, "dark", "light");
});

afterEach(() => {
	settings.clearOverride("tui.hyperlinks");
});

afterAll(() => {
	resetSettingsForTest();
});

describe("codegraphToolRenderer", () => {
	it("declares the bare transcript surface and merged call/result layout used by grep-style renderers", () => {
		expect(rendererContract.transcriptSurface).toBe("bare");
		expect(rendererContract.mergeCallAndResult).toBe(true);
	});

	it("renders a single merged success header with the search icon instead of the generic success icon", async () => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();
		const theme = uiTheme!;
		const component = makeComponent(makeResult([makeEntry(1)]));

		const renderedLines = component.render(160);
		const rendered = renderedLines.join("\n");
		const plainRendered = stripVTControlCharacters(rendered);
		const header = renderedLines[0]!;
		const plainHeader = stripVTControlCharacters(header);

		expect(header).toContain(theme.fg("toolTitle", theme.symbol("icon.search")));
		expect(header).toContain(theme.fg("toolTitle", "CodeGraph"));
		expect(plainHeader.startsWith(`${theme.symbol("icon.search")} CodeGraph`)).toBe(true);
		expect(header).not.toContain(formatStatusIcon("success", theme));
		expect(plainHeader.startsWith(`${theme.symbol("status.success")} CodeGraph`)).toBe(false);
		expect(plainRendered.match(/CodeGraph/g)?.length).toBe(1);
	});

	it("renders tree rows immediately under the title with visible branches, icons, paths, lines, and kinds", async () => {
		settings.override("tui.hyperlinks", "always");
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();
		const theme = uiTheme!;
		const sourceRoot = path.join(process.cwd(), "fixtures", "repo");
		const entries = [
			{
				node: {
					filePath: "src/server/routes.ts",
					qualifiedName: "routes.registerRoutes",
					name: "registerRoutes",
					kind: "function",
					startLine: 12,
				},
			},
			{
				node: {
					filePath: "src/server/routes.ts",
					qualifiedName: "routes.healthcheck",
					name: "healthcheck",
					kind: "method",
					startLine: 27,
				},
			},
		];
		const component = makeComponent(makeResult(entries, sourceRoot));

		const renderedLines = component.render(160);
		const visibleLines = renderedLines.map(line => stripVTControlCharacters(line).trimEnd());
		const tsIcon = theme.getLangIcon("typescript");

		expect(visibleLines[1]).toBe(`├─ ${tsIcon} src/server/routes.ts :12 · routes.registerRoutes [function]`);
		expect(visibleLines[2]).toBe(`└─ ${tsIcon} src/server/routes.ts :27 · routes.healthcheck [method]`);
		expect(visibleLines[1]?.trim()).not.toBe("");

		const hyperlinkMatch = renderedLines[1]?.match(osc8FileUriPattern);
		expect(hyperlinkMatch).toBeDefined();
		const hyperlink = new URL(hyperlinkMatch![1]!);
		expect(hyperlink.protocol).toBe("file:");
		expect(decodeURIComponent(hyperlink.pathname)).toBe(path.join(sourceRoot, "src/server/routes.ts"));
		expect(hyperlink.searchParams.get("line")).toBe("12");
	});

	it("collapses ten semantic matches to header plus three budget rows and expands to all ten rows", () => {
		// Inner renderTreeList: maxCollapsed=8 (default) with 10 entries → 2 hidden.
		//   8 items rendered + "… 2 more entries" summary = 9 body lines.
		// truncateCollapsedToolResult: truncateMiddleLines(9, 3) detects tree-prefix
		//   lines and formats the omission row with ├─ so it visually continues the
		//   tree rather than breaking the branch pattern.
		//   visibleCount=2, headCount=1, tailCount=1, hiddenCount=7.
		//   header(1) + entry[0] + ├─ … 7 lines omitted + inner-summary = 4 total.
		const component = makeComponent(makeResult(Array.from({ length: 10 }, (_, index) => makeEntry(index + 1))));

		const collapsed = component.render(160).map(line => stripVTControlCharacters(line).trimEnd());
		expect(collapsed).toHaveLength(4);
		// head entry (first tree row under the header)
		expect(collapsed[1]?.startsWith("├─ ")).toBe(true);
		expect(collapsed[1]).toContain("routes.symbol1");
		// outer omission row — tree-prefixed by truncateCollapsedToolResult
		expect(collapsed[2]?.startsWith("├─ ")).toBe(true);
		expect(collapsed[2]).toContain("7 lines omitted");
		// tail: inner tree's summary line preserved as the last visible body row
		expect(collapsed[3]?.startsWith("└─ ")).toBe(true);
		expect(collapsed[3]).toContain("2 more entries");
		// head entry still present after outer truncation
		expect(collapsed.join("\n")).toContain("routes.symbol1");

		component.setExpanded(true);
		const expanded = component.render(160).map(line => stripVTControlCharacters(line).trimEnd());
		expect(expanded).toHaveLength(11);
		expect(expanded[10]?.startsWith("└─ ")).toBe(true);
		expect(expanded.join("\n")).toContain("routes.symbol10");
		expect(expanded.join("\n")).not.toContain("lines omitted");
	});

	it("renders expanded fallback details as search-style output instead of empty-state or generic status icons", async () => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();
		const theme = uiTheme!;
		const fallback = "CodeGraph runtime unavailable; install native indexer.";
		const component = makeComponent({
			content: [{ type: "text", text: fallback }],
			details: {
				query: "find request routing",
				maxFiles: 25,
				scopeApplied: false,
				fileCount: 0,
				entryCount: 0,
				truncated: false,
				fallback,
				files: [],
				entries: [],
			},
		});
		component.setExpanded(true);

		const renderedLines = component.render(160);
		const rendered = renderedLines.join("\n");
		const plainRendered = stripVTControlCharacters(rendered);
		const header = renderedLines[0]!;
		const plainHeader = stripVTControlCharacters(header);

		expect(header).toContain(theme.fg("toolTitle", theme.symbol("icon.search")));
		expect(header).not.toContain(formatStatusIcon("warning", theme));
		expect(header).not.toContain(formatStatusIcon("success", theme));
		expect(plainHeader.startsWith(`${theme.symbol("icon.search")} CodeGraph`)).toBe(true);
		expect(plainRendered).toContain(fallback);
		expect(plainRendered).not.toContain("No semantic matches found");
	});

	it("keeps true tool errors on the error path even when fallback details exist", async () => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();
		const theme = uiTheme!;
		const fallback = "CodeGraph runtime unavailable; install native indexer.";
		const errorMessage = "spawn codegraph ENOENT";
		const component = makeComponent({
			content: [{ type: "text", text: errorMessage }],
			details: {
				query: "find request routing",
				maxFiles: 25,
				scopeApplied: false,
				fileCount: 0,
				entryCount: 0,
				truncated: false,
				fallback,
				files: [],
				entries: [],
			},
			isError: true,
		});
		component.setExpanded(true);

		const renderedLines = component.render(160);
		const rendered = renderedLines.join("\n");
		const plainRendered = stripVTControlCharacters(rendered);
		const header = renderedLines[0]!;

		expect(header).toContain(formatStatusIcon("warning", theme));
		expect(header).not.toContain(theme.fg("toolTitle", theme.symbol("icon.search")));
		expect(plainRendered).toContain(errorMessage);
		expect(plainRendered).not.toContain("No semantic matches found");
	});
});
