/**
 * Top-level CLI command table.
 *
 * Lives in its own module (importable without side effects) so that tests can
 * inspect the registered subcommands without triggering the side-effectful
 * top-level await in `cli.ts`. Adding a new subcommand here is enough to make
 * `runCli` route to it instead of forwarding the argv as a prompt to
 * `launch` — see #1496 for the original "args silently leak to the LLM"
 * regression that motivated the split.
 */
import type { CommandCtor, CommandEntry } from "@oh-my-pi/pi-utils/cli";
import * as commandHelp from "./cli/command-help";
import { flagConsumesValue } from "./cli/flag-tables";
import { launchHelp } from "./commands/launch-help";
import { registerConfigSyncAutoPush } from "./config-sync/auto-push";

interface CommandModule {
	default: CommandCtor;
}

async function loadCommand(loader: () => Promise<CommandModule>): Promise<CommandCtor> {
	const module = await loader();
	registerConfigSyncAutoPush();
	return module.default;
}

export const commands: CommandEntry[] = [
	{ name: "launch", load: () => loadCommand(() => import("./commands/launch")), help: launchHelp },
	{
		name: "acp",
		load: () => loadCommand(() => import("./commands/acp")),
		help: commandHelp.acpHelp,
	},
	{
		name: "auth-broker",
		load: () => loadCommand(() => import("./commands/auth-broker")),
		help: commandHelp.authBrokerHelp,
	},
	{
		name: "auth-gateway",
		load: () => loadCommand(() => import("./commands/auth-gateway")),
		help: commandHelp.authGatewayHelp,
	},
	{
		name: "agents",
		load: () => loadCommand(() => import("./commands/agents")),
		help: commandHelp.agentsHelp,
	},
	{
		name: "bench",
		load: () => loadCommand(() => import("./commands/bench")),
		help: commandHelp.benchHelp,
	},
	{
		name: "browser-relay",
		load: () => loadCommand(() => import("./commands/browser-relay")),
		help: commandHelp.browserRelayHelp,
	},
	{
		name: "checkpoint",
		load: () => loadCommand(() => import("./commands/checkpoint")),
		help: commandHelp.checkpointHelp,
	},
	{
		name: "cleanse",
		load: () => loadCommand(() => import("./commands/cleanse")),
		help: commandHelp.cleanseHelp,
	},
	{
		name: "commit",
		load: () => loadCommand(() => import("./commands/commit")),
		help: commandHelp.commitHelp,
	},
	{
		name: "completions",
		load: () => loadCommand(() => import("./commands/completions")),
		help: commandHelp.completionsHelp,
	},
	{
		name: "__complete",
		load: () => loadCommand(() => import("./commands/complete")),
		help: commandHelp.completeHelp,
	},
	{
		name: "config",
		load: () => loadCommand(() => import("./commands/config")),
		help: commandHelp.configHelp,
	},
	{
		name: "codegraph",
		load: () => loadCommand(() => import("./commands/codegraph")),
		help: commandHelp.codegraphHelp,
	},
	{
		name: "dry-balance",
		load: () => loadCommand(() => import("./commands/dry-balance")),
		help: commandHelp.dryBalanceHelp,
	},
	{
		name: "gc",
		load: () => loadCommand(() => import("./commands/gc")),
		help: commandHelp.gcHelp,
	},
	{
		name: "grep",
		load: () => loadCommand(() => import("./commands/grep")),
		help: commandHelp.grepHelp,
	},
	{
		name: "gallery",
		load: () => loadCommand(() => import("./commands/gallery")),
		help: commandHelp.galleryHelp,
	},
	{
		name: "grievances",
		load: () => loadCommand(() => import("./commands/grievances")),
		help: commandHelp.grievancesHelp,
	},
	{
		name: "install",
		load: () => loadCommand(() => import("./commands/install")),
		help: commandHelp.installHelp,
	},
	{
		name: "join",
		load: () => loadCommand(() => import("./commands/join")),
		help: commandHelp.joinHelp,
	},
	{
		name: "models",
		load: () => loadCommand(() => import("./commands/models")),
		help: commandHelp.modelsHelp,
	},
	{
		name: "plugin",
		load: () => loadCommand(() => import("./commands/plugin")),
		help: commandHelp.pluginHelp,
	},
	{
		name: "say",
		load: () => loadCommand(() => import("./commands/say")),
		help: commandHelp.sayHelp,
	},
	{
		name: "share",
		load: () => import("./commands/share").then(m => m.default),
		help: commandHelp.shareHelp,
	},
	{
		name: "setup",
		load: () => loadCommand(() => import("./commands/setup")),
		help: commandHelp.setupHelp,
	},
	{
		name: "shell",
		load: () => loadCommand(() => import("./commands/shell")),
		help: commandHelp.shellHelp,
	},
	{
		name: "read",
		load: () => loadCommand(() => import("./commands/read")),
		help: commandHelp.readHelp,
	},
	{
		name: "redo",
		load: () => loadCommand(() => import("./commands/redo")),
		help: commandHelp.redoHelp,
	},
	{
		name: "rewind",
		load: () => loadCommand(() => import("./commands/rewind")),
		help: commandHelp.rewindHelp,
	},
	{
		name: "ssh",
		load: () => loadCommand(() => import("./commands/ssh")),
		help: commandHelp.sshHelp,
	},
	{
		name: "stats",
		load: () => loadCommand(() => import("./commands/stats")),
		help: commandHelp.statsHelp,
	},
	{
		name: "undo",
		load: () => loadCommand(() => import("./commands/undo")),
		help: commandHelp.undoHelp,
	},
	{
		name: "update",
		load: () => loadCommand(() => import("./commands/update")),
		help: commandHelp.updateHelp,
	},
	{
		name: "usage",
		load: () => loadCommand(() => import("./commands/usage")),
		help: commandHelp.usageHelp,
	},
	{
		name: "tiny-models",
		load: () => loadCommand(() => import("./commands/tiny-models")),
		help: commandHelp.tinyModelsHelp,
	},
	{
		name: "token",
		load: () => loadCommand(() => import("./commands/token")),
		help: commandHelp.tokenHelp,
	},
	{
		name: "ttsr",
		load: () => loadCommand(() => import("./commands/ttsr")),
		help: commandHelp.ttsrHelp,
	},
	{
		name: "worktree",
		load: () => loadCommand(() => import("./commands/worktree")),
		aliases: ["wt"],
		help: commandHelp.worktreeHelp,
	},
	{
		name: "search",
		load: () => loadCommand(() => import("./commands/web-search")),
		aliases: ["q"],
		help: commandHelp.searchHelp,
	},
];

