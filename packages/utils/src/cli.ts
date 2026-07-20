/**
 * Minimal CLI framework — drop-in replacement for the subset of @oclif/core
 * actually used by the coding agent. Provides `Command`, `Args`, `Flags`,
 * and a `run()` entry point with explicit command registration.
 *
 * Design goals:
 *   - Zero dependencies beyond node builtins
 *   - No filesystem scanning, no manifest files, no plugin loading
 *   - Lazy command imports (only the invoked command is loaded)
 *   - Typed `this.parse()` output matching oclif's API shape
 */
import * as fs from "node:fs";
import { parseArgs as nodeParseArgs } from "node:util";

/**
 * Streaming startup marker, enabled by `PI_DEBUG_STARTUP`. Local copy of
 * `logger.startupMarker` so the minimal `--version`/bootstrap import graph
 * stays free of the winston-backed logger module. Synchronous on purpose:
 * a command module whose import hangs (dlopen, fs on a dead mount) must
 * still leave its `:start` marker behind.
 */
function startupMarker(text: string): void {
	if (!process.env.PI_DEBUG_STARTUP) return;
	try {
		fs.writeSync(2, `[startup] ${text}\n`);
	} catch {
		// stderr unavailable; markers are best-effort
	}
}

/**
 * A user-facing argument/flag validation failure. Thrown by {@link Command.parse}
 * for missing/invalid positionals and flags. The top-level {@link run} handler
 * prints its message plus the command usage line to stderr and exits 1, instead
 * of letting it bubble to the process-level catch — which would dump a minified
 * `dist/cli.js` code frame over a plain argument mistake (issue #5369).
 */
export class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

// ---------------------------------------------------------------------------
// Shared CLI i18n boundary (help chrome + helper-emitted stderr errors)
// ---------------------------------------------------------------------------

/**
 * Supported CLI locales. The English table is the byte-identical baseline
 * every existing CLI test depends on; `zh-CN` is the localized chrome. Other
 * inputs fall back to English without throwing so a non-UTF-8 or unknown
 * locale never crashes help rendering.
 */
export const CLI_LOCALES = ["en", "zh-CN"] as const;
export type CliLocale = (typeof CLI_LOCALES)[number];

/**
 * Translation table for the chrome strings this module owns. Only the chrome
 * is translated; dynamic values (command names, flag names, version strings,
 * paths, URLs, OS/arch) are interpolated verbatim.
 */
const CLI_MESSAGES: Record<CliLocale, Record<string, string>> = {
	en: {
		"cli.section.usage": "USAGE",
		"cli.section.arguments": "ARGUMENTS",
		"cli.section.flags": "FLAGS",
		"cli.section.examples": "EXAMPLES",
		"cli.section.commands": "COMMANDS",
		"cli.unknown_command": "Unknown command: {id}",
		"cli.error.command_not_found": "Error: command {id} not found",
		"cli.error.run_help": "Run `{bin} --help` for available commands.",
		"cli.error.expected_integer": 'Expected integer for --{name}, got "{value}"',
		"cli.error.expected_options": 'Expected --{name} to be one of: {options}; got "{value}"',
		"cli.error.missing_flag": "Missing required flag: --{name}",
		"cli.error.missing_argument": "Missing required argument: {name}",
		"cli.error.expected_arg_options": 'Expected {name} to be one of: {options}; got "{value}"',
	},
	"zh-CN": {
		"cli.section.usage": "用法",
		"cli.section.arguments": "参数",
		"cli.section.flags": "选项",
		"cli.section.examples": "示例",
		"cli.section.commands": "命令",
		"cli.unknown_command": "未知命令：{id}",
		"cli.error.command_not_found": "错误：未找到命令 {id}",
		"cli.error.run_help": "运行 `{bin} --help` 查看可用命令。",
		"cli.error.expected_integer": "--{name} 需要为整数，得到 “{value}”",
		"cli.error.expected_options": "--{name} 必须是以下取值之一：{options}；得到 “{value}”",
		"cli.error.missing_flag": "缺少必需选项：--{name}",
		"cli.error.missing_argument": "缺少必需参数：{name}",
		"cli.error.expected_arg_options": "{name} 必须是以下取值之一：{options}；得到 “{value}”",
	},
};

