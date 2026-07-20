import { useMemo } from "react";
import { formatCompact, formatInteger, formatPercent } from "../data/formatters";
import { buildAgentTokenShare } from "../data/view-models";
import { t } from "../locale/catalog";
import type { AgentType, AgentTypeStats } from "../types";
import { useLocale } from "../useLocale";

/**
 * Per-agent-type display chrome. Colors follow the OMP brand palette
 * (pink -> violet -> cyan) used by the dashboard charts so the bar reads on
 * both themes without per-theme overrides.
 */
const AGENT_META: Record<AgentType, { labelKey: string; color: string }> = {
	main: { labelKey: "agentShare.main", color: "#ed4abf" },
	subagent: { labelKey: "agentShare.subagent", color: "#9b4dff" },
	advisor: { labelKey: "agentShare.advisor", color: "#5ad8e6" },
};

export interface AgentTokenShareProps {
	stats: AgentTypeStats[];
}

export function AgentTokenShare({ stats }: AgentTokenShareProps) {
	// Subscribe so labels re-render when the user flips locale; t() resolves
	// at render time.
	useLocale();
	const view = useMemo(() => buildAgentTokenShare(stats), [stats]);
	const emptyText = t("agentShare.empty");
	const reqUnit = t("agentShare.unit.req");
	const tokUnit = t("agentShare.unit.tok");

	if (view.totalTokens === 0) {
		return <div className="py-8 text-center stats-text-muted text-sm">{emptyText}</div>;
	}

	return (
		<div className="space-y-4">
			<div className="flex h-3 w-full overflow-hidden rounded-full" style={{ background: "var(--surface-2)" }}>
				{view.segments.map(
					seg =>
						seg.share > 0 && (
							<div
								key={seg.agentType}
								className="h-full"
								style={{ width: `${seg.share * 100}%`, background: AGENT_META[seg.agentType].color }}
								title={`${t(AGENT_META[seg.agentType].labelKey)}: ${formatPercent(seg.share)}`}
							/>
						),
				)}
			</div>

			<div className="space-y-2">
				{view.segments.map(seg => (
					<div key={seg.agentType} className="flex items-center justify-between gap-3 text-sm">
						<div className="flex items-center gap-2 min-w-0">
							<span
								className="w-2.5 h-2.5 rounded-full flex-shrink-0"
								style={{ background: AGENT_META[seg.agentType].color }}
							/>
							<span className="stats-text-primary truncate">{t(AGENT_META[seg.agentType].labelKey)}</span>
							<span className="stats-text-muted stats-text-xs whitespace-nowrap">
								{formatInteger(seg.requests)} {reqUnit}
							</span>
						</div>
						<div className="flex items-center gap-3 whitespace-nowrap">
							<span className="stats-text-secondary">
								{formatCompact(seg.tokens)} {tokUnit}
							</span>
							<span className="stats-font-semibold stats-text-primary tabular-nums">
								{formatPercent(seg.share)}
							</span>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
