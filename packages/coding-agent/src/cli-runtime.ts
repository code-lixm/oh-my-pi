import { type CliConfig, type CommandMetadata, renderRootHelp, run } from "@oh-my-pi/pi-utils/cli";
import { APP_NAME, VERSION } from "@oh-my-pi/pi-utils/dirs";
import { getExtraHelpText } from "./cli/help-extra";
import { ensureCliHelpLocale, localizeCliHelpMetadata } from "./cli/help-locale";
import { commands, resolveCliArgv } from "./cli-commands";
import { tSettingsUi } from "./i18n/settings-locale";

interface StaticCommandHelpSnapshot {
	description?: string;
	examples?: string[];
	args: Record<string, string | undefined>;
	flags: Record<string, string | undefined>;
}

const staticCommandHelpSnapshots = new WeakMap<CommandMetadata, StaticCommandHelpSnapshot>();

function snapshotStaticCommandHelp(metadata: CommandMetadata): StaticCommandHelpSnapshot {
	let snapshot = staticCommandHelpSnapshots.get(metadata);
	if (snapshot) return snapshot;
	snapshot = {
		description: metadata.description,
		examples: metadata.examples ? [...metadata.examples] : undefined,
		args: Object.fromEntries(Object.entries(metadata.args ?? {}).map(([name, arg]) => [name, arg.description])),
		flags: Object.fromEntries(Object.entries(metadata.flags ?? {}).map(([name, flag]) => [name, flag.description])),
	};
	staticCommandHelpSnapshots.set(metadata, snapshot);
	return snapshot;
}

function localizeStaticCommandHelpMetadata(metadata: CommandMetadata): void {
	const snapshot = snapshotStaticCommandHelp(metadata);
	if (snapshot.description) metadata.description = tSettingsUi(snapshot.description);
	if (snapshot.examples) metadata.examples = snapshot.examples.map(example => tSettingsUi(example));
	for (const [name, description] of Object.entries(snapshot.args)) {
		if (description && metadata.args?.[name]) metadata.args[name].description = tSettingsUi(description);
	}
	for (const [name, description] of Object.entries(snapshot.flags)) {
		if (description && metadata.flags?.[name]) metadata.flags[name].description = tSettingsUi(description);
	}
}

async function renderMetadataHelp(config: CliConfig<CommandMetadata>): Promise<void> {
	await ensureCliHelpLocale();
	for (const command of config.commands.values()) localizeStaticCommandHelpMetadata(command);
	renderRootHelp(config);
	const extra = getExtraHelpText();
	if (extra.trim().length > 0) process.stdout.write(`\n${extra}\n`);
}

/** Dispatch the ordinary CLI after profile and worker bootstrap have completed. */
export async function runCliRuntime(argv: string[]): Promise<void> {
	const resolved = resolveCliArgv(argv);
	if ("error" in resolved) {
		process.stderr.write(`error: ${resolved.error}\n`);
		process.exitCode = 1;
		return;
	}

	const commandId = resolved.argv[0] ?? "";
	const commandArgv = resolved.argv.slice(1);
	if (commandArgv.includes("--help") || commandArgv.includes("-h")) {
		await ensureCliHelpLocale();
		const entry = commands.find(command => command.name === commandId || command.aliases?.includes(commandId));
		if (entry) localizeCliHelpMetadata(await entry.load());
	}

	await run({
		bin: APP_NAME,
		version: VERSION,
		argv: resolved.argv,
		commands,
		metadataHelp: renderMetadataHelp,
	});
}