function interpolate(template: string, params?: Record<string, string | number>): string {
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
		const value = params[key];
		return value === undefined ? `{${key}}` : String(value);
	});
}

/** Normalize an arbitrary locale token to a supported {@link CliLocale}. */
export function normalizeCliLocale(value: unknown): CliLocale {
	if (typeof value !== "string") return "en";
	// POSIX locales commonly carry an encoding suffix (`zh_CN.UTF-8`,
	// `en_US.utf8`); strip it before matching the language tag.
	const lower = value.trim().toLowerCase().replace(/_/g, "-").split(".")[0]?.split("-")[0] ?? "";
	if (lower === "zh") return "zh-CN";
	if (lower === "en") return "en";
	return "en";
}

let currentCliLocale: CliLocale = "en";

/** Override the resolved CLI locale (used by callers that want to flip chrome without touching env). */
export function setCliLocale(value: unknown): void {
	currentCliLocale = normalizeCliLocale(value);
}

/** Get the active CLI locale (may differ from the initial env-derived default). */
export function getCliLocale(): CliLocale {
	return currentCliLocale;
}

/**
 * Resolve the CLI locale for a given environment snapshot. Precedence:
 * explicit env key > `LC_ALL` > `LANG` > "en". Pure so the bootstrap import
 * graph stays free of side effects and so callers (tests, downstream tools)
 * can pass a custom env without mutating `process.env`.
 */
export function resolveCliLocale(
	env: {
		OMP_LOCALE?: string | undefined;
		PI_LOCALE?: string | undefined;
		LC_ALL?: string | undefined;
		LANG?: string | undefined;
	} = process.env as never,
): CliLocale {
	if (env.OMP_LOCALE) return normalizeCliLocale(env.OMP_LOCALE);
	if (env.PI_LOCALE) return normalizeCliLocale(env.PI_LOCALE);
	if (env.LC_ALL) return normalizeCliLocale(env.LC_ALL);
	if (env.LANG) return normalizeCliLocale(env.LANG);
	return "en";
}

/**
 * Translate a CLI chrome key into the active locale. Falls back to English
 * then to the raw key, so a missing translation never crashes help rendering.
 */
export function tCli(
	key: string,
	params?: Record<string, string | number>,
	locale: CliLocale = currentCliLocale,
): string {
	const table = CLI_MESSAGES[locale] ?? CLI_MESSAGES.en;
	const template = table[key] ?? CLI_MESSAGES.en[key] ?? key;
	return interpolate(template, params);
}

/** Inject/override messages for a locale (testing or downstream customizations). */
export function setCliMessages(locale: CliLocale, messages: Record<string, string>): void {
	CLI_MESSAGES[locale] = { ...CLI_MESSAGES[locale], ...messages };
}

// Pick up env at module load. Subsequent overrides must go through
// `setCliLocale` so tests can flip back to English without mutating process.env.
currentCliLocale = resolveCliLocale();

// ---------------------------------------------------------------------------
// Flag & Arg descriptors
// ---------------------------------------------------------------------------

export interface FlagDescriptor<K extends "string" | "boolean" | "integer" = "string" | "boolean" | "integer"> {
	kind: K;
	description?: string;
	char?: string;
	default?: unknown;
	multiple?: boolean;
	options?: readonly string[];
	required?: boolean;
}

export interface ArgDescriptor {
	kind: "string";
	description?: string;
	required?: boolean;
	multiple?: boolean;
	options?: readonly string[];
}

interface FlagInput {
	description?: string;
	char?: string;
	default?: unknown;
	multiple?: boolean;
	options?: readonly string[];
	required?: boolean;
}

interface ArgInput {
	description?: string;
	required?: boolean;
	multiple?: boolean;
	options?: readonly string[];
}

