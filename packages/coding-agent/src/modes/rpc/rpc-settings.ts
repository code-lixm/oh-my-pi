import { TERMINAL } from "@oh-my-pi/pi-tui";
import type { Settings } from "../../config/settings";
import { validateProviderMaxInFlightRequests } from "../../config/settings";
import {
	getDefault,
	getEnumValues,
	getSettingScope,
	getType,
	getUi,
	isCredential,
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
	TAB_METADATA,
} from "../../config/settings-schema";
import { isSettingsUiConditionMet } from "../../config/settings-ui-condition";
import { getSettingsUiLocale, tSettingsUi } from "../../i18n/settings-locale";
import { getAllSettingDefs, type SettingDef } from "../components/settings-defs";
import { readCustomStatusLinePresets } from "../components/status-line/custom-presets";
import { createTheme, loadThemeJson } from "../theme/loader";
import type { ThemeJson } from "../theme/schema";
import { getAvailableThemes } from "../theme/theme";
import type {
	RpcSettingCatalogItem,
	RpcSettingEditor,
	RpcSettingOption,
	RpcSettingsCatalog,
	RpcSettingsLocale,
	RpcSettingsSnapshot,
	RpcSettingValue,
	RpcThemePalette,
	RpcThemeVariants,
} from "./rpc-types";

function isSettingPath(value: string): value is SettingPath {
	return Object.hasOwn(SETTINGS_SCHEMA, value);
}

function canonicalDefs(locale: RpcSettingsLocale): Array<SettingDef & { path: SettingPath }> {
	return getAllSettingDefs(locale).filter((def): def is SettingDef & { path: SettingPath } => isSettingPath(def.path));
}

const ADVANCED_SETTINGS_TAB = "advanced";

function settingPaths(): SettingPath[] {
	return Object.keys(SETTINGS_SCHEMA) as SettingPath[];
}

function rpcValue(value: unknown): RpcSettingValue | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (Array.isArray(value)) {
		const result: RpcSettingValue[] = [];
		for (const entry of value) {
			const serialized = rpcValue(entry);
			if (serialized !== undefined) result.push(serialized);
		}
		return result;
	}
	if (typeof value !== "object") return undefined;
	const result: Record<string, RpcSettingValue> = {};
	for (const [key, entry] of Object.entries(value)) {
		const serialized = rpcValue(entry);
		if (serialized !== undefined) result[key] = serialized;
	}
	return result;
}

function editorFor(def: SettingDef): RpcSettingEditor {
	switch (def.type) {
		case "boolean":
			return "boolean";
		case "enum":
		case "submenu":
			return "select";
		case "number":
			return "number";
		case "multiselect":
			return "multiselect";
		case "providerLimits":
			return "json";
		case "text":
			return def.secret ? "secret" : getType(def.path) === "record" ? "json" : "text";
	}
}

function editorForPath(path: SettingPath): RpcSettingEditor {
	switch (getType(path)) {
		case "boolean":
			return "boolean";
		case "enum":
			return "select";
		case "number":
			return "number";
		case "array":
		case "record":
			return "json";
		case "string":
			return isCredential(path) ? "secret" : "text";
	}
}

function fallbackCatalogItem(path: SettingPath, settings: Settings, locale: RpcSettingsLocale): RpcSettingCatalogItem {
	const ui = getUi(path);
	const credential = isCredential(path);
	const defaultValue = credential ? undefined : rpcValue(getDefault(path));
	const namespace = path.includes(".") ? path.slice(0, path.indexOf(".")) : "general";
	const item: RpcSettingCatalogItem = {
		path,
		tab: ui?.tab ?? ADVANCED_SETTINGS_TAB,
		scope: getSettingScope(path),
		group: ui?.group ?? namespace,
		groupLabel: ui?.group ? tSettingsUi(ui.group, undefined, locale) : namespace,
		label: ui ? tSettingsUi(ui.label, undefined, locale) : path,
		description: ui
			? tSettingsUi(ui.description, undefined, locale)
			: tSettingsUi("Canonical OMP configuration key: {path}", { path }, locale),
		editor: editorForPath(path),
		visible: isSettingsUiConditionMet(ui?.condition, settings, {
			hasImageProtocol: !!TERMINAL.imageProtocol,
		}),
		credential,
		...(defaultValue !== undefined ? { defaultValue } : {}),
	};
	const enumValues = getEnumValues(path);
	if (enumValues)
		item.options = enumValues.map(value => ({
			value,
			label: tSettingsUi(value, undefined, locale),
		}));
	if (getType(path) === "number") {
		item.min = ui?.min;
		item.max = ui?.max;
		item.integer = ui?.integer === true;
	}
	return item;
}

