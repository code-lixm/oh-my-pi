import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { getSettingsUiLocale, type SettingsUiLocale, setSettingsUiLocale } from "../../src/i18n/settings-locale";
import { fffFindToolRenderer, fffGrepToolRenderer, fffMultiGrepToolRenderer } from "../../src/tools/fff-renderer";
import { getBasicToolDetailsVisible, setBasicToolDetailsVisible } from "../../src/tui/basic-tool-display-policy";

const initialSettingsUiLocale = getSettingsUiLocale();
const initialBasicToolDetailsVisible = getBasicToolDetailsVisible();

let uiTheme: Theme;
const toolExecutionUi = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
} as unknown as TUI;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false, undefined, undefined, "dark", "light");

	const theme = await getThemeByName("dark");
	expect(theme).toBeDefined();
	uiTheme = theme!;
});

afterEach(() => {
	setSettingsUiLocale(initialSettingsUiLocale);
	setBasicToolDetailsVisible(initialBasicToolDetailsVisible);
});

afterAll(() => {
	resetSettingsForTest();
});

type FffRendererCase = {
	name: string;
	titles: Record<SettingsUiLocale, string>;
	successMeta: Record<SettingsUiLocale, readonly string[]>;
	emptyMeta: Record<SettingsUiLocale, readonly string[]>;
	emptyLabel: Record<SettingsUiLocale, string>;
	treePaths: readonly string[];
	successResult: unknown;
	emptyResult: unknown;
	render: (result: unknown, expanded: boolean, width: number) => string[];
};

function textResult(details: Record<string, unknown>, isError = false): unknown {
	return { content: [{ type: "text", text: "" }], details, isError };
}

function plainLines(lines: readonly string[]): string[] {
	return sanitizeText(lines.join("\n"))
		.split("\n")
		.map(line => line.trimEnd());
}

function renderCompletedGrepCard(): string[] {
	const args = { pattern: "weather", path: "src" };
	const component = new ToolExecutionComponent("grep", args, {}, undefined, toolExecutionUi, process.cwd());

	try {
		component.setArgsComplete();
		component.updateResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					matchCount: 2,
					fileCount: 1,
					fileLocations: [{ path: "src/weather.ts", lineNumbers: [4, 9] }],
				},
			},
			false,
		);
		return plainLines(component.render(240));
	} finally {
		component.stopAnimation();
	}
}

const findPaths = [
	"packages/coding-agent/src/tools/fff-renderer-contract-alpha.ts",
	"packages/coding-agent/src/tools/fff-renderer-contract-beta.ts",
];
const grepPaths = [
	"packages/coding-agent/src/tools/fff-renderer-contract-alpha.ts",
	"packages/coding-agent/src/tools/fff-renderer-contract-beta.ts",
];
const multiGrepPaths = [
	"packages/coding-agent/src/tools/fff-renderer-contract-alpha.ts",
	"packages/coding-agent/src/tools/fff-renderer-contract-beta.ts",
];

const fffRendererCases: readonly FffRendererCase[] = [
	{
		name: "Find",
		titles: { en: "Find", "zh-CN": "查找" },
		successMeta: { en: ["2 files"], "zh-CN": ["2 个文件"] },
		emptyMeta: { en: ["0 files"], "zh-CN": ["0 个文件"] },
		emptyLabel: { en: "No files found", "zh-CN": "未找到文件" },
		treePaths: findPaths,
		successResult: textResult({ fileCount: findPaths.length, files: findPaths }),
		emptyResult: textResult({ fileCount: 0, files: [] }),
		render: (result, expanded, width) => [
			...fffFindToolRenderer.renderResult(result as never, { expanded, isPartial: false }, uiTheme).render(width),
		],
	},
	{
		name: "Grep",
		titles: { en: "Grep", "zh-CN": "Grep" },
		successMeta: { en: ["3 matches", "2 files"], "zh-CN": ["3 个匹配", "2 个文件"] },
		emptyMeta: { en: ["0 matches", "0 files"], "zh-CN": ["0 个匹配", "0 个文件"] },
		emptyLabel: { en: "No matches found", "zh-CN": "未找到匹配项" },
		treePaths: grepPaths,
		successResult: textResult({
			matchCount: 3,
			fileCount: grepPaths.length,
			files: grepPaths,
			fileLocations: [
				{ path: grepPaths[0], lineNumbers: [7, 11] },
				{ path: grepPaths[1], lineNumbers: [19] },
			],
		}),
		emptyResult: textResult({ matchCount: 0, fileCount: 0, files: [], fileLocations: [] }),
		render: (result, expanded, width) => [
			...fffGrepToolRenderer.renderResult(result as never, { expanded, isPartial: false }, uiTheme).render(width),
		],
	},
	{
		name: "Multi Grep",
		titles: { en: "Multi Grep", "zh-CN": "多模式 Grep" },
		successMeta: { en: ["3 matches", "2 files"], "zh-CN": ["3 个匹配", "2 个文件"] },
		emptyMeta: { en: ["0 matches", "0 files"], "zh-CN": ["0 个匹配", "0 个文件"] },
		emptyLabel: { en: "No matches found", "zh-CN": "未找到匹配项" },
		treePaths: multiGrepPaths,
		successResult: textResult({
			matchCount: 3,
			fileCount: multiGrepPaths.length,
			files: multiGrepPaths,
			fileLocations: [
				{ path: multiGrepPaths[0], lineNumbers: [7, 11] },
				{ path: multiGrepPaths[1], lineNumbers: [19] },
			],
		}),
		emptyResult: textResult({ matchCount: 0, fileCount: 0, files: [], fileLocations: [] }),
		render: (result, expanded, width) => [
			...fffMultiGrepToolRenderer
				.renderResult(result as never, { expanded, isPartial: false }, uiTheme)
				.render(width),
		],
	},
];

