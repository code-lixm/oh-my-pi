/**
 * Contracts: task tool spawn routing (rework-contracts.md §3).
 *
 * 1. With an AsyncJobManager wired, `execute` returns immediately (agent id +
 *    job id) while the job body is still gated; job completion delivers a
 *    result carrying the irc follow-up / `history://<id>` hint.
 * 2. Async spawn jobs are independent AsyncJobManager entries: `task.maxConcurrency`
 *    no longer serializes whole job bodies, so siblings can start together and
 *    cancellation must settle without stranding other running jobs.
 *
 * Param validation (missing agent / missing task) is covered by
 * test/task/task-schema.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../src/i18n/settings-locale";
import { getPromptLocale, setPromptLocale } from "../../src/prompts/prompt-locale";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function createSession(options: { manager?: AsyncJobManager; settings?: Record<string, unknown> }): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

describe("task spawn routing", () => {
	const managers: AsyncJobManager[] = [];
	let settingsUiLocaleBeforeTest = getSettingsUiLocale();
	let promptLocaleBeforeTest = getPromptLocale();

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		settingsUiLocaleBeforeTest = getSettingsUiLocale();
		promptLocaleBeforeTest = getPromptLocale();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		setSettingsUiLocale(settingsUiLocaleBeforeTest);
		setPromptLocale(promptLocaleBeforeTest);
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("returns immediately on spawn and delivers the follow-up hint when the job completes", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [{ ...taskAgent, model: ["anthropic/claude-sonnet-4"] }],
			projectAgentsDir: null,
		});
		const gate = deferred();
		const actualPayload = "ACTUAL_SUBAGENT_PAYLOAD";
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await gate.promise;
			return makeResult(options.id ?? "?", { output: actualPayload });
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "task.agentModelOverrides": { task: "openai/gpt-4.1-mini" } } }),
		);

		const result = await tool.execute("tc-spawn", {
			agent: "task",
			name: "Spawnling",
			task: "Do the thing.",
		} as TaskParams);

		// Tool returned while the job body is still gated on the deferred.
		const text = getFirstText(result);
		expect(text).toContain("Spawned agent `Spawnling`");
		const jobId = result.details?.async?.jobId;
		expect(jobId).toBeTruthy();
		expect(text).toContain(`job \`${jobId}\``);
		const job = manager.getJob(jobId!);
		expect(job?.status).toBe("running");
		expect(job?.resultText).toBeUndefined();

		gate.resolve();
		await job!.promise;

		expect(job!.status).toBe("completed");
		expect(job!.resultText).toContain("Spawnling is now idle");
		expect(job!.resultText).toContain("message it via `hub` to follow up");
		expect(job!.resultText).toContain("history://Spawnling");
		const latestDetails = job!.latestDetails;
		expect(latestDetails).toBeDefined();
		if (!latestDetails) throw new Error("Expected terminal task progress details");
		const taskDetails = latestDetails as unknown as TaskToolDetails;
		const progress = taskDetails.progress;
		expect(progress).toBeDefined();
		if (!progress) throw new Error("Expected terminal task progress");
		const terminalProgress = progress.find(progress => progress.id === "Spawnling");
		expect(terminalProgress).toMatchObject({ status: "completed", resultText: actualPayload });
		expect(terminalProgress?.resultText).not.toContain("is now idle");
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runSpy.mock.calls[0]?.[0].modelOverride).toEqual(["openai/gpt-4.1-mini"]);
	});

	it("adds recovery instructions only to failed task summaries in each locale", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const results: Record<string, SingleResult> = {
			ExitFailure: makeResult("ExitFailure", {
				exitCode: 2,
				output: "exit failure evidence",
				stderr: "worker exited 2",
			}),
			MergeFailure: makeResult("MergeFailure", {
				exitCode: 0,
				error: "Merge failed: conflicting changes",
				output: "merge failure evidence",
			}),
			Completed: makeResult("Completed", { output: "completed evidence" }),
			Aborted: makeResult("Aborted", {
				exitCode: 1,
				aborted: true,
				abortReason: "Cancelled by user",
				error: "cancelled",
				output: "cancelled evidence",
			}),
		};
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const result = results[options.id ?? ""];
			if (!result) throw new Error(`Missing result for ${options.id}`);
			return result;
		});

		for (const testCase of [
			{
				locale: "en",
				recoveryPhrases: [
					"Do not treat it as completed.",
					"Preserve successful sibling results",
					"inspect the failure evidence above",
					"Retry only work that has not already completed.",
					"If recovery is not possible, report the blocker explicitly.",
				],
			},
			{
				locale: "zh-CN",
				recoveryPhrases: [
					"不要将其视为已完成。",
					"保留其他已成功子任务的结果",
					"检查上述失败证据",
					"只重试尚未完成的工作",
					"如果无法恢复，请明确报告阻塞原因。",
				],
			},
		] as const) {
			const session = createSession({ settings: { "async.enabled": true, "task.batch": true } });
			setSettingsUiLocale(testCase.locale);
			setPromptLocale(testCase.locale);
			const tool = await TaskTool.create(session);
			const response = await tool.execute("tc-recovery", {
				context: "Preserve completed work while resolving failures.",
				tasks: [
					{ name: "ExitFailure", task: "Fail by exit code." },
					{ name: "MergeFailure", task: "Fail during merge." },
					{ name: "Completed", task: "Complete normally." },
					{ name: "Aborted", task: "Stop on user cancellation." },
				],
			} as TaskParams);
			const summary = getFirstText(response);
			const section = (id: string): string => {
				const start = summary.indexOf(`<task-result id="${id}"`);
				const end = summary.indexOf("</task-result>", start);
				if (start === -1 || end === -1) throw new Error(`Missing summary for ${id}`);
				return summary.slice(start, end + "</task-result>".length);
			};

			expect(section("ExitFailure")).toContain('status="failed (exit 2)"');
			expect(section("MergeFailure")).toContain('status="merge failed"');
			expect(section("Completed")).toContain('status="completed"');
			expect(section("Aborted")).toContain('status="cancelled"');
			for (const id of ["ExitFailure", "MergeFailure"]) {
				const failedSummary = section(id);
				expect(failedSummary).toContain("<recovery-required>");
				for (const phrase of testCase.recoveryPhrases) expect(failedSummary).toContain(phrase);
			}
			for (const id of ["Completed", "Aborted"]) {
				expect(section(id)).not.toContain("<recovery-required>");
			}
		}
	});

	it("does not serialize async spawn job bodies when task.maxConcurrency is 1", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const bothStarted = Promise.withResolvers<void>();
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			if (started.length === 2) bothStarted.resolve();
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		const secondJob = manager.getJob(second.details!.async!.jobId)!;

		await bothStarted.promise;
		expect([...started].sort()).toEqual(["First", "Second"]);
		expect(firstJob.queued).toBe(false);
		expect(secondJob.queued).toBe(false);

		gates.get("First")!.resolve();
		gates.get("Second")!.resolve();
		await Promise.all([firstJob.promise, secondJob.promise]);
		expect(firstJob.status).toBe("completed");
		expect(secondJob.status).toBe("completed");
	});

	it("settles a cancelled running spawn without blocking a sibling job", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const bothStarted = Promise.withResolvers<void>();
		const firstGate = deferred();
		const secondObservedAbort = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			if (started.length === 2) bothStarted.resolve();
			if (id === "First") {
				await firstGate.promise;
				return makeResult(id);
			}
			const signal = options.signal;
			if (!signal) throw new Error("Expected abort signal");
			await new Promise<void>(resolve => {
				const onAbort = () => {
					secondObservedAbort.resolve();
					resolve();
				};
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			});
			return makeResult(id, { aborted: true, exitCode: 1, error: "cancelled" });
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		const secondJob = manager.getJob(second.details!.async!.jobId)!;

		await bothStarted.promise;
		expect([...started].sort()).toEqual(["First", "Second"]);

		expect(manager.cancel(secondJob.id)).toBe(true);
		await secondObservedAbort.promise;
		await secondJob.promise;

		firstGate.resolve();
		await firstJob.promise;

		expect(secondJob.status).toBe("cancelled");
		expect(firstJob.status).toBe("completed");
	});
});