/** Builders that match the `Flags.*()` / `Args.*()` API from oclif. */
export const Flags = {
	string<T extends FlagInput>(opts?: T): FlagDescriptor<"string"> & T {
		return { kind: "string" as const, ...opts } as FlagDescriptor<"string"> & T;
	},
	boolean<T extends FlagInput>(opts?: T): FlagDescriptor<"boolean"> & T {
		return { kind: "boolean" as const, ...opts } as FlagDescriptor<"boolean"> & T;
	},
	integer<T extends FlagInput & { default?: number }>(opts?: T): FlagDescriptor<"integer"> & T {
		return { kind: "integer" as const, ...opts } as FlagDescriptor<"integer"> & T;
	},
};

export const Args = {
	string<T extends ArgInput>(opts?: T): ArgDescriptor & T {
		return { kind: "string" as const, ...opts } as ArgDescriptor & T;
	},
};

// ---------------------------------------------------------------------------
// Parse result types — mirrors oclif's typed output from this.parse()
// ---------------------------------------------------------------------------

type FlagValue<D extends FlagDescriptor> = D["kind"] extends "boolean"
	? D extends { default: boolean }
		? boolean
		: boolean | undefined
	: D["kind"] extends "integer"
		? D extends { default: number }
			? number
			: number | undefined
		: D extends { multiple: true }
			? string[] | undefined
			: string | undefined;

type ArgValue<D extends ArgDescriptor> = D extends { multiple: true } ? string[] | undefined : string | undefined;

type FlagValues<T extends Record<string, FlagDescriptor>> = { [K in keyof T]: FlagValue<T[K]> };
type ArgValues<T extends Record<string, ArgDescriptor>> = { [K in keyof T]: ArgValue<T[K]> };

export interface ParseOutput<
	F extends Record<string, FlagDescriptor> = Record<string, FlagDescriptor>,
	A extends Record<string, ArgDescriptor> = Record<string, ArgDescriptor>,
> {
	flags: FlagValues<F>;
	args: ArgValues<A>;
	argv: string[];
}

// ---------------------------------------------------------------------------
// Command base class
// ---------------------------------------------------------------------------

export interface CommandCtor {
	new (argv: string[], config: CliConfig): Command;
	description?: string;
	hidden?: boolean;
	strict?: boolean;
	aliases?: string[];
	examples?: string[];
	flags?: Record<string, FlagDescriptor>;
	args?: Record<string, ArgDescriptor>;
}

/** Configuration passed to every command instance and help renderers. */
export interface CliConfig {
	bin: string;
	version: string;
	/** All registered commands keyed by their canonical name. */
	commands: Map<string, CommandCtor>;
}

/**
 * Format the expected-options error message in the active locale. Exposed so
 * callers wiring parse errors into their own reporter get the same chrome
 * without having to inspect the {@link CLI_MESSAGES} table directly.
 */
function formatOptionsError(name: string, value: unknown, options: readonly string[]): string {
	return tCli("cli.error.expected_options", {
		name,
		options: [...options].join(", "),
		value: String(value),
	});
}

/** Minimal Command base matching the oclif surface we use. */
export abstract class Command {
	argv: string[];
	config: CliConfig;

	constructor(argv: string[], config: CliConfig) {
		this.argv = argv;
		this.config = config;
	}

	abstract run(): Promise<void>;

