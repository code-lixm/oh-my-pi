import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../src/i18n/settings-locale";
import { ToolExecutionComponent } from "../../src/modes/components/tool-execution";
import { grepToolRenderer } from "../../src/tools/grep";
import { getBasicToolDetailsVisible, setBasicToolDetailsVisible } from "../../src/tui/basic-tool-display-policy";
import { getOutputBlockBorderStyle, setOutputBlockBorderStyle } from "../../src/tui/output-block";

const initialSettingsUiLocale = getSettingsUiLocale();
const initialBasicToolDetailsVisible = getBasicToolDetailsVisible();

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false, undefined, undefined, "dark", "light");
});

afterEach(() => {
	settings.clearOverride("tui.hyperlinks");
	setSettingsUiLocale(initialSettingsUiLocale);
	setBasicToolDetailsVisible(initialBasicToolDetailsVisible);
});

afterAll(() => {
	resetSettingsForTest();
});

describe("grepToolRenderer", () => {
	const projectRoot = path.resolve("/tmp/omp-project");

	function resultWithLocations(
		fileLocations: Array<{ path: string; lineNumbers: number[] }>,
		overrides: Record<string, unknown> = {},
	) {
		return {
			content: [{ type: "text", text: "" }],
			details: {
				cwd: projectRoot,
				searchPath: path.join(projectRoot, "src"),
				scopePath: "src",
				matchCount: fileLocations.reduce((count, location) => count + location.lineNumbers.length, 0),
				fileCount: fileLocations.length,
				files: fileLocations.map(location => location.path),
				fileLocations,
				...overrides,
			},
		};
	}

	it("renders compact file locations from column 0 and coalesces sorted unique adjacent matches", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const staleSnippetPayload = [
			"# src/",
			"## alpha.ts#abcd",
			" 49│context before should stay hidden",
			"*50│const alphaSnippetShouldNotRender = true;",
			" 54│context after should stay hidden",
		].join("\n");
		const result = resultWithLocations(
			[
				{ path: "src/alpha.ts", lineNumbers: [53, 50, 51, 53, 52, 60] },
				{ path: "src/beta.ts", lineNumbers: [12] },
			],
			{ displayContent: staleSnippetPayload },
		);

		const renderedLines = grepToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { pattern: "FLAG", path: "src" })
			.render(240);
		const plainLines = sanitizeText(renderedLines.join("\n"))
			.split("\n")
			.map(line => line.trimEnd());
		const [header, separator, ...bodyLines] = plainLines;

		expect(header!.search(/\S/)).toBe(0);
		expect(header!.startsWith(`${uiTheme.symbol("icon.search")} Grep`)).toBe(true);
		expect(header).toContain("FLAG");
		expect(header).toContain("7 matches");
		expect(header).toContain("2 files");
		expect(header).not.toContain("in src");
		expect(separator).toBe("");
		expect(bodyLines).toEqual(["src/alpha.ts:50-53,60", "src/beta.ts:12"]);
		expect(plainLines.filter(line => line === "")).toHaveLength(1);
		const plain = plainLines.join("\n");
		expect(plain).not.toContain("alphaSnippetShouldNotRender");
		expect(plain).not.toContain("context before should stay hidden");
		expect(plain).not.toContain("#abcd");
		expect(plain).not.toContain("│");
		expect(renderedLines[0]).toContain(uiTheme.fg("toolTitle", uiTheme.symbol("icon.search")));
		expect(renderedLines[0]).toContain(uiTheme.fg("toolTitle", "Grep"));
		expect(renderedLines[0]).not.toContain(uiTheme.fg("accent", uiTheme.symbol("icon.search")));
		expect(renderedLines[0]).not.toContain(uiTheme.fg("accent", "Grep"));
	});

	it("renders grep under accent with a single header/body separator and no decorative blank rows", async () => {
		const previousBasicToolDetailsVisible = getBasicToolDetailsVisible();
		const previousBorderStyle = getOutputBlockBorderStyle();
		const args = { pattern: "needle", path: "src" };
		const result = resultWithLocations([{ path: "src/file.ts", lineNumbers: [12] }]);
		const component = new ToolExecutionComponent("grep", args, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});

		try {
			setBasicToolDetailsVisible(true);
			setOutputBlockBorderStyle("accent");
			component.updateArgs(args);
			component.setArgsComplete();
			component.updateResult(result, false);

			const plainLines = sanitizeText(component.render(240).join("\n"))
				.split("\n")
				.map(line => line.trimEnd());

			expect(plainLines).toHaveLength(3);
			expect(plainLines[0]!).toContain("Grep: needle");
			expect(plainLines[0]!).not.toContain("in src");
			expect(plainLines[1]).toBe("");
			expect(plainLines[2]).toBe("src/file.ts:12");
			expect(plainLines.filter(line => line === "")).toHaveLength(1);
		} finally {
			component.stopAnimation();
			setOutputBlockBorderStyle(previousBorderStyle);
			setBasicToolDetailsVisible(previousBasicToolDetailsVisible);
		}

		expect(getOutputBlockBorderStyle()).toBe(previousBorderStyle);
		expect(getBasicToolDetailsVisible()).toBe(previousBasicToolDetailsVisible);
	});

	it("keeps the Grep title unlocalized in zh-CN while localizing compact match counts", async () => {
		setSettingsUiLocale("zh-CN");

		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = resultWithLocations([{ path: "src/file.ts", lineNumbers: [12] }]);

		const renderedLines = grepToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, {
				pattern: "needle",
				path: "src",
			})
			.render(240);
		const plainHeader = sanitizeText(renderedLines[0] ?? "");

		expect(plainHeader.startsWith(`${uiTheme.symbol("icon.search")} Grep`)).toBe(true);
		expect(plainHeader).toContain("1 个匹配");
		expect(plainHeader).toContain("1 个文件");
		expect(plainHeader).not.toContain("Grep（正则搜索）");
		expect(plainHeader).not.toContain("in src");
	});

	it("keeps truncation and missing-path warnings while rendering only compact locations", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = resultWithLocations(
			[
				{ path: "src/alpha.ts", lineNumbers: [10] },
				{ path: "src/beta.ts", lineNumbers: [20] },
				{ path: "src/gamma.ts", lineNumbers: [30] },
			],
			{
				truncated: true,
				fileLimitReached: 3,
				perFileLimitReached: 20,
				missingPaths: ["missing.ts"],
				displayContent: "*10│const snippetShouldNotRender = true;",
			},
		);

		const renderedLines = sanitizeText(
			grepToolRenderer
				.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, {
					pattern: "needle",
					path: "src",
				})
				.render(200)
				.join("\n"),
		)
			.split("\n")
			.map(line => line.trimEnd());
		const plain = renderedLines.join("\n");

		expect(renderedLines[0]).toContain("truncated");
		expect(renderedLines[0]).not.toContain("in src");
		expect(renderedLines[1]).toBe("");
		expect(renderedLines.slice(2)).toEqual([
			"src/alpha.ts:10",
			"src/beta.ts:20",
			"src/gamma.ts:30",
			"skipped missing: missing.ts",
		]);
		expect(plain).not.toContain("truncated:");
		expect(plain).not.toContain("skip to paginate");
		expect(plain).not.toContain("matches per file");
		expect(plain).not.toContain("snippetShouldNotRender");
		expect(plain).not.toContain("│");
	});

	it("keeps collapsed and expanded views location-only while bounding them by file rows", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const locations = Array.from({ length: 10 }, (_, index) => ({
			path: `src/file-${String(index + 1).padStart(2, "0")}.ts`,
			lineNumbers: [index * 10 + 1],
		}));
		const result = resultWithLocations(locations, {
			displayContent: "*1│const snippetShouldNeverRender = true;\n*2│const secondSnippetShouldNeverRender = true;",
		});
		const render = (expanded: boolean) =>
			sanitizeText(
				grepToolRenderer
					.renderResult(result as never, { expanded, isPartial: false }, uiTheme, {
						pattern: "needle",
						path: "src",
					})
					.render(200)
					.join("\n"),
			)
				.split("\n")
				.map(line => line.trimEnd());

		const collapsedBody = render(false).slice(2);
		const expandedBody = render(true).slice(2);

		expect(collapsedBody).toHaveLength(6);
		expect(collapsedBody.slice(0, 5)).toEqual([
			"src/file-01.ts:1",
			"src/file-02.ts:11",
			"src/file-03.ts:21",
			"src/file-04.ts:31",
			"src/file-05.ts:41",
		]);
		expect(collapsedBody[5]).toContain("5 more files");
		expect(collapsedBody.join("\n")).not.toContain("file-06.ts");
		expect(expandedBody).toEqual(locations.map(location => `${location.path}:${location.lineNumbers[0]}`));
		const allBody = [...collapsedBody, ...expandedBody].join("\n");
		expect(allBody).not.toContain("snippetShouldNeverRender");
		expect(allBody).not.toContain("│");
	});

	it("OSC8-links the compact file path to the file at its first selected match line", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = resultWithLocations([{ path: "src/linked.ts", lineNumbers: [20, 7, 8] }]);

		const rendered = grepToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, {
				pattern: "needle",
				path: "src",
			})
			.render(240)
			.join("\n");
		const firstLineUri = new URL(url.pathToFileURL(path.join(projectRoot, "src", "linked.ts")).href);
		firstLineUri.searchParams.set("line", "7");
		const laterLineUri = new URL(url.pathToFileURL(path.join(projectRoot, "src", "linked.ts")).href);
		laterLineUri.searchParams.set("line", "20");

		expect(sanitizeText(rendered)).toContain("src/linked.ts:7-8,20");
		expect(extractLinkUris(rendered)).toContain(firstLineUri.href);
		expect(extractLinkUris(rendered)).not.toContain(laterLineUri.href);
	});

	it("summarizes successful matches with scope when basic details are hidden", async () => {
		setBasicToolDetailsVisible(false);
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = resultWithLocations(
			[
				{ path: "src/alpha.ts", lineNumbers: [4] },
				{ path: "src/beta.ts", lineNumbers: [8] },
			],
			{ displayContent: "## alpha.ts#aaaa\n*4│const alphaHitShouldNotRender = true;" },
		);

		const plainLines = sanitizeText(
			grepToolRenderer
				.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, {
					pattern: "needle",
					path: "src",
				})
				.render(240)
				.join("\n"),
		).split("\n");

		expect(plainLines).toHaveLength(1);
		const header = plainLines[0]!;
		expect(header).toContain("Grep");
		expect(header).toContain("needle");
		expect(header).toContain("2 matches");
		expect(header).toContain("2 files");
		expect(header).toContain("in src");
		expect(header).not.toContain("alpha.ts:4");
		expect(header).not.toContain("alphaHitShouldNotRender");
		expect(header).not.toContain("#aaaa");
	});

	it("keeps scope on zero-match detailed headers", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = resultWithLocations([], { matchCount: 0, fileCount: 0, files: [] });

		const plainLines = sanitizeText(
			grepToolRenderer
				.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, {
					pattern: "absent",
					path: "src",
				})
				.render(240)
				.join("\n"),
		)
			.split("\n")
			.map(line => line.trimEnd());

		expect(plainLines[0]).toContain("0 matches");
		expect(plainLines[0]).toContain("in src");
		expect(plainLines[1]).toBe("");
		expect(plainLines[2]).toContain("No matches found");
	});

	it("still renders grep error diagnostics when details are hidden", async () => {
		setBasicToolDetailsVisible(false);
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const rendered = sanitizeText(
			grepToolRenderer
				.renderResult(
					{
						content: [{ type: "text", text: "regex parse error: unclosed character class [needle" }],
						details: { error: "regex parse error: unclosed character class [needle" },
						isError: true,
					} as never,
					{ expanded: false, isPartial: false },
					uiTheme,
					{ pattern: "[needle", path: "src" },
				)
				.render(240)
				.join("\n"),
		);

		expect(rendered).toContain("Error:");
		expect(rendered).toContain("regex parse error");
		expect(rendered).toContain("unclosed character class");
	});
});
