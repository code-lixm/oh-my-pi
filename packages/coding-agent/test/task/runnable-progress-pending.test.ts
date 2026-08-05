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
		activity: {
			phase: "delegating",
			label: "Delegating task",
			phaseStartedAtMs: 1_100,
			lastActivityAtMs: 1_200,
		},
		currentTool: "task",
		currentToolArgs: "delegate source revision",
		currentToolStartMs: 1_050,
		inflightTaskDetails: {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 17,
		},
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
		const snapshots: AgentProgress[][] = [];
		const runningProgressDelivered = deferred<void>();
		const sourceProgressMutated = deferred<void>();
		let emittedRunningProgress: AgentProgress | undefined;
		let forwardedRunningProgress: AgentProgress | undefined;

		vi.spyOn(structuredSubagentModule, "runStructuredSubagent").mockImplementation(async request => {
			const id = request.identity?.id;
			if (!id) throw new Error("Expected pre-allocated child id");
			const gate = deferred<void>();
			gates.set(id, gate);
			startedIds.push(id);
			const progress = runningProgress(id, request.index ?? 0);
			request.onProgress?.(progress);
			if (request.index === 0) {
				emittedRunningProgress = progress;
				await runningProgressDelivered.promise;
				progress.activity!.label = "mutated source activity";
				progress.activity!.phaseStartedAtMs = 9_001;
				progress.activity!.lastActivityAtMs = 9_002;
				progress.currentToolArgs = "mutated source tool args";
				progress.currentToolStartMs = 9_003;
				progress.inflightTaskDetails!.totalDurationMs = 9_004;
				sourceProgressMutated.resolve();
			}
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

		const executeStartedAt = Date.now();
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
				const progress = update.details?.progress;
				if (!progress) return;
				snapshots.push(progress);
				const forwarded = progress.find(
					candidate => candidate.index === 0 && candidate.currentToolArgs === "delegate source revision",
				);
				if (forwarded && !forwardedRunningProgress) {
					forwardedRunningProgress = forwarded;
					runningProgressDelivered.resolve();
				}
			},
		);
		const initialObservedAt = Date.now();

		const initialProgress = result.details?.progress;
		expect(initialProgress).toHaveLength(10);
		for (const progress of initialProgress ?? []) {
			expect(progress.status).toBe("pending");
			expect(progress.activity?.phase).toBe("queued");
			expect(progress.activity?.phaseStartedAtMs).toBeGreaterThanOrEqual(executeStartedAt);
			expect(progress.activity?.lastActivityAtMs).toBeGreaterThanOrEqual(progress.activity!.phaseStartedAtMs);
			expect(progress.activity?.lastActivityAtMs).toBeLessThanOrEqual(initialObservedAt);
		}

		await waitUntil(() => startedIds.length === 8, "expected only eight children to reach runStructuredSubagent");
		expect(scheduler.snapshot()).toEqual({ active: 8, queued: 2, limit: 8 });
		await waitUntil(
			() => snapshots.some(snapshot => snapshot.filter(progress => progress.status === "running").length === 8),
			"expected manager scheduler to publish eight running children",
		);
		expect(snapshots.some(snapshot => snapshot.filter(progress => progress.status === "running").length === 8)).toBe(
			true,
		);
		expect(snapshots.some(snapshot => snapshot.filter(progress => progress.status === "pending").length === 2)).toBe(
			true,
		);
		const queuedSnapshot = snapshots.find(
			snapshot => snapshot.filter(progress => progress.status === "pending").length === 2,
		);
		expect(queuedSnapshot).toBeDefined();
		if (!queuedSnapshot) throw new Error("Expected a queued outer progress snapshot");
		for (const progress of queuedSnapshot.filter(progress => progress.status === "pending")) {
			expect(progress.activity?.phase).toBe("queued");
			expect(Number.isFinite(progress.activity?.phaseStartedAtMs)).toBe(true);
			expect(Number.isFinite(progress.activity?.lastActivityAtMs)).toBe(true);
		}

		await waitUntil(() => forwardedRunningProgress !== undefined, "expected forwarded child activity progress");
		await sourceProgressMutated.promise;
		if (!emittedRunningProgress || !forwardedRunningProgress) {
			throw new Error("Expected source and forwarded child progress");
		}
		expect(forwardedRunningProgress.activity).toEqual({
			phase: "delegating",
			label: "Delegating task",
			phaseStartedAtMs: 1_100,
			lastActivityAtMs: 1_200,
		});
		expect(forwardedRunningProgress.currentToolArgs).toBe("delegate source revision");
		expect(forwardedRunningProgress.currentToolStartMs).toBe(1_050);
		expect(forwardedRunningProgress.inflightTaskDetails).toMatchObject({ totalDurationMs: 17 });
		expect(forwardedRunningProgress.activity).not.toBe(emittedRunningProgress.activity);
		expect(forwardedRunningProgress.inflightTaskDetails).not.toBe(emittedRunningProgress.inflightTaskDetails);

		for (const id of startedIds) gates.get(id)?.resolve();
		await waitUntil(() => startedIds.length === 10, "queued children never started after earlier ones finished");
		for (const gate of gates.values()) gate.resolve();
		await manager.waitForAll();
	});
});