function declaredOptions(def: SettingDef, locale: RpcSettingsLocale): RpcSettingOption[] | undefined {
	if (def.type === "enum")
		return def.values.map(value => ({
			value,
			label: tSettingsUi(value, undefined, locale),
		}));
	if (def.type !== "submenu" && def.type !== "multiselect") return undefined;
	return def.options.map(option => ({ ...option }));
}

async function optionsFor(
	def: SettingDef,
	settings: Settings,
	themes: Promise<string[]>,
	locale: RpcSettingsLocale,
): Promise<RpcSettingOption[] | undefined> {
	if (def.path === "theme.dark" || def.path === "theme.light") {
		return (await themes).map(value => ({ value, label: value }));
	}
	if (def.path === "statusLine.customPreset") {
		const presets = readCustomStatusLinePresets(settings.get("statusLine.customPresets"));
		return [
			{ value: "default", label: tSettingsUi("Default", undefined, locale) },
			...Object.entries(presets).map(([value, preset]) => ({
				value,
				label: preset.label,
				...(preset.description ? { description: preset.description } : {}),
			})),
		];
	}
	const options = declaredOptions(def, locale);
	if (def.path !== "providers.webSearchOrder" || !options) return options;
	const excluded = new Set<string>(settings.get("providers.webSearchExclude"));
	return options.filter(option => !excluded.has(option.value));
}

async function rpcThemePalette(name: string, fallback: string): Promise<RpcThemePalette> {
	let id = name;
	let json: ThemeJson;
	try {
		json = await loadThemeJson(id);
	} catch {
		id = fallback;
		json = await loadThemeJson(id);
	}
	const resolved = createTheme(json, { mode: "truecolor" });
	return {
		id,
		name: json.name,
		neutral: resolved.getSurfaceBackgroundColorHex(),
		ink: resolved.getColorHex("text"),
		primary: resolved.getColorHex("accent"),
		success: resolved.getColorHex("success"),
		warning: resolved.getColorHex("warning"),
		error: resolved.getColorHex("error"),
		info: resolved.getColorHex("mdLink"),
		interactive: resolved.getColorHex("borderAccent"),
		diffAdd: resolved.getColorHex("toolDiffAdded"),
		diffDelete: resolved.getColorHex("toolDiffRemoved"),
	};
}

async function rpcThemeVariants(settings: Settings): Promise<RpcThemeVariants> {
	const light = settings.get("theme.light") ?? "light";
	const dark = settings.get("theme.dark") ?? "titanium";
	const [lightPalette, darkPalette] = await Promise.all([
		rpcThemePalette(light, "light"),
		rpcThemePalette(dark, "titanium"),
	]);
	return { light: lightPalette, dark: darkPalette };
}

