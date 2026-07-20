import { t } from "../locale/catalog";
import { useLocale } from "../useLocale";
import { type DashboardSection, routes } from "./routes";

export interface NavRailProps {
	activeSection: DashboardSection;
	onSectionChange: (section: DashboardSection) => void;
	className?: string;
}

export function NavRail({ activeSection, onSectionChange, className = "" }: NavRailProps) {
	// Subscribe so labels re-render when the locale changes (the t() helper
	// itself is sync and can be called anywhere, but this re-render is what
	// makes the nav reflect the active locale when the cycle button flips).
	useLocale();
	return (
		<aside className={`stats-nav-rail ${className}`}>
			<div className="stats-nav-rail-header">
				<div className="stats-logo-container">
					<span className="stats-logo-text">OH MY PI</span>
					<span className="stats-logo-subtext">{t("layout.logo.subtext")}</span>
				</div>
			</div>

			<nav className="stats-nav-rail-menu">
				{routes.map(route => {
					const isActive = route.id === activeSection;
					const Icon = route.icon;
					return (
						<button
							key={route.id}
							type="button"
							onClick={() => onSectionChange(route.id)}
							className="stats-nav-rail-item"
							data-active={isActive ? "true" : "false"}
							aria-current={isActive ? "page" : undefined}
						>
							<Icon size={16} className="stats-nav-rail-item-icon" />
							<span className="stats-nav-rail-item-label">{t(`nav.${route.id}`)}</span>
						</button>
					);
				})}
			</nav>

			<div className="stats-nav-rail-footer">
				<span className="stats-version-tag">OMP Stats v1.0.0</span>
			</div>
		</aside>
	);
}
