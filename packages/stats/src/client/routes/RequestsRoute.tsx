import { useMemo } from "react";
import { getRecentRequests } from "../api";
import { formatCost, formatDurationMs, formatInteger, formatRelativeTime } from "../data/formatters";
import { useResource } from "../data/useResource";
import { t } from "../locale/catalog";
import type { MessageStats, TimeRange } from "../types";
import { AsyncBoundary, DataTable, Panel, StatusPill } from "../ui";
import { useLocale } from "../useLocale";

export interface RequestsRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
	onRequestClick: (id: number) => void;
}

export function RequestsRoute({ active, refreshTrigger, onRequestClick }: RequestsRouteProps) {
	useLocale();
	const locale = useLocale();
	const {
		data: recentRequests,
		error,
		loading,
	} = useResource(["recent-requests-dense", refreshTrigger], signal => getRecentRequests(50, signal), {
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
			{
				key: "duration",
				header: t("table.column.duration"),
				numeric: true,
				render: (item: MessageStats) => formatDurationMs(item.duration),
			},
			{
				key: "status",
				header: t("table.column.status"),
				className: "stats-text-center",
				render: (item: MessageStats) => (
					<StatusPill variant={item.errorMessage ? "danger" : "success"}>
						{item.errorMessage ? t("table.status.failed") : t("table.status.success")}
					</StatusPill>
				),
			},
		],
		[locale],
	);

	const renderMobileCard = (item: MessageStats, onClick?: () => void) => (
		<div className="stats-mobile-card" onClick={onClick}>
			<div className="stats-mobile-card-header">
				<div>
					<div className="stats-font-semibold stats-text-primary">{item.model}</div>
					<div className="stats-text-xs stats-text-muted">{item.provider}</div>
				</div>
				<StatusPill variant={item.errorMessage ? "danger" : "success"}>
					{item.errorMessage ? t("table.status.failed") : t("table.status.success")}
				</StatusPill>
			</div>
			<div className="stats-mobile-card-grid">
				<div>
					<div className="stats-mobile-card-label">{t("table.column.time")}</div>
					<div className="stats-mobile-card-value">{formatRelativeTime(item.timestamp)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{t("requests.mobile.cost")}</div>
					<div className="stats-mobile-card-value">{formatCost(item.usage.cost.total, 4)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{t("requests.mobile.tokens")}</div>
					<div className="stats-mobile-card-value">{formatInteger(item.usage.totalTokens)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{t("requests.mobile.duration")}</div>
					<div className="stats-mobile-card-value">{formatDurationMs(item.duration)}</div>
				</div>
			</div>
			{item.errorMessage && <div className="stats-mobile-card-error truncate mt-2">{item.errorMessage}</div>}
		</div>
	);

	return (
		<div className="stats-route-container">
			<Panel title={t("requests.title")} subtitle={t("requests.subtitle")}>
				<AsyncBoundary loading={loading} error={error} data={recentRequests}>
					<DataTable
						columns={columns}
						data={recentRequests || []}
						keyExtractor={item => item.id || `${item.sessionFile}-${item.entryId}`}
						onRowClick={item => item.id && onRequestClick(item.id)}
						renderMobileCard={renderMobileCard}
						emptyText={t("requests.empty")}
					/>
				</AsyncBoundary>
			</Panel>
		</div>
	);
}
