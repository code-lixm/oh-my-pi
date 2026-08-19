import type { SettingPath, SettingValue } from "./settings-schema";

export interface SettingsUiConditionReader {
	get<P extends SettingPath>(path: P): SettingValue<P>;
}

export interface SettingsUiConditionRuntime {
	hasImageProtocol: boolean;
}

/** Evaluate a schema-declared settings visibility condition against one settings scope. */
export function isSettingsUiConditionMet(
	condition: string | undefined,
	settings: SettingsUiConditionReader,
	runtime: SettingsUiConditionRuntime,
): boolean {
	if (!condition) return true;
	switch (condition) {
		case "hasImageProtocol":
			return runtime.hasImageProtocol;
		case "advisorEnabled":
			return settings.get("advisor.enabled") === true;
		case "hindsightActive":
			return settings.get("memory.backend") === "hindsight";
		case "mnemopiActive":
			return settings.get("memory.backend") === "mnemopi";
		case "autolearnActive":
			return settings.get("autolearn.enabled") === true;
		case "autoThinkingActive":
			return settings.get("defaultThinkingLevel") === "auto";
		case "usageAwareFallbackEnabled":
			return settings.get("retry.usageAwareFallback") === true;
		case "planModeEnabled":
			return settings.get("plan.enabled");
		default:
			return true;
	}
}
