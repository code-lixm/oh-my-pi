export type RpcSettingPath = string;
export type RpcSettingTab = string;
export type RpcSettingScope = "shared" | "cli";
export type RpcSettingValue = boolean | string | number | null | RpcSettingValue[] | { [key: string]: RpcSettingValue };
export type RpcSettingsLocale = "en" | "zh-CN";

export interface RpcSettingOption {
	value: string;
	label: string;
	description?: string;
}

export type RpcSettingEditor = "boolean" | "select" | "text" | "secret" | "number" | "multiselect" | "json";
export interface RpcThemePalette {
	id: string;
	name: string;
	neutral: string;
	ink: string;
	primary: string;
	success: string;
	warning: string;
	error: string;
	info: string;
	interactive: string;
	diffAdd: string;
	diffDelete: string;
}

export interface RpcThemeVariants {
	light: RpcThemePalette;
	dark: RpcThemePalette;
}

export interface RpcSettingCatalogItem {
	path: RpcSettingPath;
	tab: RpcSettingTab;
	scope: RpcSettingScope;
	group?: string;
	groupLabel?: string;
	label: string;
	description: string;
	editor: RpcSettingEditor;
	visible: boolean;
	credential: boolean;
	defaultValue?: RpcSettingValue;
	options?: RpcSettingOption[];
	ordered?: boolean;
	min?: number;
	max?: number;
	integer?: boolean;
}

export interface RpcSettingsCatalog {
	version: 1;
	locale: RpcSettingsLocale;
	tabs: Array<{ id: RpcSettingTab; label: string }>;
	settings: RpcSettingCatalogItem[];
	theme: RpcThemeVariants;
}

export interface RpcSettingsSnapshot {
	version: 1;
	values: Partial<Record<RpcSettingPath, RpcSettingValue>>;
	configured: RpcSettingPath[];
	redacted: RpcSettingPath[];
}
