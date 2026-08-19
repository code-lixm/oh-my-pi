import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KEYBINDINGS, type Keybinding, KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import {
	buildRpcKeybindingsCatalog,
	resetRpcKeybindings,
	updateRpcKeybinding,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-keybindings";
import {
	buildRpcSettingsCatalog,
	buildRpcSettingsSnapshot,
	updateRpcSetting,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-settings";
import { matchesAppFollowUp } from "@oh-my-pi/pi-coding-agent/modes/utils/keybinding-matchers";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { type KeybindingsConfig, setKeybindings } from "@oh-my-pi/pi-tui";
import {
	__resetDirsFromEnvForTests,
	getAgentDir,
	getProfileRootDir,
	removeWithRetries,
	setProfile,
} from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

function ctrl(key: string): string {
	return String.fromCharCode(key.toLowerCase().charCodeAt(0) & 31);
}

async function writeKeybindingsYaml(agentDir: string, config: KeybindingsConfig): Promise<void> {
	await fs.mkdir(agentDir, { recursive: true });
	await Bun.write(path.join(agentDir, "keybindings.yml"), YAML.stringify(config, null, 2));
}

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}
describe("KeybindingsManager.create", () => {
	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	it("migrates legacy keybinding JSON to YAML during create", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));
		const jsonPath = path.join(agentDir, "keybindings.json");
		const ymlPath = path.join(agentDir, "keybindings.yml");

		await Bun.write(
			jsonPath,
			`${JSON.stringify(
				{
					fork: "ctrl+f",
					selectConfirm: "enter",
					cursorUp: "ctrl+p",
					selectModelTemporary: "alt+y",
				},
				null,
				2,
			)}\n`,
		);

		try {
			const manager = KeybindingsManager.create(agentDir);
			const writtenConfig = YAML.parse(await Bun.file(ymlPath).text());

			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(manager.getKeys("tui.select.confirm")).toEqual(["enter"]);
			expect(manager.getKeys("tui.editor.cursorUp")).toEqual(["ctrl+p"]);
			expect(manager.getKeys("app.model.selectTemporary")).toEqual(["alt+y"]);
			expect(writtenConfig).toEqual({
				"app.model.selectTemporary": "alt+y",
				"app.session.fork": "ctrl+f",
				"tui.editor.cursorUp": "ctrl+p",
				"tui.select.confirm": "enter",
			});
			expect(writtenConfig).not.toHaveProperty("selectModelTemporary");
			expect(await Bun.file(jsonPath).exists()).toBe(true);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("migrates legacy keybinding JSON with comments to YAML during create", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));
		const jsonPath = path.join(agentDir, "keybindings.json");
		const ymlPath = path.join(agentDir, "keybindings.yml");

		await Bun.write(
			jsonPath,
			`{
	// Legacy config files may contain comments from hand-edited examples.
	"fork": "ctrl+f",
	"selectConfirm": "enter",
	"cursorUp": "ctrl+p",
	"app.clipboard.copyPrompt": ["alt+c", "ctrl+shift+c"]
}
`,
		);

		try {
			const manager = KeybindingsManager.create(agentDir);
			const writtenConfig = YAML.parse(await Bun.file(ymlPath).text());

			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(manager.getKeys("tui.select.confirm")).toEqual(["enter"]);
			expect(manager.getKeys("tui.editor.cursorUp")).toEqual(["ctrl+p"]);
			expect(manager.getKeys("app.clipboard.copyPrompt")).toEqual(["alt+c", "ctrl+shift+c"]);
			expect(writtenConfig).toEqual({
				"app.clipboard.copyPrompt": ["alt+c", "ctrl+shift+c"],
				"app.session.fork": "ctrl+f",
				"tui.editor.cursorUp": "ctrl+p",
				"tui.select.confirm": "enter",
			});
			expect(await Bun.file(jsonPath).exists()).toBe(true);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("loads keybindings.yml directly", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));
		const configPath = path.join(agentDir, "keybindings.yml");

		await Bun.write(
			configPath,
			YAML.stringify(
				{
					"app.session.fork": "ctrl+f",
					"app.clipboard.copyPrompt": ["alt+c", "ctrl+shift+c"],
				},
				null,
				2,
			),
		);

		try {
			const manager = KeybindingsManager.create(agentDir);

			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(manager.getKeys("app.clipboard.copyPrompt")).toEqual(["alt+c", "ctrl+shift+c"]);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("accepts keybindings.yaml when present", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));
		const yamlPath = path.join(agentDir, "keybindings.yaml");
		const canonicalPath = path.join(agentDir, "keybindings.yml");

		await Bun.write(
			yamlPath,
			YAML.stringify(
				{
					"app.plan.toggle": "alt+shift+p",
				},
				null,
				2,
			),
		);

		try {
			const manager = KeybindingsManager.create(agentDir);

			expect(manager.getKeys("app.plan.toggle")).toEqual(["alt+shift+p"]);
			expect(await Bun.file(canonicalPath).exists()).toBe(false);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("inherits default user keybindings for a named profile without a profile keybindings file (#4867)", async () => {
		const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-profile-"));
		const defaultAgentDir = path.join(rootDir, "default", "agent");
		const profileAgentDir = path.join(rootDir, "profiles", "work", "agent");

		await writeKeybindingsYaml(defaultAgentDir, {
			"app.session.fork": "ctrl+f",
			"tui.editor.deleteCharBackward": ["backspace", "ctrl+h"],
		});

		try {
			const manager = KeybindingsManager.create(profileAgentDir, {
				inheritedAgentDir: defaultAgentDir,
			});

			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(manager.getKeys("tui.editor.deleteCharBackward")).toEqual(["backspace", "ctrl+h"]);
		} finally {
			await removeWithRetries(rootDir);
		}
	});

	it("merges default user keybindings with profile overrides for a named profile (#4867)", async () => {
		const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-profile-"));
		const defaultAgentDir = path.join(rootDir, "default", "agent");
		const profileAgentDir = path.join(rootDir, "profiles", "work", "agent");

		await writeKeybindingsYaml(defaultAgentDir, {
			"app.session.fork": "ctrl+f",
			"app.session.new": "ctrl+n",
		});
		await writeKeybindingsYaml(profileAgentDir, {
			"app.session.fork": "alt+f",
			"app.clipboard.copyLine": "alt+l",
		});

		try {
			const manager = KeybindingsManager.create(profileAgentDir, {
				inheritedAgentDir: defaultAgentDir,
			});

			expect(manager.getKeys("app.session.new")).toEqual(["ctrl+n"]);
			expect(manager.getKeys("app.session.fork")).toEqual(["alt+f"]);
			expect(manager.getKeys("app.clipboard.copyLine")).toEqual(["alt+l"]);
		} finally {
			await removeWithRetries(rootDir);
		}
	});

	it("never writes migration output into the inherited default agent dir (#4867)", async () => {
		const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-profile-"));
		const defaultAgentDir = path.join(rootDir, "default", "agent");
		const profileAgentDir = path.join(rootDir, "profiles", "work", "agent");

		// Legacy JSON in the default dir: loading it with a write-back path would
		// materialize keybindings.yml there. The inherited load must stay read-only.
		await fs.mkdir(defaultAgentDir, { recursive: true });
		await Bun.write(
			path.join(defaultAgentDir, "keybindings.json"),
			JSON.stringify({ "app.session.fork": "ctrl+f" }, null, 2),
		);

		try {
			const manager = KeybindingsManager.create(profileAgentDir, {
				inheritedAgentDir: defaultAgentDir,
			});

			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(await Bun.file(path.join(defaultAgentDir, "keybindings.yml")).exists()).toBe(false);
		} finally {
			await removeWithRetries(rootDir);
		}
	});

	it("merges default user keybindings when create uses the active profile with no arguments (#4867)", async () => {
		const originalConfigDir = process.env.PI_CONFIG_DIR;
		const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		const originalOmpProfile = process.env.OMP_PROFILE;
		const originalPiProfile = process.env.PI_PROFILE;
		const configRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-active-profile-"));

		try {
			process.env.PI_CONFIG_DIR = path.relative(os.homedir(), configRootDir);
			restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDirEnv);
			restoreEnvValue("OMP_PROFILE", originalOmpProfile);
			restoreEnvValue("PI_PROFILE", originalPiProfile);
			__resetDirsFromEnvForTests();

			const defaultAgentDir = path.join(getProfileRootDir(undefined), "agent");
			const profileAgentDir = path.join(getProfileRootDir("work"), "agent");
			await writeKeybindingsYaml(defaultAgentDir, {
				"app.session.fork": "ctrl+f",
				"app.session.new": "ctrl+n",
			});
			await writeKeybindingsYaml(profileAgentDir, {
				"app.session.fork": "alt+f",
				"app.clipboard.copyLine": "alt+l",
			});

			setProfile("work");

			expect(getAgentDir()).toBe(profileAgentDir);
			const manager = KeybindingsManager.create();

			expect(manager.getKeys("app.session.new")).toEqual(["ctrl+n"]);
			expect(manager.getKeys("app.session.fork")).toEqual(["alt+f"]);
			expect(manager.getKeys("app.clipboard.copyLine")).toEqual(["alt+l"]);
		} finally {
			restoreEnvValue("PI_CONFIG_DIR", originalConfigDir);
			restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDirEnv);
			restoreEnvValue("OMP_PROFILE", originalOmpProfile);
			restoreEnvValue("PI_PROFILE", originalPiProfile);
			__resetDirsFromEnvForTests();
			await removeWithRetries(configRootDir);
		}
	});

	it("defaults model selection to Alt+M, display reset to Alt+L, live toggle to Ctrl+L, and send-to-new-session to Alt+N", () => {
		const manager = KeybindingsManager.inMemory();

		expect(manager.getKeys("app.model.select")).toEqual(["alt+m"]);
		expect(manager.getKeys("app.display.reset")).toEqual(["alt+l"]);
		expect(manager.getKeys("app.live.toggle")).toEqual(["ctrl+l"]);
		expect(manager.getKeys("app.session.sendToNew")).toEqual(["alt+n"]);
	});

	it("keeps the Ctrl+L live toggle default when an old model remap still claims Ctrl+L", () => {
		const manager = KeybindingsManager.inMemory({
			"app.model.select": "ctrl+l",
		});

		expect(manager.getKeys("app.model.select")).toEqual(["ctrl+l"]);
		expect(manager.getKeys("app.live.toggle")).toEqual(["ctrl+l"]);
		expect(manager.getEffectiveConfig()["app.live.toggle"]).toBe("ctrl+l");
	});

	it("keeps Ctrl+L when the user explicitly assigns it to display reset", () => {
		const manager = KeybindingsManager.inMemory({
			"app.display.reset": "ctrl+l",
		});

		expect(manager.getKeys("app.display.reset")).toEqual(["ctrl+l"]);
	});

	it("defaults the follow-up shortcut to both Ctrl+Q and Ctrl+Enter (#1903)", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));

		try {
			const manager = KeybindingsManager.create(agentDir);

			// Both chords must be registered so Windows Terminal users (which swallow
			// Ctrl+Enter at the terminal layer) get a working follow-up binding out
			// of the box, without breaking users on Kitty/iTerm2/WezTerm/Ghostty.
			expect(manager.getKeys("app.message.followUp")).toEqual(["ctrl+q", "ctrl+enter"]);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("removes the Ctrl+Q follow-up default when a user remap already claims it (#1903)", () => {
		const manager = KeybindingsManager.inMemory({
			"app.plan.toggle": "ctrl+q",
		});
		setKeybindings(manager);

		expect(manager.getKeys("app.plan.toggle")).toEqual(["ctrl+q"]);
		expect(manager.getKeys("app.message.followUp")).toEqual(["ctrl+enter"]);
		expect(manager.getDisplayString("app.message.followUp")).toBe("Ctrl+Enter");
		expect(manager.getEffectiveConfig()["app.message.followUp"]).toBe("ctrl+enter");
		expect(matchesAppFollowUp(ctrl("q"))).toBe(false);
		expect(matchesAppFollowUp("\x1b[13;5u")).toBe(true);
	});

	it("keeps the Ctrl+Q follow-up default when only an unknown config key claims it (#1903)", () => {
		const manager = KeybindingsManager.inMemory({
			"unknown.action": "ctrl+q",
		});

		expect(manager.getKeys("app.message.followUp")).toEqual(["ctrl+q", "ctrl+enter"]);
	});

	it("keeps Ctrl+Q when the user explicitly assigns it to follow-up (#1903)", () => {
		const manager = KeybindingsManager.inMemory({
			"app.message.followUp": "ctrl+q",
		});

		expect(manager.getKeys("app.message.followUp")).toEqual(["ctrl+q"]);
	});
});

