import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../../src/i18n/settings-locale";

const RIGHT = "\x1b[C";
const ESCAPE = "\x1b";
const ENTER = "\n";
const CLEAR_LINE = "\x15";
const CONFIG_SENTINEL = Buffer.from("# local-sync-key selector sentinel\n", "utf8");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

let tempDir: TempDir | undefined;
let previousSettingsUiLocale = getSettingsUiLocale();

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	previousSettingsUiLocale = getSettingsUiLocale();
	setSettingsUiLocale("en");
	resetSettingsForTest();
	tempDir = TempDir.createSync("@pi-settings-selector-local-sync-key-");

	await fs.mkdir(activeAgentDir(), { recursive: true });
	await fs.writeFile(configPath(), CONFIG_SENTINEL);
	// A distinct temp dir makes a legacy global-directory lookup safe and observable.
	setAgentDir(globalAgentDirDecoy());
	await Settings.init({ agentDir: activeAgentDir(), cwd: activeAgentDir() });
});

afterEach(() => {
	resetSettingsForTest();
	restoreAgentDir();
	setSettingsUiLocale(previousSettingsUiLocale);
	tempDir?.removeSync();
	tempDir = undefined;
});

function activeAgentDir(): string {
	if (!tempDir) throw new Error("Missing temporary active agent directory");
	return tempDir.join("active-agent-dir");
}

function globalAgentDirDecoy(): string {
	if (!tempDir) throw new Error("Missing temporary global agent directory");
	return tempDir.join("global-agent-dir-decoy");
}

function configPath(): string {
	return path.join(activeAgentDir(), "config.yml");
}

function restoreAgentDir(): void {
	if (originalAgentDir !== undefined) {
		setAgentDir(originalAgentDir);
		return;
	}
	setAgentDir(fallbackAgentDir);
	delete process.env.PI_CODING_AGENT_DIR;
}

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			cwd: activeAgentDir(),
		},
		{
			onChange: () => {},
			onCancel: () => {},
		},
	);
}

function renderText(component: SettingsSelectorComponent): string {
	return Bun.stripANSI(component.render(120).join("\n"));
}

function focusSyncTab(component: SettingsSelectorComponent): void {
	for (let attempts = 0; attempts < 11; attempts++) {
		if (renderText(component).includes("Local Encryption Key")) return;
		component.handleInput(RIGHT);
	}
	throw new Error("Settings selector did not expose the Sync tab");
}

function openLocalEncryptionKeyEditor(component: SettingsSelectorComponent): void {
	focusSyncTab(component);
	for (const character of "local encryption key") component.handleInput(character);
	expect(renderText(component)).toContain("Local Encryption Key");

	// Escape leaves global search on its selected result in the Sync tab.
	component.handleInput(ESCAPE);
	expect(renderText(component)).toContain("Local Encryption Key");
	component.handleInput(ENTER);

	const editor = renderText(component);
	expect(editor).toContain("Local Encryption Key");
	expect(editor).toContain("Clear field to unset");
}

describe("SettingsSelectorComponent local sync encryption key", () => {
	it("writes and clears the key in Settings' active agent directory without rewriting config.yml", async () => {
		const component = createSelector();
		const localKey = "device-local-encryption-key";
		const localKeyPath = path.join(activeAgentDir(), "sync-passphrase");
		const decoyKeyPath = path.join(globalAgentDirDecoy(), "sync-passphrase");

		openLocalEncryptionKeyEditor(component);
		for (const character of localKey) component.handleInput(character);
		component.handleInput(ENTER);

		expect(await fs.readFile(localKeyPath, "utf8")).toBe(localKey);
		expect(await Bun.file(decoyKeyPath).exists()).toBe(false);
		if (process.platform !== "win32") {
			expect((await fs.stat(localKeyPath)).mode & 0o777).toBe(0o600);
		}

		openLocalEncryptionKeyEditor(component);
		component.handleInput(CLEAR_LINE);
		component.handleInput(ENTER);

		expect(await Bun.file(localKeyPath).exists()).toBe(false);
		expect(await fs.readFile(configPath())).toEqual(CONFIG_SENTINEL);
	});
});
