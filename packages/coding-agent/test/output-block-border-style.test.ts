import { beforeAll, describe, expect, it } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	type OutputBlockOptions,
	outputBlockContentWidth,
	renderOutputBlock,
} from "@oh-my-pi/pi-coding-agent/tui/output-block";
import type { TUI } from "@oh-my-pi/pi-tui";

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
		expect(lines[0]!.startsWith(`${darkTheme.boxRound.topLeft}${h.repeat(3)} Tool `)).toBe(true);
		expect(lines[0]!.endsWith(darkTheme.boxRound.topRight)).toBe(true);
		expect(lines[1]!).toBe(`${v} ${"X".repeat(contentWidth)}${v}`);
		expect(lines[2]!).toBe(`${v} XX${" ".repeat(contentWidth - 2)}${v}`);
		expect(lines[3]!.startsWith(`${darkTheme.boxRound.bottomLeft}${h.repeat(3)}`)).toBe(true);
		expect(lines[3]!.endsWith(darkTheme.boxRound.bottomRight)).toBe(true);
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
		expect(horizontal[0]!).toBe(`${h.repeat(3)} Tool ${h.repeat(WIDTH - 9)}`);
		expect(horizontal[1]!).toBe(` ${payload}`);
		expect(horizontal[2]!).toBe(`${h.repeat(3)} More ${h.repeat(WIDTH - 9)}`);
		expect(horizontal[3]!).toBe(` ${tail}${" ".repeat(WIDTH - tail.length - 1)}`);
		expect(horizontal[4]!).toBe(h.repeat(WIDTH));
		expect(horizontal.join("\n").includes(v)).toBe(false);
		expect(horizontal.join("\n").includes(darkTheme.boxRound.topLeft)).toBe(false);
		expect(horizontal.join("\n").includes(darkTheme.boxRound.topRight)).toBe(false);
		expect(horizontal.join("\n").includes(darkTheme.boxRound.bottomLeft)).toBe(false);
		expect(horizontal.join("\n").includes(darkTheme.boxRound.bottomRight)).toBe(false);

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
		expect(bashPlain).toContain("Output");
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
		{ name: "pending defaults on", state: "pending", expectedBg: "toolPendingBg" },
		{ name: "running defaults on", state: "running", expectedBg: "toolPendingBg" },
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
