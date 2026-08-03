import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../src/i18n/settings-locale";
import { globToolRenderer } from "../../src/tools/glob";
import { getBasicToolDetailsVisible, setBasicToolDetailsVisible } from "../../src/tui/basic-tool-display-policy";

const initialSettingsUiLocale = getSettingsUiLocale();
const initialBasicToolDetailsVisible = getBasicToolDetailsVisible();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

afterEach(() => {
	settings.clearOverride("display.toolDetailMaxLines");
	setSettingsUiLocale(initialSettingsUiLocale);
	setBasicToolDetailsVisible(initialBasicToolDetailsVisible);
});

afterAll(() => {
	resetSettingsForTest();
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
		setBasicToolDetailsVisible(true);
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
		const plainLines = sanitizeText(renderedLines.join("\n"))
			.split("\n")
			.map(line => line.trimEnd());
		const plain = plainLines.join("\n");

		expect(plainLines).toHaveLength(2);
		expect(plainLines[0]).toContain("Glob");
		expect(plainLines[1]).toStartWith("└─ ");
		expect(plainLines[1]).toBe("└─ No matches before timeout (scan incomplete)");
		expect(plain).toContain("timed out");
		expect(plain).not.toContain("No files found");
	});

	it("renders a genuinely empty result as no files found", async () => {
		setBasicToolDetailsVisible(true);
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
		const plainLines = sanitizeText(renderedLines.join("\n"))
			.split("\n")
			.map(line => line.trimEnd());
		const plain = plainLines.join("\n");

		expect(plainLines).toHaveLength(2);
		expect(plainLines[0]).toContain("Glob");
		expect(plainLines[1]).toStartWith("└─ ");
		expect(plainLines[1]).toBe("└─ No files found");
		expect(plain).not.toContain("incomplete");
	});

	it("renders a localized legacy empty result as a child below its Glob header", async () => {
		setBasicToolDetailsVisible(true);
		setSettingsUiLocale("zh-CN");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "No files found matching pattern" }],
		};

		const plainLines = sanitizeText(
			globToolRenderer
				.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/*.zig" })
				.render(240)
				.join("\n"),
		).split("\n").map(line => line.trimEnd());

		expect(plainLines).toHaveLength(2);
		expect(plainLines[0]).toContain("Glob");
		expect(plainLines[1]).toStartWith("└─ ");
		expect(plainLines[1]).toBe("└─ 未找到文件");
	});

	it("localizes zh-CN truncation status in the header without a duplicate detached reason line", async () => {
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
				meta: {
					limits: {
						resultLimit: { reached: 100, suggestion: 100 },
					},
				},
			},
		};

		const plainLines = sanitizeText(
			globToolRenderer
				.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, { paths: "src/**/*.ts" })
				.render(240)
				.join("\n"),
		).split("\n");
		const plain = plainLines.join("\n");

		expect(plainLines[0]).toContain("100 个文件");
		expect(plainLines[0]).toContain("已截断");
		expect(plainLines.some(line => /^\s*(truncated|已截断)：?/u.test(line))).toBe(false);
		expect(plain.match(/已截断/gu)?.length ?? 0).toBe(1);
		expect(plain).not.toContain("truncated: limit 100 results");
	});

	it("renders truncated detailed results without a detached duplicate truncation reason line while preserving missing-path warnings", async () => {
		setSettingsUiLocale("en");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				fileCount: 3,
				files: ["README.md", "src/glob.ts", "src/tools/render.ts"],
				truncated: true,
				resultLimitReached: 3,
				meta: {
					limits: {
						resultLimit: { reached: 3, suggestion: 3 },
					},
				},
				missingPaths: ["missing/path", "gone/file.ts"],
			},
		};

		const plainLines = sanitizeText(
			globToolRenderer
				.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, {
					path: "src/**/*.ts",
					limit: 3,
				})
				.render(80)
				.join("\n"),
		).split("\n");
		const plain = plainLines.join("\n");

		expect(plainLines[0]).toContain("Glob: src/**/*.ts");
		expect(plainLines[0]).toContain("3 files");
		expect(plainLines[0]).toContain("truncated");
		expect(plainLines.slice(1, 4)).toEqual(["├─ 📝 README.md", "├─ 🟦 src/glob.ts", "└─ 🟦 src/tools/render.ts"]);
		expect(plain).toContain("skipped missing: missing/path, gone/file.ts");
		expect(plainLines.some(line => /^\s*(truncated|已截断)：?/u.test(line))).toBe(false);
		expect(plain.match(/\btruncated\b/gu)?.length ?? 0).toBe(1);
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

	it("keeps collapsed glob file details within the default 3-line budget while expanded shows all 10 files", async () => {
		setSettingsUiLocale("en");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const files = Array.from({ length: 10 }, (_, index) => `src/file-${String(index + 1).padStart(2, "0")}.ts`);
		const result = {
			content: [{ type: "text", text: "" }],
			details: { fileCount: files.length, files },
		};
		const renderBody = (expanded: boolean) =>
			sanitizeText(
				globToolRenderer
					.renderResult(result as never, { expanded, isPartial: false }, uiTheme, { paths: "src/**/*.ts" })
					.render(240)
					.join("\n"),
			)
				.split("\n")
				.slice(1)
				.map(line => line.trimEnd());

		const collapsedBody = renderBody(false);
		const expandedBody = renderBody(true);
		const icon = uiTheme.getLangIcon("typescript");

		expect(collapsedBody).toEqual([`├─ ${icon} src/file-01.ts`, "├─ … 8 more files", `└─ ${icon} src/file-10.ts`]);
		expect(expandedBody).toEqual(
			files.map((file, index) => `${index === files.length - 1 ? "└─" : "├─"} ${icon} ${file}`),
		);
	});

	it("honors a 5-line collapsed glob detail budget while preserving the first and last files", async () => {
		settings.override("display.toolDetailMaxLines", 5);
		setSettingsUiLocale("en");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const files = Array.from({ length: 10 }, (_, index) => `src/file-${String(index + 1).padStart(2, "0")}.ts`);
		const result = {
			content: [{ type: "text", text: "" }],
			details: { fileCount: files.length, files },
		};

		const collapsedBody = sanitizeText(
			globToolRenderer
				.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, { paths: "src/**/*.ts" })
				.render(240)
				.join("\n"),
		)
			.split("\n")
			.slice(1)
			.map(line => line.trimEnd());
		const icon = uiTheme.getLangIcon("typescript");

		expect(collapsedBody).toEqual([
			`├─ ${icon} src/file-01.ts`,
			`├─ ${icon} src/file-02.ts`,
			"├─ … 6 more files",
			`├─ ${icon} src/file-09.ts`,
			`└─ ${icon} src/file-10.ts`,
		]);
		expect(collapsedBody).toHaveLength(5);
	});

	it("summarizes successful file matches to one target/count header when basic details are hidden", async () => {
		setBasicToolDetailsVisible(false);
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
		const result = {
			content: [{ type: "text", text: "" }],
			details: { fileCount: files.length, files, scopePath: "src" },
		};

		const plainLines = sanitizeText(
			globToolRenderer
				.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/**/*.ts" })
				.render(240)
				.join("\n"),
		).split("\n");

		expect(plainLines).toHaveLength(1);
		const header = plainLines[0]!;
		expect(header).toContain("Glob");
		expect(header).toContain("src/**/*.ts");
		expect(header).toContain("3 files");
		expect(header).toContain("src");
		for (const file of files) {
			expect(header).not.toContain(file);
		}
	});

	it("keeps file-list details visible when basic details policy is on", async () => {
		setBasicToolDetailsVisible(true);
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const files = ["src/visible-a.ts", "src/visible-b.ts"];
		const result = {
			content: [{ type: "text", text: "" }],
			details: { fileCount: files.length, files, cwd: "/project" },
		};

		const plain = sanitizeText(
			globToolRenderer
				.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/**/*.ts" })
				.render(240)
				.join("\n"),
		);

		expect(plain).toContain("src/visible-a.ts");
		expect(plain).toContain("src/visible-b.ts");
	});

	it("still renders glob error diagnostics when details are hidden", async () => {
		setBasicToolDetailsVisible(false);
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const rendered = sanitizeText(
			globToolRenderer
				.renderResult(
					{
						content: [{ type: "text", text: "Glob failed: EACCES permission denied scanning /private" }],
						details: { error: "EACCES permission denied scanning /private" },
						isError: true,
					} as never,
					{ expanded: false, isPartial: false },
					uiTheme,
					{ paths: "/private/**/*" },
				)
				.render(240)
				.join("\n"),
		);

		expect(rendered).toContain("Error:");
		expect(rendered).toContain("EACCES");
		expect(rendered).toContain("/private");
	});
});
