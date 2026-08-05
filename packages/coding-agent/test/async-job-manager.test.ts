import { describe, expect, setSystemTime, test, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index++) {
		await Promise.resolve();
	}
}

describe("AsyncJobManager", () => {
	test("forwards progress updates and delivers completion", async () => {
		const progressEvents: Array<{ text: string; details?: Record<string, unknown> }> = [];
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register(
			"bash",
			"echo hi",
			async ({ reportProgress }) => {
				await reportProgress("running step", { async: { state: "running" } });
				return "final output";
			},
			{
				onProgress: async (text, details) => {
					progressEvents.push({ text, details });
				},
			},
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(progressEvents).toEqual([{ text: "running step", details: { async: { state: "running" } } }]);
		expect(completions).toEqual([{ jobId, text: "final output" }]);
		expect(manager.getJob(jobId)?.status).toBe("completed");
	});

	test("swallows progress callback errors without failing the job", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register(
			"task",
			"agent task",
			async ({ reportProgress }) => {
				await reportProgress("subagent started");
				return "task done";
			},
			{
				onProgress: async () => {
					throw new Error("progress renderer exploded");
				},
			},
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(completions).toEqual([{ jobId, text: "task done" }]);
		expect(manager.getJob(jobId)?.status).toBe("completed");
	});

	test("delivers error text when run fails", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register("bash", "bad command", async () => {
			throw new Error("command failed");
		});

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(completions).toEqual([{ jobId, text: "command failed" }]);
		expect(manager.getJob(jobId)?.status).toBe("failed");
		expect(manager.getJob(jobId)?.errorText).toBe("command failed");
	});

	test("cancels a running job by id", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register("bash", "sleep", async ({ signal }) => {
			await new Promise<never>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			});
			throw new Error("unreachable");
		});

		expect(manager.cancel(jobId)).toBe(true);
		expect(manager.cancel(jobId)).toBe(false);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("cancelled");
		expect(completions).toHaveLength(0);
	});

	test("keeps scalar counts aligned with lifecycle queries across queued owner transitions", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const complete = Promise.withResolvers<string>();
		const fail = Promise.withResolvers<void>();
		const startQueued = Promise.withResolvers<void>();
		const queuedStarted = Promise.withResolvers<void>();
		const waitForAbort = (signal: AbortSignal) =>
			new Promise<string>(resolve => {
				if (signal.aborted) {
					resolve("cancelled");
					return;
				}
				signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
			});
		const mainFilter = { ownerId: "Main" };
		const workerFilter = { ownerId: "Worker" };
		const expectCount = (filter: { ownerId: string } | undefined, expected: number) => {
			expect(manager.getRunningJobCount(filter)).toBe(expected);
			expect(manager.getRunningJobs(filter)).toHaveLength(expected);
		};

		const queuedMainJobId = manager.register(
			"task",
			"queued main job",
			async ({ markRunning, signal }) => {
				await startQueued.promise;
				markRunning();
				queuedStarted.resolve();
				return waitForAbort(signal);
			},
			{ ownerId: "Main", queued: true },
		);
		const completedMainJobId = manager.register("task", "completing main job", () => complete.promise, {
			ownerId: "Main",
		});
		const failedWorkerJobId = manager.register(
			"task",
			"failing worker job",
			async () => {
				await fail.promise;
				throw new Error("worker failed");
			},
			{ ownerId: "Worker" },
		);
		const cancelledWorkerJobId = manager.register(
			"bash",
			"cancelled worker job",
			({ signal }) => waitForAbort(signal),
			{ ownerId: "Worker" },
		);

		try {
			// Queued work is visible as running, but remains isolated to its owner.
			expect(manager.getJob(queuedMainJobId)?.queued).toBe(true);
			expectCount(undefined, 4);
			expectCount(mainFilter, 2);
			expectCount(workerFilter, 2);

			complete.resolve("main completed");
			await manager.getJob(completedMainJobId)?.promise;
			expect(manager.getJob(completedMainJobId)?.status).toBe("completed");
			expectCount(undefined, 3);
			expectCount(mainFilter, 1);
			expectCount(workerFilter, 2);

			fail.resolve();
			await manager.getJob(failedWorkerJobId)?.promise;
			expect(manager.getJob(failedWorkerJobId)?.status).toBe("failed");
			expectCount(undefined, 2);
			expectCount(mainFilter, 1);
			expectCount(workerFilter, 1);

			startQueued.resolve();
			await queuedStarted.promise;
			expect(manager.getJob(queuedMainJobId)?.queued).toBe(false);
			expectCount(undefined, 2);
			expectCount(mainFilter, 1);
			expectCount(workerFilter, 1);

			expect(manager.cancel(queuedMainJobId, mainFilter)).toBe(true);
			expect(manager.getJob(queuedMainJobId)?.status).toBe("cancelled");
			expectCount(undefined, 1);
			expectCount(mainFilter, 0);
			expectCount(workerFilter, 1);

			manager.cancelAll(workerFilter);
			expect(manager.getJob(cancelledWorkerJobId)?.status).toBe("cancelled");
			expectCount(undefined, 0);
			expectCount(mainFilter, 0);
			expectCount(workerFilter, 0);
		} finally {
			startQueued.resolve();
			manager.cancelAll();
			await manager.waitForAll();
			await manager.drainDeliveries();
		}
	});

	test("enforces maxRunningJobs cap", () => {
		const manager = new AsyncJobManager({
			maxRunningJobs: 1,
			onJobComplete: async () => {},
		});

		const firstJobId = manager.register("bash", "first", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return "done";
		});

		expect(() =>
			manager.register("bash", "second", async () => {
				return "second";
			}),
		).toThrow(/Background job limit reached/);

		manager.cancel(firstJobId);
	});

	test("queued jobs do not count toward the cap until markRunning", async () => {
		const manager = new AsyncJobManager({
			maxRunningJobs: 1,
			onJobComplete: async () => {},
		});

		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const queuedJobId = manager.register(
			"task",
			"queued",
			async ({ markRunning }) => {
				await gate.promise;
				markRunning();
				started.resolve();
				await release.promise;
				return "queued done";
			},
			{ queued: true },
		);

		// Queued job holds no slot: another job registers fine at cap 1.
		const runningJobId = manager.register("bash", "running", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return "done";
		});

		// Free the slot, then let the queued job start: it now occupies the slot.
		manager.cancel(runningJobId);
		gate.resolve();
		await started.promise;
		expect(() => manager.register("bash", "third", async () => "third")).toThrow(/Background job limit reached/);

		release.resolve();
		await manager.waitForAll();
		expect(manager.getJob(queuedJobId)?.status).toBe("completed");
	});

	test("evicts completed jobs after retention period", async () => {
		const manager = new AsyncJobManager({
			retentionMs: 25,
			onJobComplete: async () => {},
		});

		const jobId = manager.register("task", "short", async () => "done");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("completed");
		await Bun.sleep(60);
		expect(manager.getJob(jobId)).toBeUndefined();
	});

	test("cancelAll does not clear retention timers for already completed jobs", async () => {
		const manager = new AsyncJobManager({
			retentionMs: 30,
			onJobComplete: async () => {},
		});

		const completedJobId = manager.register("task", "completed", async () => "done");
		const runningJobId = manager.register("bash", "running", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			throw new Error("aborted");
		});

		const completedDeadline = Date.now() + 2_000;
		while (manager.getJob(completedJobId)?.status === "running") {
			if (Date.now() >= completedDeadline) throw new Error("Timed out waiting for completed job");
			await Bun.sleep(5);
		}
		manager.cancelAll();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(completedJobId)?.status).toBe("completed");
		expect(manager.getJob(runningJobId)?.status).toBe("cancelled");

		await Bun.sleep(80);
		expect(manager.getJob(completedJobId)).toBeUndefined();
		expect(manager.getJob(runningJobId)).toBeUndefined();
	});

	test("acknowledgeDeliveries suppresses pending retries for completed jobs", async () => {
		let attempts = 0;
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				attempts += 1;
				throw new Error("delivery failed");
			},
		});

		const jobId = manager.register("task", "awaited-job", async () => "done");
		await manager.waitForAll();

		const firstAttemptDeadline = Date.now() + 2_000;
		while (attempts === 0) {
			if (Date.now() >= firstAttemptDeadline) throw new Error("Timed out waiting for first delivery attempt");
			await Bun.sleep(5);
		}

		expect(manager.hasPendingDeliveries()).toBe(true);
		const removed = manager.acknowledgeDeliveries([jobId]);
		expect(removed).toBeGreaterThanOrEqual(1);

		const drained = await manager.drainDeliveries({ timeoutMs: 200 });
		expect(drained).toBe(true);
		expect(manager.hasPendingDeliveries()).toBe(false);

		const attemptsAfterAck = attempts;
		await Bun.sleep(700);
		expect(attempts).toBe(attemptsAfterAck);
	});

	test("dispose clears jobs and pending deliveries", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				throw new Error("delivery failed");
			},
		});

		manager.register("bash", "will-complete", async () => "output");
		await manager.waitForAll();
		expect(manager.hasPendingDeliveries()).toBe(true);

		const drained = await manager.dispose({ timeoutMs: 25 });
		expect(drained).toBe(false);
		expect(manager.getAllJobs()).toHaveLength(0);
		expect(manager.hasPendingDeliveries()).toBe(false);
	});

	test("dispose honors timeout when a cancelled job never settles", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {},
		});

		manager.register(
			"bash",
			"ignores-abort",
			async () => {
				await Promise.withResolvers<never>().promise;
				return "unreachable";
			},
			{ ownerId: "stuck-owner" },
		);

		const startedAt = Date.now();
		const result = await Promise.race([
			manager.dispose({ timeoutMs: 25 }).then(drained => ({ drained, settled: true })),
			Bun.sleep(150).then(() => ({ drained: true, settled: false })),
		]);

		expect(result.settled).toBe(true);
		expect(result.drained).toBe(false);
		expect(Date.now() - startedAt).toBeLessThan(150);
		expect(manager.getAllJobs()).toHaveLength(0);
		expect(manager.getRunningJobCount()).toBe(0);
		expect(manager.getRunningJobCount({ ownerId: "stuck-owner" })).toBe(0);
	});

	test("scoped delivery drain returns once matching owner deliveries finish", async () => {
		let mainJobId = "";
		let releaseMainDelivery = (): void => {};
		let notifyMainDeliveryStarted = (): void => {};
		const mainDeliveryStarted = new Promise<void>(resolve => {
			notifyMainDeliveryStarted = resolve;
		});
		const mainDeliveryReleased = new Promise<void>(resolve => {
			releaseMainDelivery = resolve;
		});
		const subagentCompletions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({ retentionMs: 0 });
		manager.registerDeliverySink("0-Main", async () => {
			notifyMainDeliveryStarted();
			await mainDeliveryReleased;
		});
		manager.registerDeliverySink("3-AuthLoader", (jobId, text) => {
			subagentCompletions.push({ jobId, text });
		});

		mainJobId = manager.register("task", "main job", async () => "main result", { ownerId: "0-Main" });
		const targetJobId = manager.register("task", "subagent job", async () => "subagent result", {
			ownerId: "3-AuthLoader",
		});
		await manager.waitForAll();
		await mainDeliveryStarted;

		expect(manager.hasPendingDeliveries({ ownerId: "0-Main" })).toBe(true);
		const drained = await manager.drainDeliveries({ timeoutMs: 50, filter: { ownerId: "3-AuthLoader" } });

		expect(drained).toBe(true);
		expect(subagentCompletions).toEqual([{ jobId: targetJobId, text: "subagent result" }]);
		expect(manager.hasPendingDeliveries({ ownerId: "3-AuthLoader" })).toBe(false);

		expect(manager.acknowledgeDeliveries([mainJobId])).toBe(0);
		expect(manager.hasPendingDeliveries({ ownerId: "0-Main" })).toBe(false);
		releaseMainDelivery();
		await Bun.sleep(0);
	});

	test("scoped delivery drain times out while a matching delivery callback is in flight", async () => {
		let targetJobId = "";
		let releaseMainDelivery = (): void => {};
		let notifyMainDeliveryStarted = (): void => {};
		let releaseTargetDelivery = (): void => {};
		let notifyTargetDeliveryStarted = (): void => {};
		const mainDeliveryStarted = new Promise<void>(resolve => {
			notifyMainDeliveryStarted = resolve;
		});
		const mainDeliveryReleased = new Promise<void>(resolve => {
			releaseMainDelivery = resolve;
		});
		const targetDeliveryStarted = new Promise<void>(resolve => {
			notifyTargetDeliveryStarted = resolve;
		});
		const targetDeliveryReleased = new Promise<void>(resolve => {
			releaseTargetDelivery = resolve;
		});
		const completions: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerDeliverySink("0-Main", async () => {
			notifyMainDeliveryStarted();
			await mainDeliveryReleased;
		});
		manager.registerDeliverySink("3-AuthLoader", async jobId => {
			notifyTargetDeliveryStarted();
			await targetDeliveryReleased;
			completions.push(jobId);
		});

		manager.register("task", "main job", async () => "main result", { ownerId: "0-Main" });
		targetJobId = manager.register("task", "subagent job", async () => "subagent result", {
			ownerId: "3-AuthLoader",
		});
		await manager.waitForAll();
		await mainDeliveryStarted;

		const timedOut = await manager.drainDeliveries({ timeoutMs: 10, filter: { ownerId: "3-AuthLoader" } });
		await targetDeliveryStarted;

		expect(timedOut).toBe(false);
		expect(manager.hasPendingDeliveries({ ownerId: "3-AuthLoader" })).toBe(true);
		expect(completions).toEqual([]);

		releaseTargetDelivery();
		const drained = await manager.drainDeliveries({ timeoutMs: 200, filter: { ownerId: "3-AuthLoader" } });
		expect(drained).toBe(true);
		expect(completions).toEqual([targetJobId]);

		releaseMainDelivery();
		expect(await manager.drainDeliveries({ timeoutMs: 200 })).toBe(true);
	});

	test("cancelAll with ownerId only cancels matching jobs", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {},
		});

		const hold = (signal: AbortSignal) =>
			new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});

		const parentJobId = manager.register(
			"bash",
			"parent-job",
			async ({ signal }) => {
				await hold(signal);
				return "parent-cancelled";
			},
			{ ownerId: "0-Main" },
		);
		const subagentJobId = manager.register(
			"bash",
			"subagent-job",
			async ({ signal }) => {
				await hold(signal);
				return "subagent-cancelled";
			},
			{ ownerId: "3-AuthLoader" },
		);

		manager.cancelAll({ ownerId: "3-AuthLoader" });

		expect(manager.getJob(parentJobId)?.status).toBe("running");
		expect(manager.getJob(subagentJobId)?.status).toBe("cancelled");

		// Filtered query mirrors filtered cancel.
		expect(manager.getRunningJobs({ ownerId: "0-Main" }).map(j => j.id)).toEqual([parentJobId]);
		expect(manager.getRunningJobs({ ownerId: "3-AuthLoader" })).toEqual([]);
		expect(manager.getAllJobs({ ownerId: "0-Main" }).map(j => j.id)).toEqual([parentJobId]);

		// Unscoped cancelAll still cleans up everything.
		manager.cancelAll();
		await manager.waitForAll();
		expect(manager.getJob(parentJobId)?.status).toBe("cancelled");
	});

	test("routes owned deliveries to the owner's registered sink only", async () => {
		const mainDeliveries: string[] = [];
		const defaultDeliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				defaultDeliveries.push(jobId);
			},
		});
		manager.registerDeliverySink("Main", jobId => {
			mainDeliveries.push(jobId);
		});

		manager.register("bash", "owned", async () => "ok", { id: "owned-1", ownerId: "Main" });
		manager.register("bash", "unowned", async () => "ok", { id: "unowned-1" });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });

		expect(mainDeliveries).toEqual(["owned-1"]);
		expect(defaultDeliveries).toEqual(["unowned-1"]);
	});

	test("dead-letters a task delivery without an owner sink while retaining its result", async () => {
		const defaultDeliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				defaultDeliveries.push(jobId);
			},
		});
		const unregister = manager.registerDeliverySink("Sub", () => {});
		unregister();

		manager.register("task", "orphan", async () => "orphan result", {
			id: "orphan-1",
			ownerId: "Sub",
			agentId: "Orphan",
		});
		await manager.waitForAll();
		const drained = await manager.drainDeliveries({ timeoutMs: 500 });

		// Dead-letter drops the delivery (drain settles) without misrouting it
		// into the default sink; the task result remains inspectable on the job row.
		expect(drained).toBe(true);
		expect(defaultDeliveries).toEqual([]);
		expect(manager.getJob("orphan-1")).toMatchObject({
			deliveryStatus: "dead-letter",
			resultText: "orphan result",
		});
	});

	test("keeps a completed task delivery pending while in flight, then marks it delivered", async () => {
		const sinkStarted = Promise.withResolvers<void>();
		const releaseSink = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({});
		manager.registerDeliverySink("Main", async () => {
			sinkStarted.resolve();
			await releaseSink.promise;
		});

		const jobId = manager.register("task", "deliver worker result", async () => "actual worker payload", {
			id: "task-delivery-1",
			ownerId: "Main",
			agentId: "Worker",
		});
		await manager.waitForAll();
		await sinkStarted.promise;

		expect(manager.getJob(jobId)).toMatchObject({
			status: "completed",
			resultText: "actual worker payload",
			deliveryStatus: "delivering",
		});
		expect(manager.getDeliveryState({ ownerId: "Main" })).toMatchObject({
			queued: 1,
			pendingJobIds: [jobId],
		});

		releaseSink.resolve();
		await expect(manager.drainDeliveries({ timeoutMs: 500, filter: { ownerId: "Main" } })).resolves.toBe(true);
		expect(manager.getJob(jobId)?.deliveryStatus).toBe("delivered");
		expect(manager.getDeliveryState({ ownerId: "Main" }).pendingJobIds).toEqual([]);
	});

	test("returns the newest task job for an exact agent without leaking another agent's job", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const olderWorkerJob = manager.register("task", "older worker task", async () => "older", {
			id: "worker-old",
			agentId: "Worker",
		});
		const otherAgentJob = manager.register("task", "other agent task", async () => "other", {
			id: "reviewer-new",
			agentId: "Reviewer",
		});
		const latestWorkerJob = manager.register("task", "latest worker task", async () => "latest", {
			id: "worker-new",
			agentId: "Worker",
		});
		manager.register("bash", "worker shell task", async () => "shell", { id: "worker-bash", agentId: "Worker" });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });

		expect(manager.getLatestJobForAgent("Worker")?.id).toBe(latestWorkerJob);
		expect(manager.getLatestJobForAgent("Reviewer")?.id).toBe(otherAgentJob);
		expect(manager.getLatestJobForAgent("Worker")?.id).not.toBe(olderWorkerJob);
	});

	test("waitForOwnerJobs settles cancelled jobs and skips suppressed ones on request", async () => {
		const manager = new AsyncJobManager({});
		manager.register(
			"bash",
			"hung",
			async ({ signal }) => {
				await new Promise<void>(resolve => {
					if (signal.aborted) return resolve();
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return "stopped";
			},
			{ id: "hung-1", ownerId: "Sub" },
		);

		// Quiescence-barrier contract: a watched (suppressed) job can never
		// re-wake a run, so the filtered wait treats it as settled.
		manager.watchJobs(["hung-1"]);
		await expect(manager.waitForOwnerJobs("Sub", { excludeSuppressed: true })).resolves.toBe(true);

		// Teardown-reap contract: the unfiltered wait blocks until the
		// cancelled job's body actually finishes.
		const reap = manager.waitForOwnerJobs("Sub", { timeoutMs: 1_000 });
		manager.cancelAll({ ownerId: "Sub" });
		await expect(reap).resolves.toBe(true);
		expect(manager.getJob("hung-1")?.status).toBe("cancelled");
	});

	test("coalesces shared progress across jobs and resolves the superseded report", async () => {
		vi.useFakeTimers();
		setSystemTime(1);
		const rendered: string[] = [];
		const supersededReportResolved = Promise.withResolvers<void>();
		const releaseFirstJob = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });

		manager.register(
			"task",
			"first shared target",
			async ({ reportProgress }) => {
				await reportProgress("stale revision");
				supersededReportResolved.resolve();
				await releaseFirstJob.promise;
				return "first done";
			},
			{
				progressKey: "shared-target",
				onProgress: text => {
					rendered.push(`first:${text}`);
				},
			},
		);
		const newestJobId = manager.register(
			"task",
			"second shared target",
			async ({ reportProgress }) => {
				await reportProgress("newest revision");
				return "second done";
			},
			{
				progressKey: "shared-target",
				onProgress: text => {
					rendered.push(`second:${text}`);
				},
			},
		);

		try {
			await supersededReportResolved.promise;
			expect(rendered).toEqual([]);

			vi.advanceTimersByTime(100);
			await Promise.resolve();
			expect(rendered).toEqual(["second:newest revision"]);

			releaseFirstJob.resolve();
			await manager.waitForAll();
			expect(manager.getJob(newestJobId)?.status).toBe("completed");
		} finally {
			releaseFirstJob.resolve();
			manager.cancelAll();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 0 });
			setSystemTime();
			vi.useRealTimers();
		}
	});

	test("materializes lazy progress factories only for the dispatched revision", async () => {
		vi.useFakeTimers();
		setSystemTime(1);
		const materialized: string[] = [];
		const rendered: Array<{ text: string; details?: Record<string, unknown> }> = [];
		const staleReportResolved = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });

		manager.register(
			"bash",
			"lazy progress",
			async ({ reportProgress }) => {
				const stale = reportProgress(
					() => {
						materialized.push("stale text");
						return "stale";
					},
					() => {
						materialized.push("stale details");
						return { revision: "stale" };
					},
				);
				const latest = reportProgress(
					() => {
						materialized.push("latest text");
						return "latest";
					},
					() => {
						materialized.push("latest details");
						return { revision: "latest" };
					},
				);
				await stale;
				staleReportResolved.resolve();
				await latest;
				return "done";
			},
			{
				onProgress: (text, details) => {
					rendered.push({ text, details });
				},
			},
		);

		try {
			await staleReportResolved.promise;
			expect(materialized).toEqual([]);

			vi.advanceTimersByTime(100);
			await manager.waitForAll();

			expect(materialized).toEqual(["latest text", "latest details"]);
			expect(rendered).toEqual([{ text: "latest", details: { revision: "latest" } }]);
		} finally {
			manager.cancelAll();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 0 });
			setSystemTime();
			vi.useRealTimers();
		}
	});

	test("limits progress globally to eight callbacks per tick and serves the deferred target next", async () => {
		vi.useFakeTimers();
		setSystemTime(1);
		const rendered: string[] = [];
		const releaseJobs = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });

		for (let index = 0; index < 9; index++) {
			manager.register(
				"bash",
				`target ${index}`,
				async ({ reportProgress }) => {
					void reportProgress(`frame-${index}`);
					await releaseJobs.promise;
					return `done-${index}`;
				},
				{
					progressKey: `target-${index}`,
					onProgress: text => {
						rendered.push(text);
					},
				},
			);
		}

		try {
			vi.advanceTimersByTime(99);
			await Promise.resolve();
			expect(rendered).toEqual([]);

			vi.advanceTimersByTime(1);
			await Promise.resolve();
			expect(rendered).toEqual(Array.from({ length: 8 }, (_value, index) => `frame-${index}`));

			vi.advanceTimersByTime(100);
			await Promise.resolve();
			expect(rendered).toEqual(Array.from({ length: 9 }, (_value, index) => `frame-${index}`));

			releaseJobs.resolve();
			await manager.waitForAll();
		} finally {
			releaseJobs.resolve();
			manager.cancelAll();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 0 });
			setSystemTime();
			vi.useRealTimers();
		}
	});

	test("throttles a terminal burst to eight callbacks per global budget window", async () => {
		vi.useFakeTimers();
		setSystemTime(1);
		const rendered: string[] = [];
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });

		for (let index = 0; index < 9; index++) {
			manager.register(
				"bash",
				`terminal target ${index}`,
				async ({ reportProgress }) => {
					await reportProgress(`terminal-${index}`, undefined, { terminal: true });
					return `done-${index}`;
				},
				{
					progressKey: `terminal-target-${index}`,
					onProgress: text => {
						rendered.push(text);
					},
				},
			);
		}

		try {
			await Promise.resolve();
			expect(rendered).toEqual([]);

			vi.advanceTimersByTime(0);
			await Promise.resolve();
			expect(rendered).toEqual(Array.from({ length: 8 }, (_value, index) => `terminal-${index}`));

			vi.advanceTimersByTime(99);
			await Promise.resolve();
			expect(rendered).toEqual(Array.from({ length: 8 }, (_value, index) => `terminal-${index}`));

			vi.advanceTimersByTime(1);
			await manager.waitForAll();
			expect(rendered).toEqual(Array.from({ length: 9 }, (_value, index) => `terminal-${index}`));
		} finally {
			manager.cancelAll();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 0 });
			setSystemTime();
			vi.useRealTimers();
		}
	});

	test("reserves one shared-budget slot for ordinary progress while terminals have priority", async () => {
		vi.useFakeTimers();
		setSystemTime(1);
		const rendered: string[] = [];
		const manager = new AsyncJobManager({ maxRunningJobs: 16, onJobComplete: async () => {} });

		for (let index = 0; index < 8; index++) {
			manager.register(
				"bash",
				`ordinary target ${index}`,
				async ({ reportProgress }) => {
					await reportProgress(`ordinary-${index}`);
					return `ordinary done-${index}`;
				},
				{
					progressKey: `ordinary-target-${index}`,
					onProgress: text => {
						rendered.push(text);
					},
				},
			);
		}
		for (let index = 0; index < 8; index++) {
			manager.register(
				"bash",
				`terminal target ${index}`,
				async ({ reportProgress }) => {
					await reportProgress(`terminal-${index}`, undefined, { terminal: true });
					return `terminal done-${index}`;
				},
				{
					progressKey: `terminal-target-${index}`,
					onProgress: text => {
						rendered.push(text);
					},
				},
			);
		}

		try {
			await Promise.resolve();
			expect(rendered).toEqual([]);

			vi.advanceTimersByTime(0);
			await Promise.resolve();
			expect(rendered).toEqual([
				"terminal-0",
				"terminal-1",
				"terminal-2",
				"terminal-3",
				"terminal-4",
				"terminal-5",
				"terminal-6",
				"ordinary-0",
			]);

			vi.advanceTimersByTime(99);
			await Promise.resolve();
			expect(rendered).toHaveLength(8);

			vi.advanceTimersByTime(1);
			await manager.waitForAll();
			expect(rendered).toEqual([
				"terminal-0",
				"terminal-1",
				"terminal-2",
				"terminal-3",
				"terminal-4",
				"terminal-5",
				"terminal-6",
				"ordinary-0",
				"terminal-7",
				"ordinary-1",
				"ordinary-2",
				"ordinary-3",
				"ordinary-4",
				"ordinary-5",
				"ordinary-6",
				"ordinary-7",
			]);
		} finally {
			manager.cancelAll();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 0 });
			setSystemTime();
			vi.useRealTimers();
		}
	});

	test("defers a terminal arriving after a full ordinary window until the next global window", async () => {
		vi.useFakeTimers();
		setSystemTime(1);
		const rendered: string[] = [];
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });

		for (let index = 0; index < 8; index++) {
			manager.register(
				"bash",
				`ordinary target ${index}`,
				async ({ reportProgress }) => {
					await reportProgress(`ordinary-${index}`);
					return `ordinary done-${index}`;
				},
				{
					progressKey: `ordinary-target-${index}`,
					onProgress: text => {
						rendered.push(text);
					},
				},
			);
		}

		try {
			vi.advanceTimersByTime(100);
			await Promise.resolve();
			expect(rendered).toEqual(Array.from({ length: 8 }, (_value, index) => `ordinary-${index}`));

			manager.register(
				"bash",
				"late terminal target",
				async ({ reportProgress }) => {
					await reportProgress("terminal", undefined, { terminal: true });
					return "terminal done";
				},
				{
					progressKey: "late-terminal-target",
					onProgress: text => {
						rendered.push(text);
					},
				},
			);

			await Promise.resolve();
			expect(rendered).toHaveLength(8);
			vi.advanceTimersByTime(0);
			await Promise.resolve();
			expect(rendered).toHaveLength(8);

			vi.advanceTimersByTime(100);
			await manager.waitForAll();
			expect(rendered).toEqual([...Array.from({ length: 8 }, (_value, index) => `ordinary-${index}`), "terminal"]);
		} finally {
			manager.cancelAll();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 0 });
			setSystemTime();
			vi.useRealTimers();
		}
	});

	test("holds terminal job settlement and delivery until its terminal callback completes", async () => {
		vi.useFakeTimers();
		setSystemTime(1);
		const order: string[] = [];
		const terminalProgressStarted = Promise.withResolvers<void>();
		const releaseTerminalProgress = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				order.push("delivery");
			},
		});
		const jobId = manager.register(
			"bash",
			"terminal settlement",
			async ({ reportProgress }) => {
				await reportProgress("terminal", undefined, { terminal: true });
				return "finished";
			},
			{
				onProgress: async text => {
					order.push(`${text}:started`);
					terminalProgressStarted.resolve();
					await releaseTerminalProgress.promise;
					order.push(`${text}:finished`);
				},
			},
		);

		try {
			await Promise.resolve();
			expect(order).toEqual([]);

			vi.advanceTimersByTime(0);
			await terminalProgressStarted.promise;
			expect(order).toEqual(["terminal:started"]);
			expect(manager.getJob(jobId)?.status).toBe("running");

			releaseTerminalProgress.resolve();
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 1_000 });
			expect(order).toEqual(["terminal:started", "terminal:finished", "delivery"]);
			expect(manager.getJob(jobId)?.status).toBe("completed");
		} finally {
			releaseTerminalProgress.resolve();
			manager.cancelAll();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 0 });
			setSystemTime();
			vi.useRealTimers();
		}
	});

	test("cancelling an active terminal callback waits for its report before settling", async () => {
		vi.useFakeTimers();
		setSystemTime(1);
		const order: string[] = [];
		const terminalProgressStarted = Promise.withResolvers<void>();
		const releaseTerminalProgress = Promise.withResolvers<void>();
		let reporterResumed = false;
		let jobSettled = false;
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				order.push("delivery");
			},
		});
		const jobId = manager.register(
			"bash",
			"active terminal cancellation",
			async ({ reportProgress }) => {
				await reportProgress("terminal", undefined, { terminal: true });
				reporterResumed = true;
				return "finished";
			},
			{
				onProgress: async () => {
					order.push("terminal:started");
					terminalProgressStarted.resolve();
					await releaseTerminalProgress.promise;
					order.push("terminal:finished");
				},
			},
		);
		const jobPromise = manager.getJob(jobId)!.promise;
		void jobPromise.then(() => {
			jobSettled = true;
		});

		try {
			await Promise.resolve();
			vi.advanceTimersByTime(0);
			await terminalProgressStarted.promise;

			expect(manager.cancel(jobId)).toBe(true);
			await Promise.resolve();
			await Promise.resolve();
			expect(reporterResumed).toBe(false);
			expect(jobSettled).toBe(false);
			expect(order).toEqual(["terminal:started"]);

			releaseTerminalProgress.resolve();
			await jobPromise;
			expect(reporterResumed).toBe(true);
			expect(jobSettled).toBe(true);
			expect(manager.getJob(jobId)?.status).toBe("cancelled");
			expect(order).toEqual(["terminal:started", "terminal:finished"]);
		} finally {
			releaseTerminalProgress.resolve();
			manager.cancelAll();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 0 });
			setSystemTime();
			vi.useRealTimers();
		}
	});

	test("keeps same-key terminal reports FIFO while replacing a queued ordinary revision", async () => {
		vi.useFakeTimers();
		setSystemTime(1);
		const rendered: string[] = [];
		const ordinaryReporterResumed = Promise.withResolvers<void>();
		const firstTerminalStarted = Promise.withResolvers<void>();
		const releaseFirstTerminal = Promise.withResolvers<void>();
		const secondTerminalStarted = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });

		manager.register(
			"bash",
			"shared terminal target",
			async ({ reportProgress }) => {
				const ordinary = reportProgress("ordinary");
				const firstTerminal = reportProgress("terminal first", undefined, { terminal: true });
				const secondTerminal = reportProgress("terminal second", undefined, { terminal: true });
				await ordinary;
				ordinaryReporterResumed.resolve();
				await firstTerminal;
				await secondTerminal;
				return "finished";
			},
			{
				progressKey: "shared-terminal-target",
				onProgress: async text => {
					rendered.push(text);
					if (text === "terminal first") {
						firstTerminalStarted.resolve();
						await releaseFirstTerminal.promise;
						return;
					}
					if (text === "terminal second") secondTerminalStarted.resolve();
				},
			},
		);

		try {
			await ordinaryReporterResumed.promise;
			expect(rendered).toEqual([]);

			vi.advanceTimersByTime(0);
			await firstTerminalStarted.promise;
			expect(rendered).toEqual(["terminal first"]);

			releaseFirstTerminal.resolve();
			await flushMicrotasks();
			vi.advanceTimersToNextTimer();
			await flushMicrotasks();
			await secondTerminalStarted.promise;
			await manager.waitForAll();
			expect(rendered).toEqual(["terminal first", "terminal second"]);
		} finally {
			releaseFirstTerminal.resolve();
			manager.cancelAll();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 0 });
			setSystemTime();
			vi.useRealTimers();
		}
	});

	test("starts queued same-key terminal callbacks at global budget boundaries", async () => {
		vi.useFakeTimers();
		setSystemTime(1);
		const order: string[] = [];
		const firstTerminalStarted = Promise.withResolvers<void>();
		const releaseFirstTerminal = Promise.withResolvers<void>();
		const queueRemainingTerminals = Promise.withResolvers<void>();
		const remainingTerminalsQueued = Promise.withResolvers<void>();
		const secondTerminalStarted = Promise.withResolvers<void>();
		const releaseSecondTerminal = Promise.withResolvers<void>();
		const thirdTerminalStarted = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });

		manager.register(
			"bash",
			"same-key terminal queue",
			async ({ reportProgress }) => {
				const first = reportProgress("first", undefined, { terminal: true });
				await queueRemainingTerminals.promise;
				const second = reportProgress("second", undefined, { terminal: true });
				const third = reportProgress("third", undefined, { terminal: true });
				remainingTerminalsQueued.resolve();
				await first;
				await second;
				await third;
				return "finished";
			},
			{
				onProgress: async text => {
					order.push(text);
					if (text === "first") {
						firstTerminalStarted.resolve();
						await releaseFirstTerminal.promise;
						return;
					}
					if (text === "second") {
						secondTerminalStarted.resolve();
						await releaseSecondTerminal.promise;
						return;
					}
					if (text === "third") thirdTerminalStarted.resolve();
				},
			},
		);

		try {
			vi.advanceTimersByTime(0);
			await firstTerminalStarted.promise;
			queueRemainingTerminals.resolve();
			await remainingTerminalsQueued.promise;

			vi.advanceTimersByTime(50);
			await Promise.resolve();
			expect(order).toEqual(["first"]);

			releaseFirstTerminal.resolve();
			await flushMicrotasks();
			expect(order).toEqual(["first"]);

			vi.advanceTimersByTime(49);
			await Promise.resolve();
			expect(order).toEqual(["first"]);
			vi.advanceTimersByTime(1);
			await flushMicrotasks();
			await secondTerminalStarted.promise;
			expect(order).toEqual(["first", "second"]);

			releaseSecondTerminal.resolve();
			await flushMicrotasks();
			expect(order).toEqual(["first", "second"]);

			vi.advanceTimersByTime(99);
			await Promise.resolve();
			expect(order).toEqual(["first", "second"]);
			vi.advanceTimersByTime(1);
			await flushMicrotasks();
			await thirdTerminalStarted.promise;
			await manager.waitForAll();
			expect(order).toEqual(["first", "second", "third"]);
		} finally {
			queueRemainingTerminals.resolve();
			releaseFirstTerminal.resolve();
			releaseSecondTerminal.resolve();
			manager.cancelAll();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 0 });
			setSystemTime();
			vi.useRealTimers();
		}
	});

	test("cancel and cancelAll discard queued progress and unblock its reporters", async () => {
		vi.useFakeTimers();
		setSystemTime(1);
		let materializations = 0;
		const callbacks: string[] = [];
		const firstReporterResumed = Promise.withResolvers<void>();
		const secondReporterResumed = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });

		const firstJobId = manager.register(
			"bash",
			"cancel one",
			async ({ reportProgress }) => {
				await reportProgress(() => {
					materializations++;
					return "cancel one";
				});
				firstReporterResumed.resolve();
				return "cancelled";
			},
			{
				onProgress: text => {
					callbacks.push(text);
				},
			},
		);
		const secondJobId = manager.register(
			"bash",
			"cancel all",
			async ({ reportProgress }) => {
				await reportProgress(() => {
					materializations++;
					return "cancel all";
				});
				secondReporterResumed.resolve();
				return "cancelled";
			},
			{
				onProgress: text => {
					callbacks.push(text);
				},
			},
		);

		try {
			expect(manager.cancel(firstJobId)).toBe(true);
			manager.cancelAll();
			await Promise.all([firstReporterResumed.promise, secondReporterResumed.promise]);
			await manager.waitForAll();

			vi.advanceTimersByTime(1_000);
			await Promise.resolve();
			expect(materializations).toBe(0);
			expect(callbacks).toEqual([]);
			expect(manager.getJob(firstJobId)?.status).toBe("cancelled");
			expect(manager.getJob(secondJobId)?.status).toBe("cancelled");
		} finally {
			manager.cancelAll();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 0 });
			setSystemTime();
			vi.useRealTimers();
		}
	});

	test("cancelling a terminal reporter chained behind another job releases it without rendering", async () => {
		vi.useFakeTimers();
		setSystemTime(1);
		const rendered: string[] = [];
		let terminalFactoryMaterializations = 0;
		const firstCallbackStarted = Promise.withResolvers<void>();
		const releaseFirstCallback = Promise.withResolvers<void>();
		const terminalReporterResumed = Promise.withResolvers<void>();
		const terminalJobSettled = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });

		manager.register(
			"bash",
			"blocking shared target",
			async ({ reportProgress }) => {
				await reportProgress("live");
				return "first done";
			},
			{
				progressKey: "shared-cancel-target",
				onProgress: async text => {
					rendered.push(`first:${text}`);
					firstCallbackStarted.resolve();
					await releaseFirstCallback.promise;
				},
			},
		);

		try {
			vi.advanceTimersByTime(100);
			await firstCallbackStarted.promise;

			const terminalJobId = manager.register(
				"bash",
				"terminal behind callback",
				async ({ reportProgress }) => {
					await reportProgress(
						() => {
							terminalFactoryMaterializations++;
							return "terminal";
						},
						undefined,
						{ terminal: true },
					);
					terminalReporterResumed.resolve();
					return "terminal done";
				},
				{
					progressKey: "shared-cancel-target",
					onProgress: text => {
						rendered.push(`terminal:${text}`);
					},
				},
			);
			manager.getJob(terminalJobId)?.promise.then(() => terminalJobSettled.resolve());

			vi.advanceTimersByTime(100);
			await Promise.resolve();
			expect(rendered).toEqual(["first:live"]);
			expect(terminalFactoryMaterializations).toBe(0);

			expect(manager.cancel(terminalJobId)).toBe(true);
			await terminalReporterResumed.promise;
			await terminalJobSettled.promise;
			expect(manager.getJob(terminalJobId)?.status).toBe("cancelled");
			expect(rendered).toEqual(["first:live"]);
			expect(terminalFactoryMaterializations).toBe(0);
		} finally {
			releaseFirstCallback.resolve();
			manager.cancelAll();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 0 });
			setSystemTime();
			vi.useRealTimers();
		}
	});

	test("keeps stale default-key progress out of a retention-zero job id reuse", async () => {
		vi.useFakeTimers();
		setSystemTime(1);
		const callbacks: string[] = [];
		let oldTerminalFactoryMaterializations = 0;
		const oldLiveStarted = Promise.withResolvers<void>();
		const releaseOldLive = Promise.withResolvers<void>();
		const allowOldTerminal = Promise.withResolvers<void>();
		const oldTerminalQueued = Promise.withResolvers<void>();
		const oldLiveReportResolved = Promise.withResolvers<void>();
		const newTerminalQueued = Promise.withResolvers<void>();
		const newTerminalRendered = Promise.withResolvers<void>();
		const releaseNewJob = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({ retentionMs: 0, onJobComplete: async () => {} });

		const oldJobId = manager.register(
			"bash",
			"old job",
			async ({ reportProgress }) => {
				const oldLive = reportProgress("old live");
				void oldLive.then(() => oldLiveReportResolved.resolve());
				await allowOldTerminal.promise;
				const oldTerminal = reportProgress(
					() => {
						oldTerminalFactoryMaterializations++;
						return "old terminal";
					},
					undefined,
					{ terminal: true },
				);
				oldTerminalQueued.resolve();
				await oldTerminal;
				return "old done";
			},
			{
				onProgress: async text => {
					callbacks.push(`old:${text}`);
					if (text !== "old live") return;
					oldLiveStarted.resolve();
					await releaseOldLive.promise;
				},
			},
		);

		try {
			vi.advanceTimersByTime(100);
			await oldLiveStarted.promise;
			allowOldTerminal.resolve();
			await oldTerminalQueued.promise;
			vi.advanceTimersByTime(100);
			await Promise.resolve();
			expect(callbacks).toEqual(["old:old live"]);
			expect(oldTerminalFactoryMaterializations).toBe(0);

			expect(manager.cancel(oldJobId)).toBe(true);
			expect(manager.getJob(oldJobId)).toBeUndefined();

			const newJobId = manager.register(
				"bash",
				"new job",
				async ({ reportProgress }) => {
					await reportProgress("new live");
					const newTerminal = reportProgress("new terminal", undefined, { terminal: true });
					newTerminalQueued.resolve();
					await newTerminal;
					await releaseNewJob.promise;
					return "new done";
				},
				{
					onProgress: text => {
						callbacks.push(`new:${text}`);
						if (text === "new terminal") newTerminalRendered.resolve();
					},
				},
			);
			expect(newJobId).toBe(oldJobId);

			vi.advanceTimersToNextTimer();
			await newTerminalQueued.promise;
			await flushMicrotasks();
			expect(callbacks).toEqual(["old:old live", "new:new live"]);
			vi.advanceTimersToNextTimer();
			await flushMicrotasks();
			await newTerminalRendered.promise;
			expect(callbacks).toEqual(["old:old live", "new:new live", "new:new terminal"]);
			expect(manager.getJob(newJobId)?.latestProgressText).toBe("new terminal");

			releaseOldLive.resolve();
			await oldLiveReportResolved.promise;
			await flushMicrotasks();
			expect(callbacks).toEqual(["old:old live", "new:new live", "new:new terminal"]);
			expect(oldTerminalFactoryMaterializations).toBe(0);
			expect(manager.getJob(newJobId)?.latestProgressText).toBe("new terminal");

			releaseNewJob.resolve();
			await manager.waitForAll();
		} finally {
			allowOldTerminal.resolve();
			releaseOldLive.resolve();
			releaseNewJob.resolve();
			manager.cancelAll();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 0 });
			setSystemTime();
			vi.useRealTimers();
		}
	});

	test("cancellation gates an old revision already waiting behind an in-flight callback", async () => {
		vi.useFakeTimers();
		setSystemTime(1);
		const rendered: string[] = [];
		let staleFactoryMaterializations = 0;
		const firstProgressStarted = Promise.withResolvers<void>();
		const releaseFirstProgress = Promise.withResolvers<void>();
		const allowSecondReport = Promise.withResolvers<void>();
		const secondReportQueued = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });

		const jobId = manager.register(
			"bash",
			"gated progress",
			async ({ reportProgress, signal }) => {
				const first = reportProgress("first");
				await allowSecondReport.promise;
				const stale = reportProgress(() => {
					staleFactoryMaterializations++;
					return "stale";
				});
				secondReportQueued.resolve();
				await Promise.all([first, stale]);
				await new Promise<void>(resolve => {
					if (signal.aborted) {
						resolve();
						return;
					}
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return "cancelled";
			},
			{
				onProgress: async text => {
					rendered.push(text);
					if (text !== "first") return;
					firstProgressStarted.resolve();
					await releaseFirstProgress.promise;
				},
			},
		);

		try {
			vi.advanceTimersByTime(100);
			await firstProgressStarted.promise;

			allowSecondReport.resolve();
			await secondReportQueued.promise;
			vi.advanceTimersByTime(100);

			expect(manager.cancel(jobId)).toBe(true);
			releaseFirstProgress.resolve();
			await manager.waitForAll();

			expect(rendered).toEqual(["first"]);
			expect(staleFactoryMaterializations).toBe(0);
			expect(manager.getJob(jobId)?.status).toBe("cancelled");
		} finally {
			allowSecondReport.resolve();
			releaseFirstProgress.resolve();
			manager.cancelAll();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 0 });
			setSystemTime();
			vi.useRealTimers();
		}
	});

	test("dispose clears scheduled progress, resolves its reporter, and prevents a late callback", async () => {
		vi.useFakeTimers();
		setSystemTime(1);
		const timerBaseline = vi.getTimerCount();
		let materializations = 0;
		let callbackCalls = 0;
		const reporterResumed = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });

		manager.register(
			"bash",
			"dispose pending progress",
			async ({ reportProgress }) => {
				await reportProgress(() => {
					materializations++;
					return "late";
				});
				reporterResumed.resolve();
				return "cancelled";
			},
			{
				onProgress: () => {
					callbackCalls++;
				},
			},
		);

		try {
			expect(vi.getTimerCount()).toBe(timerBaseline + 1);
			const disposed = await manager.dispose({ timeoutMs: 1_000 });
			await reporterResumed.promise;
			expect(vi.getTimerCount()).toBe(timerBaseline);
			vi.advanceTimersByTime(1_000);
			await Promise.resolve();

			expect(disposed).toBe(true);
			expect(materializations).toBe(0);
			expect(callbackCalls).toBe(0);
			expect(manager.getAllJobs()).toEqual([]);
		} finally {
			await manager.dispose({ timeoutMs: 0 });
			setSystemTime();
			vi.useRealTimers();
		}
	});
});

