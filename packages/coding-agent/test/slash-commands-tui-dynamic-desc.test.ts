import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getSettingsUiLocale, type SettingsUiLocale, setSettingsUiLocale } from "../src/i18n/settings-locale";
import { buildTuiBuiltinSlashCommands } from "../src/slash-commands/builtin-registry";

describe("buildTuiBuiltinSlashCommands dynamic desc zh-CN", () => {
	let previousLocale: SettingsUiLocale;

	beforeEach(() => {
		previousLocale = getSettingsUiLocale();
		setSettingsUiLocale("zh-CN");
	});

	afterEach(() => {
		setSettingsUiLocale(previousLocale);
	});

	function makeStubRuntime(
		overrides: {
			planEnabled?: boolean;
			planMode?: boolean;
			goalMode?: boolean;
			vibeMode?: boolean;
			browserEnabled?: boolean;
			browserHeadless?: boolean;
			loopEnabled?: boolean;
			loopPaused?: boolean;
			loopLimit?: unknown;
			loopPrompt?: string;
			model?: { provider: string; id: string } | undefined;
			streaming?: boolean;
			usage?: { percent: number; tokens: number; contextWindow: number } | null;
			advisor?: {
				active: boolean;
				configured: boolean;
				model?: { provider: string; id: string };
				advisors?: unknown[];
			};
			tasks?: Array<{ status: string }>;
			jobs?: { running: unknown[]; recent: unknown[] };
			tools?: { active: number; all: number };
			collab?: { host?: unknown; guest?: { readOnly?: boolean } | null };
			oauthPending?: { providerId: string | null } | null;
			limit?: { limit: unknown };
		} = {},
	): unknown {
		const planEnabled = overrides.planEnabled ?? true;
		const planMode = overrides.planMode ?? false;
		const goalMode = overrides.goalMode ?? false;
		const vibeMode = overrides.vibeMode ?? false;
		const browserEnabled = overrides.browserEnabled ?? true;
		const browserHeadless = overrides.browserHeadless ?? false;
		const loopEnabled = overrides.loopEnabled ?? false;
		const loopPaused = overrides.loopPaused ?? false;
		const limit = overrides.loopLimit;
		const prompt = overrides.loopPrompt;
		const streaming = overrides.streaming ?? false;
		const advisor = overrides.advisor ?? { active: false, configured: false, advisors: [] };
		const tasks = overrides.tasks ?? [];
		const jobs = overrides.jobs ?? { running: [], recent: [] };
		const tools = overrides.tools ?? { active: 0, all: 0 };
		const usage = overrides.usage ?? null;
		const oauth =
			overrides.oauthPending === undefined
				? { hasPending: () => false, pendingProviderId: null as string | null }
				: {
						hasPending: () => overrides.oauthPending !== null,
						pendingProviderId: overrides.oauthPending?.providerId ?? null,
					};
		const collab = overrides.collab ?? { host: undefined, guest: null };

		const ctx: Record<string, unknown> = {
			settings: {
				get: (key: string) =>
					key === "plan.enabled"
						? planEnabled
						: key === "goal.enabled"
							? true
							: key === "browser.enabled"
								? browserEnabled
								: key === "browser.headless"
									? browserHeadless
									: (false as unknown),
			},
			planModeEnabled: planMode,
			planModePlanFilePath: undefined,
			vibeModeEnabled: vibeMode,
			goalModeEnabled: goalMode,
			loopModeEnabled: loopEnabled,
			loopModePaused: loopPaused,
			loopLimit: limit,
			loopPrompt: prompt,
			todoPhases: tasks.length ? [{ tasks }] : [],
			collabHost: collab.host,
			collabGuest: collab.guest,
			oauthManualInput: oauth,
			session: {
				model: overrides.model,
				isStreaming: streaming,
				getContextUsage: () => usage,
				getAdvisorStats: () => advisor,
				getActiveToolNames: () => (tools.active > 0 ? new Array(tools.active).fill("dummy") : []),
				getAllToolNames: () => (tools.all > 0 ? new Array(tools.all).fill("dummy") : []),
				getAsyncJobSnapshot: () => jobs,
				isFastModeEnabled: () => overrides.model !== undefined, // arbitrary
			},
			sessionManager: { getCwd: () => process.cwd() },
			showSettingsSelector: () => {},
			editor: { setText: () => {} },
			ui: { requestRender: () => {} },
			statusLine: { invalidate: () => {} },
			shutdown: () => {},
		};

		return { ctx: ctx as never };
	}

	function findCmd(
		commands: ReadonlyArray<{ name: string; getAutocompleteDescription?: () => string | undefined }>,
		name: string,
	) {
		return commands.find(command => command.name === name);
	}

	test("/plan disabled in settings returns Chinese", () => {
		const commands = buildTuiBuiltinSlashCommands(makeStubRuntime({ planEnabled: false }) as never);
		const desc = findCmd(commands, "plan")?.getAutocompleteDescription?.();
		expect(desc).toContain("计划");
		expect(desc).toContain("禁用");
	});

	test("/vibe on returns Chinese", () => {
		const commands = buildTuiBuiltinSlashCommands(makeStubRuntime({ vibeMode: true }) as never);
		const desc = findCmd(commands, "vibe")?.getAutocompleteDescription?.();
		expect(desc).toContain("Vibe");
		expect(desc).toContain("开启");
	});

	test("/loop paused returns Chinese", () => {
		const commands = buildTuiBuiltinSlashCommands(makeStubRuntime({ loopEnabled: true, loopPaused: true }) as never);
		const desc = findCmd(commands, "loop")?.getAutocompleteDescription?.();
		expect(desc).toContain("循环");
		expect(desc).toContain("暂停");
	});

	test("/model returns Chinese with provider placeholder substituted", () => {
		const commands = buildTuiBuiltinSlashCommands(
			makeStubRuntime({ model: { provider: "anthropic", id: "claude-sonnet-4-5" } }) as never,
		);
		const desc = findCmd(commands, "model")?.getAutocompleteDescription?.();
		expect(desc).toContain("模型");
		expect(desc).toContain("anthropic");
		expect(desc).toContain("claude-sonnet-4-5");
	});

	test("/todos empty returns Chinese", () => {
		const commands = buildTuiBuiltinSlashCommands(makeStubRuntime() as never);
		const desc = findCmd(commands, "todo")?.getAutocompleteDescription?.();
		expect(desc).toContain("待办");
	});

	test("/context returns Chinese with substituted percentages", () => {
		const commands = buildTuiBuiltinSlashCommands(
			makeStubRuntime({
				usage: { percent: 42, tokens: 1024, contextWindow: 4096 },
			}) as never,
		);
		const desc = findCmd(commands, "context")?.getAutocompleteDescription?.();
		expect(desc).toContain("上下文");
		expect(desc).toContain("42");
	});
	test("/advisor off returns Chinese", () => {
		const commands = buildTuiBuiltinSlashCommands(makeStubRuntime() as never);
		const desc = findCmd(commands, "advisor")?.getAutocompleteDescription?.();
		expect(desc).toContain("审阅");
		expect(desc).toContain("关闭");
	});

	test("/tools active returns Chinese with substituted counts", () => {
		const commands = buildTuiBuiltinSlashCommands(makeStubRuntime({ tools: { active: 3, all: 7 } }) as never);
		const desc = findCmd(commands, "tools")?.getAutocompleteDescription?.();
		expect(desc).toContain("工具");
		expect(desc).toContain("3");
		expect(desc).toContain("7");
	});

	test("/login waiting for pending OAuth callback returns Chinese", () => {
		const commands = buildTuiBuiltinSlashCommands(
			makeStubRuntime({ oauthPending: { providerId: "anthropic" } }) as never,
		);
		const desc = findCmd(commands, "login")?.getAutocompleteDescription?.();
		expect(desc).toContain("登录");
		expect(desc).toContain("等待");
		expect(desc).toContain("anthropic");
	});

	test("/login idle returns the Chinese choose-provider path", () => {
		const commands = buildTuiBuiltinSlashCommands(makeStubRuntime() as never);
		const desc = findCmd(commands, "login")?.getAutocompleteDescription?.();
		expect(desc).toContain("登录");
		expect(desc).toContain("选择提供方");
	});

	test("/tools none returns Chinese empty state", () => {
		const commands = buildTuiBuiltinSlashCommands(makeStubRuntime() as never);
		const desc = findCmd(commands, "tools")?.getAutocompleteDescription?.();
		expect(desc).toContain("工具");
	});
});
