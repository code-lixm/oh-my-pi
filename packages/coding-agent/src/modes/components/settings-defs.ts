/**
 * UI adapter over the schema. Reads `ui.options` declared inline in
 * settings-schema.ts and produces typed widget definitions for the
 * settings selector.
 *
 * To add a new setting to the UI: declare it in `settings-schema.ts`
 * with a `ui` block carrying `tab` and `group` (the group must be listed
 * in `TAB_GROUPS[tab]`). If it needs a submenu, include `options: [...]`
 * (or `options: "runtime"` for runtime-injected lists like themes).
 */

import { TERMINAL } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import {
	type AnyUiMetadata,
	getDefault,
	getEnumValues,
	getPathsForTab,
	getType,
	getUi,
	isCredential,
	SETTING_TABS,
	type SettingPath,
	type SettingTab,
	type SubmenuOption,
	TAB_GROUPS,
} from "../../config/settings-schema";
import { isSettingsUiConditionMet } from "../../config/settings-ui-condition";
import { LOCAL_SYNC_PASSPHRASE_SETTING_PATH } from "../../config-sync/local-secret";
import { getSettingsUiLocale, type SettingsUiLocale, tSettingsUi } from "../../i18n/settings-locale";

// ═══════════════════════════════════════════════════════════════════════════
// UI Definition Types
// ═══════════════════════════════════════════════════════════════════════════

export type SettingDefPath = SettingPath | typeof LOCAL_SYNC_PASSPHRASE_SETTING_PATH;

interface BaseSettingDef<P extends SettingDefPath = SettingPath> {
	path: P;
	label: string;
	description: string;
	tab: SettingTab;
	/** Section within the tab; items are ordered by TAB_GROUPS[tab] and rendered under a heading row. */
	group?: string;
	groupLabel?: string;
	/**
	 * Optional visibility predicate. When supplied and returning false, the
	 * setting is hidden from the UI. Applies to every variant — booleans,
	 * enums, submenus, and text inputs.
	 */
	conditionName?: string;
	condition?: () => boolean;
}

export interface BooleanSettingDef extends BaseSettingDef {
	type: "boolean";
}

export interface EnumSettingDef extends BaseSettingDef {
	type: "enum";
	values: readonly string[];
}

type OptionList = ReadonlyArray<SubmenuOption>;

function localizeOption(option: SubmenuOption, locale: SettingsUiLocale): SubmenuOption {
	return {
		...option,
		label: tSettingsUi(option.label, undefined, locale),
		...(option.description ? { description: tSettingsUi(option.description, undefined, locale) } : {}),
	};
}

export interface SubmenuSettingDef extends BaseSettingDef {
	type: "submenu";
	options: OptionList;
	onPreview?: (value: string) => void;
	onPreviewCancel?: (originalValue: string) => void;
}

export interface TextInputSettingDef extends BaseSettingDef {
	type: "text";
	secret: boolean;
}

export interface LocalSecretSettingDef extends BaseSettingDef<typeof LOCAL_SYNC_PASSPHRASE_SETTING_PATH> {
	type: "text";
	secret: true;
	localSecret: true;
}

export interface NumberInputSettingDef extends BaseSettingDef {
	type: "number";
	min?: number;
	max?: number;
	integer: boolean;
}

export interface ProviderLimitsSettingDef extends BaseSettingDef {
	type: "providerLimits";
}

/** Array-of-enum setting edited as a toggle list; `ordered` lists render positions and support reordering. */
export interface MultiSelectSettingDef extends BaseSettingDef {
	type: "multiselect";
	options: OptionList;
	ordered: boolean;
}

export type SettingDef =
	| BooleanSettingDef
	| EnumSettingDef
	| SubmenuSettingDef
	| TextInputSettingDef
	| LocalSecretSettingDef
	| NumberInputSettingDef
	| ProviderLimitsSettingDef
	| MultiSelectSettingDef;

// ═══════════════════════════════════════════════════════════════════════════
// Condition Functions
// ═══════════════════════════════════════════════════════════════════════════

