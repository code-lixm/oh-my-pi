import { beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";

const stats: SessionStats = {
	sessionFile: undefined,
	sessionId: "s1",
	userMessages: 2,
	assistantMessages: 1,
	toolCalls: 0,
	toolResults: 0,
	totalMessages: 3,
	tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 10, cacheWrite: 5, total: 165 },
	premiumRequests: 0,
	cost: 0.01,
	contextUsage: undefined,
};

function makeCtx(getSessionStats: () => unknown | Promise<unknown>): {
	ctx: InteractiveModeContext;
	present: Mock<(component: unknown) => void>;
} {
	const present = vi.fn();
	const ctx = {
		session: {
			getSessionStats,
			sessionManager: { getUsageStatistics: () => ({ premiumRequests: 0 }) },
			model: undefined,
			modelRegistry: { authStorage: {} },
			settings: { get: () => "auto" },
		},
		settings: { get: () => "auto" },
		presentCommandOutput: present,
	} as unknown as InteractiveModeContext;
	return { ctx, present };
}

describe("handleSessionCommand stats resolution", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("resolves a Promise-returning getSessionStats (daemon/remote facade)", async () => {
		const { ctx, present } = makeCtx(() => Promise.resolve(stats));
		await new CommandController(ctx).handleSessionCommand();
		expect(present).toHaveBeenCalledTimes(1);
		const block = present.mock.calls[0][0] as Array<{ getText?: () => string }>;
		const content = Bun.stripANSI(block.map(child => child.getText?.() ?? "").join("\n"));
		expect(content).toContain("Tokens");
		expect(content).toContain("Input: 100");
		expect(content).toContain("Output: 50");
		expect(content).toContain("Total: 165");
	});

	it("keeps working with synchronous stats (in-process session)", async () => {
		const { ctx, present } = makeCtx(() => stats);
		await new CommandController(ctx).handleSessionCommand();
		expect(present).toHaveBeenCalledTimes(1);
		const block = present.mock.calls[0][0] as Array<{ getText?: () => string }>;
		expect(Bun.stripANSI(block.map(child => child.getText?.() ?? "").join("\n"))).toContain("Input: 100");
	});
});
