import { type LucideIcon, Monitor, Moon, Sun } from "lucide-react";
import { t } from "../locale/catalog";
import { type ThemePreference, useThemePreference } from "../useSystemTheme";

const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
	system: "light",
	light: "dark",
	dark: "system",
};

const PREFERENCE_ICON: Record<ThemePreference, LucideIcon> = {
	system: Monitor,
	light: Sun,
	dark: Moon,
};

const PREFERENCE_LABEL_KEY: Record<ThemePreference, string> = {
	system: "themeToggle.system",
	light: "themeToggle.light",
	dark: "themeToggle.dark",
};

export function ThemeToggle() {
	const { preference, setPreference } = useThemePreference();
	const Icon = PREFERENCE_ICON[preference];
	const label = t(PREFERENCE_LABEL_KEY[preference]);
	const titleSuffix = t("themeToggle.cycleHint.title");
	const ariaSuffix = t("themeToggle.cycleHint.aria");

	return (
		<button
			type="button"
			className="stats-theme-toggle"
			onClick={() => setPreference(NEXT_PREFERENCE[preference])}
			aria-label={`${label}${ariaSuffix}`}
			title={`${label}${titleSuffix}`}
		>
			<Icon size={16} />
		</button>
	);
}
