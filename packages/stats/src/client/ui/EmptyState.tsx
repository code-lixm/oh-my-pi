import { Inbox, type LucideIcon } from "lucide-react";
import { t } from "../locale/catalog";
import { useLocale } from "../useLocale";

export interface EmptyStateProps {
	message?: string;
	icon?: LucideIcon;
	className?: string;
}

export function EmptyState({ message, icon: Icon = Inbox, className = "" }: EmptyStateProps) {
	useLocale();
	const finalMessage = message ?? t("state.empty.default");
	return (
		<div className={`stats-empty-state ${className}`}>
			<Icon size={24} className="stats-empty-state-icon" aria-hidden="true" />
			<p className="stats-empty-state-message">{finalMessage}</p>
		</div>
	);
}
