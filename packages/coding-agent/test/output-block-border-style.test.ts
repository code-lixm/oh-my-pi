import { beforeAll, describe, expect, it } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	type OutputBlockOptions,
	outputBlockContentWidth,
	renderOutputBlock,
} from "@oh-my-pi/pi-coding-agent/tui/output-block";
import { type TUI, visibleWidth } from "@oh-my-pi/pi-tui";

/**
 * Regression teeth:
 * - Reverting horizontal bars back to rounded corners/side rails breaks the
 *   horizontal layout assertions.
 * - Forgetting to remove the side borders from horizontal content breaks the
 *   width-release case: a width-1 payload no longer fits on one rendered row.
 * - Changing the default background policy or ignoring applyBg overrides breaks
 *   the ANSI background matrix below.
 *
 * All border-style assertions use per-call `borderStyle` overrides so the global
 * module state is never touched — tests are fully order-independent.
 */

const WIDTH = 16;

type BgName = "toolPendingBg" | "toolErrorBg" | "toolSuccessBg";

let darkTheme: Theme;

function render(options: Omit<OutputBlockOptions, "width"> & { width?: number }): readonly string[] {
	return renderOutputBlock({ width: options.width ?? WIDTH, ...options }, darkTheme);
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

function bgAnsi(name: BgName): string {
	const ansi = darkTheme.getBgAnsi(name);
	expect(ansi).toMatch(/\x1b\[48;/);
	return ansi;
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
		if (!dark) throw new Error("Expected dark theme");
		darkTheme = dark;
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

		expect(lines).toHaveLength(4);
		expect(lines.every(line => line.length === WIDTH)).toBe(true);
		expect(lines[0]!).toBe(
			`${darkTheme.boxRound.topLeft}${h} Tool ${h.repeat(WIDTH - 9)}${darkTheme.boxRound.topRight}`,
		);
		expect(lines[1]!).toBe(`${v} ${"X".repeat(contentWidth)}${v}`);
		expect(lines[2]!).toBe(`${v} XX${" ".repeat(contentWidth - 2)}${v}`);
		expect(lines[3]!).toBe(`${darkTheme.boxRound.bottomLeft}${h.repeat(WIDTH - 2)}${darkTheme.boxRound.bottomRight}`);
	});

	it("renders horizontal blocks with only horizontal bars and frees both side-border columns to content", () => {
		const payload = "Y".repeat(WIDTH - 1);
		const tail = "tail";
		const h = darkTheme.boxRound.horizontal;
		const v = darkTheme.boxRound.vertical;

		expect(outputBlockContentWidth(WIDTH, undefined, "horizontal")).toBe(WIDTH - 1);
		const horizontal = plain(
			render({
				borderStyle: "horizontal",
				header: "Tool",
				sections: [{ lines: [payload] }, { label: "More", lines: [tail] }],
			}),
		);

		expect(horizontal).toHaveLength(5);
		expect(horizontal.every(line => line.length === WIDTH)).toBe(true);
		expect(horizontal[0]!).toBe(`${h} Tool ${h.repeat(WIDTH - 7)}`);
		expect(horizontal[1]!).toBe(` ${payload}`);
		expect(horizontal[2]!).toBe(`${h} More ${h.repeat(WIDTH - 7)}`);
		expect(horizontal[3]!).toBe(` ${tail}${" ".repeat(WIDTH - tail.length - 1)}`);
		expect(horizontal[4]!).toBe(h.repeat(WIDTH));

		expect(outputBlockContentWidth(WIDTH, undefined, "full")).toBe(WIDTH - 3);
		const full = plain(
			render({
				borderStyle: "full",
				header: "Tool",
				sections: [{ lines: [payload] }],
			}),
		);
		const fullContentRows = full.filter(line => line.startsWith(`${v} `));
		expect(fullContentRows).toHaveLength(2);
		expect(fullContentRows[0]!).toBe(`${v} ${"Y".repeat(WIDTH - 3)}${v}`);
		expect(fullContentRows[1]!).toBe(`${v} YY${" ".repeat(WIDTH - 5)}${v}`);
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

	it.each([
		{ name: "pending emits no background", state: "pending", expectedBg: null },
		{ name: "running emits no background", state: "running", expectedBg: null },
		{ name: "error defaults on", state: "error", expectedBg: "toolErrorBg" },
		{ name: "success defaults off", state: "success", expectedBg: null },
		{ name: "warning defaults off", state: "warning", expectedBg: null },
		{ name: "success applyBg forces on", state: "success", applyBg: true, expectedBg: "toolSuccessBg" },
		{ name: "warning applyBg forces on", state: "warning", applyBg: true, expectedBg: "toolPendingBg" },
		{ name: "pending applyBg forces off", state: "pending", applyBg: false, expectedBg: null },
		{ name: "error applyBg forces off", state: "error", applyBg: false, expectedBg: null },
	] as const)("%s background policy", ({ state, applyBg, expectedBg }) => {
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
});
