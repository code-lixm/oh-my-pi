import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentActivityState } from "@oh-my-pi/pi-coding-agent/registry/agent-activity";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import {
	formatAgentActivity,
	formatAgentActivityDetail,
	formatAgentActivityToolArgs,
} from "../../../src/modes/components/agent-activity";
import { renderAgentActivityDisplay } from "../../../src/modes/components/agent-activity-display";
import { initTheme } from "../../../src/modes/theme/theme";

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
		await initTheme(false);
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
});
