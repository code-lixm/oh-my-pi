import type { Keybinding, KeyId } from "../../config/keybindings";
import { KEYBINDINGS, KeybindingsManager } from "../../config/keybindings";
import { getSettingsUiLocale, tSettingsUi } from "../../i18n/settings-locale";
import type { RpcKeybindingsCatalog, RpcKeybindingsSnapshot } from "./rpc-keybindings-types";
import type { RpcSettingsLocale } from "./rpc-settings-types";

const GROUPS = [
	{ id: "application", label: "Application" },
	{ id: "editor", label: "Editor" },
	{ id: "input", label: "Input" },
	{ id: "selection", label: "Selection" },
] as const;

function groupFor(id: string): (typeof GROUPS)[number]["id"] {
	if (id.startsWith("tui.editor.")) return "editor";
	if (id.startsWith("tui.input.")) return "input";
	if (id.startsWith("tui.select.")) return "selection";
	return "application";
}

function keys(value: KeyId | KeyId[] | undefined): string[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? [...value] : [value];
}

export function buildRpcKeybindingsCatalog(locale: RpcSettingsLocale = getSettingsUiLocale()): RpcKeybindingsCatalog {
	const defaults = KeybindingsManager.inMemory();
	return {
		version: 1,
		groups: GROUPS.map(group => ({ id: group.id, label: tSettingsUi(group.label, undefined, locale) })),
		keybindings: Object.entries(KEYBINDINGS).map(([id, definition]) => ({
			id,
			label: definition.description ? tSettingsUi(definition.description, undefined, locale) : id,
			group: groupFor(id),
			defaultKeys: defaults.getKeys(id as Keybinding),
		})),
	};
}

export function buildRpcKeybindingsSnapshot(manager: KeybindingsManager): RpcKeybindingsSnapshot {
	const effective = manager.getEffectiveConfig();
	return {
		version: 1,
		values: Object.fromEntries(Object.keys(KEYBINDINGS).map(id => [id, keys(effective[id])])),
		configured: Object.keys(manager.getUserBindings()).filter(id => id in KEYBINDINGS),
	};
}

export function updateRpcKeybinding(
	manager: KeybindingsManager,
	rawId: string,
	rawKeys: string[],
): RpcKeybindingsSnapshot {
	if (!(rawId in KEYBINDINGS)) throw new Error(`Unknown keybinding: ${rawId}`);
	if (!rawKeys.every(key => key.trim().length > 0)) throw new Error(`${rawId} contains an empty key`);
	const normalized = [...new Set(rawKeys.map(key => key.trim().toLowerCase()))] as KeyId[];
	manager.setBinding(rawId as Keybinding, normalized);
	return buildRpcKeybindingsSnapshot(manager);
}

export function resetRpcKeybindings(manager: KeybindingsManager): RpcKeybindingsSnapshot {
	manager.resetBindings();
	return buildRpcKeybindingsSnapshot(manager);
}
