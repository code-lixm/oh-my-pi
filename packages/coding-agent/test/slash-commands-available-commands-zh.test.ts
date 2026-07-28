import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getSettingsUiLocale, type SettingsUiLocale, setSettingsUiLocale } from "../src/i18n/settings-locale";
import { buildAvailableSlashCommands } from "../src/slash-commands/available-commands";
import { buildTuiBuiltinSlashCommands, executeBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";

function createVisionTuiHarness() {
	const statusMessages: string[] = [];
	const runtime = {
		ctx: {
			collabGuest: undefined,
			showStatus: (message: string) => statusMessages.push(message),
			editor: { setText: () => {} },
			session: {
				inspectImageState: () => ({ mode: "on" as const, active: true, model: "vision-model" }),
				getInspectImageModeOverride: () => "on" as const,
				model: { input: ["text", "image"] },
				settings: {
					get: (key: string) => {
						if (key !== "inspect_image.mode") throw new Error(`unexpected setting: ${key}`);
						return "auto";
					},
				},
			},
		},
	};

	return { runtime, statusMessages };
}

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
	test("renders /vision autocomplete, status, and usage in Chinese while retaining protocol arguments", async () => {
		setSettingsUiLocale("zh-CN");
		const harness = createVisionTuiHarness();
		const vision = buildTuiBuiltinSlashCommands(harness.runtime as never).find(command => command.name === "vision");

		expect(vision?.getAutocompleteDescription?.()).toBe("视觉：on");

		await executeBuiltinSlashCommand("/vision status", harness.runtime as never);
		await executeBuiltinSlashCommand("/vision unexpected", harness.runtime as never);

		expect(harness.statusMessages).toEqual([
			"inspect_image：活跃 · 模式：on（会话覆盖） · 配置值：auto · 模型：vision-model（原生图像输入）",
			"用法：/vision [on|off|auto|status]",
		]);
	});
});
