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

type BorderStyle = "full" | "horizontal";

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

function contentRows(lines: readonly string[], borderStyle: BorderStyle): string[] {
	return strip(lines)
		.slice(2, -2)
		.map(line => {
			const inner = borderStyle === "horizontal" ? line : line.slice(1, -1);
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

	it("renders horizontal overlays with only horizontal bars, equal widths, and no vertical or rounded glyphs", async () => {
		const lines = await renderOverlay({
			borderStyle: "horizontal",
			output: "left\r\nright",
			completion: { exitCode: 0, cancelled: false, timedOut: false },
		});
		const plain = strip(lines);
		const text = plain.join("\n");

		expect(plain[0]!).toBe(uiTheme.boxRound.horizontal.repeat(WIDTH));
		expect(plain.at(-1)!).toBe(uiTheme.boxRound.horizontal.repeat(WIDTH));
		expect(contentRows(lines, "horizontal")).toEqual(["left", "right"]);
		expect(text.includes(uiTheme.boxRound.vertical)).toBe(false);
		expect(text.includes(uiTheme.boxRound.topLeft)).toBe(false);
		expect(text.includes(uiTheme.boxRound.topRight)).toBe(false);
		expect(text.includes(uiTheme.boxRound.bottomLeft)).toBe(false);
		expect(text.includes(uiTheme.boxRound.bottomRight)).toBe(false);
		expectLineWidths(lines, WIDTH);
	});
});
