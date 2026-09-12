import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { STATUS_LINE_PRESETS } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/presets";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { setSettingsUiLocale } from "../src/i18n/settings-locale";

beforeAll(async () => {
	await initTheme();
	setSettingsUiLocale("en");
});

afterEach(() => {
	vi.restoreAllMocks();
	setSettingsUiLocale("en");
});

function ctxWith(schedule: SegmentContext["schedule"]): SegmentContext {
	return { schedule } as unknown as SegmentContext;
}

function plain(text: string): string {
	return stripVTControlCharacters(text);
}

describe("schedule status-line segment", () => {
	it("hides when scheduling is unavailable", () => {
		const rendered = renderSegment("schedule", ctxWith(null));

		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("hides when no active scheduled job has a next run", () => {
		const rendered = renderSegment("schedule", ctxWith({ nextRunAt: null, activeCount: 0, pausedCount: 0 }));

		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("renders the upcoming delay in English", () => {
		const now = Date.parse("2026-09-12T12:00:00Z");
		vi.spyOn(Date, "now").mockReturnValue(now);
		const rendered = renderSegment(
			"schedule",
			ctxWith({ nextRunAt: Date.now() + 90_000, activeCount: 1, pausedCount: 0 }),
		);

		expect(rendered.visible).toBe(true);
		expect(plain(rendered.content)).toContain("1m30s from now");
	});

	it("renders due rather than a negative countdown after a run is due", () => {
		const now = Date.parse("2026-09-12T12:00:00Z");
		vi.spyOn(Date, "now").mockReturnValue(now);
		const rendered = renderSegment(
			"schedule",
			ctxWith({ nextRunAt: Date.now() - 5_000, activeCount: 1, pausedCount: 0 }),
		);
		const content = plain(rendered.content);

		expect(rendered.visible).toBe(true);
		expect(content).toContain("due");
		expect(content).not.toMatch(/-\d+(?:\.\d+)?(?:ms|s|m|h|d)/);
	});

	it("shows the count of additional active scheduled jobs", () => {
		const now = Date.parse("2026-09-12T12:00:00Z");
		vi.spyOn(Date, "now").mockReturnValue(now);
		const rendered = renderSegment(
			"schedule",
			ctxWith({ nextRunAt: Date.now() + 90_000, activeCount: 3, pausedCount: 0 }),
		);

		expect(rendered.visible).toBe(true);
		expect(plain(rendered.content)).toContain("+2");
	});

	it("localizes a future delay for zh-CN and restores English", () => {
		const now = Date.parse("2026-09-12T12:00:00Z");
		vi.spyOn(Date, "now").mockReturnValue(now);
		setSettingsUiLocale("zh-CN");
		try {
			const rendered = renderSegment(
				"schedule",
				ctxWith({ nextRunAt: Date.now() + 90_000, activeCount: 1, pausedCount: 0 }),
			);

			expect(rendered.visible).toBe(true);
			expect(plain(rendered.content)).toContain("1m30s 后");
		} finally {
			setSettingsUiLocale("en");
		}
	});

	it("places schedule immediately after token_rate in full and nerd presets", () => {
		for (const presetName of ["full", "nerd"] as const) {
			const segments = STATUS_LINE_PRESETS[presetName].rightSegments;
			const tokenRateIndex = segments.indexOf("token_rate");

			expect(tokenRateIndex).toBeGreaterThanOrEqual(0);
			expect(segments.indexOf("schedule")).toBe(tokenRateIndex + 1);
		}
	});
});