	/**
	 * Parse argv against the static `flags` and `args` declared on the
	 * concrete command class. Returns a typed `{ flags, args, argv }` object.
	 */
	async parse<C extends CommandCtor>(
		_Cmd: C,
	): Promise<
		ParseOutput<
			NonNullable<C["flags"]> extends Record<string, FlagDescriptor>
				? NonNullable<C["flags"]>
				: Record<string, FlagDescriptor>,
			NonNullable<C["args"]> extends Record<string, ArgDescriptor>
				? NonNullable<C["args"]>
				: Record<string, ArgDescriptor>
		>
	> {
		const Cmd = _Cmd as CommandCtor;
		const flagDefs = (Cmd.flags ?? {}) as Record<string, FlagDescriptor>;
		const argDefs = (Cmd.args ?? {}) as Record<string, ArgDescriptor>;
		const strict = Cmd.strict !== false;

		// Build node:util parseArgs options from flag descriptors
		const options: Record<
			string,
			{ type: "string" | "boolean"; short?: string; multiple?: boolean; default?: string | boolean }
		> = {};
		for (const [name, desc] of Object.entries(flagDefs)) {
			const opt: (typeof options)[string] = {
				type: desc.kind === "boolean" ? "boolean" : "string",
			};
			if (desc.char) opt.short = desc.char;
			if (desc.multiple) opt.multiple = true;
			if (desc.default !== undefined) {
				opt.default = desc.kind === "boolean" ? Boolean(desc.default) : String(desc.default);
			}
			options[name] = opt;
		}

		// strict=false when command declares args (positionals must pass through)
		// or when the command itself opts out
		const { values: rawValues, positionals } = (() => {
			try {
				return nodeParseArgs({
					args: this.argv,
					options,
					allowPositionals: true,
					strict,
				});
			} catch (error) {
				throw new CliUsageError(error instanceof Error ? error.message : String(error));
			}
		})();

		// Convert raw values to proper types and validate
		const flags: Record<string, unknown> = {};
		for (const [name, desc] of Object.entries(flagDefs)) {
			const raw = rawValues[name];
			if (desc.kind === "integer") {
				if (raw === undefined || typeof raw === "boolean") {
					flags[name] = desc.default ?? undefined;
				} else {
					const n = Number.parseInt(raw as string, 10);
					if (Number.isNaN(n)) {
						throw new CliUsageError(tCli("cli.error.expected_integer", { name, value: String(raw) }));
					}
					flags[name] = n;
				}
			} else if (desc.kind === "boolean") {
				flags[name] =
					raw !== undefined ? Boolean(raw) : desc.default !== undefined ? Boolean(desc.default) : undefined;
			} else {
				// string
				const val = raw !== undefined && typeof raw !== "boolean" ? raw : (desc.default ?? undefined);
				// Validate options constraint
				if (val !== undefined && desc.options && !Array.isArray(val)) {
					if (!desc.options.includes(val as string)) {
						throw new CliUsageError(formatOptionsError(name, val, desc.options));
					}
				}
				flags[name] = val;
			}
			// Validate required
			if (desc.required && flags[name] === undefined) {
				throw new CliUsageError(tCli("cli.error.missing_flag", { name }));
			}
		}

		// Map positionals to named args in declaration order and validate
		const args: Record<string, unknown> = {};
		let posIdx = 0;
		for (const [argName, desc] of Object.entries(argDefs)) {
			if (desc.multiple) {
				const val = positionals.slice(posIdx);
				args[argName] = val.length > 0 ? val : undefined;
				posIdx = positionals.length;
			} else {
				const val = positionals[posIdx];
				args[argName] = val;
				posIdx++;
			}
			// Validate required
			if (desc.required && args[argName] === undefined) {
				throw new CliUsageError(tCli("cli.error.missing_argument", { name: argName }));
			}
			// Validate options constraint
			const argVal = args[argName];
			if (argVal !== undefined && desc.options && typeof argVal === "string") {
				if (!desc.options.includes(argVal)) {
					throw new CliUsageError(
						tCli("cli.error.expected_arg_options", {
							name: argName,
							options: [...desc.options].join(", "),
							value: argVal,
						}),
					);
				}
			}
		}

		return { flags, args, argv: positionals } as never;
	}
}

// ---------------------------------------------------------------------------
// Help rendering
// ---------------------------------------------------------------------------

/** Render full root help: header, default command details, subcommand list. */
export function renderRootHelp(config: CliConfig): void {
	const { bin, version, commands } = config;
	const lines: string[] = [];
	lines.push(`${bin} v${version}\n`);
	lines.push(tCli("cli.section.usage"));
	lines.push(`  $ ${bin} [COMMAND]\n`);

	// Show the default command's flags/args/examples inline.
	// The default command is the one marked hidden (it's the implicit entry point).
	const defaultCmd = [...commands.values()].find(C => C.hidden);
	if (defaultCmd) {
		renderCommandBody(lines, defaultCmd);
	}

	// List visible subcommands
	const visible = [...commands.entries()].filter(([, C]) => !C.hidden);
	if (visible.length > 0) {
		lines.push(tCli("cli.section.commands"));
		const maxLen = Math.max(...visible.map(([n]) => n.length));
		for (const [name, C] of visible.sort((a, b) => a[0].localeCompare(b[0]))) {
			lines.push(`  ${name.padEnd(maxLen + 2)}${C.description ?? ""}`);
		}
		lines.push("");
	}

	process.stdout.write(lines.join("\n"));
}