describe("RPC keybinding contracts", () => {
	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	it("exposes every OMP binding with its UI group and current effective default", () => {
		const catalog = buildRpcKeybindingsCatalog();
		const defaults = KeybindingsManager.inMemory();

		expect(catalog.keybindings.map(keybinding => keybinding.id)).toEqual(Object.keys(KEYBINDINGS));
		expect(catalog.groups.map(group => group.id)).toEqual(["application", "editor", "input", "selection"]);

		for (const id of Object.keys(KEYBINDINGS) as Keybinding[]) {
			const keybinding = catalog.keybindings.find(candidate => candidate.id === id);
			if (!keybinding) throw new Error(`Catalog omitted registered keybinding: ${id}`);

			expect(keybinding.defaultKeys).toEqual(defaults.getKeys(id));
		}

		for (const [id, group] of [
			["app.model.select", "application"],
			["tui.editor.cursorUp", "editor"],
			["tui.input.submit", "input"],
			["tui.select.confirm", "selection"],
		] as const) {
			const keybinding = catalog.keybindings.find(candidate => candidate.id === id);
			if (!keybinding) throw new Error(`Catalog omitted registered keybinding: ${id}`);

			expect(keybinding.group).toBe(group);
		}
	});

	it("persists one RPC override and resets it to the effective default", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-keybindings-"));
		const keybindingsPath = path.join(agentDir, "keybindings.yml");

		try {
			const manager = KeybindingsManager.create(agentDir);
			const defaultKeys = manager.getKeys("app.model.select");
			const updated = updateRpcKeybinding(manager, "app.model.select", ["ctrl+shift+m"]);

			expect(updated.configured).toEqual(["app.model.select"]);
			expect(updated.values["app.model.select"]).toEqual(["ctrl+shift+m"]);
			expect(YAML.parse(await Bun.file(keybindingsPath).text())).toEqual({
				"app.model.select": "ctrl+shift+m",
			});

			const reset = resetRpcKeybindings(manager);

			expect(reset.configured).toEqual([]);
			expect(reset.values["app.model.select"]).toEqual(defaultKeys);
			expect(YAML.parse(await Bun.file(keybindingsPath).text())).toEqual({});
		} finally {
			await removeWithRetries(agentDir);
		}
	});
});

