import { beforeAll, describe, expect, it, vi } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

interface RenderableBlock {
	render(width: number): string[];
}

function isRenderableBlock(value: unknown): value is RenderableBlock {
	return value !== null && typeof value === "object" && "render" in value && typeof value.render === "function";
}

function renderPresentedBlocks(value: unknown): string {
	const blocks = Array.isArray(value) ? value : [value];
	return blocks
		.filter(isRenderableBlock)
		.flatMap(block => block.render(120))
		.join("\n");
}

const ansiPattern = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
	return text.replace(ansiPattern, "");
}

describe("CommandController /jobs", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("renders command labels at the left edge while preserving job metadata", async () => {
		const label = "bun test packages/coding-agent/test/modes/controllers/jobs-command.test.ts";
		const id = "job-running";
		const type = "bash";
		const status = "running";
		const present = vi.fn();
		const ctx = {
			session: {
				getAsyncJobSnapshot: () => ({
					running: [
						{
							id,
							type,
							status,
							label,
							startTime: Date.now() - 5_000,
						},
					],
					recent: [],
					delivery: { queued: 0, delivering: false, pendingJobIds: [] },
				}),
			},
			ui: { terminal: { columns: 160 } },
			present,
			showWarning: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleJobsCommand();

		expect(present).toHaveBeenCalledTimes(1);
		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = stripAnsi(renderPresentedBlocks(firstCall?.[0]));
		expect(output).toContain(` ${label}`);
		expect(output).not.toContain(`  ${label}`);
		expect(output).toContain(id);
		expect(output).toContain(`[${type}]`);
		expect(output).toContain(status);
	});
});
