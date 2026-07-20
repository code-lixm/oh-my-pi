import { Languages } from "lucide-react";
import { t } from "../locale/catalog";
import { type Locale, setLocale, useLocale } from "../useLocale";

const NEXT_LOCALE: Record<Locale, Locale> = {
	en: "zh-CN",
	"zh-CN": "en",
};

export function LocaleToggle() {
	const locale = useLocale();
	const next = NEXT_LOCALE[locale];
	return (
		<button
			type="button"
			className="stats-locale-toggle"
			onClick={() => setLocale(next)}
			data-locale={locale}
			aria-label={t(`localeToggle.cycleHint.to-${next}`)}
			title={t(`localeToggle.cycleHint.to-${next}`)}
		>
			<Languages size={16} />
			<span className="stats-locale-toggle-label">{t(`localeToggle.label.${locale}`)}</span>
		</button>
	);
}
