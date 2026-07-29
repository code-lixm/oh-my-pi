import { afterEach, describe, expect, it } from "bun:test";
import type { Tool as AiTool } from "@oh-my-pi/pi-ai/types";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

const managers: AsyncJobManager[] = [];

function createJobManager(): AsyncJobManager {
	const manager = new AsyncJobManager({ onJobComplete: async () => {} });
	managers.push(manager);
	return manager;
}

function createBashTool(overrides: Partial<Record<SettingPath, unknown>>, asyncJobManager?: AsyncJobManager): BashTool {
	return new BashTool({
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => "BashAsyncSettingTest",
		settings: Settings.isolated(overrides),
		asyncJobManager,
	} as ToolSession);
}

function wireProperties(tool: BashTool): Record<string, unknown> {
	const schema = toolWireSchema(tool as unknown as AiTool) as { properties?: unknown };
	if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
		throw new Error("Expected Bash tool wire schema properties");
	}
	return schema.properties as Record<string, unknown>;
}

afterEach(async () => {
	await Promise.all(managers.splice(0).map(manager => manager.dispose({ timeoutMs: 1_000 })));
});

describe("BashTool bash.async.enabled", () => {
	it("hides and rejects explicit async when only Bash async is disabled", async () => {
		const manager = createJobManager();
		const tool = createBashTool(
			{
				"async.enabled": true,
				"bash.async.enabled": false,
				"bash.autoBackground.enabled": false,
			},
			manager,
		);

		// The model-facing API must not offer a control that the runtime rejects.
		expect(wireProperties(tool).async).toBeUndefined();
		expect(tool.description).not.toContain("async: true");

		// A direct executor call must reject rather than silently create a job.
		await expect(
			tool.execute("bash-async-disabled", { command: "echo should-not-run", async: true }),
		).rejects.toThrow(
			"Async bash execution is disabled. Enable both async.enabled and bash.async.enabled to use async mode.",
		);
		expect(manager.getAllJobs()).toEqual([]);
	});

	it.each([
		{ name: "the Bash-specific setting is absent", settings: {} },
		{ name: "the Bash-specific setting is explicitly enabled", settings: { "bash.async.enabled": true } },
	])("keeps explicit async Bash execution available when $name", async ({ settings }) => {
		const manager = createJobManager();
		const tool = createBashTool(
			{
				"async.enabled": true,
				"bash.autoBackground.enabled": false,
				...settings,
			},
			manager,
		);

		expect(wireProperties(tool).async).toBeDefined();
		expect(tool.description).toContain("async: true");

		const marker = "bash-async-setting-executes";
		const result = await tool.execute("bash-async-enabled", {
			command: `printf '%s\\n' ${marker}`,
			async: true,
		});
		const asyncDetails = result.details?.async;
		expect(asyncDetails).toEqual(expect.objectContaining({ state: "running", type: "bash" }));
		if (!asyncDetails) throw new Error("Expected an explicit Bash async job");

		const job = manager.getJob(asyncDetails.jobId);
		expect(job).toBeDefined();
		await job!.promise;
		expect(job!.status).toBe("completed");
		expect(job!.resultText).toContain(marker);
	});
});
