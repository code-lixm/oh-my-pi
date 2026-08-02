import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { defaultThemes } from "@oh-my-pi/pi-coding-agent/modes/theme/defaults";
import {
	getCurrentThemeName,
	getThemeByName,
	initTheme,
	onTerminalAppearanceChange,
	stopThemeWatcher,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getAgentDir, getCustomThemesDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

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

	it("keeps a normal custom theme on its text fallback when a palette-index fill is loaded", async () => {
		const previousAgentDir = getAgentDir();
		const previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		const tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-theme-contrast-"));
		const customThemeName = "normal-palette-fill-fallback";

		try {
			setAgentDir(tempAgentDir);
			await fs.mkdir(getCustomThemesDir(), { recursive: true });
			await Bun.write(
				path.join(getCustomThemesDir(), `${customThemeName}.json`),
				JSON.stringify({
					...defaultThemes.porcelain,
					name: customThemeName,
					colors: {
						...defaultThemes.porcelain.colors,
						accent: 15,
						text: "#ff00ff",
					},
				}),
			);

			const theme = await getThemeByName(customThemeName);
			if (!theme) throw new Error(`Expected custom theme ${customThemeName} to load`);

			const expectedTextFallback = theme.getFgAnsi("text");
			expect(theme.getFgAnsi("accent")).toBe(fgPaletteAnsi(15));
			expect(expectedTextFallback).not.toBe(fgPaletteAnsi(0));
			expect(expectedTextFallback).not.toBe(fgPaletteAnsi(15));
			expect(theme.getContrastFgAnsi("accent")).toBe(expectedTextFallback);
		} finally {
			setAgentDir(previousAgentDir);
			if (previousAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv;
			await removeWithRetries(tempAgentDir);
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

	describe("terminal palette setting", () => {
		const configuredThemes = {
			dark: "dark-catppuccin",
			light: "light-catppuccin",
		} as const;

		async function settleAutoTheme(): Promise<void> {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		}

		beforeEach(() => {
			resetSettingsForTest();
			stopThemeWatcher();
		});

		afterEach(async () => {
			resetSettingsForTest();
			stopThemeWatcher();
			await initTheme(false, undefined, undefined, "dark", "light");
		});

		it("switches effective themes without replacing the configured dark and light selections", async () => {
			const settings = await Settings.init({
				inMemory: true,
				overrides: {
					"theme.dark": configuredThemes.dark,
					"theme.light": configuredThemes.light,
				},
			});

			onTerminalAppearanceChange("dark");
			await initTheme(false, undefined, undefined, settings.get("theme.dark"), settings.get("theme.light"));
			expect(getCurrentThemeName()).toBe(configuredThemes.dark);

			settings.set("theme.terminalPalette", true);
			await settleAutoTheme();
			expect(getCurrentThemeName()).toBe("dark-terminal-adaptive");
			expect([settings.get("theme.dark"), settings.get("theme.light")]).toEqual([
				configuredThemes.dark,
				configuredThemes.light,
			]);

			onTerminalAppearanceChange("light");
			await settleAutoTheme();
			expect(getCurrentThemeName()).toBe("light-terminal-adaptive");

			settings.set("theme.terminalPalette", false);
			await settleAutoTheme();
			expect(getCurrentThemeName()).toBe(configuredThemes.light);

			onTerminalAppearanceChange("dark");
			await settleAutoTheme();
			expect(getCurrentThemeName()).toBe(configuredThemes.dark);
			expect([settings.get("theme.dark"), settings.get("theme.light")]).toEqual([
				configuredThemes.dark,
				configuredThemes.light,
			]);
		});
	});
});
