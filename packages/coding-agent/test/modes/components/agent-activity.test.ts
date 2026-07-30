import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import type { AgentActivityState } from "@oh-my-pi/pi-coding-agent/registry/agent-activity";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../../src/i18n/settings-locale";
import {
	formatAgentActivity,
	formatAgentActivityDetail,
	formatAgentActivityToolArgs,
} from "../../../src/modes/components/agent-activity";
import { renderAgentActivityDisplay } from "../../../src/modes/components/agent-activity-display";
import { initTheme } from "../../../src/modes/theme/theme";

const initialLocale = getSettingsUiLocale();

function activity(overrides: Partial<AgentActivityState> = {}): AgentActivityState {
	return {
		phase: "streaming",
		label: "Streaming response",
		detail: "Reading response chunks",
		phaseStartedAtMs: 0,
		lastActivityAtMs: 0,
		...overrides,
	};
}

describe("agent activity display contracts", () => {
	beforeEach(async () => {
		setSettingsUiLocale("en");
		await initTheme(false);
	});

	afterEach(() => {
		vi.useRealTimers();
		setSystemTime();
		setSettingsUiLocale(initialLocale);
	});

	it("keeps 15-second and 60-second silence distinct from an evidenced stall", () => {
		const streaming = activity();

		for (const now of [15_000, 60_000]) {
			expect(formatAgentActivity(streaming, now).health).toBe("quiet");
		}
		expect(formatAgentActivity(streaming, 60_000, { stallReason: "provider deadline exceeded" }).health).toBe(
			"suspected-stall",
		);
		expect(formatAgentActivity(streaming, 60_000, { stallReason: "\u001b[31m\t\n\u001b[0m" }).health).toBe("quiet");
		expect(
			formatAgentActivity(activity({ phase: "waiting-peer", label: "Waiting for peer" }), 60_000, {
				stallReason: "provider deadline exceeded",
			}).health,
		).toBe("blocked");
	});

	it("suppresses unknown totals and fits sanitized activity data into narrow viewer and HUD rows", () => {
		const unknownTotal = activity({
			detail: "Scanning workspace",
			progress: { completed: 2, total: 0, unit: "files" },
		});
		expect(formatAgentActivityDetail(unknownTotal, 80)).toBe("Scanning workspace");
		expect(
			formatAgentActivityDetail(activity({ progress: { completed: 2, total: 5, unit: "files" } }), 80),
		).toContain("2/5 files");

		const toolArgs = formatAgentActivityToolArgs(
			{ path: "src\tactivity\nview.ts", payload: { unbounded: "must not serialize" } },
			12,
		);
		expect(toolArgs).toContain("path=");
		expect(toolArgs).not.toMatch(/[\t\n]/);
		expect(visibleWidth(toolArgs)).toBeLessThanOrEqual(12);

		const display = renderAgentActivityDisplay({
			activity: unknownTotal,
			progress: {
				currentToolArgs: "path=src\tactivity\nview.ts payload={nested:true}",
				toolCount: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
			},
			width: 18,
			now: 60_000,
		});
		const line = display.activityLine ?? "";
		const text = Bun.stripANSI(line);
		expect(visibleWidth(line)).toBeLessThanOrEqual(18);
		expect(text).not.toContain("2/0");
		expect(text).not.toMatch(/[\t\n]/);
	});

	it("shows a running task's start time and complete fixed duration without an end time", () => {
		const startedAtMs = new Date(2025, 0, 2, 3, 4, 5).getTime();
		const display = renderAgentActivityDisplay({
			progress: {
				status: "running",
				startedAtMs,
				durationMs: 0,
				tokens: 0,
				toolCount: 0,
				cost: 0,
			},
			width: 160,
			now: startedAtMs + 3_723_000,
		});
		const text = Bun.stripANSI(display.statsLine ?? "");
		const started = new Date(startedAtMs);
		const clock = [started.getHours(), started.getMinutes(), started.getSeconds()]
			.map(value => String(value).padStart(2, "0"))
			.join(":");

		expect(text).toContain(`Started ${clock}`);
		expect(text).toContain("Duration 01:02:03");
		expect(text).not.toContain("Ended");
	});

	it("freezes terminal start, end, and complete duration across clock advances", () => {
		const startedAtMs = new Date(2025, 0, 2, 3, 4, 5).getTime();
		const durationMs = 3_723_000;
		const completedAtMs = startedAtMs + durationMs;
		const render = (): string =>
			Bun.stripANSI(
				renderAgentActivityDisplay({
					progress: {
						status: "completed",
						startedAtMs,
						completedAtMs,
						durationMs,
						tokens: 0,
						toolCount: 0,
						cost: 0,
					},
					width: 160,
				}).statsLine ?? "",
			);

		vi.useFakeTimers();
		try {
			setSystemTime(completedAtMs + 1_000);
			const first = render();
			setSystemTime(completedAtMs + 7_200_000);
			const later = render();
			const started = new Date(startedAtMs);
			const ended = new Date(completedAtMs);
			const clock = (date: Date): string =>
				[date.getHours(), date.getMinutes(), date.getSeconds()]
					.map(value => String(value).padStart(2, "0"))
					.join(":");

			expect(later).toBe(first);
			expect(first).toContain(`Started ${clock(started)}`);
			expect(first).toContain(`Ended ${clock(ended)}`);
			expect(first).toContain("Duration 01:02:03");
		} finally {
			vi.useRealTimers();
			setSystemTime();
		}
	});

	it("uses terminal registry state to freeze stale running observer activity", () => {
		const startedAtMs = new Date(2025, 0, 2, 3, 4, 5).getTime();
		const durationMs = 3_723_000;
		const completedAtMs = startedAtMs + durationMs;
		const staleActivity = activity({ phaseStartedAtMs: startedAtMs, lastActivityAtMs: startedAtMs + 1_000 });
		const staleProgress = {
			activity: staleActivity,
			status: "running" as const,
			startedAtMs,
			durationMs,
			tokens: 0,
			toolCount: 0,
			cost: 0,
		};
		const render = (registryStatus: "idle" | "parked" | "aborted"): string => {
			const display = renderAgentActivityDisplay({
				activity: staleActivity,
				progress: staleProgress,
				registryStatus,
				width: 200,
			});
			return Bun.stripANSI([display.activityLine, display.statsLine].filter(Boolean).join("\n"));
		};

		vi.useFakeTimers();
		try {
			for (const registryStatus of ["idle", "parked", "aborted"] as const) {
				setSystemTime(completedAtMs + 1_000);
				const first = render(registryStatus);
				setSystemTime(completedAtMs + 7_200_000);
				const later = render(registryStatus);

				expect(later).toBe(first);
				expect(first).toContain("phase");
				expect(first).toContain("quiet");
				expect(first).toContain("Ended");
				expect(first).toContain("Duration 01:02:03");
			}
		} finally {
			vi.useRealTimers();
			setSystemTime();
		}
	});
});
