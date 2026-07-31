import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const fgPaletteAnsi = (index: number) => `\x1b[38;5;${index}m`;
const bgPaletteAnsi = (index: number) => `\x1b[48;5;${index}m`;

const terminalAdaptiveThemes = [
	{
		name: "dark-terminal-adaptive",
		isLight: false,
		accentIndex: 14,
		errorIndex: 9,
		accentContrastIndex: 0,
		errorContrastIndex: 0,
		surfaceIndex: 0,
	},
	{
		name: "light-terminal-adaptive",
		isLight: true,
		accentIndex: 5,
		errorIndex: 1,
		accentContrastIndex: 15,
		errorContrastIndex: 15,
		surfaceIndex: 15,
	},
] as const;

describe("terminal adaptive themes", () => {
	it("loads both themes with palette ANSI and terminal-default tint surfaces", async () => {
		for (const fixture of terminalAdaptiveThemes) {
			const theme = await getThemeByName(fixture.name);
			if (!theme) throw new Error(`Expected built-in theme ${fixture.name} to load`);

			expect(theme.getColorMode()).toBe("256color");
			expect(theme.isLight).toBe(fixture.isLight);
			expect(theme.getFgAnsi("accent")).toBe(fgPaletteAnsi(fixture.accentIndex));
			expect(theme.getFgAnsi("error")).toBe(fgPaletteAnsi(fixture.errorIndex));
			expect(theme.getContrastFgAnsi("accent")).toBe(fgPaletteAnsi(fixture.accentContrastIndex));
			expect(theme.getContrastFgAnsi("error")).toBe(fgPaletteAnsi(fixture.errorContrastIndex));
			expect(theme.getBgAnsi("statusLineBg")).toBe(bgPaletteAnsi(fixture.surfaceIndex));
			expect(theme.getSurfaceTintBgAnsi("borderMuted", 0.06)).toBe("\x1b[49m");
			expect(theme.getSurfaceTintFgAnsi("borderMuted")).toBe(fgPaletteAnsi(8));
		}
	});

	it("keeps fixed-RGB themes on opaque surface tints", async () => {
		const theme = await getThemeByName("dark-catppuccin");
		if (!theme) throw new Error("Expected built-in theme dark-catppuccin to load");

		const accentFg = theme.getFgAnsi("accent");
		expect(theme.getSurfaceTintBgAnsi("accent", 1)).toBe(accentFg.replace("\x1b[38;", "\x1b[48;"));

		const untintedBg = theme.getSurfaceTintBgAnsi("accent", 0);
		expect(untintedBg).not.toBe("\x1b[49m");
		expect(theme.getSurfaceTintFgAnsi("accent", 0)).toBe(untintedBg.replace("\x1b[48;", "\x1b[38;"));
	});
});
