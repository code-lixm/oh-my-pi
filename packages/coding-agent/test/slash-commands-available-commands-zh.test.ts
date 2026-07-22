import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getSettingsUiLocale, type SettingsUiLocale, setSettingsUiLocale } from "../src/i18n/settings-locale";
import { buildAvailableSlashCommands } from "../src/slash-commands/available-commands";

describe("buildAvailableSlashCommands zh-CN", () => {
	let previousLocale: SettingsUiLocale;

	beforeEach(() => {
		previousLocale = getSettingsUiLocale();
	});

	afterEach(() => {
		setSettingsUiLocale(previousLocale);
	});

	test("localizes top-level builtin descriptions under zh-CN", async () => {
		setSettingsUiLocale("zh-CN");

		const session = {
			customCommands: [],
			extensionRunner: { getRegisteredCommands: () => [] },
			mcpPromptCommands: undefined,
			skills: [],
			skillsSettings: { enableSkillCommands: false },
			sessionManager: { getCwd: () => process.cwd() },
			setSlashCommands() {},
		};

		const commands = await buildAvailableSlashCommands(session as never, async () => []);
		const byName = Object.fromEntries(commands.map(command => [command.name, command]));

		expect(byName.mcp?.description).toContain("管理 MCP 服务器");
		expect(byName.todo?.description).toContain("管理 todos");
		expect(byName.advisor?.description).toContain("切换审阅助手");
	});

	test("localizes subcommand descriptions and preserves usage placeholders", async () => {
		setSettingsUiLocale("zh-CN");

		const session = {
			customCommands: [],
			extensionRunner: { getRegisteredCommands: () => [] },
			mcpPromptCommands: undefined,
			skills: [],
			skillsSettings: { enableSkillCommands: false },
			sessionManager: { getCwd: () => process.cwd() },
			setSlashCommands() {},
		};

		const commands = await buildAvailableSlashCommands(session as never, async () => []);
		const byName = Object.fromEntries(commands.map(command => [command.name, command]));

		// /mcp.add subcommand — description localized, usage placeholder preserved verbatim.
		const mcpAdd = byName.mcp?.subcommands?.find(sub => sub.name === "add");
		expect(mcpAdd?.description).toContain("添加新的 MCP 服务器");
		expect(mcpAdd?.usage).toBe("<name> [--scope project|user] [--url <url>] [-- <command...>]");

		// /todo.append subcommand — Chinese description and verbatim usage placeholder.
		const todoAppend = byName.todo?.subcommands?.find(sub => sub.name === "append");
		expect(todoAppend?.description).toContain("追加任务");
		expect(todoAppend?.usage).toBe("[<phase>] <task...>");

		// /advisor subcommand descriptions all localize (on/off/status/dump/configure).
		expect(byName.advisor?.subcommands?.find(sub => sub.name === "on")?.description).toContain("启用审阅助手");
		expect(byName.advisor?.subcommands?.find(sub => sub.name === "off")?.description).toContain("禁用审阅助手");
		expect(byName.advisor?.subcommands?.find(sub => sub.name === "status")?.description).toContain(
			"显示审阅助手状态",
		);
		const advisorDump = byName.advisor?.subcommands?.find(sub => sub.name === "dump");
		expect(advisorDump?.description).toContain("复制审阅助手的转录");
		expect(advisorDump?.usage).toBe("[raw]");
		expect(byName.advisor?.subcommands?.find(sub => sub.name === "configure")?.description).toContain(
			"打开审阅助手配置编辑器",
		);
	});
});
