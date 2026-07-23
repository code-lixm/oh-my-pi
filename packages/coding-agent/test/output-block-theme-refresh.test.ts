import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	theme as activeTheme,
	getThemeByName,
	initTheme,
	setThemeInstance,
	type Theme,
	type ThemeColor,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { CachedOutputBlock, framedBlock, type OutputBlockOptions } from "@oh-my-pi/pi-coding-agent/tui/output-block";

/**
 * Regression teeth:
 * - Dropping `h.u32(getThemeEpoch())` from CachedOutputBlock.#buildKey breaks the
 *   epoch-only invalidation case.
 * - Dropping `this.#theme === theme` from CachedOutputBlock.render breaks the
 *   dark→light identity-swap case.
 * - Reverting `block.render(build(width), followsActiveTheme ? activeTheme : theme)`
 *   to `block.render(build(width), theme)` in framedBlock breaks the active-theme case.
 */

const WIDTH = 72;

let darkTheme: Theme;
let lightTheme: Theme;

function surfaceTintBg(theme: Theme, color: ThemeColor): string {
	const ansi = theme.getSurfaceTintBgAnsi(color, 0.06);
	expect(ansi).toMatch(/\x1b\[48;/);
	return ansi;
}

function buildOptions(width: number): OutputBlockOptions {
	return {
		header: "Tool",
		state: "success",
		applyBg: true,
		sections: [{ lines: ["done"] }],
		width,
	};
}

function join(lines: readonly string[]): string {
	return lines.join("\n");
}

describe("output-block theme refresh", () => {
	beforeAll(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("Expected dark theme");
		const light = await getThemeByName("light");
		if (!light) throw new Error("Expected light theme");
		darkTheme = dark;
		lightTheme = light;
	});

	afterEach(() => {
		setThemeInstance(darkTheme);
	});

	it("reuses the cached array while options and theme stay unchanged", () => {
		const options = buildOptions(WIDTH);
		const block = new CachedOutputBlock();

		const first = block.render(options, darkTheme);
		const second = block.render(options, darkTheme);

		expect(second).toBe(first);
	});

	it("invalidates CachedOutputBlock when only the theme epoch changes", () => {
		setThemeInstance(darkTheme);
		const darkBg = surfaceTintBg(darkTheme, "borderMuted");
		const options = buildOptions(WIDTH);
		const block = new CachedOutputBlock();

		const first = block.render(options, activeTheme);
		setThemeInstance(darkTheme);
		const second = block.render(options, activeTheme);

		expect(second).not.toBe(first);
		expect(join(second)).toContain(darkBg);
	});

	it("rebuilds CachedOutputBlock from dark ANSI to light ANSI with a new array", () => {
		const darkBg = surfaceTintBg(darkTheme, "borderMuted");
		const lightBg = surfaceTintBg(lightTheme, "borderMuted");
		const options = buildOptions(WIDTH);
		const block = new CachedOutputBlock();

		const first = block.render(options, darkTheme);
		const firstText = join(first);
		expect(firstText).toContain(darkBg);
		expect(firstText).not.toContain(lightBg);

		const second = block.render(options, lightTheme);
		const secondText = join(second);

		expect(second).not.toBe(first);
		expect(secondText).toContain(lightBg);
		expect(secondText).not.toContain(darkBg);
	});

	it("makes framedBlock follow the replaced active theme with a new array", () => {
		setThemeInstance(darkTheme);
		const darkBg = surfaceTintBg(darkTheme, "borderMuted");
		const lightBg = surfaceTintBg(lightTheme, "borderMuted");
		const component = framedBlock(darkTheme, width => buildOptions(width));

		const first = component.render(WIDTH);
		const firstText = join(first);
		expect(firstText).toContain(darkBg);
		expect(firstText).not.toContain(lightBg);

		setThemeInstance(lightTheme);
		const second = component.render(WIDTH);
		const secondText = join(second);

		expect(second).not.toBe(first);
		expect(secondText).toContain(lightBg);
		expect(secondText).not.toContain(darkBg);
	});
});