/**
 * Format a command's positional args for a USAGE line. Required args render
 * bare (`MODELS`), optional args wrapped in brackets (`[MODELS]`), and
 * `multiple` args get a trailing ellipsis (`MODELS...`) so a required
 * variadic reads as `MODELS...`, not the misleading optional `[MODELS]`.
 */
function formatUsageArgs(Cmd: CommandCtor): string {
	const entries = Object.entries(Cmd.args ?? {});
	if (entries.length === 0) return "";
	const parts = entries.map(([name, desc]) => {
		const label = `${name.toUpperCase()}${desc.multiple ? "..." : ""}`;
		return desc.required ? label : `[${label}]`;
	});
	return ` ${parts.join(" ")}`;
}

/** Build the single USAGE line for a command (without the leading label). */
export function commandUsageLine(bin: string, id: string, Cmd: CommandCtor): string {
	const hasFlags = Object.keys(Cmd.flags ?? {}).length > 0;
	return `$ ${bin} ${id}${formatUsageArgs(Cmd)}${hasFlags ? " [FLAGS]" : ""}`;
}

/** Render help for a single command. */
export function renderCommandHelp(bin: string, id: string, Cmd: CommandCtor): void {
	const lines: string[] = [];
	if (Cmd.description) lines.push(`${Cmd.description}\n`);
	lines.push(tCli("cli.section.usage"));
	lines.push(`  ${commandUsageLine(bin, id, Cmd)}\n`);
	renderCommandBody(lines, Cmd);
	process.stdout.write(lines.join("\n"));
}

/** Render a localized stderr error for an unknown subcommand. */
export function formatUnknownCommand(id: string, bin: string, locale: CliLocale = currentCliLocale): string {
	return `${tCli("cli.unknown_command", { id }, locale)}\n${tCli("cli.error.run_help", { bin }, locale)}\n`;
}

/** Render a localized stderr error for an unresolvable command-line entry. */
export function formatCommandNotFound(id: string, bin: string, locale: CliLocale = currentCliLocale): string {
	return `${tCli("cli.error.command_not_found", { id }, locale)}\n${tCli("cli.error.run_help", { bin }, locale)}\n`;
}

