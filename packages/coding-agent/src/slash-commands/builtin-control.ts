import { tSettingsUi } from "../i18n/settings-locale";
import { runPauseScreen } from "../modes/components/pause-screen";
import { splitSecretScopeSetting } from "../secrets/scope";
import { addSecretTerm, listSecretTerms, removeSecretTerm } from "../secrets/terms";
import { shutdownHandlerTui } from "./builtin-lifecycle";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

/**
 * `secrets.yml` is read once when a session starts, so a newly added term only
 * takes effect for sessions opened afterwards. Say so rather than letting the
 * user conclude the change was ignored.
 */
function restartHint(enabled: boolean): string {
	return enabled ? "Takes effect in a new session." : "Enable obfuscation in settings to use it.";
}

export const BUILTIN_CONTROL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "force",
		description: "Force next turn to use a specific tool",
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const count = runtime.ctx.session.getActiveToolNames().length;
			return count === 0
				? tSettingsUi("Force: no active tools")
				: tSettingsUi("Force: {count} active tools", { count });
		},
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage("Usage: /force:<tool-name> [prompt]", runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(`Next turn forced to use ${toolName}.`);
			return prompt ? { prompt } : commandConsumed();
		},
		handleTui: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError("Usage: /force:<tool-name> [prompt]");
				runtime.ctx.editor.setText("");
				return;
			}
			if (typeof runtime.ctx.session.setForcedToolChoice !== "function") {
				runtime.ctx.showError("Forcing a tool is unavailable in the current session.");
				runtime.ctx.editor.setText("");
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(`Next turn forced to use ${toolName}.`);
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				runtime.ctx.editor.setText("");
				return;
			}

			runtime.ctx.editor.setText("");

			// If a prompt was provided, pass it through as input
			if (prompt) return { prompt };
		},
	},
	{
		name: "live",
		description: "Start Codex-backed realtime voice mode",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleLiveCommand();
		},
	},
	{
		name: "pause",
		description: "Freeze all agents (main, subagents, advisor) until resumed",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runPauseScreen(runtime.ctx);
		},
	},
	{
		name: "quit",
		aliases: ["q"],
		description: "Quit the application",
		handleTui: shutdownHandlerTui,
	},
	{
		name: "secrets",
		description: "Manage the terms obfuscated before reaching an AI provider",
		inlineHint: "[list|add|remove] [term]",
		allowArgs: true,
		// Text-only on purpose: the same handler works in the TUI and in ACP, and
		// the term list is a data surface rather than a navigable panel. The
		// settings UI owns the interactive editing experience.
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			const enabled = runtime.settings.get("secrets.enabled");

			if (verb === "add") {
				if (!rest) return usage("Usage: /secrets add <term>", runtime);
				const result = await addSecretTerm(rest);
				if (!result.ok) return usage(result.reason, runtime);
				await runtime.output(`Added "${result.added}". ${restartHint(enabled)}`);
				return commandConsumed();
			}

			if (verb === "remove" || verb === "rm") {
				if (!rest) return usage("Usage: /secrets remove <term>", runtime);
				const result = await removeSecretTerm(rest, runtime.cwd);
				if (!result.ok) return usage(result.reason, runtime);
				await runtime.output(`Removed ${result.removed} entry for "${rest}". ${restartHint(enabled)}`);
				return commandConsumed();
			}

			if (verb && verb !== "list" && verb !== "ls") {
				return usage("Usage: /secrets [list|add|remove] [term]", runtime);
			}

			const terms = await listSecretTerms(runtime.cwd);
			const keywords = terms.filter(term => term.kind === "keyword");
			const patterns = terms.filter(term => term.kind === "pattern");
			const scopeProviders = splitSecretScopeSetting(runtime.settings.get("secrets.scope.providers"));
			const scopeModels = splitSecretScopeSetting(runtime.settings.get("secrets.scope.models"));
			const scope =
				scopeProviders.length + scopeModels.length === 0
					? "all providers"
					: [...scopeProviders, ...scopeModels].join(", ");
			const lines = [
				`Obfuscation: ${enabled ? "enabled" : "disabled"} (secrets.enabled)`,
				`Scope: ${scope}`,
				`Terms: ${keywords.length} keyword(s), ${patterns.length} pattern(s)`,
			];
			if (keywords.length > 0) {
				lines.push("", `Keywords: ${keywords.map(term => term.content).join(" ")}`);
			}
			if (patterns.length > 0) {
				lines.push("", `Patterns: ${patterns.map(term => term.content).join("  ")}`);
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
	},
];
