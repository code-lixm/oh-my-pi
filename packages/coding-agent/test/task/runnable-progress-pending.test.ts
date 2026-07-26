import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { TaskRunnableConcurrency } from "@oh-my-pi/pi-coding-agent/task/request-concurrency";
import * as structuredSubagentModule from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, AgentProgress, SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function deferred<T = void>(): PromiseWithResolvers<T> {
	return Promise.withResolvers<T>();
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs: number = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(message);
		await Bun.sleep(5);
	}
}

function createSession(manager: AsyncJobManager, scheduler: TaskRunnableConcurrency): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": true,
			"task.batch": true,
			"task.maxConcurrency": 8,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => "Main",
		asyncJobManager: manager,
		taskRunnableConcurrency: scheduler,
	} as unknown as ToolSession;
}

function makeResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: `${id} output.`,
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
	};
}

function runningProgress(id: string, index: number): AgentProgress {
	return {
		index,
		id,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "task prompt",
		assignment: "Do the thing.",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 1,
		tokens: 0,
		cost: 0,
		durationMs: 0,
	};
}

describe("task runnable progress scheduling", () => {
	const managers: AsyncJobManager[] = [];

	beforeEach(() => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1_000 });
		}
	});

	it("keeps >8 queued async task progress pending until those children actually start", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const scheduler = new TaskRunnableConcurrency(() => 8);
		const tool = await TaskTool.create(createSession(manager, scheduler));
		const gates = new Map<string, PromiseWithResolvers<void>>();
		const startedIds: string[] = [];
		const snapshots: Array<Array<{ id: string; status: string }>> = [];

		vi.spyOn(structuredSubagentModule, "runStructuredSubagent").mockImplementation(async request => {
			const id = request.identity?.id;
			if (!id) throw new Error("Expected pre-allocated child id");
			const gate = deferred<void>();
			gates.set(id, gate);
			startedIds.push(id);
			request.onProgress?.(runningProgress(id, request.index ?? 0));
			await gate.promise;
			return {
				result: makeResult(id),
				policy: { discovery: { projectAgentsDir: null } },
				mergeSummary: "",
				changesApplied: null,
				artifactsDir: `/tmp/${id}`,
				temporaryArtifacts: false,
			} as Awaited<ReturnType<typeof structuredSubagentModule.runStructuredSubagent>>;
		});

		const result = await tool.execute(
			"tc-pending",
			{
				context: "ctx",
				tasks: Array.from({ length: 10 }, (_, index) => ({
					name: `Worker-${index + 1}`,
					agent: "task",
					task: `Work item ${index + 1}.`,
				})),
			} as TaskParams,
			undefined,
			update => {
				if (update.details?.progress) {
					snapshots.push(update.details.progress.map(progress => ({ id: progress.id, status: progress.status })));
				}
			},
		);

		const initialProgress = result.details?.progress?.map(progress => progress.status);
		expect(initialProgress).toEqual(new Array(10).fill("pending"));

		await waitUntil(() => startedIds.length === 8, "expected only eight children to reach runStructuredSubagent");
		expect(scheduler.snapshot()).toEqual({ active: 8, queued: 2, limit: 8 });
		expect(snapshots.some(snapshot => snapshot.filter(progress => progress.status === "running").length === 8)).toBe(
			true,
		);
		expect(snapshots.some(snapshot => snapshot.filter(progress => progress.status === "pending").length === 2)).toBe(
			true,
		);

		for (const id of startedIds) gates.get(id)?.resolve();
		await waitUntil(() => startedIds.length === 10, "queued children never started after earlier ones finished");
		for (const gate of gates.values()) gate.resolve();
		await manager.waitForAll();
	});
});