function renderCommandBody(lines: string[], Cmd: CommandCtor): void {
	const argDefs = Cmd.args ?? {};
	const flagDefs = Cmd.flags ?? {};

	// Arguments
	const argEntries = Object.entries(argDefs);
	if (argEntries.length > 0) {
		lines.push(tCli("cli.section.arguments"));
		const maxLen = Math.max(...argEntries.map(([n]) => n.length));
		for (const [name, desc] of argEntries) {
			const parts = [name.toUpperCase().padEnd(maxLen + 2)];
			if (desc.description) parts.push(desc.description);
			if (desc.options) parts.push(`(${[...desc.options].join("|")})`);
			lines.push(`  ${parts.join(" ")}`);
		}
		lines.push("");
	}

	// Flags
	const flagEntries = Object.entries(flagDefs);
	if (flagEntries.length > 0) {
		lines.push(tCli("cli.section.flags"));
		const formatted: [string, string][] = [];
		for (const [name, desc] of flagEntries) {
			const charPart = desc.char ? `-${desc.char}, ` : "    ";
			const namePart = `--${name}`;
			const typePart = desc.kind === "boolean" ? "" : desc.kind === "integer" ? "=<int>" : "=<value>";
			formatted.push([`  ${charPart}${namePart}${typePart}`, desc.description ?? ""]);
		}
		const maxLeft = Math.max(...formatted.map(([l]) => l.length));
		for (const [left, right] of formatted) {
			lines.push(`${left.padEnd(maxLeft + 2)}${right}`);
		}
		lines.push("");
	}

	// Examples
	if (Cmd.examples && Cmd.examples.length > 0) {
		lines.push(tCli("cli.section.examples"));
		for (const ex of Cmd.examples) {
			for (const line of ex.split("\n")) {
				lines.push(`  ${line}`);
			}
		}
		lines.push("");
	}
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/** A lazily-loaded command: canonical name, loader, and optional aliases. */
export interface CommandEntry {
	name: string;
	load: () => Promise<CommandCtor>;
	aliases?: string[];
}

export interface RunOptions {
	bin: string;
	version: string;
	argv: string[];
	commands: CommandEntry[];
	/** Custom help renderer. Receives fully-populated config. */
	help?: (config: CliConfig) => Promise<void> | void;
}

/** Find a command entry by exact name or alias. */
function findEntry(commands: CommandEntry[], id: string): CommandEntry | undefined {
	return commands.find(e => e.name === id) ?? commands.find(e => e.aliases?.includes(id));
}

/**
 * Main entry point — replaces `run()` from @oclif/core.
 *
 * Each command is explicitly registered with a lazy loader.
 * No filesystem scanning, no plugin system, no package.json reading.
 */
export async function run(opts: RunOptions): Promise<void> {
	const { bin, version, argv } = opts;

	const commandId = argv[0] ?? "";
	const commandArgv = argv.slice(1);

	// Top-level help
	if (commandId === "--help" || commandId === "-h" || commandId === "help" || commandId === "") {
		const config = await loadAllCommands(opts);
		if (opts.help) {
			await opts.help(config);
		} else {
			renderRootHelp(config);
		}
		return;
	}

	// Version
	if (commandId === "--version" || commandId === "-v") {
		process.stdout.write(`${bin}/${version}\n`);
		return;
	}

	// Per-command help: load only the requested command. Loading the full
	// command table here would make `omp <cmd> --help` hang or crash whenever
	// any *unrelated* command module misbehaves at import time.
	if (commandArgv.includes("--help") || commandArgv.includes("-h")) {
		const entry = findEntry(opts.commands, commandId);
		if (entry) {
			const Cmd = await loadEntry(entry);
			renderCommandHelp(bin, entry.name, Cmd);
		} else {
			process.stderr.write(formatUnknownCommand(commandId, bin));
		}
		return;
	}

	// Find command by name or alias
	const entry = findEntry(opts.commands, commandId);

	if (!entry) {
		process.stderr.write(formatCommandNotFound(commandId, bin));
		process.exitCode = 1;
		return;
	}

	const Cmd = await loadEntry(entry);
	const config: CliConfig = { bin, version, commands: new Map([[entry.name, Cmd]]) };
	const instance = new Cmd(commandArgv, config);
	try {
		await instance.run();
	} catch (error) {
		// A usage mistake (missing/invalid arg or flag) is not a crash: print the
		// message and the command's usage line, then exit 1. Letting it reach the
		// process-level catch would dump a minified `dist/cli.js` code frame over a
		// plain argument error (issue #5369).
		if (error instanceof CliUsageError) {
			process.stderr.write(`error: ${error.message}\n\n`);
			process.stderr.write(`USAGE\n  ${commandUsageLine(bin, entry.name, Cmd)}\n`);
			process.stderr.write(`\nRun \`${bin} ${entry.name} --help\` for details.\n`);
			process.exitCode = 1;
			return;
		}
		throw error;
	}
}

/** Load one command module, leaving streaming markers around the import. */
async function loadEntry(entry: CommandEntry): Promise<CommandCtor> {
	startupMarker(`cli:load:${entry.name}:start`);
	const Cmd = await entry.load();
	startupMarker(`cli:load:${entry.name}:done`);
	return Cmd;
}

/** Resolve all command loaders for help/alias display. */
async function loadAllCommands(opts: RunOptions): Promise<CliConfig> {
	const commands = new Map<string, CommandCtor>();
	const loaded = await Promise.all(opts.commands.map(async e => [e.name, await loadEntry(e)] as const));
	for (const [name, Cmd] of loaded) {
		commands.set(name, Cmd);
	}
	return { bin: opts.bin, version: opts.version, commands };
}