// Documented-looking plugin/marketplace verbs that are NOT registered top-level
// commands. Without a guard `resolveCliArgv` rewrites e.g. `omp marketplace add
// xyz` to `omp launch marketplace add xyz`, silently forwarding the argv to the
// model as a prompt instead of managing plugins (#4845; same class as the
// `list`/`remove` leak fixed in #2935 and the `install` leak in #1496/#1498).
// The real commands live under `omp plugin <action>`; each entry maps a verb to
// a hint pointing there. See {@link reservedTopLevelWordMessage} for when a hint
// fires vs. when the argv still falls through to `launch`.
const RESERVED_TOP_LEVEL_WORDS: Record<string, string> = {
	extensions:
		'`omp extensions` is not a management command. Use `omp plugin list` / `omp plugin install`, or run `omp launch extensions` if you meant to send "extensions" as a prompt.',
	list: '`omp list` is not a top-level command. Use `omp plugin list` to list installed plugins, or run `omp launch list` if you meant to send "list" as a prompt.',
	remove:
		'`omp remove` is not a top-level command. Use `omp plugin uninstall <name>` to remove a plugin, or run `omp launch remove` if you meant to send "remove" as a prompt.',
	uninstall:
		'`omp uninstall` is not a top-level command. Use `omp plugin uninstall <name@marketplace>` to remove a plugin, or run `omp launch uninstall` if you meant to send "uninstall" as a prompt.',
	marketplace:
		'`omp marketplace` is not a top-level command. Use `omp plugin marketplace <add|remove|update|list>` to manage marketplaces, or run `omp launch marketplace` if you meant to send "marketplace" as a prompt.',
	discover:
		'`omp discover` is not a top-level command. Use `omp plugin discover [marketplace]` to browse available plugins, or run `omp launch discover` if you meant to send "discover" as a prompt.',
	upgrade:
		'`omp upgrade` is not a top-level command. Use `omp plugin upgrade [name@marketplace]` to upgrade plugins, or run `omp launch upgrade` if you meant to send "upgrade" as a prompt.',
	enable:
		'`omp enable` is not a top-level command. Use `omp plugin enable <name@marketplace>` to enable a plugin, or run `omp launch enable` if you meant to send "enable" as a prompt.',
	disable:
		'`omp disable` is not a top-level command. Use `omp plugin disable <name@marketplace>` to disable a plugin, or run `omp launch disable` if you meant to send "disable" as a prompt.',
};

