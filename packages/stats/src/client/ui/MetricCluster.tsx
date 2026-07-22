import {
	formatCompact,
	formatCost,
	formatDurationMs,
	formatInteger,
	formatPercent,
	formatTokensPerSecond,
} from "../data/formatters";
import { sumConversationTokens } from "../data/view-models";
import { t } from "../locale/catalog";
import type { AggregatedStats } from "../types";
import { useLocale } from "../useLocale";

export interface MetricClusterProps {
	stats: AggregatedStats;
}

export function MetricCluster({ stats }: MetricClusterProps) {
	useLocale();
	const conversationTokens = sumConversationTokens(stats);

	return (
		<div className="stats-metric-cluster">
			<div className="stats-metric-primary-grid">
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">{t("overview.metric.totalCost")}</div>
					<div className="stats-metric-value">
						{formatCost(stats.totalCost, stats.totalCost > 0 && stats.totalCost < 0.01 ? 4 : 2)}
					</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">{t("overview.metric.requests")}</div>
					<div className="stats-metric-value">{formatInteger(stats.totalRequests)}</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">{t("overview.metric.cacheRate")}</div>
					<div className="stats-metric-value">{formatPercent(stats.cacheRate)}</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">{t("overview.metric.errorRate")}</div>
					<div className="stats-metric-value">{formatPercent(stats.errorRate)}</div>
				</div>
			</div>

			<div className="stats-metric-secondary-grid">
				<div className="stats-metric-card secondary" title={t("overview.metric.uncachedInputTitle")}>
					<div className="stats-metric-label">{t("overview.metric.uncachedInput")}</div>
					<div className="stats-metric-value">{formatCompact(stats.totalInputTokens)}</div>
				</div>
				<div className="stats-metric-card secondary" title={t("overview.metric.cacheReadTitle")}>
					<div className="stats-metric-label">{t("overview.metric.cacheRead")}</div>
					<div className="stats-metric-value">{formatCompact(stats.totalCacheReadTokens)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">{t("overview.metric.outputTokens")}</div>
					<div className="stats-metric-value">{formatCompact(stats.totalOutputTokens)}</div>
				</div>
				<div className="stats-metric-card secondary" title={t("overview.metric.conversationTotalTitle")}>
					<div className="stats-metric-label">{t("overview.metric.conversationTotal")}</div>
					<div className="stats-metric-value">{formatCompact(conversationTokens)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">{t("overview.metric.premiumRequests")}</div>
					<div className="stats-metric-value">{formatInteger(stats.totalPremiumRequests)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">{t("overview.metric.tokensPerSecond")}</div>
					<div className="stats-metric-value">{formatTokensPerSecond(stats.avgTokensPerSecond)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">{t("overview.metric.avgLatency")}</div>
					<div className="stats-metric-value">{formatDurationMs(stats.avgDuration)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">{t("overview.metric.avgTtft")}</div>
					<div className="stats-metric-value">{formatDurationMs(stats.avgTtft)}</div>
				</div>
			</div>
		</div>
	);
}
