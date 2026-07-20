import { afterEach, describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../src/i18n/settings-locale";
import { globToolRenderer } from "../../src/tools/glob";

const initialSettingsUiLocale = getSettingsUiLocale();

afterEach(() => {
	setSettingsUiLocale(initialSettingsUiLocale);
});

describe("globToolRenderer", () => {
	it("renders inline glob output from column 0 while keeping toolTitle success headers", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				fileCount: 2,
				files: ["src/a.ts", "src/b.ts"],
			},
		};

		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/**/*.ts" })
			.render(240);
		const plainLines = sanitizeText(renderedLines.join("\n")).split("\n");

		expect(plainLines.every(line => line === line.trimStart())).toBe(true);
		expect(plainLines.slice(1)).toHaveLength(2);
		expect(plainLines[1]).toMatch(/src\/a\.ts$/);
		expect(plainLines[2]).toMatch(/src\/b\.ts$/);
		expect(renderedLines[0]).toContain(uiTheme.fg("toolTitle", uiTheme.symbol("icon.search")));
		expect(renderedLines[0]).toContain(uiTheme.fg("toolTitle", "Glob"));
		expect(renderedLines[0]).not.toContain(uiTheme.fg("accent", uiTheme.symbol("icon.search")));
		expect(renderedLines[0]).not.toContain(uiTheme.fg("accent", "Glob"));
	});

	it("renders a timed-out empty scan as incomplete instead of a definitive no-files claim", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		// `truncated` with zero files only happens on the timeout path — the
		// scan died mid-walk, so "No files found" would be a false claim.
		const result = {
			content: [{ type: "text", text: "Glob timed out after 5s before finding any matches" }],
			details: {
				fileCount: 0,
				files: [],
				truncated: true,
			},
		};

		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "~/.cache/*" })
			.render(240);
		const plain = sanitizeText(renderedLines.join("\n"));

		expect(plain).toContain("No matches before timeout (scan incomplete)");
		expect(plain).toContain("timed out");
		expect(plain).not.toContain("No files found");
	});

	it("renders a genuinely empty result as no files found", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "No files found matching pattern" }],
			details: {
				fileCount: 0,
				files: [],
				truncated: false,
			},
		};

		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/*.zig" })
			.render(240);
		const plain = sanitizeText(renderedLines.join("\n"));

		expect(plain).toContain("No files found");
		expect(plain).not.toContain("incomplete");
	});

	it("localizes zh-CN truncation messaging for the 100-result cap", async () => {
		setSettingsUiLocale("zh-CN");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				fileCount: 100,
				files: Array.from({ length: 100 }, (_, i) => `src/file-${i + 1}.ts`),
				resultLimitReached: 100,
			},
		};

		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, { paths: "src/**/*.ts" })
			.render(240);
		const plain = sanitizeText(renderedLines.join("\n"));

		expect(plain).toContain("已截断");
		expect(plain).toContain("达到 100 条结果上限");
		expect(plain).not.toContain("truncated: limit 100 results");
	});
	it("localizes file count to '1 个文件' in zh-CN and '1 file' in en, preserving the original file path", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		// Use a glob pattern in args.paths so the description chrome does not
		// duplicate the file-list entry being tested.
		const file = "src/solo.ts";
		const globPattern = "src/**/*.ts";

		setSettingsUiLocale("en");
		const enResult = {
			content: [{ type: "text", text: "" }],
			details: { fileCount: 1, files: [file], cwd: "/project" },
		};
		const enLines = globToolRenderer
			.renderResult(enResult as never, { expanded: false, isPartial: false }, uiTheme, { paths: globPattern })
			.render(240);
		const enPlain = sanitizeText(enLines.join("\n"));
		expect(enPlain).toContain("1 file");
		expect(enPlain).not.toContain("Glob（通配查找）");
		expect(enPlain).not.toMatch(/\d+\s*个文件/);

		setSettingsUiLocale("zh-CN");
		const zhResult = {
			content: [{ type: "text", text: "" }],
			details: { fileCount: 1, files: [file], cwd: "/project" },
		};
		const zhLines = globToolRenderer
			.renderResult(zhResult as never, { expanded: false, isPartial: false }, uiTheme, { paths: globPattern })
			.render(240);
		const zhPlain = sanitizeText(zhLines.join("\n"));
		expect(zhPlain).toContain("1 个文件");
		expect(zhPlain).not.toContain("1 file");
		// The path itself stays in original form; it must appear in the file list.
		expect(zhPlain).toContain(file);
	});

	it("localizes file count to '3 个文件' in zh-CN and '3 files' in en, preserving original file paths", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const files = ["src/a.ts", "src/b.ts", "src/c.ts"];

		setSettingsUiLocale("en");
		const enResult = {
			content: [{ type: "text", text: "" }],
			details: { fileCount: files.length, files, cwd: "/project" },
		};
		const enLines = globToolRenderer
			.renderResult(enResult as never, { expanded: false, isPartial: false }, uiTheme, { paths: "src/**/*.ts" })
			.render(240);
		const enPlain = sanitizeText(enLines.join("\n"));
		expect(enPlain).toContain("3 files");
		expect(enPlain).not.toContain("Glob（通配查找）");
		expect(enPlain).not.toMatch(/\d+\s*个文件/);
		for (const file of files) {
			expect(enPlain).toContain(file);
		}

		setSettingsUiLocale("zh-CN");
		const zhResult = {
			content: [{ type: "text", text: "" }],
			details: { fileCount: files.length, files, cwd: "/project" },
		};
		const zhLines = globToolRenderer
			.renderResult(zhResult as never, { expanded: false, isPartial: false }, uiTheme, { paths: "src/**/*.ts" })
			.render(240);
		const zhPlain = sanitizeText(zhLines.join("\n"));
		expect(zhPlain).toContain("3 个文件");
		expect(zhPlain).not.toContain("3 files");
		for (const file of files) {
			expect(zhPlain).toContain(file);
		}
	});
});
