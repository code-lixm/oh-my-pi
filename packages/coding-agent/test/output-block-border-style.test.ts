import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { getThemeByName, initTheme, type Theme, type ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	ACCENT_PAD_TINT_OPACITY,
	framedBlock,
	getOutputBlockBorderStyle,
	type OutputBlockBorderStyle,
	type OutputBlockOptions,
	outputBlockContentWidth,
	renderOutputBlock,
	resolveMarkdownTableBorderStyle,
	setOutputBlockBorderStyle,
} from "@oh-my-pi/pi-coding-agent/tui/output-block";
import { type TUI, visibleWidth } from "@oh-my-pi/pi-tui";

/**
 * Regression teeth:
 * - Reverting full frames away from rounded corners/side rails breaks the full
 *   layout assertions.
 * - Dropping the Accent Gutter default or changing its rail/tint geometry breaks
 *   the byte-for-byte default-vs-explicit accent assertion.
 * - Changing the default background policy or ignoring applyBg overrides breaks
 *   the ANSI matrix below.
 *
 * Per-call `borderStyle` overrides keep render(...) order-independent.
 * The `renderToolResult` regression teeth below snapshot+restore the module default.
 */

const WIDTH = 16;

type BgName = "toolPendingBg" | "toolErrorBg" | "toolSuccessBg";

let darkTheme: Theme;
let lightCatppuccinTheme: Theme;

function render(
	options: Omit<OutputBlockOptions, "width"> & { width?: number },
	theme: Theme = darkTheme,
): readonly string[] {
	return renderOutputBlock({ width: options.width ?? WIDTH, ...options }, theme);
}

