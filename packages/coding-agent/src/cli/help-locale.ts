import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { tSettingsUi } from "../i18n/settings-locale";

interface LocalizableCliEntry {
	load: () => Promise<LocalizableCliConstructor>;
}

interface LocalizableCliField {
	description?: string;
}

export interface LocalizableCliConstructor {
	description?: string;
	examples?: string[];
	args?: Record<string, LocalizableCliField>;
	flags?: Record<string, LocalizableCliField>;
}

interface CommandHelpSnapshot {
	description?: string;
	examples?: string[];
	args: Record<string, string | undefined>;
	flags: Record<string, string | undefined>;
}

const commandHelpSnapshots = new WeakMap<object, CommandHelpSnapshot>();
let helpLocalePromise: Promise<void> | undefined;

function snapshotCommandHelp(ctor: LocalizableCliConstructor): CommandHelpSnapshot {
	let cached = commandHelpSnapshots.get(ctor);
	if (cached) return cached;
	cached = {
		description: ctor.description,
		examples: ctor.examples ? [...ctor.examples] : undefined,
		args: Object.fromEntries(
			Object.entries(ctor.args ?? {}).map(([name, arg]) => [
				name,
				typeof arg.description === "string" ? arg.description : undefined,
			]),
		),
		flags: Object.fromEntries(
			Object.entries(ctor.flags ?? {}).map(([name, flag]) => [
				name,
				typeof flag.description === "string" ? flag.description : undefined,
			]),
		),
	};
	commandHelpSnapshots.set(ctor, cached);
	return cached;
}

export async function ensureCliHelpLocale(cwd = getProjectDir()): Promise<void> {
	helpLocalePromise ??= Settings.loadReadOnly({ cwd }).then(() => undefined);
	await helpLocalePromise;
}

export function localizeCliHelpMetadata<T extends LocalizableCliConstructor>(ctor: T): T {
	const snapshot = snapshotCommandHelp(ctor);
	if (snapshot.description) ctor.description = tSettingsUi(snapshot.description);
	if (snapshot.examples) ctor.examples = snapshot.examples.map(example => tSettingsUi(example));
	for (const [name, description] of Object.entries(snapshot.args)) {
		if (description && ctor.args?.[name]) ctor.args[name].description = tSettingsUi(description);
	}
	for (const [name, description] of Object.entries(snapshot.flags)) {
		if (description && ctor.flags?.[name]) ctor.flags[name].description = tSettingsUi(description);
	}
	return ctor;
}

export async function localizeCommandEntryHelp(entries: readonly LocalizableCliEntry[]): Promise<void> {
	await Promise.all(
		entries.map(async entry => {
			const ctor = await entry.load();
			if (typeof ctor === "function") {
				localizeCliHelpMetadata(ctor);
			}
		}),
	);
}
