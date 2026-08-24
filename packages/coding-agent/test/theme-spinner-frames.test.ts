import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	SPINNER_GLYPH_ADVANCE_MS,
	sharedSpinnerFrame,
} from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getConfigRootDir, getCustomThemesDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

// Path of the built-in dark theme JSON, used as a known-valid base we can
// extend with custom `symbols.spinnerFrames` shapes.
const DARK_THEME_PATH = path.join(import.meta.dir, "..", "src", "modes", "theme", "dark.json");

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const ACTIVITY_CORNER_FRAMES = ["▖", "▘", "▝", "▗"];
const UNICODE_STATUS_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const NERD_STATUS_FRAMES = ["󱑖", "󱑋", "󱑌", "󱑍", "󱑎", "󱑏", "󱑐", "󱑑", "󱑒", "󱑓", "󱑔", "󱑕"];
const ASCII_STATUS_FRAMES = ["|", "/", "-", "\\"];
const ASCII_ACTIVITY_FRAMES = ["-", "\\", "|", "/"];

let tmpAgentDir: string;

async function writeCustomTheme(name: string, extraSymbols: Record<string, unknown>): Promise<void> {
	const dark = (await Bun.file(DARK_THEME_PATH).json()) as Record<string, unknown>;
	const base = (dark.symbols ?? {}) as Record<string, unknown>;
	const themeJson = {
		...dark,
		name,
		symbols: { ...base, ...extraSymbols },
	};
	const themesDir = getCustomThemesDir();
	await fs.mkdir(themesDir, { recursive: true });
	await Bun.write(path.join(themesDir, `${name}.json`), JSON.stringify(themeJson, null, 2));
}

describe("theme symbols.spinnerFrames", () => {
	beforeEach(async () => {
		tmpAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spinner-frames-"));
		setAgentDir(tmpAgentDir);
	});

	afterEach(async () => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await removeWithRetries(tmpAgentDir);
	});

	it("flat-array override applies to both status and activity spinners", async () => {
		const frames = ["◐", "◓", "◑", "◒"];
		await writeCustomTheme("custom-flat", { spinnerFrames: frames });

		const theme = await getThemeByName("custom-flat");
		expect(theme).toBeDefined();
		expect(theme!.getSpinnerFrames("status")).toEqual(frames);
		expect(theme!.getSpinnerFrames("activity")).toEqual(frames);
		// Default getter is the status spinner.
		expect(theme!.spinnerFrames).toEqual(frames);
	});

	it("object status override wins while unoverridden activity falls back to Unicode corners", async () => {
		const statusFrames = ["A", "B", "C"];
		await writeCustomTheme("custom-status-only", { spinnerFrames: { status: statusFrames } });

		const theme = await getThemeByName("custom-status-only");
		expect(theme).toBeDefined();
		expect(theme!.getSpinnerFrames("status")).toEqual(statusFrames);
		expect(theme!.getSpinnerFrames("activity")).toEqual(ACTIVITY_CORNER_FRAMES);
	});

	it("rejects empty arrays and empty objects at validation time", async () => {
		await writeCustomTheme("custom-empty-array", { spinnerFrames: [] });
		await expect(getThemeByName("custom-empty-array")).resolves.toBeUndefined();

		await writeCustomTheme("custom-empty-object", { spinnerFrames: {} });
		await expect(getThemeByName("custom-empty-object")).resolves.toBeUndefined();
	});

	it("uses preset activity fallbacks without changing status or ASCII frames", async () => {
		const presets = [
			{
				name: "unicode",
				preset: "unicode",
				statusFrames: UNICODE_STATUS_FRAMES,
				activityFrames: ACTIVITY_CORNER_FRAMES,
			},
			{ name: "nerd", preset: "nerd", statusFrames: NERD_STATUS_FRAMES, activityFrames: ACTIVITY_CORNER_FRAMES },
			{ name: "ascii", preset: "ascii", statusFrames: ASCII_STATUS_FRAMES, activityFrames: ASCII_ACTIVITY_FRAMES },
		] as const;

		for (const { name, preset, statusFrames, activityFrames } of presets) {
			await writeCustomTheme(`custom-${name}-preset`, { preset });

			const theme = await getThemeByName(`custom-${name}-preset`);
			expect(theme).toBeDefined();
			expect(theme!.getSpinnerFrames("status")).toEqual(statusFrames);
			expect(theme!.getSpinnerFrames("activity")).toEqual(activityFrames);
		}
	});

	it("derives live tool spinner frames from a shared clock", () => {
		const frameCount = 4;
		const now = SPINNER_GLYPH_ADVANCE_MS * 3 + 12;

		expect(sharedSpinnerFrame(frameCount, now)).toBe(sharedSpinnerFrame(frameCount, now));
		expect(sharedSpinnerFrame(frameCount, now + SPINNER_GLYPH_ADVANCE_MS)).toBe(
			(sharedSpinnerFrame(frameCount, now) + 1) % frameCount,
		);
		expect(sharedSpinnerFrame(frameCount, SPINNER_GLYPH_ADVANCE_MS * frameCount)).toBe(0);
		expect(sharedSpinnerFrame(0, now)).toBe(0);
	});
});