function conditionFor(name: string | undefined): (() => boolean) | undefined {
	if (!name) return undefined;
	return () => {
		try {
			return isSettingsUiConditionMet(name, Settings.instance, { hasImageProtocol: !!TERMINAL.imageProtocol });
		} catch {
			return false;
		}
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Schema to UI Conversion
// ═══════════════════════════════════════════════════════════════════════════

function resolveOptions(ui: AnyUiMetadata, locale: SettingsUiLocale): OptionList | "runtime" | undefined {
	if (!ui.options) return undefined;
	if (ui.options === "runtime") return "runtime";
	return ui.options.map(option => localizeOption(option, locale));
}

function pathToSettingDef(path: SettingPath, locale: SettingsUiLocale): SettingDef | null {
	const ui = getUi(path);
	if (!ui) return null;
	const schemaType = getType(path);

	const conditionName = ui.condition;
	const condition = conditionFor(conditionName);
	const base = {
		path,
		label: tSettingsUi(ui.label, undefined, locale),
		description: tSettingsUi(ui.description, undefined, locale),
		tab: ui.tab,
		group: ui.group,
		groupLabel: ui.group ? tSettingsUi(ui.group, undefined, locale) : undefined,
		condition,
		conditionName,
	};

	if (schemaType === "boolean") {
		return { ...base, type: "boolean" };
	}

	const options = resolveOptions(ui, locale);

	if (schemaType === "enum") {
		if (options === undefined) {
			return { ...base, type: "enum", values: getEnumValues(path) ?? [] };
		}
		// "runtime" is not a valid sentinel for enums — schema types prevent this,
		// but treat defensively as an empty submenu.
		return { ...base, type: "submenu", options: options === "runtime" ? [] : options };
	}

	if (schemaType === "number") {
		if (ui.input) {
			return {
				...base,
				type: "number",
				min: ui.min,
				max: ui.max,
				integer: ui.integer === true,
			};
		}
		// Numbers without an input or options are intentionally hidden from the UI.
		if (!options || options === "runtime") return null;
		return { ...base, type: "submenu", options };
	}

	if (schemaType === "string") {
		if (options === "runtime") {
			// Empty list now; the selector layer (theme handling, etc.) injects choices.
			return { ...base, type: "submenu", options: [] };
		}
		if (options) {
			return { ...base, type: "submenu", options };
		}
		// One classification drives both surfaces: a setting marked `credential`
		// masks here too, so the panel cannot display one that only the CLI knows
		// to redact.
		return { ...base, type: "text", secret: isCredential(path) };
	}

	if (schemaType === "array") {
		// Arrays without declared options stay config-file only (free-form lists
		// like extension paths have no finite choice set to toggle).
		if (!options || options === "runtime") return null;
		return { ...base, type: "multiselect", options, ordered: ui.ordered === true };
	}

	if (schemaType === "record") {
		return path === "providers.maxInFlightRequests"
			? { ...base, type: "providerLimits" }
			: { ...base, type: "text", secret: false };
	}

	return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/** Cache of generated definitions */
const cachedDefs = new Map<SettingsUiLocale, SettingDef[]>();

/** Get all setting definitions with UI */
export function getAllSettingDefs(locale: SettingsUiLocale = getSettingsUiLocale()): SettingDef[] {
	const cached = cachedDefs.get(locale);
	if (cached) return cached;

	const defs: SettingDef[] = [];
	for (const tab of SETTING_TABS) {
		for (const path of getPathsForTab(tab)) {
			const def = pathToSettingDef(path, locale);
			if (tab === "sync" && path === "sync.passphraseEnv") {
				defs.push({
					path: LOCAL_SYNC_PASSPHRASE_SETTING_PATH,
					label: tSettingsUi("Local Encryption Key", undefined, locale),
					description: tSettingsUi(
						"Encryption key stored only in this device's local secret file; it is never written to config.yml or uploaded to S3.",
						undefined,
						locale,
					),
					tab: "sync",
					group: "Credentials",
					groupLabel: tSettingsUi("Credentials", undefined, locale),
					type: "text",
					secret: true,
					localSecret: true,
				});
			}
			if (def) defs.push(def);
		}
	}
	cachedDefs.set(locale, defs);
	return defs;
}

export function clearSettingDefsCache(): void {
	cachedDefs.clear();
}

/**
 * Get settings for a specific tab, ordered by the tab's group layout
 * (TAB_GROUPS). Ungrouped settings sort first; within a group, schema
 * declaration order is preserved.
 */
export function getSettingsForTab(tab: SettingTab): SettingDef[] {
	const defs = getAllSettingDefs().filter(def => def.tab === tab);
	const order = TAB_GROUPS[tab];
	const rank = (def: SettingDef): number => {
		if (!def.group) return -1;
		const index = order.indexOf(def.group);
		return index >= 0 ? index : order.length;
	};
	return defs.sort((a, b) => rank(a) - rank(b));
}

/** Get a setting definition by path */
export function getSettingDef(path: SettingDefPath): SettingDef | undefined {
	return getAllSettingDefs().find(def => def.path === path);
}

/** Get default value for display */
export function getDisplayDefault(path: SettingPath): string {
	const value = getDefault(path);
	if (value === undefined) return "";
	if (typeof value === "boolean") return value ? "true" : "false";
	return String(value);
}
