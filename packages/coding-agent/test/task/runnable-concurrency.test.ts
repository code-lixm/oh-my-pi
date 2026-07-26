import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskRunnableConcurrency } from "@oh-my-pi/pi-coding-agent/task/request-concurrency";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";

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

interface ControlledSession {
	id: string;
	session: AgentSession;
	started: Promise<void>;
	startCount: () => number;
	hasStarted: () => boolean;
	release: () => void;
}

describe("TaskRunnableConcurrency", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: ControlledSession[] = [];

	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-runnable-concurrency-");
		authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join(`models-${Snowflake.next()}.yml`));
	});

	afterEach(async () => {
		const current = sessions.splice(0);
		for (const controlled of current) controlled.release();
		await Promise.allSettled(current.map(controlled => controlled.session.waitForIdle()));
		for (const controlled of current) {
			await controlled.session.dispose();
		}
		authStorage.close();
		await tempDir.remove();
		AgentRegistry.resetGlobalForTests();
	});

	function createControlledSubSession(
		shared: TaskRunnableConcurrency,
		id: string,
		initialMessages: AgentMessage[] = [],
	): ControlledSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");

		const started = deferred<void>();
		const finish = deferred<void>();
		let released = false;
		let startedFlag = false;
		let callCount = 0;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: initialMessages,
			},
			streamFn: (_model, _context, options) => {
				callCount++;
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;
				const response = createAssistantMessage(`${id} reply ${callCount}`);
				let settled = false;
				const finishWithDone = () => {
					if (settled) return;
					settled = true;
					stream.push({ type: "done", reason: "stop", message: response });
				};
				const finishWithAbort = () => {
					if (settled) return;
					settled = true;
					const aborted = createAssistantMessage(`${id} aborted`);
					aborted.content = [];
					aborted.stopReason = "error";
					aborted.errorMessage = "aborted";
					stream.push({ type: "error", reason: "aborted", error: aborted });
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					startedFlag = true;
					started.resolve();
					if (signal?.aborted) {
						finishWithAbort();
						return;
					}
					finish.promise.then(finishWithDone, finishWithAbort);
					signal?.addEventListener("abort", finishWithAbort, { once: true });
				});
				return stream;
			},
		});

		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
			}),
			modelRegistry,
			agentId: id,
			agentKind: "sub",
			taskRunnableConcurrency: shared,
		});

		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session,
			status: "idle",
		});

		const controlled = {
			id,
			session,
			started: started.promise,
			startCount: () => callCount,
			hasStarted: () => startedFlag,
			release: () => {
				if (released) return;
				released = true;
				finish.resolve();
			},
		};
		sessions.push(controlled);
		return controlled;
	}

	it("limits active runnable leases to 2 across five agents and reports queued waiters", async () => {
		const scheduler = new TaskRunnableConcurrency(() => 2);
		const acquired: string[] = [];
		const gates = new Map<string, PromiseWithResolvers<void>>();
		const ids = ["A", "B", "C", "D", "E"];
		const runs = ids.map(async id => {
			const gate = deferred<void>();
			gates.set(id, gate);
			const release = await scheduler.acquire(id);
			acquired.push(id);
			await gate.promise;
			release();
		});

		await waitUntil(() => acquired.length === 2, "expected exactly two runnable leases to start");
		expect(scheduler.snapshot()).toEqual({ active: 2, queued: 3, limit: 2 });

		gates.get(acquired[0]!)?.resolve();
		await waitUntil(() => acquired.length === 3, "third runnable lease never started after a release");
		expect(scheduler.snapshot()).toEqual({ active: 2, queued: 2, limit: 2 });

		gates.get(acquired[1]!)?.resolve();
		await waitUntil(() => acquired.length === 4, "fourth runnable lease never started after a release");
		expect(scheduler.snapshot()).toEqual({ active: 2, queued: 1, limit: 2 });

		gates.get(acquired[2]!)?.resolve();
		await waitUntil(() => acquired.length === 5, "fifth runnable lease never started after a release");
		expect(scheduler.snapshot()).toEqual({ active: 2, queued: 0, limit: 2 });

		for (const id of ids) gates.get(id)?.resolve();
		await Promise.all(runs);
		expect(scheduler.snapshot()).toEqual({ active: 0, queued: 0, limit: 2 });
	});

	it("withSuspended releases the parent slot for a child and reacquires it on resume", async () => {
		const scheduler = new TaskRunnableConcurrency(() => 1);
		const parentRelease = await scheduler.acquire("parent");
		expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0, limit: 1 });

		const childLease = scheduler.acquire("child");
		await waitUntil(() => scheduler.snapshot().queued === 1, "child never queued behind the parent slot");

		const phases: string[] = [];
		const snapshots = {
			suspended: undefined as ReturnType<TaskRunnableConcurrency["snapshot"]> | undefined,
			duringChild: undefined as ReturnType<TaskRunnableConcurrency["snapshot"]> | undefined,
			resumed: undefined as ReturnType<TaskRunnableConcurrency["snapshot"]> | undefined,
		};

		await scheduler.withSuspended(
			"parent",
			async () => {
				phases.push("run");
				const childRelease = await childLease;
				snapshots.duringChild = scheduler.snapshot();
				childRelease();
			},
			{
				onSuspend: () => {
					phases.push("suspend");
					snapshots.suspended = scheduler.snapshot();
				},
				onResume: () => {
					phases.push("resume");
					snapshots.resumed = scheduler.snapshot();
				},
			},
		);

		expect(phases).toEqual(["suspend", "run", "resume"]);
		expect(snapshots.suspended).toEqual({ active: 0, queued: 1, limit: 1 });
		expect(snapshots.duringChild).toEqual({ active: 1, queued: 0, limit: 1 });
		expect(snapshots.resumed).toEqual({ active: 1, queued: 0, limit: 1 });

		parentRelease();
		expect(scheduler.snapshot()).toEqual({ active: 0, queued: 0, limit: 1 });
	});

	it("shares one runnable scheduler across prompt, YieldQueue wake, IRC wake, and follow-up continue", async () => {
		const shared = new TaskRunnableConcurrency(() => 8);
		const registry = AgentRegistry.global();
		let maxRunning = 0;
		const runningCount = () => registry.list().filter(ref => ref.kind === "sub" && ref.status === "running").length;
		const updateMaxRunning = () => {
			maxRunning = Math.max(maxRunning, runningCount());
		};
		const unsubscribe = registry.onChange(() => updateMaxRunning());
		updateMaxRunning();

		try {
			const promptSessions = ["Prompt-1", "Prompt-2", "Prompt-3"].map(id => createControlledSubSession(shared, id));
			const yieldSessions = ["Yield-1", "Yield-2", "Yield-3"].map(id => createControlledSubSession(shared, id));
			const ircSessions = ["IRC-1", "IRC-2"].map(id => createControlledSubSession(shared, id));
			const followUpSessions = ["Follow-1", "Follow-2"].map(id =>
				createControlledSubSession(shared, id, [
					{ role: "user", content: "seed", timestamp: Date.now() - 1 },
					createAssistantMessage("seed"),
				]),
			);
			const all = [...promptSessions, ...yieldSessions, ...ircSessions, ...followUpSessions];
			expect(all.map(controlled => registry.get(controlled.id)?.status)).toEqual(new Array(all.length).fill("idle"));

			const startedIds = new Set<string>();
			for (const controlled of all) {
				void controlled.started.then(() => {
					startedIds.add(controlled.id);
				});
			}

			for (const controlled of yieldSessions) {
				controlled.session.yieldQueue.register<string>("wake-test", {
					build: entries => ({
						role: "custom",
						customType: "wake-test",
						content: entries.join("\n"),
						display: false,
						attribution: "agent",
						timestamp: Date.now(),
					}),
				});
			}

			const promptPromises = promptSessions.map(controlled =>
				controlled.session.prompt(`start ${controlled.id}`, { attribution: "agent" }),
			);
			for (const controlled of yieldSessions) {
				controlled.session.yieldQueue.enqueue("wake-test", controlled.id);
			}
			const ircOutcomePromise = Promise.all(
				ircSessions.map(controlled =>
					controlled.session.deliverIrcMessage({
						id: `msg-${controlled.id}`,
						from: "peer",
						to: controlled.id,
						body: "status?",
						ts: Date.now(),
					} as IrcMessage),
				),
			);
			await Promise.all(
				followUpSessions.map(controlled =>
					controlled.session.sendUserMessage(`follow ${controlled.id}`, { deliverAs: "followUp" }),
				),
			);

			await waitUntil(() => {
				const snapshot = shared.snapshot();
				return snapshot.active === 8 && snapshot.queued === 2 && startedIds.size === 8;
			}, "shared runnable scheduler never reached the expected 8 active / 2 queued state");

			const queuedIds = all
				.filter(controlled => !startedIds.has(controlled.id))
				.map(controlled => controlled.id)
				.sort();
			expect(shared.snapshot()).toEqual({ active: 8, queued: 2, limit: 8 });
			expect(runningCount()).toBe(8);
			expect(queuedIds).toHaveLength(2);
			for (const id of queuedIds) {
				expect(registry.get(id)?.status).toBe("waiting");
			}
			expect(await ircOutcomePromise).toEqual(["woken", "woken"]);
			expect(maxRunning).toBeLessThanOrEqual(8);

			for (const controlled of all.filter(candidate => candidate.hasStarted())) {
				controlled.release();
			}
			await waitUntil(
				() => startedIds.size === all.length,
				"queued runnable turns never started after slots were freed",
			);
			expect(shared.snapshot()).toEqual({ active: 2, queued: 0, limit: 8 });
			expect(runningCount()).toBe(2);

			for (const controlled of all) controlled.release();
			await Promise.all(promptPromises);
			await Promise.all(all.map(controlled => controlled.session.waitForIdle()));
			expect(shared.snapshot()).toEqual({ active: 0, queued: 0, limit: 8 });
			expect(maxRunning).toBeLessThanOrEqual(8);
			expect(all.map(controlled => controlled.startCount())).toEqual(new Array(all.length).fill(1));
		} finally {
			unsubscribe();
		}
	});
});
