import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatCompact } from "../src/client/data/formatters";
import { getLocale, setLocale, type Locale } from "../src/client/useLocale";
import { MetricCluster } from "../src/client/ui/MetricCluster";
import type { AggregatedStats } from "../src/shared-types";

const stats: AggregatedStats = {
	totalRequests: 1,
	successfulRequests: 1,
	failedRequests: 0,
	errorRate: 0,
	totalInputTokens: 100,
	totalOutputTokens: 20,
	totalCacheReadTokens: 300,
	totalCacheWriteTokens: 40,
	cacheRate: 0.75,
	cacheSavings: 0.695,
	totalCost: 0,
	totalPremiumRequests: 0,
	avgDuration: 1000,
	avgTtft: 100,
	avgTokensPerSecond: 20,
	firstTimestamp: 1,
	lastTimestamp: 1,
};

let previousLocale: Locale;

beforeEach(() => {
	previousLocale = getLocale();
});

afterEach(() => {
	setLocale(previousLocale);
});

function expectVisibleMetricLabel(html: string, label: string): void {
	expect(html).toContain(`<div class="stats-metric-label">${label}</div>`);
}

describe("overview token metrics", () => {
	it("renders localized token metrics, including cache savings and reconciled conversation total", () => {
		const expectedTotal = formatCompact(
			stats.totalInputTokens +
				stats.totalOutputTokens +
				stats.totalCacheReadTokens +
				stats.totalCacheWriteTokens,
		);

		const cases: Array<{
			locale: Locale;
			labels: string[];
			conversationTotalTitle: string;
			cacheSavingsTitle: string;
			cacheRateTitle: string;
		}> = [
			{
				locale: "en",
				labels: ["Uncached Input", "Cache Read", "Output Tokens", "Conversation Total", "Cache Rate", "Cache Savings"],
				conversationTotalTitle: "Uncached input + cache reads + cache writes + output",
				cacheSavingsTitle:
					"Prompt-input cost saved versus billing the same tokens uncached; cache writes can make this negative",
				cacheRateTitle: "Prompt input served from cache: cache reads / (uncached input + cache reads)",
			},
			{
				locale: "zh-CN",
				labels: ["未缓存输入", "缓存读取", "输出 Token", "对话 Token 总量", "缓存率", "缓存节省"],
				conversationTotalTitle: "未缓存输入 + 缓存读取 + 缓存写入 + 输出",
				cacheSavingsTitle: "相较于将相同提示词输入按未缓存计费所节省的成本；缓存写入可能使该值为负数",
				cacheRateTitle: "由缓存提供的提示词输入：缓存读取 ÷（未缓存输入 + 缓存读取）",
			},
		];

		for (const { locale, labels, conversationTotalTitle, cacheSavingsTitle, cacheRateTitle } of cases) {
			setLocale(locale);
			const html = renderToStaticMarkup(<MetricCluster stats={stats} />);

			for (const label of labels) expectVisibleMetricLabel(html, label);
			expect(html).toContain(`title="${conversationTotalTitle}"`);
			expect(html).toContain(`title="${cacheSavingsTitle}"`);
			expect(html).toContain(`title="${cacheRateTitle}"`);
			expect(html).toContain("75.0%");
			expect(html).toContain("69.5%");
			expect(html).toContain(`<div class="stats-metric-value">${expectedTotal}</div>`);
		}
	});
});
