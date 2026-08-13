import { beforeAll, describe, expect, it } from "bun:test";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext, StatusLineUsageItem } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme, type ThemeColor, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function makeSession(sessionId = "status-line-session-123456"): SegmentContext["session"] {
	return {
		state: { model: undefined },
		sessionManager: {
			getSessionId: () => sessionId,
		},
	} as unknown as SegmentContext["session"];
}

function makeContext(overrides: Partial<SegmentContext> = {}): SegmentContext {
	return {
		session: makeSession(),
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		collab: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 300_000,
		autoCompactEnabled: false,
		subagentCount: 0,
		activeMs: 0,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
		...overrides,
	} as SegmentContext;
}

function expectColoredIcon(content: string, color: ThemeColor, icon: string): void {
	expect(content.startsWith(`${theme.getFgAnsi(color)}${icon} `)).toBe(true);
}

function expectColoredValue(content: string, color: ThemeColor, value: string): void {
	expect(content).toContain(`${theme.getFgAnsi(color)}${value}\x1b[39m`);
}

describe("status-line icon theme colors", () => {
	it("colors the context_pct icon with the same threshold color as its value", () => {
		const cases: Array<{ percent: number; color: ThemeColor }> = [
			{ percent: 20, color: "statusLineContext" },
			{ percent: 60, color: "warning" },
			{ percent: 75, color: "thinkingHigh" },
			{ percent: 95, color: "error" },
		];

		for (const { percent, color } of cases) {
			const rendered = renderSegment("context_pct", makeContext({ contextPercent: percent, contextTokens: 30_000 }));
			expect(rendered.visible).toBe(true);
			expectColoredIcon(rendered.content, color, theme.icon.context);
		}
	});

	it("colors the time_spent icon once active processing time is visible", () => {
		const rendered = renderSegment("time_spent", makeContext({ activeMs: 2_000 }));

		expect(rendered.visible).toBe(true);
		expectColoredIcon(rendered.content, "statusLineContext", theme.icon.time);
	});
	it("colors the clock icon in the time segment", () => {
		const rendered = renderSegment("time", makeContext({ options: { time: { format: "24h", showSeconds: true } } }));

		expect(rendered.visible).toBe(true);
		expectColoredIcon(rendered.content, "statusLineContext", theme.icon.time);
	});

	it("colors session and hostname icons with the status-line context color", () => {
		const session = renderSegment("session", makeContext());
		const hostname = renderSegment("hostname", makeContext());

		expect(session.visible).toBe(true);
		expect(hostname.visible).toBe(true);
		expectColoredIcon(session.content, "statusLineContext", theme.icon.session);
		expectColoredIcon(hostname.content, "statusLineContext", theme.icon.host);
	});

	it("colors the cache_hit icon with the same spend color as its percentage", () => {
		const rendered = renderSegment(
			"cache_hit",
			makeContext({ usageStats: { ...makeContext().usageStats, cacheRead: 80, cacheWrite: 10, input: 10 } }),
		);

		expect(rendered.visible).toBe(true);
		expectColoredIcon(rendered.content, "statusLineSpend", theme.icon.cache);
		expect(rendered.content).toContain(theme.fg("statusLineSpend", `${theme.icon.cache} 80.00%`));
	});

	it("colors the usage time icon while retaining distinct colors for nested quota values", () => {
		const items: StatusLineUsageItem[] = [
			{ provider: "provider", label: "low", usedFraction: 0.2, amount: { unit: "percent", usedFraction: 0.2 } },
			{ provider: "provider", label: "near", usedFraction: 0.8, amount: { unit: "percent", usedFraction: 0.8 } },
			{ provider: "provider", label: "full", usedFraction: 1, amount: { unit: "percent", usedFraction: 1 } },
		];
		const rendered = renderSegment(
			"usage",
			makeContext({ usage: { items }, options: { usage: { maxItems: 3, showResetTime: false } } }),
		);

		expect(rendered.visible).toBe(true);
		expectColoredIcon(rendered.content, "statusLineContext", theme.icon.time);
		expectColoredValue(rendered.content, "muted", "20%");
		expectColoredValue(rendered.content, "warning", "80%");
		expectColoredValue(rendered.content, "error", "100%");
	});

	it("colors the compact usage time icon while retaining per-window semantic colors", () => {
		const rendered = renderSegment(
			"usage",
			makeContext({
				usage: {
					items: [],
					preferCompact: true,
					fiveHour: { percent: 20 },
					sevenDay: { percent: 80 },
					monthly: { percent: 100 },
				},
			}),
		);

		expect(rendered.visible).toBe(true);
		expectColoredIcon(rendered.content, "statusLineContext", theme.icon.time);
		expectColoredValue(rendered.content, "muted", "20%");
		expectColoredValue(rendered.content, "warning", "80%");
		expectColoredValue(rendered.content, "error", "100%");
	});
});