describe("RPC settings catalog", () => {
	it("maps the configured light and dark selections to complete hex palettes", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-settings-"));
		const selectedThemes = {
			light: "light-catppuccin",
			dark: "dark-poimandres",
		} as const;

		try {
			await Bun.write(
				path.join(agentDir, "config.yml"),
				YAML.stringify({ theme: { ...selectedThemes, terminalPalette: true } }, null, 2),
			);
			const settings = await Settings.loadReadOnly({ agentDir, cwd: agentDir });
			const catalog = await buildRpcSettingsCatalog(settings);

			expect(catalog.theme.light.id).toBe(selectedThemes.light);
			expect(catalog.theme.dark.id).toBe(selectedThemes.dark);

			for (const palette of [catalog.theme.light, catalog.theme.dark]) {
				for (const color of [
					palette.neutral,
					palette.ink,
					palette.primary,
					palette.success,
					palette.warning,
					palette.error,
					palette.info,
					palette.interactive,
					palette.diffAdd,
					palette.diffDelete,
				]) {
					expect(color).toMatch(/^#[0-9a-f]{6}$/i);
				}
			}
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("covers every schema path once while retaining native and advanced catalog metadata", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-settings-catalog-"));

		try {
			const catalog = await buildRpcSettingsCatalog(await Settings.loadReadOnly({ agentDir, cwd: agentDir }));

			expect(catalog.settings.map(setting => setting.path).sort()).toEqual(Object.keys(SETTINGS_SCHEMA).sort());
			expect(catalog.tabs.map(tab => tab.id)).toContain("advanced");

			const extensions = catalog.settings.find(setting => setting.path === "extensions");
			if (!extensions) throw new Error("Settings catalog omitted extensions");
			expect(extensions.tab).toBe("advanced");
			expect(extensions.editor).toBe("json");

			const darkTheme = catalog.settings.find(setting => setting.path === "theme.dark");
			if (!darkTheme) throw new Error("Settings catalog omitted theme.dark");
			expect(darkTheme.tab).toBe("appearance");
			expect(darkTheme.editor).toBe("select");

			const authBrokerToken = catalog.settings.find(setting => setting.path === "auth.broker.token");
			if (!authBrokerToken) throw new Error("Settings catalog omitted auth.broker.token");
			expect(authBrokerToken.tab).toBe("advanced");
			expect(authBrokerToken.editor).toBe("secret");
			expect(authBrokerToken.credential).toBe(true);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("exposes valid shared and CLI scopes for representative canonical settings", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-settings-scope-"));

		try {
			const settings = await Settings.loadReadOnly({ agentDir, cwd: agentDir });
			const catalog = await buildRpcSettingsCatalog(settings);
			const byPath = new Map(catalog.settings.map(setting => [setting.path, setting]));

			for (const item of catalog.settings) {
				expect(["shared", "cli"]).toContain(item.scope);
			}

			for (const [settingPath, scope] of [
				["theme.light", "shared"],
				["theme.dark", "shared"],
				["defaultThinkingLevel", "shared"],
				["task.maxRuntimeMs", "shared"],
				["display.borderStyle", "cli"],
				["thinkingDisplay", "cli"],
				["stt.enabled", "cli"],
			] as const) {
				const item = byPath.get(settingPath);
				if (!item) throw new Error(`Settings catalog omitted ${settingPath}`);
				expect(item.scope).toBe(scope);
			}
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("persists an advanced extension update while redacting an advanced credential", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-settings-update-"));
		const configPath = path.join(agentDir, "config.yml");
		const extensions = ["./test-extension.ts"];

		try {
			const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
			const updatedExtensions = await updateRpcSetting(settings, "extensions", extensions);

			expect(updatedExtensions.configured).toContain("extensions");
			expect(updatedExtensions.values.extensions).toEqual(extensions);
			const persistedConfig = YAML.parse(await Bun.file(configPath).text()) as {
				extensions?: string[];
			};
			expect(persistedConfig.extensions).toEqual(extensions);

			const redactedUpdate = await updateRpcSetting(settings, "auth.broker.token", "rpc-settings-test-token");
			expect(redactedUpdate.configured).toContain("auth.broker.token");
			expect(redactedUpdate.values.extensions).toEqual(extensions);
			expect(redactedUpdate.redacted).toContain("auth.broker.token");
			expect(Object.hasOwn(redactedUpdate.values, "auth.broker.token")).toBe(false);

			const reloaded = await Settings.loadReadOnly({ agentDir, cwd: agentDir });
			const reloadedSnapshot = buildRpcSettingsSnapshot(reloaded);
			expect(reloadedSnapshot.configured).toContain("extensions");
			expect(reloadedSnapshot.values.extensions).toEqual(extensions);
			expect(reloadedSnapshot.configured).toContain("auth.broker.token");
			expect(reloadedSnapshot.redacted).toContain("auth.broker.token");
			expect(Object.hasOwn(reloadedSnapshot.values, "auth.broker.token")).toBe(false);
		} finally {
			resetSettingsForTest();
			AgentStorage.resetInstance();
			await removeWithRetries(agentDir);
		}
	});
});

describe("RPC catalog locale contracts", () => {
	it("localizes settings tabs, schema copy, and enum labels without changing enum values", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-settings-locale-"));

		try {
			const settings = await Settings.loadReadOnly({ agentDir, cwd: agentDir });
			const english = await buildRpcSettingsCatalog(settings, "en");
			const chinese = await buildRpcSettingsCatalog(settings, "zh-CN");
			const englishAppearance = english.tabs.find(tab => tab.id === "appearance");
			const chineseAppearance = chinese.tabs.find(tab => tab.id === "appearance");
			const englishHyperlinks = english.settings.find(setting => setting.path === "tui.hyperlinks");
			const chineseHyperlinks = chinese.settings.find(setting => setting.path === "tui.hyperlinks");

			if (!englishAppearance || !chineseAppearance) throw new Error("Settings catalog omitted the appearance tab");
			if (!englishHyperlinks || !chineseHyperlinks) throw new Error("Settings catalog omitted tui.hyperlinks");

			expect(english.locale).toBe("en");
			expect(chinese.locale).toBe("zh-CN");
			expect(englishAppearance.label).toBe("Appearance");
			expect(chineseAppearance.label).toBe("外观");
			expect(englishHyperlinks.label).toBe("Terminal Hyperlinks");
			expect(chineseHyperlinks.label).toBe("终端超链接");
			expect(englishHyperlinks.options).toEqual([
				{ value: "off", label: "off" },
				{ value: "auto", label: "auto" },
				{ value: "always", label: "always" },
			]);
			expect(chineseHyperlinks.options).toEqual([
				{ value: "off", label: "关闭" },
				{ value: "auto", label: "自动" },
				{ value: "always", label: "总是" },
			]);

			for (const [path, expected] of [
				[
					"codexResets.salvageHorizonHours",
					{
						english: {
							label: "Codex Reset Salvage Horizon",
							description:
								"Spend a saved Codex reset automatically when it would otherwise expire within this many hours and either chat window (5h or weekly) has meaningful usage to restore (0 disables expiry salvage).",
						},
						chinese: {
							label: "Codex 重置到期挽救时限",
							description:
								"当已保存的 Codex 重置将在这么多小时内过期，且任一聊天窗口（5h 或每周）都有可恢复的实质用量时，自动使用该重置（0 禁用到期挽救）。",
						},
					},
				],
				[
					"workspaceCheckpoint.retention.maxPerSession",
					{
						english: {
							label: "Max checkpoints per session",
							description:
								"Maximum workspace checkpoints retained per session before garbage collection prunes the oldest.",
						},
						chinese: {
							label: "每个会话的检查点上限",
							description: "每个会话最多保留的工作区检查点数量；超过后，垃圾回收会裁剪最旧的检查点。",
						},
					},
				],
				[
					"workspaceCheckpoint.retention.maxAgeDays",
					{
						english: {
							label: "Max checkpoint age (days)",
							description:
								"Drop workspace checkpoints older than this many days during garbage collection; set to 0 to skip age-based pruning.",
						},
						chinese: {
							label: "检查点最长保留时长（天）",
							description: "垃圾回收时删除超过此保留天数的工作区检查点；设为 0 可跳过按时长裁剪。",
						},
					},
				],
			] as const) {
				const englishSetting = english.settings.find(setting => setting.path === path);
				const chineseSetting = chinese.settings.find(setting => setting.path === path);
				if (!englishSetting || !chineseSetting) throw new Error(`Settings catalog omitted ${path}`);

				expect(englishSetting.label).toBe(expected.english.label);
				expect(englishSetting.description).toBe(expected.english.description);
				expect(chineseSetting.label).toBe(expected.chinese.label);
				expect(chineseSetting.description).toBe(expected.chinese.description);
			}
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("localizes keybinding groups and labels per explicit catalog locale", () => {
		const english = buildRpcKeybindingsCatalog("en");
		const chinese = buildRpcKeybindingsCatalog("zh-CN");
		const englishApplication = english.groups.find(group => group.id === "application");
		const chineseApplication = chinese.groups.find(group => group.id === "application");
		const englishInterrupt = english.keybindings.find(keybinding => keybinding.id === "app.interrupt");
		const chineseInterrupt = chinese.keybindings.find(keybinding => keybinding.id === "app.interrupt");

		if (!englishApplication || !chineseApplication)
			throw new Error("Keybinding catalog omitted the application group");
		if (!englishInterrupt || !chineseInterrupt) throw new Error("Keybinding catalog omitted app.interrupt");

		expect(englishApplication.label).toBe("Application");
		expect(chineseApplication.label).toBe("应用");
		expect(englishInterrupt.label).toBe("Interrupt current operation");
		expect(chineseInterrupt.label).toBe("中断当前操作");
	});
});
