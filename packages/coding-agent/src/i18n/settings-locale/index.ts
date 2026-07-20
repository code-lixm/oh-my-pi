import { SETTINGS_EN_MESSAGES } from "./en";
import { SETTINGS_ZH_CN_MESSAGES } from "./zh-CN";

export const SETTINGS_UI_LOCALES = ["en", "zh-CN"] as const;

export type SettingsUiLocale = (typeof SETTINGS_UI_LOCALES)[number];

const MESSAGES: Record<SettingsUiLocale, Record<string, string>> = {
	en: SETTINGS_EN_MESSAGES,
	"zh-CN": SETTINGS_ZH_CN_MESSAGES,
};

let currentLocale: SettingsUiLocale = "en";
let currentLocaleEpoch = 0;

export function normalizeSettingsUiLocale(value: unknown): SettingsUiLocale {
	return value === "zh-CN" ? "zh-CN" : "en";
}

export function setSettingsUiLocale(value: unknown): void {
	const nextLocale = normalizeSettingsUiLocale(value);
	if (nextLocale === currentLocale) return;
	currentLocale = nextLocale;
	currentLocaleEpoch++;
}

export function getSettingsUiLocale(): SettingsUiLocale {
	return currentLocale;
}

export function getSettingsUiLocaleEpoch(): number {
	return currentLocaleEpoch;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
		const value = params[key];
		return value === undefined ? `{${key}}` : String(value);
	});
}

export function tSettingsUi(
	text: string,
	params?: Record<string, string | number>,
	locale = getSettingsUiLocale(),
): string {
	const localized = MESSAGES[locale][text] ?? SETTINGS_EN_MESSAGES[text] ?? text;
	return interpolate(localized, params);
}
