import { Menu } from "lucide-react";
import { t } from "../locale/catalog";
import type { TimeRange } from "../types";
import { useLocale } from "../useLocale";
import { LocaleToggle } from "./LocaleToggle";
import { RangeControl } from "./RangeControl";
import type { DashboardSection } from "./routes";
import { SyncButton } from "./SyncButton";
import { ThemeToggle } from "./ThemeToggle";

export interface TopBarProps {
	activeSection: DashboardSection;
	range: TimeRange;
	onRangeChange: (range: TimeRange) => void;
	updatedAt: number | null;
	onSyncStart?: () => void;
	onSyncComplete?: (result: { success: boolean }) => void;
	onMenuToggle?: () => void;
	className?: string;
}

export function TopBar({
	activeSection,
	range,
	onRangeChange,
	updatedAt,
	onSyncStart,
	onSyncComplete,
	onMenuToggle,
	className = "",
}: TopBarProps) {
	const locale = useLocale();
	const title = t(`nav.${activeSection}`);

	const formatLastUpdated = (time: number | null) => {
		if (!time) return t("topBar.lastUpdated.notUpdated");
		const date = new Date(time);
		const hh = date.toLocaleTimeString(locale, {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		return t("topBar.lastUpdated.prefix", { time: hh });
	};

	return (
		<header className={`stats-top-bar ${className}`}>
			<div className="stats-top-bar-left">
				{onMenuToggle && (
					<button
						type="button"
						onClick={onMenuToggle}
						className="stats-mobile-menu-btn"
						aria-label={t("topBar.menu.open")}
					>
						<Menu size={20} />
					</button>
				)}
				<h1 className="stats-page-title">{title}</h1>
			</div>

			<div className="stats-top-bar-right">
				<div className="stats-top-bar-meta">
					<span
						className="stats-last-updated"
						title={updatedAt ? new Date(updatedAt).toLocaleString() : undefined}
					>
						{formatLastUpdated(updatedAt)}
					</span>
				</div>

				<RangeControl value={range} onChange={onRangeChange} />

				<ThemeToggle />

				<LocaleToggle />

				<SyncButton onSyncStart={onSyncStart} onSyncComplete={onSyncComplete} />
			</div>
		</header>
	);
}