describe("AsyncJobManager smart poll-wait escalation", () => {
	const newManager = () => new AsyncJobManager({ onJobComplete: async () => {} });

	test("first poll waits the ladder floor", () => {
		const m = newManager();
		expect(m.nextPollWaitMs("Main", 1_000)).toBe(5_000);
		// A fresh owner also starts at the floor.
		expect(m.nextPollWaitMs("Other", 1_000)).toBe(5_000);
	});

	test("back-to-back polls climb the ladder to the top rung", () => {
		const m = newManager();
		const owner = "Main";
		const t = 1_000;
		const waits: number[] = [];
		for (let i = 0; i < 6; i++) {
			// Same timestamp every time → zero gap → always escalates.
			waits.push(m.nextPollWaitMs(owner, t));
			m.recordPollWaitEnd(owner, t);
		}
		// Climbs the rungs, then saturates at the top.
		expect(waits).toEqual([5_000, 10_000, 30_000, 60_000, 300_000, 300_000]);
	});

	test("a quiet gap of a minute resets back to the floor", () => {
		const m = newManager();
		const owner = "Main";

		expect(m.nextPollWaitMs(owner, 0)).toBe(5_000);
		m.recordPollWaitEnd(owner, 0);

		// Still within the reset window (just under a minute) → keeps climbing.
		expect(m.nextPollWaitMs(owner, 59_999)).toBe(10_000);
		m.recordPollWaitEnd(owner, 60_000);

		// A full minute without polling resets the climb to the floor.
		expect(m.nextPollWaitMs(owner, 120_000)).toBe(5_000);
	});

	test("escalation is tracked independently per owner", () => {
		const m = newManager();
		const t = 1_000;

		m.nextPollWaitMs("A", t);
		m.recordPollWaitEnd("A", t);
		m.nextPollWaitMs("A", t);
		m.recordPollWaitEnd("A", t);

		// A fresh owner starts at the floor regardless of A's escalation.
		expect(m.nextPollWaitMs("B", t)).toBe(5_000);
		// A keeps climbing from where it left off.
		expect(m.nextPollWaitMs("A", t)).toBe(30_000);
	});
});
