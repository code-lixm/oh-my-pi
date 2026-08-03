import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getAgentDir, getCustomThemesDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const DARK_THEME_PATH = path.join(import.meta.dir, "..", "src", "modes", "theme", "dark.json");

const NERD_THEME_NAME = "nerd-symbols";
const POIMANDRES_THEME_NAMES = ["dark-poimandres", "light-poimandres"] as const;
const HUD_NERD_ICON_KEYS = [
	"icon.model",
	"icon.folder",
	"icon.scratchFolder",
	"icon.plan",
	"icon.goal",
	"icon.pause",
	"icon.loop",
	"icon.pi",
] as const;
const NERD_PUA_GLYPH = /^[\ue000-\uf8ff]$/u;

let tempAgentDir: string | undefined;
let originalAgentDir = "";
let originalAgentDirEnv: string | undefined;

let nerdPresetTheme: Theme;

async function getRequiredTheme(name: string): Promise<Theme> {
	const theme = await getThemeByName(name);
	if (theme === undefined) throw new Error(`Expected theme "${name}" to load`);
	return theme;
}

beforeEach(async () => {
	originalAgentDir = getAgentDir();
	originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-nerd-symbols-"));
	setAgentDir(tempAgentDir);

	const dark = await Bun.file(DARK_THEME_PATH).json();
	await Bun.write(
		path.join(getCustomThemesDir(), `${NERD_THEME_NAME}.json`),
		JSON.stringify({ ...dark, name: NERD_THEME_NAME, symbols: { preset: "nerd" } }),
	);
	nerdPresetTheme = await getRequiredTheme(NERD_THEME_NAME);
});

afterEach(async () => {
	if (tempAgentDir === undefined) return;
	setAgentDir(originalAgentDir);
	if (originalAgentDirEnv === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
	}
	await removeWithRetries(tempAgentDir);
	tempAgentDir = undefined;
});

it("uses the Nerd Fonts v3 Material Design session icon", () => {
	expect(nerdPresetTheme.symbol("icon.session")).toBe("\u{f0051}");
});

for (const themeName of POIMANDRES_THEME_NAMES) {
	it(`${themeName} resolves HUD icons from the Nerd preset`, async () => {
		const poimandresTheme = await getRequiredTheme(themeName);
		for (const iconKey of HUD_NERD_ICON_KEYS) {
			const nerdGlyph = nerdPresetTheme.symbol(iconKey);
			expect(nerdGlyph).toMatch(NERD_PUA_GLYPH);
			expect(poimandresTheme.symbol(iconKey)).toBe(nerdGlyph);
		}
	});

	it(`${themeName} does not mix geometric model and folder icons into the Nerd HUD`, async () => {
		const poimandresTheme = await getRequiredTheme(themeName);
		expect(poimandresTheme.symbol("icon.model")).not.toBe("◇");
		expect(poimandresTheme.symbol("icon.folder")).not.toBe("▸");
	});
}