describe("FFF search renderers", () => {
	it("localizes Find, Grep, and Multi Grep titles, counts, and empty rows", () => {
		setBasicToolDetailsVisible(true);

		for (const locale of ["en", "zh-CN"] as const) {
			setSettingsUiLocale(locale);

			for (const renderer of fffRendererCases) {
				const successLines = plainLines(renderer.render(renderer.successResult, true, 240));
				const successHeader = successLines[0]!;
				expect(successHeader).toContain(renderer.titles[locale]);
				for (const meta of renderer.successMeta[locale]) expect(successHeader).toContain(meta);

				const emptyLines = plainLines(renderer.render(renderer.emptyResult, true, 240));
				const emptyHeader = emptyLines[0]!;
				expect(emptyHeader).toContain(renderer.titles[locale]);
				for (const meta of renderer.emptyMeta[locale]) expect(emptyHeader).toContain(meta);
				expect(emptyLines.slice(1).join("\n")).toContain(renderer.emptyLabel[locale]);
			}
		}
	});

	it("keeps a compact localized header but hides successful file trees when basic details are off", () => {
		setSettingsUiLocale("en");
		setBasicToolDetailsVisible(false);

		for (const renderer of fffRendererCases) {
			const lines = plainLines(renderer.render(renderer.successResult, true, 240));
			const header = lines[0]!;

			expect(lines).toHaveLength(1);
			expect(header).toContain(renderer.titles.en);
			for (const meta of renderer.successMeta.en) expect(header).toContain(meta);
			for (const file of renderer.treePaths) expect(header).not.toContain(file);
			expect(header).not.toMatch(/[├└]─/u);
		}
	});

	it("keeps expanded FFF file trees visible at wide and narrow widths without overflowing rows", () => {
		setSettingsUiLocale("en");
		setBasicToolDetailsVisible(true);
		const wideWidth = 240;
		const narrowWidth = 36;

		for (const renderer of fffRendererCases) {
			const wideLines = plainLines(renderer.render(renderer.successResult, true, wideWidth));
			const wideBody = wideLines.slice(1);
			for (const file of renderer.treePaths) expect(wideBody.join("\n")).toContain(file);
			expect(wideBody.some(line => /^[├└]─ /u.test(line))).toBe(true);

			const narrowRawLines = renderer.render(renderer.successResult, true, narrowWidth);
			const narrowLines = plainLines(narrowRawLines);
			expect(narrowLines.length).toBeGreaterThan(1);
			expect(narrowLines.slice(1).some(line => /^[├└]─ /u.test(line))).toBe(true);
			expect(narrowRawLines.every(line => visibleWidth(Bun.stripANSI(line)) <= narrowWidth)).toBe(true);
		}
	});

	it("renders a completed Grep card with one result header instead of stacking the pending call header", () => {
		setSettingsUiLocale("en");
		setBasicToolDetailsVisible(false);

		const headers = renderCompletedGrepCard().filter(line => line.includes("Grep"));
		expect(headers).toHaveLength(1);
		expect(headers[0]).toContain("2 matches");
		expect(headers[0]).toContain("1 file");
		expect(headers[0]).not.toContain("weather");
	});

	it("renders sanitized FFF errors without leaking tab characters even when details are hidden", () => {
		setSettingsUiLocale("en");
		setBasicToolDetailsVisible(false);
		const error = "Error:\tpermission\tdenied while scanning";

		for (const renderer of fffRendererCases) {
			const raw = renderer.render(textResult({ error }, true), false, 240).join("\n");
			const plain = sanitizeText(raw).replace(/\s+/gu, " ");

			expect(raw).not.toContain("\t");
			expect(plain).toContain("Error: permission denied while scanning");
		}
	});
});