function plain(lines: readonly string[]): string[] {
	return lines.map(line => Bun.stripANSI(line));
}
function padLine(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function expectUniformWidth(lines: readonly string[], width: number): void {
	expect(lines.map(line => visibleWidth(line))).toEqual(Array(lines.length).fill(width));
}

function expectNoFrameGlyphs(text: string): void {
	for (const glyph of [
		darkTheme.boxRound.topLeft,
		darkTheme.boxRound.topRight,
		darkTheme.boxRound.bottomLeft,
		darkTheme.boxRound.bottomRight,
		darkTheme.boxRound.vertical,
	]) {
		expect(text).not.toContain(glyph);
	}
	expect(text).not.toContain(darkTheme.boxRound.horizontal.repeat(3));
}

function bgAnsi(name: BgName, theme: Theme = darkTheme): string {
	const ansi = theme.getBgAnsi(name);
	expect(ansi).toMatch(/\x1b\[48;/);
	return ansi;
}

function surfaceTintBgAnsi(name: ThemeColor, theme: Theme = darkTheme): string {
	const ansi = theme.getSurfaceTintBgAnsi(name, 0.06);
	expect(ansi).toMatch(/\x1b\[48;/);
	return ansi;
}

function surfaceTintFgAnsi(name: ThemeColor, theme: Theme = darkTheme): string {
	const ansi = theme.getSurfaceTintFgAnsi(name);
	expect(ansi).toMatch(/\x1b\[/);
	return ansi;
}

function colorFgAnsi(name: ThemeColor, theme: Theme = darkTheme): string {
	const ansi = theme.getFgAnsi(name);
	expect(ansi).toMatch(/\x1b\[/);
	return ansi;
}
function accentPrefix(railColor: ThemeColor, theme: Theme = darkTheme): string {
	const bg = surfaceTintBgAnsi(railColor, theme);
	const railFg = railColor === "borderMuted" ? surfaceTintFgAnsi(railColor, theme) : colorFgAnsi(railColor, theme);
	return `${bg}${railFg}▌\x1b[39m\x1b[49m${bg} `;
}
function accentPadPrefix(railColor: ThemeColor, theme: Theme = darkTheme): string {
	// Block-internal pad rows share the same surface tone as accent content.
	const bg = theme.getSurfaceTintBgAnsi(railColor, ACCENT_PAD_TINT_OPACITY);
	const railFg = railColor === "borderMuted" ? surfaceTintFgAnsi(railColor, theme) : colorFgAnsi(railColor, theme);
	return `${bg}${railFg}▌\x1b[39m\x1b[49m${bg} `;
}
function lineStartsWithAccentPrefix(line: string, railColor: ThemeColor, theme: Theme = darkTheme): boolean {
	return line.startsWith(accentPrefix(railColor, theme)) || line.startsWith(accentPadPrefix(railColor, theme));
}

function expectAccentTintStopsBeforeRightInset(
	lines: readonly string[],
	railColor: ThemeColor,
	width: number,
	theme: Theme = darkTheme,
): void {
	const expectedTintBg = surfaceTintBgAnsi(railColor, theme);
	const expectedPadTintBg = theme.getSurfaceTintBgAnsi(railColor, ACCENT_PAD_TINT_OPACITY);
	// Accent content and internal edge padding share the same surface tone.
	expect(expectedPadTintBg).toBe(expectedTintBg);
	for (const line of lines) {
		expect(visibleWidth(line)).toBe(width);
		expect(line.includes(expectedTintBg)).toBe(true);
		expect(Bun.stripANSI(line).endsWith(" ")).toBe(true);
		expect(line.endsWith("\x1b[49m ")).toBe(true);
	}
}

const RENDERER_WIDTH = 80;

type FgName = "borderMuted" | "dim";

const uiStub = {
	requestRender: () => {},
	requestComponentRender: () => {},
} as unknown as TUI;

function fgAnsi(name: FgName): string {
	const ansi = darkTheme.getFgAnsi(name);
	expect(ansi).toMatch(/\x1b\[/);
	return ansi;
}

function renderToolResult(
	toolName: "bash" | "write",
	args: Record<string, unknown>,
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: Record<string, unknown>;
		isError?: boolean;
	},
): readonly string[] {
	const component = new ToolExecutionComponent(toolName, args, {}, undefined, uiStub);
	component.updateResult(result, false);
	return component.render(RENDERER_WIDTH);
}

function expectBorderMutedTopFrame(lines: readonly string[]): void {
	const frameLine = lines.find(line => {
		const visible = Bun.stripANSI(line).trimStart();
		return visible.startsWith("─") || visible.startsWith("╭") || visible.startsWith("╰");
	});
	expect(frameLine).toBeDefined();
	const normalized = frameLine!.replace(/^ +/, "");
	expect(fgAnsi("borderMuted")).not.toBe(fgAnsi("dim"));
	expect(normalized.startsWith(fgAnsi("borderMuted"))).toBe(true);
	expect(normalized.startsWith(fgAnsi("dim"))).toBe(false);
}

describe("output-block border style", () => {
	beforeAll(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
		const dark = await getThemeByName("dark");
		const lightCatppuccin = await getThemeByName("light-catppuccin");
		if (!dark) throw new Error("Expected dark theme");
		if (!lightCatppuccin) throw new Error("Expected light-catppuccin theme");
		darkTheme = dark;
		lightCatppuccinTheme = lightCatppuccin;
	});

	it("keeps the full frame with rounded corners and side borders", () => {
		const contentWidth = outputBlockContentWidth(WIDTH, undefined, "full");
		const payload = "X".repeat(contentWidth + 2);
		const lines = plain(
			render({
				borderStyle: "full",
				header: "Tool",
				sections: [{ lines: [payload] }],
			}),
		);
		const h = darkTheme.boxRound.horizontal;
		const v = darkTheme.boxRound.vertical;

		expect(contentWidth).toBe(WIDTH - 4);
		expect(lines).toHaveLength(4);
		expect(lines.every(line => line.length === WIDTH)).toBe(true);
		expect(lines[0]!).toBe(
			` ${darkTheme.boxRound.topLeft}${h} Tool ${h.repeat(WIDTH - 10)}${darkTheme.boxRound.topRight}`,
		);
		expect(lines[1]!).toBe(` ${v} ${"X".repeat(contentWidth)}${v}`);
		expect(lines[2]!).toBe(` ${v} XX${" ".repeat(contentWidth - 2)}${v}`);
		expect(lines[3]!).toBe(
			` ${darkTheme.boxRound.bottomLeft}${h.repeat(WIDTH - 3)}${darkTheme.boxRound.bottomRight}`,
		);
	});

	it("renders borderless blocks with a flush header, a two-space body gutter, and no frame glyphs", () => {
		const contentWidth = outputBlockContentWidth(WIDTH, undefined, "none");
		const payload = "Z".repeat(contentWidth + 2);
		const lines = plain(
			render({
				borderStyle: "none",
				header: "Tool",
				sections: [{ lines: [payload] }],
			}),
		);

		expect(contentWidth).toBe(WIDTH - 2);
		expect(lines).toHaveLength(3);
		expectUniformWidth(lines, WIDTH);
		expect(lines[0]).toBe(padLine("Tool", WIDTH));
		expect(lines[1]).toBe(`  ${"Z".repeat(contentWidth)}`);
		expect(lines[2]).toBe(padLine("  ZZ", WIDTH));
		expectNoFrameGlyphs(lines.join("\n"));
	});

	it("renders self-framed accent header+body blocks with tinted breathing rails and no internal separator", () => {
		const width = 18;
		const expectedContentWidth = width - 3;
		const contentWidth = outputBlockContentWidth(width, undefined, "accent");
		const errorPrefix = accentPrefix("error");
		const payload = "A".repeat(expectedContentWidth + 2);
		const success = framedBlock(darkTheme, blockWidth => ({
			width: blockWidth,
			borderStyle: "accent",
			header: "Tool",
			state: "success",
			borderColor: "success",
			sections: [{ lines: [payload] }],
		})).render(width);
		const error = framedBlock(darkTheme, blockWidth => ({
			width: blockWidth,
			borderStyle: "accent",
			header: "Tool",
			state: "error",
			sections: [{ lines: ["boom"] }],
		})).render(width);
		const singleColumn = render({
			width: 1,
			borderStyle: "accent",
			header: "T",
			state: "success",
			borderColor: "success",
			sections: [{ lines: ["x"] }],
		});

		expect(contentWidth).toBe(expectedContentWidth);
		expect(outputBlockContentWidth(width, 0, "accent")).toBe(expectedContentWidth);
		expectUniformWidth(success, width);
		expectUniformWidth(error, width);
		expect(plain(success)).toEqual([
			padLine("▌ Tool", width),
			padLine("▌ ", width),
			padLine(`▌ ${"A".repeat(expectedContentWidth)}`, width),
			padLine("▌ AA", width),
			padLine("▌ ", width),
		]);
		expect(plain(error)).toEqual([
			padLine("▌ Tool", width),
			padLine("▌ ", width),
			padLine("▌ boom", width),
			padLine("▌ ", width),
		]);
		expectNoFrameGlyphs(plain(success).join("\n"));
		expectNoFrameGlyphs(plain(error).join("\n"));
		expect(success.every(line => lineStartsWithAccentPrefix(line, "success"))).toBe(true);
		expect(error.every(line => lineStartsWithAccentPrefix(line, "error"))).toBe(true);
		expect(success.join("\n")).not.toContain(errorPrefix);
		expectAccentTintStopsBeforeRightInset(success, "success", width);
		expectAccentTintStopsBeforeRightInset(error, "error", width);
		expect(singleColumn.length).toBeGreaterThan(0);
		expectUniformWidth(singleColumn, 1);
		expect(singleColumn.every(line => line === " ")).toBe(true);
		expect(singleColumn.join("")).not.toContain(surfaceTintBgAnsi("success"));
	});

	it("keeps header-only accent blocks framed by one tinted breathing row at each edge", () => {
		const width = 18;
		const lines = render({
			width,
			borderStyle: "accent",
			header: "Tool",
			state: "success",
			borderColor: "success",
		});

		expectUniformWidth(lines, width);
		expect(plain(lines)).toEqual([padLine("▌ Tool", width), padLine("▌ ", width)]);
		expect(lines.every(line => lineStartsWithAccentPrefix(line, "success"))).toBe(true);
		expectAccentTintStopsBeforeRightInset(lines, "success", width);
		expectNoFrameGlyphs(plain(lines).join("\n"));
	});

	it("omitting borderStyle renders the Accent Gutter default exactly like explicit accent", () => {
		const options = {
			width: 18,
			header: "Tool",
			state: "success",
			borderColor: "success",
			sections: [{ lines: ["default rail"] }],
		} satisfies Omit<OutputBlockOptions, "width" | "borderStyle"> & { width: number };

		expect(render(options)).toEqual(render({ ...options, borderStyle: "accent" }));
	});

	it.each([
		{
			name: "pending",
			state: "pending",
			railColor: "borderMuted",
			borderColor: undefined,
		},
		{
			name: "success",
			state: "success",
			railColor: "success",
			borderColor: "success",
		},
		{
			name: "error",
			state: "error",
			railColor: "error",
			borderColor: undefined,
		},
	] as const)("paints accent $name rows with the matching surface tint after resets", spec => {
		const width = 30;
		const resetText = `pre\x1b[0mmid\x1b[49mpost`;
		const expectedTintBg = surfaceTintBgAnsi(spec.railColor);
		const otherTintBgs = (["borderMuted", "success", "error"] as const)
			.filter(name => name !== spec.railColor)
			.map(name => surfaceTintBgAnsi(name));
		const lines = render({
			width,
			borderStyle: "accent",
			header: "Tool",
			state: spec.state,
			borderColor: spec.borderColor,
			sections: [{ lines: [resetText] }],
		});
		const raw = lines.join("\n");

		expectUniformWidth(lines, width);
		expect(plain(lines)).toEqual([
			padLine("▌ Tool", width),
			padLine("▌ ", width),
			padLine("▌ premidpost", width),
			padLine("▌ ", width),
		]);
		expectNoFrameGlyphs(plain(lines).join("\n"));
		expect(lines.every(line => lineStartsWithAccentPrefix(line, spec.railColor))).toBe(true);
		expect(lines.every(line => line.endsWith("\x1b[49m "))).toBe(true);
		expect(raw).toContain(`\x1b[0m${expectedTintBg}mid`);
		expect(raw).toContain(`\x1b[49m${expectedTintBg}post`);
		for (const other of otherTintBgs) {
			expect(raw).not.toContain(other);
		}
		if (spec.railColor === "borderMuted") {
			expect(surfaceTintFgAnsi("borderMuted")).not.toBe(colorFgAnsi("borderMuted"));
		}
	});

	it("maps accent to borderless markdown table layout", () => {
		expect(resolveMarkdownTableBorderStyle("accent")).toBe("none");
	});

	it("keeps root todo tree prefixes at column zero and aligns wrapped continuation text under the checkbox body", () => {
		const width = 18;
		const branchBody = "甲乙丙丁戊己庚辛壬癸";
		const lastBody = "子丑寅卯辰巳午未申酉";
		const branchPrefix = `${darkTheme.tree.branch} ${darkTheme.checkbox.unchecked} `;
		const branchContinuationPrefix = `${darkTheme.tree.vertical}  ${" ".repeat(visibleWidth(`${darkTheme.checkbox.unchecked} `))}`;
		const lastPrefix = `${darkTheme.tree.last} ${darkTheme.checkbox.checked} `;
		const lastContinuationPrefix = " ".repeat(visibleWidth(`${darkTheme.tree.last} ${darkTheme.checkbox.checked} `));
		const lines = plain(
			render({
				width,
				borderStyle: "none",
				header: "Todos",
				sections: [
					{
						lines: [
							`${darkTheme.tree.branch} ${darkTheme.checkbox.unchecked} ${branchBody}`,
							`${darkTheme.tree.last} ${darkTheme.checkbox.checked} ${lastBody}`,
						],
					},
				],
			}),
		);

		expectUniformWidth(lines, width);
		expect(lines).toEqual([
			padLine("Todos", width),
			padLine(`${branchPrefix}甲乙丙丁戊己`, width),
			padLine(`${branchContinuationPrefix}庚辛壬癸`, width),
			padLine(`${lastPrefix}子丑寅卯辰巳`, width),
			padLine(`${lastContinuationPrefix}午未申酉`, width),
		]);
	});

	it("keeps labeled borderless sections on the section tree gutter, including nested tree rows", () => {
		const width = 18;
		const sectionBranchPrefix = `  ${darkTheme.tree.branch} `;
		const sectionContinuePrefix = `  ${darkTheme.tree.vertical}  `;
		const sectionLastPrefix = `  ${darkTheme.tree.last} `;
		const sectionLastContinuePrefix = " ".repeat(visibleWidth(sectionLastPrefix));
		const lines = plain(
			render({
				width,
				borderStyle: "none",
				header: "Result",
				sections: [
					{ label: "Stdout", lines: ["ABCDEFGHIJKLMNO", `${darkTheme.tree.last} child`] },
					{ label: "Stderr", lines: ["PQRSTUVWXYZABCD"] },
				],
			}),
		);

		expectUniformWidth(lines, width);
		expect(lines).toEqual([
			padLine("Result", width),
			padLine(`${sectionBranchPrefix}Stdout`, width),
			padLine(`${sectionContinuePrefix}ABCDEFGHIJKLM`, width),
			padLine(`${sectionContinuePrefix}NO`, width),
			padLine(`${sectionContinuePrefix}${darkTheme.tree.last} child`, width),
			padLine(`${sectionLastPrefix}Stderr`, width),
			padLine(`${sectionLastContinuePrefix}PQRSTUVWXYZAB`, width),
			padLine(`${sectionLastContinuePrefix}CD`, width),
		]);
	});

	describe("borderMuted full-frame regression teeth", () => {
		let previousStyle: OutputBlockBorderStyle;
		beforeAll(() => {
			previousStyle = getOutputBlockBorderStyle();
			setOutputBlockBorderStyle("full");
		});
		afterAll(() => {
			setOutputBlockBorderStyle(previousStyle);
		});

		it("uses borderMuted for ordinary success blocks by default", () => {
			const lines = render({
				header: "Tool",
				state: "success",
				sections: [{ lines: ["body"] }],
			});

			expectBorderMutedTopFrame(lines);
		});

		it("renders final bash and write success cards with borderMuted borders", () => {
			const bashLines = renderToolResult(
				"bash",
				{ command: "printf 'ok'" },
				{ content: [{ type: "text", text: "ok\n" }], details: { wallTimeMs: 12 } },
			);
			expectBorderMutedTopFrame(bashLines);
			const bashPlain = Bun.stripANSI(bashLines.join("\n"));
			expect(bashPlain).toContain("$ printf 'ok'");
			// New contract: no labeled divider between command and output
			expect(bashPlain).not.toContain("Output:");
			expect(bashPlain).toContain("ok");
			const writeLines = renderToolResult(
				"write",
				{ path: "src/example.ts", content: "export const answer = 42;\n" },
				{ content: [{ type: "text", text: "Successfully wrote src/example.ts" }], details: {} },
			);
			expectBorderMutedTopFrame(writeLines);
			const writePlain = Bun.stripANSI(writeLines.join("\n"));
			expect(writePlain).toContain("Write");
			expect(writePlain).toContain("src/example.ts");
			expect(writePlain).toContain("export const answer = 42;");
		});
	});

	it.each([
		{ name: "full", borderStyle: "full" },
		{ name: "none", borderStyle: "none" },
	] as const)("does not fill $name error blocks by default", ({ borderStyle }) => {
		const lines = render({
			borderStyle,
			header: "Tool",
			state: "error",
			sections: [{ lines: ["body"] }],
		});
		const raw = lines.join("\n");
		const allBg = [bgAnsi("toolPendingBg"), bgAnsi("toolErrorBg"), bgAnsi("toolSuccessBg")];

		expect(raw.includes("\x1b[49m")).toBe(false);
		for (const ansi of allBg) {
			expect(raw.includes(ansi)).toBe(false);
		}
	});

	it.each([
		{ name: "pending emits no background", state: "pending", expectedBg: null },
		{ name: "running emits no background", state: "running", expectedBg: null },
		{ name: "success defaults off", state: "success", expectedBg: null },
		{ name: "warning defaults off", state: "warning", expectedBg: null },
		{ name: "error applyBg forces on", state: "error", applyBg: true, expectedBg: "toolErrorBg" },
		{ name: "success applyBg forces on", state: "success", applyBg: true, expectedBg: "toolSuccessBg" },
		{ name: "warning applyBg forces on", state: "warning", applyBg: true, expectedBg: "toolPendingBg" },
		{ name: "pending applyBg forces off", state: "pending", applyBg: false, expectedBg: null },
		{ name: "error applyBg forces off", state: "error", applyBg: false, expectedBg: null },
	] as const)("%s background override policy", ({ state, applyBg, expectedBg }) => {
		const lines = render({
			borderStyle: "full",
			header: "Tool",
			state,
			applyBg,
			sections: [{ lines: ["body"] }],
		});
		const raw = lines.join("\n");
		const allBg = [bgAnsi("toolPendingBg"), bgAnsi("toolErrorBg"), bgAnsi("toolSuccessBg")];

		if (expectedBg) {
			const ansi = bgAnsi(expectedBg);
			expect(lines.every(line => line.startsWith(ansi))).toBe(true);
			expect(lines.every(line => line.endsWith("\x1b[49m"))).toBe(true);
			expect(raw.includes(ansi)).toBe(true);
			for (const other of allBg.filter(value => value !== ansi)) {
				expect(raw.includes(other)).toBe(false);
			}
			return;
		}

		expect(raw.includes("\x1b[49m")).toBe(false);
		for (const ansi of allBg) {
			expect(raw.includes(ansi)).toBe(false);
		}
	});

	it("uses light-catppuccin errorSurface for explicit error output backgrounds while keeping error-colored borders", () => {
		const ansiMode = lightCatppuccinTheme.getColorMode() === "truecolor" ? "ansi-16m" : "ansi-256";
		const expectedErrorSurface = Bun.color("#f5d3d8", ansiMode);
		const expectedErrorFg = Bun.color("#d20f39", ansiMode);
		if (!expectedErrorSurface || !expectedErrorFg) throw new Error("Expected Catppuccin colors to resolve");
		const expectedErrorBg = expectedErrorSurface.replace("\x1b[38;", "\x1b[48;");
		const pendingBg = bgAnsi("toolPendingBg", lightCatppuccinTheme);
		const successBg = bgAnsi("toolSuccessBg", lightCatppuccinTheme);
		const errorFg = lightCatppuccinTheme.getFgAnsi("error");
		const lines = render(
			{
				borderStyle: "full",
				header: "Tool",
				state: "error",
				sections: [{ lines: ["body"] }],
				applyBg: true,
			},
			lightCatppuccinTheme,
		);
		const raw = lines.join("\n");

		expect(bgAnsi("toolErrorBg", lightCatppuccinTheme)).toBe(expectedErrorBg);
		expect(errorFg).toBe(expectedErrorFg);
		expect(expectedErrorBg).not.toBe(pendingBg);
		expect(expectedErrorBg).not.toBe(successBg);
		expect(lines.every(line => line.startsWith(expectedErrorBg))).toBe(true);
		expect(lines.every(line => line.endsWith("\x1b[49m"))).toBe(true);
		expect(raw).toContain(errorFg);
		expect(raw).toContain(expectedErrorBg);
		expect(raw).not.toContain(pendingBg);
		expect(raw).not.toContain(successBg);
	});
});