// Sub-actions that make `omp marketplace <sub>` unambiguously a management
// command even when multi-word (the reporter's `omp marketplace add xyz`,
// #4845). Mirrors the switch in `handleMarketplace` (cli/plugin-cli.ts).
const MARKETPLACE_SUBCOMMANDS: Record<string, true> = { add: true, remove: true, rm: true, update: true, list: true };

/**
 * Hint for a reserved plugin/marketplace verb used as a top-level command, or
 * `undefined` when the argv should fall through to `launch`.
 *
 * A bare verb (`omp marketplace`) always hints. A multi-word invocation only
 * hints when the arguments follow the documented plugin grammar — a marketplace
 * sub-action (`omp marketplace add …`) or a `name@marketplace` plugin id
 * (`omp uninstall foo@bar`) — so genuine prompts that merely begin with one of
 * these words (`omp list all my files`, `omp upgrade the deps`) still launch.
 *
 * Flags (`-…`) and `@file` arguments in the verb slot are never management
 * commands; those fall through to the default `launch` command.
 */
export function reservedTopLevelWordMessage(argv: readonly string[]): string | undefined {
	const first = argv[0];
	if (!first || first.startsWith("-") || first.startsWith("@")) return undefined;
	const hint = RESERVED_TOP_LEVEL_WORDS[first];
	if (!hint) return undefined;
	const second = argv[1];
	if (second === undefined) return hint;
	if (first === "marketplace" && MARKETPLACE_SUBCOMMANDS[second]) return hint;
	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("-") && arg.includes("@")) return hint;
	}
	return undefined;
}

/**
 * Return true when `first` matches a registered subcommand name or alias.
 *
 * Flags (`-…`) and `@file` arguments are never subcommands; for those the CLI
 * runner skips ahead to the default `launch` command.
 */
export function isSubcommand(first: string | undefined): boolean {
	if (!first || first.startsWith("-") || first.startsWith("@")) return false;
	return commands.some(entry => entry.name === first || entry.aliases?.includes(first));
}

export type ResolvedCliArgv = { argv: string[] } | { error: string };

/**
 * Index of the first argv token that names a registered subcommand, skipping
 * leading global option flags (and any value they consume) with the same
 * contract as the launch parser ({@link flagConsumesValue}). Returns -1 when
 * scanning hits a non-subcommand positional, an end-of-options `--`, or the end
 * of argv first.
 */
function leadingSubcommandIndex(argv: string[]): number {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") return -1;
		if (!arg.startsWith("-")) return isSubcommand(arg) ? index : -1;
		if (flagConsumesValue(arg, argv[index + 1])) index += 1;
	}
	return -1;
}

/**
 * Decide what the CLI runner should do with raw argv: reject bare reserved
 * management words, pass help/version through untouched, route a recognized
 * subcommand (even behind leading global flags like `--approval-mode=yolo`) to
 * that command with the flags preserved, and forward everything else to
 * `launch` (#2970).
 */
export function resolveCliArgv(argv: string[]): ResolvedCliArgv {
	const first = argv[0];
	const reservedMessage = reservedTopLevelWordMessage(argv);
	if (reservedMessage) return { error: reservedMessage };
	if (first === "--help" || first === "-h" || first === "--version" || first === "-v" || first === "help") {
		return { argv };
	}
	if (isSubcommand(first)) return { argv };
	// A subcommand can hide behind leading global option flags
	// (`omp --approval-mode=yolo acp`). `run` dispatches strictly on argv[0], so
	// hoist the subcommand to the front and keep the leading flags as its own
	// argv; the command's parser then applies them. Genuine launch prompts (no
	// trailing subcommand) are untouched.
	const subIndex = leadingSubcommandIndex(argv);
	if (subIndex >= 0) {
		return { argv: [argv[subIndex], ...argv.slice(0, subIndex), ...argv.slice(subIndex + 1)] };
	}
	return { argv: ["launch", ...argv] };
}
