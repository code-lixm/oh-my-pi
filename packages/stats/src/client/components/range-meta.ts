/**
 * Display metadata for a `TimeRange` — keeps chart labels, sparkline bucket
 * counts, and x-axis date formatting in sync with the server-side bucketing
 * defined in `aggregator.ts`.
 */

import { format } from "date-fns";
import { t } from "../locale/catalog";
import type { TimeRange } from "../types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FIVE_MIN_MS = 5 * 60 * 1000;

export interface RangeMeta {
	/** Human label used in chart subtitles ("the last 24 hours"). */
	windowLabel: string;
	/** Short prefix used in compact column headers ("24h Trend"). */
	trendLabel: string;
	/** Bucket size matching the server query for this range. */
	bucketMs: number;
	/** Number of buckets the server is expected to return for this range. */
	bucketCount: number;
	/** date-fns format string for x-axis labels and tooltip headings. */
	tickFormat: string;
}

interface RangeSpec {
	windowKey: string;
	trendKey: string;
	bucketMs: number;
	bucketCount: number;
	tickFormat: string;
}

const RANGE_SPECS: Record<TimeRange, RangeSpec> = {
	"1h": {
		windowKey: "rangeMeta.1h.window",
		trendKey: "rangeMeta.1h.trend",
		bucketMs: FIVE_MIN_MS,
		bucketCount: 12,
		tickFormat: "HH:mm",
	},
	"24h": {
		windowKey: "rangeMeta.24h.window",
		trendKey: "rangeMeta.24h.trend",
		bucketMs: HOUR_MS,
		bucketCount: 24,
		tickFormat: "HH:mm",
	},
	"7d": {
		windowKey: "rangeMeta.7d.window",
		trendKey: "rangeMeta.7d.trend",
		bucketMs: DAY_MS,
		bucketCount: 7,
		tickFormat: "MMM d",
	},
	"30d": {
		windowKey: "rangeMeta.30d.window",
		trendKey: "rangeMeta.30d.trend",
		bucketMs: DAY_MS,
		bucketCount: 30,
		tickFormat: "MMM d",
	},
	"90d": {
		windowKey: "rangeMeta.90d.window",
		trendKey: "rangeMeta.90d.trend",
		bucketMs: DAY_MS,
		bucketCount: 90,
		tickFormat: "MMM d",
	},
	all: {
		windowKey: "rangeMeta.all.window",
		trendKey: "rangeMeta.all.trend",
		bucketMs: DAY_MS,
		bucketCount: 0,
		tickFormat: "MMM d",
	},
};

/**
 * Resolve localized metadata for a time range. Reads the current locale at
 * call time so it surfaces zh-CN strings after a locale flip, provided the
 * caller lists the active `locale` in its `useMemo` deps.
 */
export function rangeMeta(range: TimeRange): RangeMeta {
	const spec = RANGE_SPECS[range];
	return {
		windowLabel: t(spec.windowKey),
		trendLabel: t(spec.trendKey),
		bucketMs: spec.bucketMs,
		bucketCount: spec.bucketCount,
		tickFormat: spec.tickFormat,
	};
}

/** Format a bucket timestamp using the active range's tick format. */
export function formatRangeTick(timestamp: number, range: TimeRange): string {
	return format(new Date(timestamp), RANGE_SPECS[range].tickFormat);
}
