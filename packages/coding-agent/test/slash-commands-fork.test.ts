/**
 * Contracts: the `/fork` slash command.
 *
 * `/fork` is the "branch at THIS moment" counterpart of `/branch` (which picks a
 * historical point): it must be a registered builtin (so the name is reserved
 * against extension shadowing) and its TUI handler must delegate to the shared
 * fork flow — `ctx.handleForkCommand()`, which owns the streaming guard and the
 * new-file fork feedback. The command description follows the UI locale.
 */
import { describe, expect, it, vi } from "bun:test";
import { getSettingsUiLocale, setSettingsUiLocale } from "../src/i18n/settings-locale";
import {
	BUILTIN_SLASH_COMMAND_RESERVED_NAMES,
	BUILTIN_SLASH_COMMANDS_INTERNAL,
	buildTuiBuiltinSlashCommands,
	executeBuiltinSlashCommand,
} from "../src/slash-commands/builtin-registry";

function createRuntime() {
	const handleForkCommand = vi.fn(async () => {});
	const runtime = {
		ctx: {
			collabGuest: false,
			handleForkCommand,
			editor: { setText: vi.fn() },
			showStatus: vi.fn(),
		},
	};
	return { handleForkCommand, runtime };
}

describe("/fork slash command", () => {
	it("is a registered builtin whose name is reserved", () => {
		const fork = BUILTIN_SLASH_COMMANDS_INTERNAL.find(command => command.name === "fork");
		expect(fork).toBeDefined();
		expect(fork?.handleTui).toBeDefined();
		// Reserved names block extensions from shadowing the builtin.
		expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has("fork")).toBe(true);
	});

	it("delegates to the shared fork flow", async () => {
		const { handleForkCommand, runtime } = createRuntime();
		const result = await executeBuiltinSlashCommand("/fork", runtime as never);
		expect(result).toBe(true);
		expect(handleForkCommand).toHaveBeenCalledTimes(1);
	});

	it("localizes the description to the UI locale", () => {
		const previous = getSettingsUiLocale();
		try {
			setSettingsUiLocale("zh-CN");
			const localized = buildTuiBuiltinSlashCommands({} as never).find(command => command.name === "fork");
			expect(localized?.description).toBe("立即分叉当前会话并在副本中继续");

			setSettingsUiLocale("en");
			const english = buildTuiBuiltinSlashCommands({} as never).find(command => command.name === "fork");
			expect(english?.description).toBe("Fork the current session now and continue in the copy");
		} finally {
			setSettingsUiLocale(previous);
		}
	});
});