export async function buildRpcSettingsCatalog(
	settings: Settings,
	locale: RpcSettingsLocale = getSettingsUiLocale(),
): Promise<RpcSettingsCatalog> {
	const themes = getAvailableThemes();
	const defs = canonicalDefs(locale);
	const defsByPath = new Map(defs.map(def => [def.path, def]));
	const items = await Promise.all(
		settingPaths().map(async path => {
			const def = defsByPath.get(path);
			if (!def) return fallbackCatalogItem(path, settings, locale);
			const credential = isCredential(def.path);
			const defaultValue = credential ? undefined : rpcValue(getDefault(def.path));
			const item: RpcSettingCatalogItem = {
				path: def.path,
				tab: def.tab,
				scope: getSettingScope(def.path),
				...(def.group ? { group: def.group } : {}),
				...(def.groupLabel ? { groupLabel: def.groupLabel } : {}),
				label: def.label,
				description: def.description,
				editor: editorFor(def),
				visible: isSettingsUiConditionMet(def.conditionName, settings, {
					hasImageProtocol: !!TERMINAL.imageProtocol,
				}),
				credential,
				...(defaultValue !== undefined ? { defaultValue } : {}),
			};
			const options = await optionsFor(def, settings, themes, locale);
			if (options) item.options = options;
			if (def.type === "multiselect") item.ordered = def.ordered;
			if (def.type === "number") {
				item.min = def.min;
				item.max = def.max;
				item.integer = def.integer;
			}
			return item;
		}),
	);
	return {
		version: 1,
		locale,
		tabs: [
			...SETTING_TABS.map(id => ({
				id,
				label: tSettingsUi(TAB_METADATA[id].label, undefined, locale),
			})),
			{
				id: ADVANCED_SETTINGS_TAB,
				label: tSettingsUi("Advanced", undefined, locale),
			},
		],
		settings: items,
		theme: await rpcThemeVariants(settings),
	};
}

export function buildRpcSettingsSnapshot(settings: Settings): RpcSettingsSnapshot {
	const values: RpcSettingsSnapshot["values"] = {};
	const configured: SettingPath[] = [];
	const redacted: SettingPath[] = [];
	for (const path of settingPaths()) {
		if (settings.isConfigured(path)) configured.push(path);
		if (isCredential(path)) {
			redacted.push(path);
			continue;
		}
		const value = rpcValue(settings.get(path));
		if (value !== undefined) values[path] = value;
	}
	return { version: 1, values, configured, redacted };
}

function validateObject(path: SettingPath, value: RpcSettingValue): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must be an object`);
	}
	return value;
}

export async function updateRpcSetting(
	settings: Settings,
	rawPath: string,
	value: RpcSettingValue,
): Promise<RpcSettingsSnapshot> {
	if (!isSettingPath(rawPath)) {
		throw new Error(`Unknown setting: ${rawPath}`);
	}
	const path = rawPath;
	const type = getType(path);
	const ui = getUi(path);
	if (type === "boolean") {
		if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
	} else if (type === "string") {
		if (typeof value !== "string") throw new Error(`${path} must be a string`);
		const item = (await buildRpcSettingsCatalog(settings)).settings.find(candidate => candidate.path === path);
		if (item?.options && !item.options.some(option => option.value === value)) {
			throw new Error(`${path} must be one of the available options`);
		}
	} else if (type === "enum") {
		if (
			typeof value !== "string" ||
			!(SETTINGS_SCHEMA[path] as { values: readonly string[] }).values.includes(value)
		) {
			throw new Error(`${path} must be one of the declared enum values`);
		}
	} else if (type === "number") {
		if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
		if (ui?.integer && !Number.isInteger(value)) throw new Error(`${path} must be an integer`);
		if (ui?.min !== undefined && value < ui.min) throw new Error(`${path} must be at least ${ui.min}`);
		if (ui?.max !== undefined && value > ui.max) throw new Error(`${path} must be at most ${ui.max}`);
	} else if (type === "array") {
		if (!Array.isArray(value) || !value.every(entry => typeof entry === "string")) {
			throw new Error(`${path} must be an array of strings`);
		}
		const allowed = ui?.options;
		if (Array.isArray(allowed) && value.some(entry => !allowed.some(option => option.value === entry))) {
			throw new Error(`${path} contains an unsupported value`);
		}
	} else if (path === "providers.maxInFlightRequests") {
		value = validateProviderMaxInFlightRequests(validateObject(path, value)) as RpcSettingValue;
	} else {
		value = validateObject(path, value) as RpcSettingValue;
	}
	settings.set(path, value as never);
	await settings.flush();
	return buildRpcSettingsSnapshot(settings);
}
