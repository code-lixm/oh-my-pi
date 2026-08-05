/**
 * Owner-routed async delivery + quiescence (structured concurrency for
 * background jobs): each AgentSession registers a delivery sink for its own
 * agent id, owned job completions inject async-result follow-up turns into
 * THAT session, and `hasPendingAsyncWork()` / `settleAsyncWork()` define the
 * run quiescence the task executor's barrier is built on.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { DaemonCompletionNotification } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AsyncResultEntry } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("AgentSession owner-routed async delivery", () => {
	let session: AgentSession;
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-async-delivery-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		AsyncJobManager.resetForTests();
	});

	const createSessionWithAsyncManager = async (manager: AsyncJobManager, agentId?: string): Promise<AgentSession> => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			asyncJobManager: manager,
			...(agentId === undefined ? {} : { agentId }),
		});
	};

	const waitForAbort = (signal: AbortSignal) =>
		new Promise<string>(resolve => {
			if (signal.aborted) {
				resolve("cancelled");
				return;
			}
			signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
		});

	it("keeps visible count aligned with an owner-scoped snapshot and cancels only that owner", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		session = await createSessionWithAsyncManager(manager, "SubAgent");
		const ownedJobId = manager.register("task", "queued owned job", ({ signal }) => waitForAbort(signal), {
			ownerId: "SubAgent",
			queued: true,
		});
		const otherJobId = manager.register("bash", "other owner's job", ({ signal }) => waitForAbort(signal), {
			ownerId: "Other",
		});

		try {
			const snapshot = session.getAsyncJobSnapshot();
			if (!snapshot) throw new Error("Expected owner-scoped async job snapshot");
			expect(snapshot.running.map(job => job.id)).toEqual([ownedJobId]);
			expect(session.getVisibleAsyncJobCount()).toBe(snapshot.running.length);
			expect(session.getVisibleAsyncJobCount()).toBe(1);
			expect(session.runningAsyncJobCount).toBe(1);

			expect(session.cancelAsyncJobs()).toBe(1);
			expect(manager.getJob(ownedJobId)?.status).toBe("cancelled");
			expect(manager.getJob(otherJobId)?.status).toBe("running");
			expect(session.getVisibleAsyncJobCount()).toBe(0);
			expect(session.getAsyncJobSnapshot()?.running).toEqual([]);
			expect(manager.getRunningJobCount()).toBe(1);
		} finally {
			manager.cancelAll();
			await manager.waitForAll();
		}
	});

	it("keeps visible count unscoped without an agent id while cancellation remains own-scoped", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		session = await createSessionWithAsyncManager(manager);
		const mainJobId = manager.register("task", "main job", ({ signal }) => waitForAbort(signal), { ownerId: "Main" });
		const otherJobId = manager.register("bash", "other job", ({ signal }) => waitForAbort(signal), {
			ownerId: "Other",
		});

		try {
			const snapshot = session.getAsyncJobSnapshot();
			if (!snapshot) throw new Error("Expected unscoped async job snapshot");
			expect(snapshot.running.map(job => job.id)).toEqual([mainJobId, otherJobId]);
			expect(session.getVisibleAsyncJobCount()).toBe(snapshot.running.length);
			expect(session.getVisibleAsyncJobCount()).toBe(2);
			expect(session.runningAsyncJobCount).toBe(0);
			expect(session.cancelAsyncJobs()).toBe(0);
			expect(manager.getRunningJobs().map(job => job.id)).toEqual([mainJobId, otherJobId]);
		} finally {
			manager.cancelAll();
			await manager.waitForAll();
		}
	});

	it("injects an owned completion as a follow-up turn and reaches quiescence", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "SubAgent",
			asyncJobManager: manager,
		});

		const gate = Promise.withResolvers<string>();
		manager.register("bash", "gated job", () => gate.promise, { id: "sub-job", ownerId: "SubAgent" });

		// A running owned job holds the session out of quiescence.
		expect(session.hasPendingAsyncWork()).toBe(true);

		gate.resolve("job finished: ALL GREEN");
		await session.settleAsyncWork();

		// The completion routed to THIS session (not a global default sink) and
		// ran as a follow-up turn whose context carries the job result.
		expect(session.hasPendingAsyncWork()).toBe(false);
		const sawResult = mock.calls.some(call =>
			call.context.messages.some(message => {
				if (typeof message.content === "string") {
					return message.content.includes("ALL GREEN");
				}
				return (
					Array.isArray(message.content) &&
					message.content.some(content => content.type === "text" && content.text.includes("ALL GREEN"))
				);
			}),
		);
		expect(sawResult).toBe(true);
	});

	it("routes an advisor-owned launch completion through the session", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory();
		const owner = `${sessionManager.getSessionId()}-advisor`;
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const completion = {
			event: "daemon-completed",
			completionId: "advisor-completion",
			owner,
			daemon: {
				name: "advisor-worker",
				id: "daemon-id",
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner,
				persist: false,
				detached: false,
			},
		} satisfies DaemonCompletionNotification;

		await session.queueLaunchCompletion(completion);
		await session.waitForIdle();

		expect(
			mock.calls.some(call =>
				call.context.messages.some(message =>
					typeof message.content === "string"
						? message.content.includes("advisor-worker")
						: message.content.some(content => content.type === "text" && content.text.includes("advisor-worker")),
				),
			),
		).toBe(true);
	});

	it("purges finished owned jobs when starting a new session", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});

		const completedJobId = manager.register("task", "prior session", async () => "done", {
			id: "prior-session-job",
			ownerId: "Main",
		});
		const failedJobId = manager.register(
			"task",
			"failed prior session",
			async () => {
				throw new Error("prior session failure");
			},
			{
				id: "failed-prior-session-job",
				ownerId: "Main",
			},
		);
		const otherOwnerJobId = manager.register("task", "other session", async () => "done", {
			id: "other-session-job",
			ownerId: "Other",
		});
		manager.watchJobs([completedJobId, failedJobId, otherOwnerJobId]);
		await manager.waitForAll();

		expect(manager.getJob(completedJobId)?.status).toBe("completed");
		expect(manager.getJob(failedJobId)?.status).toBe("failed");
		expect(await session.newSession()).toBe(true);
		expect(manager.getJob(completedJobId)).toBeUndefined();
		expect(manager.getJob(failedJobId)).toBeUndefined();
		expect(manager.getJob(otherOwnerJobId)?.status).toBe("completed");
	});

	it("does not inject a prior session's pending async result after a new session", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});

		// Complete a job and push its result all the way onto the yield queue, so a
		// follow-up turn is pending injection into the (soon-to-be-replaced) session.
		manager.register("task", "prior session", async () => "STALE ASYNC RESULT", {
			id: "prior-session-job",
			ownerId: "Main",
		});
		await manager.waitForOwnerJobs("Main");
		await manager.drainDeliveries({ filter: { ownerId: "Main" } });
		expect(session.hasPendingAsyncWork()).toBe(true);

		expect(await session.newSession()).toBe(true);
		expect(session.hasPendingAsyncWork()).toBe(false);

		// A fresh turn in the replacement session must not carry the prior result.
		const callsBefore = mock.calls.length;
		await session.sendUserMessage("fresh turn");
		const leaked = mock.calls.slice(callsBefore).some(call =>
			call.context.messages.some(message => {
				if (typeof message.content === "string") return message.content.includes("STALE ASYNC RESULT");
				return (
					Array.isArray(message.content) &&
					message.content.some(content => content.type === "text" && content.text.includes("STALE ASYNC RESULT"))
				);
			}),
		);
		expect(leaked).toBe(false);
	});

	it("drops a prior session's late delivery even after its job id is reused", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});

		// The delivery generation starts at 0; a new session bumps it to 1.
		expect(await session.newSession()).toBe(true);

		// Simulate a delivery that finished formatting in the prior session (epoch
		// 0) but only reaches the yield queue after the transition — the exact
		// window a reused job id would reopen by clearing the manager's per-id
		// suppression marker. It must not inject into the replacement transcript.
		session.yieldQueue.enqueue<AsyncResultEntry>("async-result", {
			jobId: "bg_1",
			result: "STALE ASYNC RESULT",
			job: undefined,
			durationMs: 0,
			epoch: 0,
		});

		const callsBefore = mock.calls.length;
		await session.sendUserMessage("fresh turn");
		await session.settleAsyncWork();
		const leaked = mock.calls.slice(callsBefore).some(call =>
			call.context.messages.some(message => {
				if (typeof message.content === "string") return message.content.includes("STALE ASYNC RESULT");
				return (
					Array.isArray(message.content) &&
					message.content.some(content => content.type === "text" && content.text.includes("STALE ASYNC RESULT"))
				);
			}),
		);
		expect(leaked).toBe(false);
		// The stale entry was consumed by the run's aside/flush path and dropped,
		// not left lingering as pending work.
		expect(session.hasPendingAsyncWork()).toBe(false);
	});

	it("still reports pending async work while a delivered result awaits injection", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "SubAgent",
			asyncJobManager: manager,
		});

		const gate = Promise.withResolvers<string>();
		manager.register("bash", "gated job", () => gate.promise, { id: "sub-job", ownerId: "SubAgent" });
		gate.resolve("job finished: QUEUED RESULT");
		await manager.waitForOwnerJobs("SubAgent");
		await manager.drainDeliveries({ filter: { ownerId: "SubAgent" } });

		// The manager has fully handed off — no running jobs, no queued or
		// in-flight deliveries — but the async-result follow-up still sits on
		// the session's yield queue awaiting the (delayed) idle flush / next
		// step boundary. A terminal yield observed in this window MUST still
		// count as pending async work, or the run driver terminates and the
		// delivered result is silently dropped from the final report.
		expect(session.hasPendingAsyncWork()).toBe(true);

		// Settling drains the queued follow-up into a real turn and only then
		// reaches quiescence.
		await session.settleAsyncWork();
		expect(session.hasPendingAsyncWork()).toBe(false);
	});

	it("cancels only its own running jobs and prevents its queued result from reaching a later turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});

		manager.register("task", "queued owned result", async () => "CANCELLED ASYNC RESULT", {
			id: "queued-main-job",
			ownerId: "Main",
		});
		await manager.waitForOwnerJobs("Main");
		await manager.drainDeliveries({ filter: { ownerId: "Main" } });
		expect(session.hasPendingAsyncWork()).toBe(true);

		let ownedAborted = false;
		let otherOwnerAborted = false;
		const waitForAbort = (signal: AbortSignal, onAbort: () => void) =>
			new Promise<string>(resolve => {
				signal.addEventListener(
					"abort",
					() => {
						onAbort();
						resolve("cancelled");
					},
					{ once: true },
				);
			});
		manager.register("bash", "running owned job", ({ signal }) => waitForAbort(signal, () => (ownedAborted = true)), {
			id: "running-main-job",
			ownerId: "Main",
		});
		manager.register(
			"bash",
			"running other-owner job",
			({ signal }) => waitForAbort(signal, () => (otherOwnerAborted = true)),
			{ id: "running-other-job", ownerId: "Other" },
		);

		try {
			expect(session.runningAsyncJobCount).toBe(1);
			expect(session.cancelAsyncJobs()).toBe(1);
			expect(ownedAborted).toBe(true);
			expect(otherOwnerAborted).toBe(false);
			expect(session.runningAsyncJobCount).toBe(0);
			expect(session.hasPendingAsyncWork()).toBe(false);

			const callsBefore = mock.calls.length;
			await session.sendUserMessage("fresh turn");
			const laterCalls = mock.calls.slice(callsBefore);
			const messageTexts = laterCalls.flatMap(call =>
				call.context.messages.flatMap(message => {
					if (typeof message.content === "string") return [message.content];
					return Array.isArray(message.content)
						? message.content.flatMap(content => (content.type === "text" ? [content.text] : []))
						: [];
				}),
			);
			expect(messageTexts.some(text => text.includes("fresh turn"))).toBe(true);
			expect(messageTexts.some(text => text.includes("CANCELLED ASYNC RESULT"))).toBe(false);
		} finally {
			manager.cancelAll();
			await manager.waitForAll();
		}
	});
});
