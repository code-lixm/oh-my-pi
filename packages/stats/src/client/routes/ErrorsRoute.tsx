import { useMemo } from "react";
import { getRecentErrors } from "../api";
import { formatCost, formatInteger, formatRelativeTime } from "../data/formatters";
import { useResource } from "../data/useResource";
import { t } from "../locale/catalog";
import type { MessageStats, TimeRange } from "../types";
import { AsyncBoundary, DataTable, Panel, StatusPill } from "../ui";
import { useLocale } from "../useLocale";

export interface ErrorsRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
	onRequestClick: (id: number) => void;
}

export function ErrorsRoute({ active, range, refreshTrigger, onRequestClick }: ErrorsRouteProps) {
	const locale = useLocale();
	const {
		data: recentErrors,
		error,
		loading,
	} = useResource(["recent-errors-dense", range, refreshTrigger], signal => getRecentErrors(range, 50, signal), {
		pollMs: 30000,
		enabled: active,
	});

	const columns = useMemo(
		() => [
			{
				key: "model",
				header: t("table.column.model"),
				render: (item: MessageStats) => (
					<div>
						<div className="stats-font-medium stats-text-primary">{item.model}</div>
						<div className="stats-text-xs stats-text-muted">{item.provider}</div>
					</div>
				),
			},
			{
				key: "timestamp",
				header: t("table.column.time"),
				render: (item: MessageStats) => formatRelativeTime(item.timestamp),
			},
			{
				key: "errorMessage",
				header: t("errors.column.errorMessage"),
				render: (item: MessageStats) => (
					<div
						className="stats-text-xs stats-text-danger stats-truncate stats-max-w-md stats-font-mono"
						title={item.errorMessage || ""}
					>
						{item.errorMessage || t("errors.unknownError")}
					</div>
				),
			},
			{
				key: "tokens",
				header: t("table.column.tokens"),
				numeric: true,
				render: (item: MessageStats) => formatInteger(item.usage.totalTokens),
			},
			{
				key: "cost",
				header: t("table.column.cost"),
				numeric: true,
				render: (item: MessageStats) => formatCost(item.usage.cost.total, 4),
			},
		],
		[locale],
	);

	const renderMobileCard = (item: MessageStats, onClick?: () => void) => (
		<div className="stats-mobile-card stats-border-danger" onClick={onClick}>
			<div className="stats-mobile-card-header">
				<div>
					<div className="stats-font-semibold stats-text-primary">{item.model}</div>
					<div className="stats-text-xs stats-text-muted">{item.provider}</div>
				</div>
				<StatusPill variant="danger">{t("errors.mobile.status.failed")}</StatusPill>
			</div>
			<div className="stats-mobile-card-grid">
				<div>
					<div className="stats-mobile-card-label">{t("table.column.time")}</div>
					<div className="stats-mobile-card-value">{formatRelativeTime(item.timestamp)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{t("errors.mobile.cost")}</div>
					<div className="stats-mobile-card-value">{formatCost(item.usage.cost.total, 4)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{t("errors.mobile.tokens")}</div>
					<div className="stats-mobile-card-value">{formatInteger(item.usage.totalTokens)}</div>
				</div>
			</div>
			{item.errorMessage && <div className="stats-mobile-card-error mt-2 stats-font-mono">{item.errorMessage}</div>}
		</div>
	);

	return (
		<div className="stats-route-container">
			<Panel title={t("errors.title")} subtitle={t("errors.subtitle")}>
				<AsyncBoundary loading={loading} error={error} data={recentErrors} emptyText={t("errors.empty")}>
					<DataTable
						columns={columns}
						data={recentErrors || []}
						keyExtractor={item => item.id || `${item.sessionFile}-${item.entryId}`}
						onRowClick={item => item.id && onRequestClick(item.id)}
						renderMobileCard={renderMobileCard}
						emptyText={t("errors.empty")}
					/>
				</AsyncBoundary>
			</Panel>
		</div>
	);
}
