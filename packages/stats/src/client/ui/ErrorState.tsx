import { t } from "../locale/catalog";
import { useLocale } from "../useLocale";

export interface ErrorStateProps {
	error?: Error | null;
	onRetry?: () => void;
	className?: string;
}

export function ErrorState({ error, onRetry, className = "" }: ErrorStateProps) {
	useLocale();
	return (
		<div className={`stats-error-state ${className}`}>
			<div className="stats-error-state-content">
				<h4 className="stats-error-state-title">{t("state.error.title")}</h4>
				{error && <p className="stats-error-state-message">{error.message}</p>}
				{onRetry && (
					<button
						type="button"
						onClick={onRetry}
						className="stats-button stats-button-secondary stats-error-state-btn"
					>
						{t("state.error.retry")}
					</button>
				)}
			</div>
		</div>
	);
}
