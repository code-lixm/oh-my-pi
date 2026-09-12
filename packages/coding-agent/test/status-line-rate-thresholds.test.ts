import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	getMetricThemeColor,
	getThroughputLevel,
	getTtftLevel,
} from "@oh-my-pi/pi-coding-agent/modes/components/status-line/rate-thresholds";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

/** The exact ANSI prefix `theme.fg(color, …)` emits, extracted via a sentinel. */
function fgPrefix(color: Parameters<typeof theme.fg>[0]): string {
	const rendered = theme.fg(color, "\u0000");
	return rendered.slice(0, rendered.indexOf("\u0000"));
}

function ctx(over: { tps?: number | null; ttft?: number | null }): SegmentContext {
	return {
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: over.tps ?? null,
			ttftMs: over.ttft ?? null,
		},
	} as unknown as SegmentContext;
}

describe("rate threshold grading", () => {
	it("grades generation speed into green/yellow/red bands at the documented boundaries", () => {
		// At or above 30 t/s outpaces comfortable reading.
		expect(getThroughputLevel(120)).toBe("good");
		expect(getThroughputLevel(30)).toBe("good");
		expect(getThroughputLevel(29.9)).toBe("fair");
		expect(getThroughputLevel(10)).toBe("fair");
		expect(getThroughputLevel(9.9)).toBe("poor");
		expect(getThroughputLevel(0.2)).toBe("poor");
	});

	it("grades first-token latency with the opposite polarity", () => {
		// Up to 2s feels immediate; past 5s is visibly slow.
		expect(getTtftLevel(400)).toBe("good");
		expect(getTtftLevel(2_000)).toBe("good");
		expect(getTtftLevel(2_001)).toBe("fair");
		expect(getTtftLevel(5_000)).toBe("fair");
		expect(getTtftLevel(5_001)).toBe("poor");
		expect(getTtftLevel(30_000)).toBe("poor");
	});

	it("treats a non-finite reading as the worst band instead of crashing", () => {
		expect(getThroughputLevel(Number.NaN)).toBe("poor");
		expect(getTtftLevel(Number.NaN)).toBe("poor");
	});

	it("maps grades onto the theme's semantic colors", () => {
		expect(getMetricThemeColor("good")).toBe("success");
		expect(getMetricThemeColor("fair")).toBe("warning");
		expect(getMetricThemeColor("poor")).toBe("error");
	});
});

describe("graded status-line rendering", () => {
	it("paints each throughput band with its own semantic color", () => {
		const bands = [
			{ tps: 120, level: "good" as const },
			{ tps: 20, level: "fair" as const },
			{ tps: 3, level: "poor" as const },
		];
		const seen = new Set<string>();
		for (const { tps, level } of bands) {
			const content = renderSegment("token_rate", ctx({ tps })).content;
			// The graded color must actually wrap the reading.
			expect(content).toContain(fgPrefix(getMetricThemeColor(level)));
			expect(stripVTControlCharacters(content)).toContain(`${tps.toFixed(1)} t/s`);
			seen.add(fgPrefix(getMetricThemeColor(level)));
		}
		// Three bands, three distinct escape sequences.
		expect(seen.size).toBe(3);
	});

	it("paints each first-token band with its own semantic color", () => {
		const seen = new Set<string>();
		for (const [ttft, level] of [
			[800, "good"],
			[3_000, "fair"],
			[9_000, "poor"],
		] as const) {
			const content = renderSegment("token_ttft", ctx({ ttft })).content;
			expect(content).toContain(fgPrefix(getMetricThemeColor(level)));
			seen.add(fgPrefix(getMetricThemeColor(level)));
		}
		expect(seen.size).toBe(3);
	});
});
