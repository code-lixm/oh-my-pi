import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import xterm from "@xterm/headless";
import { Settings } from "../../config/settings";
import { getThemeByName, setThemeInstance, type Theme } from "../../modes/theme/theme";
import { BashInteractiveOverlayComponent } from "../bash-interactive";

const WIDTH = 36;
const VIEWPORT_ROWS = 10;
const MAX_OVERLAY_ROWS = Math.max(5, Math.floor(VIEWPORT_ROWS * 0.8));
const MAX_CONTENT_ROWS = Math.max(1, MAX_OVERLAY_ROWS - 4);
const NONE_MAX_CONTENT_ROWS = Math.max(1, MAX_OVERLAY_ROWS - 2);

type BorderStyle = "full" | "none" | "accent";

type Completion = {
	exitCode: number | undefined;
	cancelled: boolean;
	timedOut: boolean;
};

let uiTheme: Theme;

function strip(lines: readonly string[]): string[] {
	return lines.map(line => Bun.stripANSI(line));
}

function expectLineWidths(lines: readonly string[], width: number): void {
	expect(lines.map(line => visibleWidth(line))).toEqual(Array(lines.length).fill(width));
}

function expectNoFrameOrTreeGlyphs(lines: readonly string[]): void {
	const text = strip(lines).join("\n");
	const forbiddenGlyphs = [
		uiTheme.boxRound.horizontal,
		uiTheme.boxRound.vertical,
		uiTheme.boxRound.topLeft,
		uiTheme.boxRound.topRight,
		uiTheme.boxRound.bottomLeft,
		uiTheme.boxRound.bottomRight,
		uiTheme.symbol("tree.branch"),
		uiTheme.symbol("tree.last"),
		uiTheme.symbol("tree.vertical"),
		uiTheme.symbol("tree.horizontal"),
		uiTheme.symbol("tree.hook"),
	];
	for (const glyph of forbiddenGlyphs) {
		expect(text.includes(glyph)).toBe(false);
	}
}

function contentRows(lines: readonly string[], borderStyle: BorderStyle): string[] {
	const start = borderStyle === "none" ? 1 : 2;
	const end = borderStyle === "none" ? -1 : -2;
	return strip(lines)
		.slice(start, end)
		.map(line => {
			if (borderStyle === "accent") {
				return line.replace(/^▌ /, "").trimEnd();
			}
			const inner = borderStyle === "full" ? line.slice(1, -1) : line.slice(2);
			return inner.trimEnd();
		});
}

async function renderOverlay(options?: {
	borderStyle?: BorderStyle;
	command?: string;
	output?: string;
	rows?: number;
	width?: number;
	completion?: Completion;
}): Promise<readonly string[]> {
	const component = new BashInteractiveOverlayComponent(
		options?.command ?? "printf bash-overlay",
		uiTheme,
		() => options?.rows ?? VIEWPORT_ROWS,
		options?.borderStyle ?? "full",
		xterm.Terminal,
	);
	try {
		component.render(options?.width ?? WIDTH);
		if (options?.output) {
			component.appendOutput(options.output);
		}
		await component.flushOutput();
		if (options?.completion) {
			component.setComplete(options.completion);
		}
		return component.render(options?.width ?? WIDTH);
	} finally {
		component.dispose();
	}
}

