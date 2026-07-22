import { beforeEach, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/bash-execution";
import { EvalExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/eval-execution";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";

const MAX_DISPLAY_LINE_CHARS = 4000;

describe("BashExecutionComponent #clampDisplayLine", () => {
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	beforeEach(async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		setThemeInstance(theme!);
	});

	function createComponentWithOutput(output: string): BashExecutionComponent {
		const component = new BashExecutionComponent("test", ui, false);
		component.appendOutput(output);
		component.setComplete(0, false);
		return component;
	}

	describe("wide glyphs (CJK characters)", () => {
		it("counts CJK characters as 2 columns each", () => {
			const cjkString = "日本語";
			expect(visibleWidth(cjkString)).toBe(6);
		});

		it("does not truncate CJK string under limit", () => {
			const cjkString = "日本語".repeat(100);
			const component = createComponentWithOutput(cjkString);
			const output = component.getOutput();

			expect(output).toBe(cjkString);
			expect(output).not.toContain("omitted");
		});

		it("truncates CJK string over limit and calculates omitted correctly", () => {
			const cjkString = "日本語".repeat(2500);
			const expectedVisible = visibleWidth(cjkString);
			const component = createComponentWithOutput(cjkString);
			const output = component.getOutput();

			expect(output).toContain("visible columns omitted");
			expect(output).toContain(`[${expectedVisible - MAX_DISPLAY_LINE_CHARS} visible columns omitted]`);
			expect(output).toContain("…");
		});
	});

	describe("emoji handling", () => {
		it("counts emoji as appropriate columns", () => {
			expect(visibleWidth("😀")).toBe(2);
			expect(visibleWidth("👨‍👩‍👧‍👦")).toBe(2);
			expect(visibleWidth("🎌")).toBe(2);
		});

		it("does not truncate emoji string under limit", () => {
			const emojiString = "🎌".repeat(1000);
			const component = createComponentWithOutput(emojiString);
			const output = component.getOutput();

			expect(output).toBe(emojiString);
			expect(output).not.toContain("omitted");
		});

		it("truncates emoji string over limit correctly", () => {
			const emojiString = "🎌".repeat(2500);
			const expectedVisible = visibleWidth(emojiString);
			const component = createComponentWithOutput(emojiString);
			const output = component.getOutput();

			expect(output).toContain("visible columns omitted");
			expect(output).toContain(`[${expectedVisible - MAX_DISPLAY_LINE_CHARS} visible columns omitted]`);
		});
	});

	describe("combining marks", () => {
		it("handles combining diacritical marks", () => {
			const combined = "e\u0304";
			expect(visibleWidth(combined)).toBe(1);
		});

		it("handles string with combining marks over limit", () => {
			const base = "e\u0304".repeat(2500);
			const expectedVisible = visibleWidth(base);
			const component = createComponentWithOutput(base);
			const output = component.getOutput();

			if (expectedVisible > MAX_DISPLAY_LINE_CHARS) {
				expect(output).toContain("visible columns omitted");
				expect(output).toContain(`[${expectedVisible - MAX_DISPLAY_LINE_CHARS} visible columns omitted]`);
			}
		});
	});

	describe("ANSI-decorated strings", () => {
		it("ignores ANSI escape sequences in visible width calculation", () => {
			const ansiString = "\x1b[31mred\x1b[0m";
			expect(visibleWidth(ansiString)).toBe(3);
		});

		it("does not truncate ANSI string under visible limit", () => {
			const ansiString = "\x1b[32mgreen\x1b[0m".repeat(200);
			const component = createComponentWithOutput(ansiString);
			const output = component.getOutput();

			expect(output).not.toContain("omitted");
		});

		it("truncates ANSI string based on visible content, not raw length", () => {
			const ansiString = "\x1b[31mred\x1b[0m".repeat(2500);
			const component = createComponentWithOutput(ansiString);
			const output = component.getOutput();

			expect(output).toContain("visible columns omitted");
		});

		it("calculates omitted count based on visible width, not raw length", () => {
			const ansiString = "\x1b[1;31;47mbold red on white\x1b[0m".repeat(1000);
			const expectedVisible = visibleWidth(ansiString);
			const component = createComponentWithOutput(ansiString);
			const output = component.getOutput();

			if (expectedVisible > MAX_DISPLAY_LINE_CHARS) {
				const omittedMatch = output.match(/\[(\d+) visible columns omitted\]/);
				expect(omittedMatch).not.toBeNull();
				const omitted = parseInt(omittedMatch![1], 10);
				expect(omitted).toBe(expectedVisible - MAX_DISPLAY_LINE_CHARS);
			}
		});
	});

	describe("truncation with Ellipsis.Omit", () => {
		it("truncates using visibleWidth and truncateToWidth", () => {
			const longAscii = "a".repeat(5000);
			const component = createComponentWithOutput(longAscii);
			const output = component.getOutput();

			expect(output).toContain("…");
			expect(output).toContain("visible columns omitted");
			expect(output.length).toBeLessThan(5000);
		});

		it("includes ellipsis in truncated output", () => {
			const longString = "x".repeat(5000);
			const component = createComponentWithOutput(longString);
			const output = component.getOutput();

			expect(output).toContain("… [");
		});

		it("truncated portion is within MAX_DISPLAY_LINE_CHARS visible width", () => {
			const longString = "hello world ".repeat(1000);
			const component = createComponentWithOutput(longString);
			const output = component.getOutput();

			if (output.includes("omitted")) {
				const truncatedPart = output.split(" [")[0];
				// truncateToWidth limits to exactly MAX_DISPLAY_LINE_CHARS, may go 1 over due to wide chars
				expect(visibleWidth(truncatedPart)).toBeLessThanOrEqual(MAX_DISPLAY_LINE_CHARS + 10);
			}
		});
	});

	describe("omitted count accuracy", () => {
		it("calculates omitted as visibleWidth(original) - MAX_DISPLAY_LINE_CHARS", () => {
			const testString = "test".repeat(1500);
			const originalVisible = visibleWidth(testString);
			const component = createComponentWithOutput(testString);
			const output = component.getOutput();

			const expectedOmitted = originalVisible - MAX_DISPLAY_LINE_CHARS;
			expect(output).toContain(`[${expectedOmitted} visible columns omitted]`);
		});

		it("handles mixed content (ASCII + CJK + emoji + ANSI)", () => {
			const mixed = "abc日本語😀\x1b[34mblue\x1b[0m".repeat(500);
			const originalVisible = visibleWidth(mixed);
			const component = createComponentWithOutput(mixed);
			const output = component.getOutput();

			if (originalVisible > MAX_DISPLAY_LINE_CHARS) {
				const expectedOmitted = originalVisible - MAX_DISPLAY_LINE_CHARS;
				expect(output).toContain(`[${expectedOmitted} visible columns omitted]`);
			}
		});
	});

	describe("edge cases at, below, and above MAX_DISPLAY_LINE_CHARS", () => {
		it("returns original string when visibleWidth equals MAX_DISPLAY_LINE_CHARS", () => {
			const exactlyAtLimit = "a".repeat(MAX_DISPLAY_LINE_CHARS);
			const component = createComponentWithOutput(exactlyAtLimit);
			const output = component.getOutput();

			expect(output).toBe(exactlyAtLimit);
			expect(output).not.toContain("omitted");
		});

		it("returns original string when visibleWidth is just below limit", () => {
			const justBelow = "a".repeat(MAX_DISPLAY_LINE_CHARS - 1);
			const component = createComponentWithOutput(justBelow);
			const output = component.getOutput();

			expect(output).toBe(justBelow);
			expect(output).not.toContain("omitted");
		});

		it("truncates when visibleWidth is just above limit", () => {
			const justAbove = "a".repeat(MAX_DISPLAY_LINE_CHARS + 1);
			const component = createComponentWithOutput(justAbove);
			const output = component.getOutput();

			expect(output).toContain("omitted");
			expect(output).toContain(`[1 visible columns omitted]`);
		});

		it("handles empty string", () => {
			const component = createComponentWithOutput("");
			const output = component.getOutput();

			expect(output).toBe("");
		});
	});

	describe("visibleWidth calculation verification", () => {
		it("verifies ASCII characters count as 1 column", () => {
			expect(visibleWidth("abc")).toBe(3);
			expect(visibleWidth("")).toBe(0);
		});

		it("verifies CJK counts as 2 columns", () => {
			expect(visibleWidth("中")).toBe(2);
			expect(visibleWidth("日本語中文")).toBe(10);
		});

		it("verifies emoji count", () => {
			expect(visibleWidth("🎉")).toBe(2);
			expect(visibleWidth("🔢")).toBe(2);
		});

		it("ignores ANSI escape sequences", () => {
			expect(visibleWidth("\x1b[7m")).toBe(0);
			expect(visibleWidth("a\x1b[7mb")).toBe(2);
		});
	});
});
describe("BashExecutionComponent rounded legend frame", () => {
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	beforeEach(async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		setThemeInstance(theme!);
	});

	it("renders one unified rounded legend frame without standalone DynamicBorder rows", async () => {
		const component = new BashExecutionComponent("echo test", ui, false);
		component.appendOutput("output line");
		component.setComplete(0, false);

		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const rendered = component.render(80);

		// ALL four rounded corners must appear (not just some)
		expect(rendered.some(line => line.includes(theme!.boxRound.topLeft))).toBe(true);
		expect(rendered.some(line => line.includes(theme!.boxRound.topRight))).toBe(true);
		expect(rendered.some(line => line.includes(theme!.boxRound.bottomLeft))).toBe(true);
		expect(rendered.some(line => line.includes(theme!.boxRound.bottomRight))).toBe(true);

		// NO line may consist entirely of ─ repeated (catches standalone DynamicBorder rows)
		const pureHorizontalLines = rendered.filter(line => {
			const stripped = Bun.stripANSI(line);
			return stripped.length > 0 && stripped === theme!.boxRound.horizontal.repeat(stripped.length);
		});
		expect(pureHorizontalLines.length).toBe(0);

		// Must NOT have an internal titled divider between command and output
		const plain = rendered.map(line => Bun.stripANSI(line));
		const hasOutputLabel = plain.some(line => /^[│┃]?\s*Output:?\s*$/.test(line.trim()));
		expect(hasOutputLabel).toBe(false);
	});

	it("renders command and output content in the legend frame", async () => {
		const component = new BashExecutionComponent("ls -la", ui, false);
		component.appendOutput("file1.txt\nfile2.txt");
		component.setComplete(0, false);

		const rendered = component.render(80);
		const plain = rendered.map(line => Bun.stripANSI(line));

		// Command must appear
		expect(plain.some(line => line.includes("$ ls -la"))).toBe(true);

		// Output must appear (both lines in one appendOutput call)
		expect(plain.some(line => line.includes("file1.txt"))).toBe(true);
		expect(plain.some(line => line.includes("file2.txt"))).toBe(true);
	});
});
describe("BashExecutionComponent streaming rebuild invariant", () => {
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	beforeEach(async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		setThemeInstance(theme!);
	});

	it("appended output appears in the same rounded legend frame as the initial running state", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const bashSentinel = "streamed bash output";

		// Render initial running frame (no output yet)
		const component = new BashExecutionComponent("echo hello", ui, false);
		const initialLines = component.render(80);
		const initialPlain = initialLines.map(line => Bun.stripANSI(line));

		// Verify initial frame has one rounded shell legend and the command body.
		expect(initialLines.some(line => line.includes(theme!.boxRound.topLeft))).toBe(true);
		expect(initialLines.some(line => line.includes(theme!.boxRound.bottomRight))).toBe(true);
		expect(initialPlain[0]).toContain("shell");
		expect(initialPlain.some(line => line.includes("$ echo hello"))).toBe(true);

		// Simulate streaming: append output then re-render.
		component.appendOutput(bashSentinel);
		const rebuiltLines = component.render(80);
		const rebuiltPlain = rebuiltLines.map(line => Bun.stripANSI(line));

		// The same rounded legend frame must be used (same corners + shell legend).
		expect(rebuiltLines.some(line => line.includes(theme!.boxRound.topLeft))).toBe(true);
		expect(rebuiltLines.some(line => line.includes(theme!.boxRound.bottomRight))).toBe(true);
		expect(rebuiltPlain[0]).toContain("shell");

		// Streamed output must appear inside that same frame, not as a separate block.
		expect(rebuiltPlain.some(line => line.includes(bashSentinel))).toBe(true);

		const initialCornerCount =
			(initialLines.join("").match(new RegExp(theme!.boxRound.topLeft, "g")) || []).length +
			(initialLines.join("").match(new RegExp(theme!.boxRound.bottomRight, "g")) || []).length;
		const rebuiltCornerCount =
			(rebuiltLines.join("").match(new RegExp(theme!.boxRound.topLeft, "g")) || []).length +
			(rebuiltLines.join("").match(new RegExp(theme!.boxRound.bottomRight, "g")) || []).length;

		// Frame structure remains one legend frame across the streaming rebuild.
		expect(rebuiltCornerCount).toBe(initialCornerCount);
	});
});
describe("EvalExecutionComponent streaming rebuild invariant", () => {
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	beforeEach(async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		setThemeInstance(theme!);
	});

	it("appended output appears in the same rounded legend frame as the initial running state", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const evalSentinel = "streamed eval output";

		// Render initial running frame (no output yet).
		const component = new EvalExecutionComponent("print(1)", ui, false, "python");
		const initialLines = component.render(80);
		const initialPlain = initialLines.map(line => Bun.stripANSI(line));

		// Verify initial frame has one rounded python legend and the eval prompt.
		expect(initialLines.some(line => line.includes(theme!.boxRound.topLeft))).toBe(true);
		expect(initialLines.some(line => line.includes(theme!.boxRound.bottomRight))).toBe(true);
		expect(initialPlain[0]).toContain("python");
		expect(initialPlain.some(line => line.includes(">>>"))).toBe(true);

		// Simulate streaming: append output then re-render.
		component.appendOutput(evalSentinel);
		const rebuiltLines = component.render(80);
		const rebuiltPlain = rebuiltLines.map(line => Bun.stripANSI(line));

		// The same rounded legend frame must be used (same corners + python legend).
		expect(rebuiltLines.some(line => line.includes(theme!.boxRound.topLeft))).toBe(true);
		expect(rebuiltLines.some(line => line.includes(theme!.boxRound.bottomRight))).toBe(true);
		expect(rebuiltPlain[0]).toContain("python");

		// Streamed output must appear inside that same frame, not as a separate block.
		expect(rebuiltPlain.some(line => line.includes(evalSentinel))).toBe(true);

		const initialCornerCount =
			(initialLines.join("").match(new RegExp(theme!.boxRound.topLeft, "g")) || []).length +
			(initialLines.join("").match(new RegExp(theme!.boxRound.bottomRight, "g")) || []).length;
		const rebuiltCornerCount =
			(rebuiltLines.join("").match(new RegExp(theme!.boxRound.topLeft, "g")) || []).length +
			(rebuiltLines.join("").match(new RegExp(theme!.boxRound.bottomRight, "g")) || []).length;

		// Frame structure remains one legend frame across the streaming rebuild.
		expect(rebuiltCornerCount).toBe(initialCornerCount);
	});
});
