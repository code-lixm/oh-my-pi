import { reloadTuiPluginState } from "../builtin-marketplace";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "../types";

/**
 * Adapt a TUI-only runtime to the {@link SlashCommandRuntime} shape the
 * text/ACP `handle` body expects: `output` routes through `ctx.showStatus`,
 * `refreshCommands`/`reloadPlugins` reuse the active session's pipelines.
 *
 * `handleTui` overrides that delegate to `handle` MUST go through this instead
 * of passing their narrower runtime straight through — the TUI runtime only
 * carries `ctx`, so a `handle` body reading `session`/`settings`/`cwd` would
 * otherwise be handed `undefined`.
 */
export function adaptTuiSlashRuntime(runtime: TuiSlashCommandRuntime): SlashCommandRuntime {
	const ctx = runtime.ctx;
	return {
		session: ctx.session,
		sessionManager: ctx.sessionManager,
		settings: ctx.settings,
		cwd: ctx.sessionManager.getCwd(),
		output: (text: string) => {
			ctx.showStatus(text);
		},
		refreshCommands: () => ctx.refreshSlashCommandState(),
		reloadPlugins: () => reloadTuiPluginState(ctx),
	};
}