describe("BashInteractiveOverlayComponent render", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
	});

	it("keeps empty normal output at the 1-row minimum instead of padding to 80% viewport height", async () => {
		const lines = await renderOverlay();

		expect(lines).toHaveLength(5);
		expect(contentRows(lines, "full")).toEqual([""]);
		expectLineWidths(lines, WIDTH);
	});

	it("preserves every short normal-buffer row while trimming only trailing filler rows", async () => {
		const lines = await renderOverlay({ output: "alpha\r\n\r\nomega" });

		expect(lines).toHaveLength(7);
		expect(contentRows(lines, "full")).toEqual(["alpha", "", "omega"]);
		expectLineWidths(lines, WIDTH);
	});

	it("clamps long normal output to maxOverlayRows and keeps the visible tail", async () => {
		const lines = await renderOverlay({
			output: ["row-01", "row-02", "row-03", "row-04", "row-05", "row-06"].join("\r\n"),
		});

		expect(lines).toHaveLength(MAX_OVERLAY_ROWS);
		expect(contentRows(lines, "full")).toEqual(["row-03", "row-04", "row-05", "row-06"]);
		expectLineWidths(lines, WIDTH);
	});

	it("keeps alternate-buffer overlays at full content height even for short screens", async () => {
		const lines = await renderOverlay({ output: "\x1b[?1049hALT SCREEN" });

		expect(lines).toHaveLength(MAX_OVERLAY_ROWS);
		expect(contentRows(lines, "full")).toEqual(["ALT SCREEN", "", "", ""]);
		expect(contentRows(lines, "full")).toHaveLength(MAX_CONTENT_ROWS);
		expectLineWidths(lines, WIDTH);
	});
	it("renders running none overlays as header + visible content + footer with a 2-cell gutter and no frame glyphs", async () => {
		const lines = await renderOverlay({
			borderStyle: "none",
			output: "left\r\nright",
		});
		const plain = strip(lines);

		expect(lines).toHaveLength(4);
		expect(contentRows(lines, "none")).toEqual(["left", "right"]);
		for (const line of plain) {
			expect(line.startsWith("  ")).toBe(true);
		}
		expectNoFrameOrTreeGlyphs(lines);
		expectLineWidths(lines, WIDTH);
	});

	it("renders completed none overlays without reintroducing framed chrome for short normal buffers", async () => {
		const lines = await renderOverlay({
			borderStyle: "none",
			output: "done",
			completion: { exitCode: 0, cancelled: false, timedOut: false },
		});
		const plain = strip(lines);

		expect(lines).toHaveLength(3);
		expect(contentRows(lines, "none")).toEqual(["done"]);
		for (const line of plain) {
			expect(line.startsWith("  ")).toBe(true);
		}
		expectNoFrameOrTreeGlyphs(lines);
		expectLineWidths(lines, WIDTH);
	});

	it("renders running accent overlays with tinted padding rows around the header/content/footer chrome", async () => {
		const lines = await renderOverlay({
			borderStyle: "accent",
			output: "left\r\nright",
		});
		const plain = strip(lines);

		expect(lines).toHaveLength(6);
		expect(contentRows(lines, "accent")).toEqual(["left", "right"]);
		expect(plain[0]).toBe(`▌ ${" ".repeat(WIDTH - 2)}`);
		expect(plain.at(-1)).toBe(`▌ ${" ".repeat(WIDTH - 2)}`);
		for (const line of plain) {
			expect(line.startsWith("▌ ")).toBe(true);
		}
		expectNoFrameOrTreeGlyphs(lines);
		expectLineWidths(lines, WIDTH);
	});

	it("uses maxOverlayRows - 4 content rows for alternate-buffer accent overlays", async () => {
		const lines = await renderOverlay({
			borderStyle: "accent",
			output: "\x1b[?1049hALT SCREEN",
		});

		expect(lines).toHaveLength(MAX_OVERLAY_ROWS);
		expect(contentRows(lines, "accent")).toEqual(["ALT SCREEN", "", "", ""]);
		expect(contentRows(lines, "accent")).toHaveLength(MAX_CONTENT_ROWS);
		expectLineWidths(lines, WIDTH);
	});

	it("uses maxOverlayRows - 2 content rows for alternate-buffer none overlays instead of the framed budget", async () => {
		const lines = await renderOverlay({
			borderStyle: "none",
			output: "\x1b[?1049hALT SCREEN",
		});

		expect(lines).toHaveLength(MAX_OVERLAY_ROWS);
		expect(contentRows(lines, "none")).toEqual(["ALT SCREEN", "", "", "", "", ""]);
		expect(contentRows(lines, "none")).toHaveLength(NONE_MAX_CONTENT_ROWS);
		expectLineWidths(lines, WIDTH);
	});

	it("keeps short none normal buffers at content rows plus header/footer exactly", async () => {
		const lines = await renderOverlay({
			borderStyle: "none",
			output: "alpha\r\n\r\nomega",
		});
		const plain = strip(lines);
		const content = contentRows(lines, "none");

		expect(content).toEqual(["alpha", "", "omega"]);
		expect(lines).toHaveLength(content.length + 2);
		for (const line of plain) {
			expect(line.startsWith("  ")).toBe(true);
		}
		expectNoFrameOrTreeGlyphs(lines);
		expectLineWidths(lines, WIDTH);
	});

	it("renders running full overlays with an accent frame, rounded corners, and side rails", async () => {
		const lines = await renderOverlay({ output: "ready" });
		const plain = strip(lines);

		expect(lines[0]!.startsWith(uiTheme.getFgAnsi("accent"))).toBe(true);
		expect(plain[0]!).toBe(
			`${uiTheme.boxRound.topLeft}${uiTheme.boxRound.horizontal.repeat(WIDTH - 2)}${uiTheme.boxRound.topRight}`,
		);
		expect(plain.at(-1)!).toBe(
			`${uiTheme.boxRound.bottomLeft}${uiTheme.boxRound.horizontal.repeat(WIDTH - 2)}${uiTheme.boxRound.bottomRight}`,
		);
		for (const line of plain.slice(1, -1)) {
			expect(line.startsWith(uiTheme.boxRound.vertical)).toBe(true);
			expect(line.endsWith(uiTheme.boxRound.vertical)).toBe(true);
		}
		expectLineWidths(lines, WIDTH);
	});
});
