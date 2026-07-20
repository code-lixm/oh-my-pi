import { t } from "../locale/catalog";
import type { TimeRange } from "../types";

export interface RangeControlProps {
	value: TimeRange;
	onChange: (value: TimeRange) => void;
	className?: string;
}

const RANGE_OPTIONS: { value: TimeRange }[] = [
	{ value: "1h" },
	{ value: "24h" },
	{ value: "7d" },
	{ value: "30d" },
	{ value: "90d" },
	{ value: "all" },
];

export function RangeControl({ value, onChange, className = "" }: RangeControlProps) {
	return (
		<div className={`stats-range-control ${className}`} role="radiogroup" aria-label={t("rangeControl.aria")}>
			{RANGE_OPTIONS.map(opt => {
				const isActive = opt.value === value;
				const label = opt.value === "all" ? t("rangeControl.all") : opt.value;
				return (
					<button
						key={opt.value}
						type="button"
						role="radio"
						aria-checked={isActive}
						data-active={isActive ? "true" : "false"}
						className="stats-range-control-btn"
						onClick={() => onChange(opt.value)}
					>
						{label}
					</button>
				);
			})}
		</div>
	);
}
