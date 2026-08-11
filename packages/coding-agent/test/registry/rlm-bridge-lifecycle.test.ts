import { describe, expect, it } from "bun:test";
import { AsyncJobManager, RLM_JOB_TYPE } from "../../src/async";
import { createRlmLifecycle, type RlmBridgeDeps, type RlmSpawnedSubagent } from "../../src/eval/rlm-bridge";
import type { RlmChildRegistryEntry } from "../../src/eval/rlm-types";
import type { RlmChildLifecycle } from "../../src/prime-integration/contracts";
import type {
	RlmAdmissionRecord,
	RlmAdmissionReservation,
	RlmChildInfo,
	RlmChildRegistry,
	RlmDeleteSubagentResult,
	RlmRunningPublication,
	RlmSettlement,
} from "../../src/registry/rlm-child-registry";

type JobRegistrar = NonNullable<RlmBridgeDeps["registerJob"]>;
type JobRun = Parameters<JobRegistrar>[1];
type JobOptions = Parameters<JobRegistrar>[2];
type SpawnOptions = Parameters<RlmBridgeDeps["spawnSubagent"]>[1];
type SiblingRegistry = NonNullable<RlmBridgeDeps["siblingRegistry"]>;

type DeliveryStatus = "delivered" | "queued" | "failed";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(nextResolve => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index++) await Promise.resolve();
}

interface SentMessage {
	agentId: string;
	message: string;
	mode: "steer" | "followUp";
}

interface SpawnCall {
	prompt: string;
	options: SpawnOptions;
}

interface FakeJobRegistration {
	label: string;
	jobId: string;
	options: JobOptions;
	runPromise: Promise<string>;
}

class FakeJobManager {
	readonly registrations: FakeJobRegistration[] = [];

	register(label: string, run: JobRun, options: JobOptions): string {
		const jobId = `job-${options.id}`;
		const runPromise = run({
			jobId,
			signal: new AbortController().signal,
			markRunning: () => {},
		});
		this.registrations.push({ label, jobId, options, runPromise });
		void runPromise.catch(() => {});
		return jobId;
	}
}

class FakeRlmChildRegistry {
	readonly admitCalls: RlmAdmissionRecord[] = [];
	readonly markRunningCalls: Array<{ childId: string; publication: RlmRunningPublication }> = [];
	readonly markSettledCalls: Array<{ childId: string; result: RlmSettlement }> = [];
	readonly markTerminalNoticeCalls: Array<{ childId: string; status: "pending" | "sent" }> = [];
	readonly listCalls: Array<readonly string[]> = [];
	readonly deleteDirectChildCalls: Array<{ target: string; reason: string }> = [];
	readonly markParentReplyCalls: string[] = [];
	readonly awaitPublicationCalls: string[] = [];
	readonly timeline: string[] = [];
	readonly admissionStarted: Promise<void>;

	readonly #children = new Map<string, RlmChildInfo>();
	readonly #reservations = new Map<string, RlmAdmissionRecord>();
	readonly #blockAdmission: boolean;
	readonly #admissionError: Error | undefined;
	readonly #admissionStarted = deferred<void>();
	readonly #admissionRelease = deferred<void>();
	readonly #settledResults = new Map<string, RlmSettlement>();
	readonly #settledWaiters = new Map<string, Deferred<RlmSettlement>>();
	readonly #terminalNoticeResults = new Map<string, "pending" | "sent">();
	readonly #publicationWaiters = new Map<string, Deferred<RlmChildInfo>>();
	readonly #terminalNoticeWaiters = new Map<string, Deferred<"pending" | "sent">>();
	#pendingTerminalNoticeRetry: ((child: RlmChildInfo) => Promise<void>) | undefined;

	constructor(blockAdmission = false, admissionError?: Error) {
		this.#blockAdmission = blockAdmission;
		this.#admissionError = admissionError;
		this.admissionStarted = this.#admissionStarted.promise;
	}

	async reserveAdmission(input: RlmAdmissionRecord): Promise<RlmAdmissionReservation> {
		if (this.#admissionError) throw this.#admissionError;
		this.admitCalls.push({ ...input });
		this.#reservations.set(input.rlmChildId, { ...input });
		this.timeline.push(`reserve:${input.rlmChildId}`);
		this.#admissionStarted.resolve(undefined);
		return { rlmChildId: input.rlmChildId, name: input.name };
	}

	async commitAdmission(reservation: RlmAdmissionReservation, jobId?: string | null): Promise<RlmChildInfo> {
		const input = this.#reservations.get(reservation.rlmChildId);
		if (!input) throw new Error(`Unknown fake reservation ${reservation.rlmChildId}`);
		if (this.#blockAdmission) await this.#admissionRelease.promise;
		const info: RlmChildInfo = {
			rlm_child_id: input.rlmChildId,
			name: input.name,
			session_dir: `/fake/rlm/${input.rlmChildId}`,
			model: input.model,
			run_status: "queued",
			residency: null,
			agent_id: input.rlmChildId,
			active_session_id: null,
			session_id: null,
			session_file: null,
			job_id: jobId ?? input.jobId ?? null,
			task_depth: input.taskDepth,
			max_depth: input.maxDepth,
			terminal_notice: "none",
			replied_to_parent: false,
		};
		this.#children.set(input.rlmChildId, info);
		this.#reservations.delete(input.rlmChildId);
		const admission = this.admitCalls.find(call => call.rlmChildId === input.rlmChildId);
		if (admission && jobId) admission.jobId = jobId;
		this.timeline.push(`commit:${input.rlmChildId}`);
		return { ...info };
	}

	async bindJob(childId: string, jobId: string): Promise<void> {
		const child = this.requireChild(childId);
		this.#children.set(childId, { ...child, job_id: jobId });
		const admission = this.admitCalls.find(call => call.rlmChildId === childId);
		if (admission) admission.jobId = jobId;
		this.timeline.push(`bindJob:${childId}`);
	}

	rollbackAdmission(reservation: RlmAdmissionReservation, _jobId?: string): void {
		this.#reservations.delete(reservation.rlmChildId);
		this.timeline.push(`rollback:${reservation.rlmChildId}`);
	}

	async admit(input: RlmAdmissionRecord): Promise<RlmChildInfo> {
		const reservation = await this.reserveAdmission(input);
		return await this.commitAdmission(reservation, input.jobId);
	}

	async list(): Promise<RlmChildInfo[]> {
		const children = [...this.#children.values()]
			.filter(child => child.run_status !== "deleted")
			.map(child => ({ ...child }));
		this.listCalls.push(children.map(child => child.rlm_child_id));
		this.timeline.push("list");
		return children;
	}

	async awaitPublication(childId: string): Promise<RlmChildInfo> {
		this.awaitPublicationCalls.push(childId);
		const child = this.requireChild(childId);
		if (child.residency !== null || child.active_session_id !== null || child.session_id !== null) {
			return { ...child };
		}
		const waiter = deferred<RlmChildInfo>();
		this.#publicationWaiters.set(childId, waiter);
		return await waiter.promise;
	}

	async markRunning(childId: string, publication: RlmRunningPublication): Promise<void> {
		this.markRunningCalls.push({ childId, publication: { ...publication } });
		const child = this.requireChild(childId);
		const nextChild: RlmChildInfo = {
			...child,
			run_status: "running",
			residency: publication.sessionId ? "live" : null,
			agent_id: publication.agentId ?? child.agent_id,
			active_session_id: publication.sessionId ?? null,
			session_id: publication.sessionId ?? null,
			session_file: publication.sessionFile ?? null,
		};
		this.#children.set(childId, nextChild);
		if (nextChild.residency !== null || nextChild.active_session_id !== null || nextChild.session_id !== null) {
			this.#publicationWaiters.get(childId)?.resolve({ ...nextChild });
			this.#publicationWaiters.delete(childId);
		}
		this.timeline.push(`markRunning:${childId}`);
	}

	async markSettled(childId: string, result: RlmSettlement): Promise<void> {
		this.markSettledCalls.push({ childId, result: { ...result } });
		const child = this.requireChild(childId);
		this.#children.set(childId, {
			...child,
			run_status: result.status,
			...(result.error ? { error: result.error } : {}),
		});
		this.#settledResults.set(childId, { ...result });
		this.#settledWaiters.get(childId)?.resolve({ ...result });
		this.timeline.push(`markSettled:${childId}:${result.status}`);
	}

	async markParentReply(childId: string): Promise<void> {
		this.markParentReplyCalls.push(childId);
		const child = this.requireChild(childId);
		this.#children.set(childId, { ...child, replied_to_parent: true });
		this.timeline.push(`markParentReply:${childId}`);
	}

	async markTerminalNotice(childId: string, status: "pending" | "sent"): Promise<void> {
		const child = this.requireChild(childId);
		if (child.terminal_notice === "sent" || child.terminal_notice === status) return;
		this.markTerminalNoticeCalls.push({ childId, status });
		this.#children.set(childId, { ...child, terminal_notice: status });
		this.#terminalNoticeResults.set(childId, status);
		this.#terminalNoticeWaiters.get(childId)?.resolve(status);
		this.timeline.push(`markTerminalNotice:${childId}:${status}`);
	}

	setPendingTerminalNoticeRetry(retry: (child: RlmChildInfo) => Promise<void>): void {
		this.#pendingTerminalNoticeRetry = retry;
	}

	async retryPendingTerminalNotices(): Promise<void> {
		const retry = this.#pendingTerminalNoticeRetry;
		if (!retry) return;
		const pending = [...this.#children.values()]
			.filter(child => child.terminal_notice === "pending")
			.map(child => ({ ...child }));
		await Promise.all(pending.map(child => retry(child)));
	}

	async deleteDirectChild(target: string, reason: string): Promise<RlmDeleteSubagentResult> {
		this.deleteDirectChildCalls.push({ target, reason });
		const child = this.requireChild(target);
		this.#children.set(target, { ...child, run_status: "deleted", error: reason });
		return { rlm_child_id: child.rlm_child_id, name: child.name, deleted: true };
	}

	snapshotEntries(): RlmChildRegistryEntry[] {
		return [...this.#children.values()]
			.filter(child => child.run_status !== "deleted")
			.map(child => ({
				rlm_child_id: child.rlm_child_id,
				active_session_id: child.active_session_id,
				session_id: child.session_id,
				session_name: child.name,
				session_dir: child.session_dir,
				status:
					child.run_status === "completed"
						? "completed"
						: child.run_status === "cancelled"
							? "cancelled"
							: child.run_status === "failed"
								? "failed"
								: "running",
			}));
	}

	releaseAdmission(): void {
		this.#admissionRelease.resolve(undefined);
	}

	park(childId: string): void {
		const child = this.requireChild(childId);
		this.#children.set(childId, { ...child, residency: "parked", active_session_id: null });
	}

	async waitForSettled(childId: string): Promise<RlmSettlement> {
		const settled = this.#settledResults.get(childId);
		if (settled) return { ...settled };
		const waiter = deferred<RlmSettlement>();
		this.#settledWaiters.set(childId, waiter);
		return await waiter.promise;
	}

	async waitForTerminalNotice(childId: string): Promise<"pending" | "sent"> {
		const notice = this.#terminalNoticeResults.get(childId);
		if (notice) return notice;
		const waiter = deferred<"pending" | "sent">();
		this.#terminalNoticeWaiters.set(childId, waiter);
		return await waiter.promise;
	}

	current(childId: string): RlmChildInfo {
		return { ...this.requireChild(childId) };
	}

	private requireChild(childId: string): RlmChildInfo {
		const child = this.#children.get(childId);
		if (!child) throw new Error(`Unknown fake child ${childId}`);
		return child;
	}
}

interface FixtureOptions {
	registerJob?: boolean;
	blockAdmission?: boolean;
	sendMessages?: boolean;
	selfAgentId?: string;
	ownerAgentId?: string;
	parentAgentId?: string;
	currentDepth?: number;
	maxDepth?: number;
	defaultModel?: string;
	sendStatus?: DeliveryStatus;
	sendStatuses?: DeliveryStatus[];
	siblings?: RlmChildRegistryEntry[];
	siblingRegistry?: SiblingRegistry;
	spawnError?: Error;
	spawnResult?: Promise<RlmSpawnedSubagent>;
}

interface LifecycleFixture {
	lifecycle: RlmChildLifecycle;
	registry: FakeRlmChildRegistry;
	jobs: FakeJobManager;
	spawnCalls: SpawnCall[];
	sentMessages: SentMessage[];
}

function makeFixture(options: FixtureOptions = {}): LifecycleFixture {
	const registry = new FakeRlmChildRegistry(options.blockAdmission);
	const jobs = new FakeJobManager();
	const spawnCalls: SpawnCall[] = [];
	const sentMessages: SentMessage[] = [];

	const sendStatuses = [...(options.sendStatuses ?? [])];
	const spawnSubagent: RlmBridgeDeps["spawnSubagent"] = async (prompt, spawnOptions) => {
		spawnCalls.push({ prompt, options: { ...spawnOptions } });
		if (options.spawnError) throw options.spawnError;
		const spawned = options.spawnResult
			? await options.spawnResult
			: {
					agentId: spawnOptions.rlmChildId,
					sessionDir: spawnOptions.sessionDir,
					sessionId: `session-${spawnOptions.rlmChildId}`,
					sessionFile: `${spawnOptions.sessionDir}/${spawnOptions.rlmChildId}.jsonl`,
					model: spawnOptions.model,
					settlement: { status: "completed" as const },
				};
		await spawnOptions.publishRunning({
			agentId: spawned.agentId,
			sessionId: spawned.sessionId,
			sessionFile: spawned.sessionFile,
		});
		return spawned;
	};

	const deps: RlmBridgeDeps = {
		registry: registry as unknown as RlmChildRegistry,
		spawnSubagent,
		getDefaultModel: () => options.defaultModel,
		ownerAgentId: options.ownerAgentId ?? "parent-agent",
		...(options.parentAgentId === undefined ? {} : { parentAgentId: options.parentAgentId }),
		currentDepth: options.currentDepth ?? 0,
		maxDepth: options.maxDepth ?? 3,
		...(options.registerJob
			? {
					registerJob: (label: string, run: JobRun, jobOptions: JobOptions) =>
						jobs.register(label, run, jobOptions),
				}
			: {}),
		...(options.sendMessages
			? {
					sendToAgent: async (agentId: string, message: string, mode: "steer" | "followUp") => {
						sentMessages.push({ agentId, message, mode });
						registry.timeline.push(`send:${agentId}`);
						return sendStatuses.shift() ?? options.sendStatus ?? "delivered";
					},
				}
			: {}),
		...(options.siblingRegistry === undefined ? {} : { siblingRegistry: options.siblingRegistry }),
		...(options.siblings === undefined ? {} : { listSiblings: () => options.siblings! }),
		...(options.selfAgentId === undefined
			? {}
			: { markParentReply: () => registry.markParentReply(options.selfAgentId!) }),
	};

	return {
		lifecycle: createRlmLifecycle(deps),
		registry,
		jobs,
		spawnCalls,
		sentMessages,
	};
}

interface AsyncLifecycleFixtureOptions {
	registry?: FakeRlmChildRegistry;
	spawnSubagent?: RlmBridgeDeps["spawnSubagent"];
}

interface AsyncLifecycleFixture {
	lifecycle: RlmChildLifecycle;
	manager: AsyncJobManager;
	registry: FakeRlmChildRegistry;
}

function makeAsyncLifecycleFixture(options: AsyncLifecycleFixtureOptions = {}): AsyncLifecycleFixture {
	const manager = new AsyncJobManager({ maxRunningJobs: 1 });
	const registry = options.registry ?? new FakeRlmChildRegistry();
	const spawnSubagent: RlmBridgeDeps["spawnSubagent"] = async (prompt, spawnOptions) => {
		const spawned = options.spawnSubagent
			? await options.spawnSubagent(prompt, spawnOptions)
			: {
					agentId: spawnOptions.rlmChildId,
					sessionDir: spawnOptions.sessionDir,
					sessionId: `session-${spawnOptions.rlmChildId}`,
					sessionFile: `${spawnOptions.sessionDir}/${spawnOptions.rlmChildId}.jsonl`,
					model: spawnOptions.model,
					settlement: { status: "completed" as const },
				};
		await spawnOptions.publishRunning({
			agentId: spawned.agentId,
			sessionId: spawned.sessionId,
			sessionFile: spawned.sessionFile,
		});
		return spawned;
	};
	const registerJob: JobRegistrar = (label, run, jobOptions) =>
		manager.register(RLM_JOB_TYPE, label, run, {
			id: jobOptions.id,
			ownerId: jobOptions.ownerId,
			description: jobOptions.description,
		});

	return {
		lifecycle: createRlmLifecycle({
			registry: registry as unknown as RlmChildRegistry,
			spawnSubagent,
			getDefaultModel: () => undefined,
			ownerAgentId: "parent-agent",
			currentDepth: 0,
			maxDepth: 3,
			registerJob,
		}),
		manager,
		registry,
	};
}

function requireAsyncJob(manager: AsyncJobManager, jobId: string) {
	const job = manager.getJob(jobId);
	if (!job) throw new Error(`Expected AsyncJobManager job ${jobId}`);
	return job;
}

describe("RlmBridge lifecycle state machine", () => {
	it("admits before running a registered job and returns its handle before settlement", async () => {
		const spawnResult = deferred<RlmSpawnedSubagent>();
		const fixture = makeFixture({
			registerJob: true,
			blockAdmission: true,
			sendMessages: true,
			spawnResult: spawnResult.promise,
		});

		const spawnPromise = fixture.lifecycle.spawnChild("perform work", { name: "worker", model: "provider/model" });
		await fixture.registry.admissionStarted;
		expect(fixture.jobs.registrations).toHaveLength(0);
		expect(fixture.spawnCalls).toHaveLength(0);

		const admission = fixture.registry.admitCalls[0]!;
		expect(admission.jobId).toBeUndefined();
		fixture.registry.releaseAdmission();
		const handle = await spawnPromise;
		await flushMicrotasks();
		const registration = fixture.jobs.registrations[0]!;
		expect(registration.label).toBe("rlm: worker");
		expect(registration.options.id).toBe(admission.rlmChildId);
		expect(handle).toEqual({
			rlm_child_id: admission.rlmChildId,
			name: "worker",
			session_dir: fixture.registry.current(admission.rlmChildId).session_dir,
			model: "provider/model",
		});
		expect(admission.jobId).toBe(registration.jobId);
		expect(fixture.registry.markSettledCalls).toHaveLength(0);
		expect(fixture.spawnCalls).toHaveLength(1);

		spawnResult.resolve({
			agentId: handle.rlm_child_id,
			sessionDir: handle.session_dir,
			sessionId: "session-1",
			sessionFile: `${handle.session_dir}/child.jsonl`,
			model: handle.model,
			settlement: { status: "completed" },
		});
		await registration.runPromise;

		expect(fixture.registry.markRunningCalls).toHaveLength(1);
		expect(fixture.registry.markSettledCalls).toEqual([
			{ childId: handle.rlm_child_id, result: { status: "completed" } },
		]);
		expect(fixture.sentMessages).toEqual([
			{
				agentId: "parent-agent",
				message: "RLM child worker completed without reply: completed",
				mode: "steer",
			},
		]);
		expect(await fixture.registry.waitForTerminalNotice(handle.rlm_child_id)).toBe("sent");
		expect(fixture.registry.markTerminalNoticeCalls).toEqual([
			{ childId: handle.rlm_child_id, status: "pending" },
			{ childId: handle.rlm_child_id, status: "sent" },
		]);

		const runningIndex = fixture.registry.timeline.indexOf(`markRunning:${handle.rlm_child_id}`);
		const settledIndex = fixture.registry.timeline.indexOf(`markSettled:${handle.rlm_child_id}:completed`);
		const pendingIndex = fixture.registry.timeline.indexOf(`markTerminalNotice:${handle.rlm_child_id}:pending`);
		const sendIndex = fixture.registry.timeline.indexOf("send:parent-agent");
		const noticeIndex = fixture.registry.timeline.indexOf(`markTerminalNotice:${handle.rlm_child_id}:sent`);
		expect(runningIndex).toBeGreaterThanOrEqual(0);
		expect(runningIndex).toBeLessThan(settledIndex);
		expect(settledIndex).toBeLessThan(pendingIndex);
		expect(pendingIndex).toBeLessThan(sendIndex);
		expect(sendIndex).toBeLessThan(noticeIndex);
	});

	it("settles a failed registered job and sends the failure notice", async () => {
		const fixture = makeFixture({
			registerJob: true,
			sendMessages: true,
			spawnError: new Error("worker exploded"),
		});

		const handle = await fixture.lifecycle.spawnChild("fail", { name: "broken", model: "provider/model" });
		const registration = fixture.jobs.registrations[0]!;
		await expect(registration.runPromise).rejects.toThrow("worker exploded");

		expect(fixture.registry.markSettledCalls).toEqual([
			{
				childId: handle.rlm_child_id,
				result: { status: "failed", error: "Error: worker exploded" },
			},
		]);
		expect(fixture.sentMessages).toEqual([
			{
				agentId: "parent-agent",
				message: "RLM child broken failed: Error: worker exploded",
				mode: "steer",
			},
		]);
		expect(fixture.registry.markTerminalNoticeCalls).toEqual([
			{ childId: handle.rlm_child_id, status: "pending" },
			{ childId: handle.rlm_child_id, status: "sent" },
		]);
	});

	it("does not send a completion notice when the child already replied to its parent", async () => {
		const spawnResult = deferred<RlmSpawnedSubagent>();
		const fixture = makeFixture({
			registerJob: true,
			sendMessages: true,
			spawnResult: spawnResult.promise,
		});

		const handle = await fixture.lifecycle.spawnChild("reply first", { name: "replier", model: "provider/model" });
		await flushMicrotasks();
		await fixture.registry.markParentReply(handle.rlm_child_id);
		spawnResult.resolve({
			agentId: handle.rlm_child_id,
			sessionDir: handle.session_dir,
			sessionId: "session-replier",
			sessionFile: `${handle.session_dir}/child.jsonl`,
			model: handle.model,
			settlement: { status: "completed" },
		});
		await fixture.jobs.registrations[0]!.runPromise;

		expect(fixture.registry.current(handle.rlm_child_id).replied_to_parent).toBe(true);
		expect(fixture.registry.markSettledCalls[0]).toEqual({
			childId: handle.rlm_child_id,
			result: { status: "completed" },
		});
		expect(fixture.sentMessages).toHaveLength(0);
		expect(fixture.registry.current(handle.rlm_child_id).terminal_notice).toBe("sent");
		expect(fixture.registry.markTerminalNoticeCalls).toEqual([{ childId: handle.rlm_child_id, status: "sent" }]);

		await fixture.registry.retryPendingTerminalNotices();
		expect(fixture.sentMessages).toHaveLength(0);
		expect(fixture.registry.markTerminalNoticeCalls).toEqual([{ childId: handle.rlm_child_id, status: "sent" }]);
	});

	it("runs detached when no job registrar is supplied and still settles the child", async () => {
		const fixture = makeFixture();
		const handle = await fixture.lifecycle.spawnChild("detached work", { name: "detached", model: "provider/model" });

		expect(fixture.jobs.registrations).toHaveLength(0);
		expect(await fixture.registry.waitForSettled(handle.rlm_child_id)).toEqual({ status: "completed" });
		expect(fixture.spawnCalls).toHaveLength(1);
		expect(fixture.registry.markRunningCalls).toHaveLength(1);
		expect(fixture.registry.current(handle.rlm_child_id).run_status).toBe("completed");
	});

	it("rejects empty models and max-depth children before registry admission", async () => {
		const missingModel = makeFixture({ maxDepth: 3 });
		await expect(missingModel.lifecycle.spawnChild("no model", { model: "   " })).rejects.toThrow(
			"RLM child model is required",
		);
		expect(missingModel.registry.admitCalls).toHaveLength(0);
		expect(missingModel.jobs.registrations).toHaveLength(0);

		const atMaxDepth = makeFixture({ currentDepth: 2, maxDepth: 2, defaultModel: "provider/default" });
		await expect(atMaxDepth.lifecycle.spawnChild("too deep", { model: "provider/model" })).rejects.toThrow(
			"RLM max depth reached: depth=2, max=2",
		);
		expect(atMaxDepth.registry.admitCalls).toHaveLength(0);
		expect(atMaxDepth.jobs.registrations).toHaveLength(0);
	});

	it("marks a self child as having replied when a parent message is delivered", async () => {
		const fixture = makeFixture({
			sendMessages: true,
			selfAgentId: "self-child",
			ownerAgentId: "self-child",
			parentAgentId: "parent-agent",
		});
		await fixture.registry.admit({
			rlmChildId: "self-child",
			name: "self",
			model: "provider/model",
			taskDepth: 1,
			maxDepth: 3,
		});

		if (!fixture.lifecycle.sendMessage) throw new Error("RLM message adapter was not configured");
		const receipt = await fixture.lifecycle.sendMessage("reply", { receiverRole: "parent" });

		expect(receipt).toEqual({ deliveryStatus: "delivered", receiverId: "parent-agent" });
		expect(fixture.sentMessages).toEqual([{ agentId: "parent-agent", message: "reply", mode: "steer" }]);
		expect(fixture.registry.markParentReplyCalls).toEqual(["self-child"]);
		expect(fixture.registry.current("self-child").replied_to_parent).toBe(true);
	});

	it("registers a manual RLM job and completes it after a successful child spawn", async () => {
		const spawnStarted = deferred<void>();
		const spawnResult = deferred<RlmSpawnedSubagent>();
		let childOptions: SpawnOptions | undefined;
		const fixture = makeAsyncLifecycleFixture({
			spawnSubagent: async (_prompt, options) => {
				childOptions = options;
				spawnStarted.resolve(undefined);
				return await spawnResult.promise;
			},
		});

		try {
			const handle = await fixture.lifecycle.spawnChild("perform work", { name: "worker", model: "provider/model" });
			await spawnStarted.promise;

			const job = requireAsyncJob(fixture.manager, handle.rlm_child_id);
			expect(job).toMatchObject({
				id: handle.rlm_child_id,
				type: RLM_JOB_TYPE,
				ownerId: "parent-agent",
				completionDelivery: "manual",
				status: "running",
			});

			spawnResult.resolve({
				agentId: handle.rlm_child_id,
				sessionDir: handle.session_dir,
				sessionId: "session-worker",
				sessionFile: `${handle.session_dir}/child.jsonl`,
				model: handle.model,
				settlement: { status: "completed" },
			});
			await job.promise;

			expect(requireAsyncJob(fixture.manager, handle.rlm_child_id).status).toBe("completed");
		} finally {
			if (childOptions) {
				spawnResult.resolve({
					agentId: childOptions.rlmChildId,
					sessionDir: childOptions.sessionDir,
					sessionId: "session-worker",
					sessionFile: `${childOptions.sessionDir}/child.jsonl`,
					model: childOptions.model,
					settlement: { status: "completed" },
				});
			}
			await fixture.manager.dispose();
		}
	});

	it("marks the manager job failed when spawnSubagent throws", async () => {
		const fixture = makeAsyncLifecycleFixture({
			spawnSubagent: async () => {
				throw new Error("worker exploded");
			},
		});

		try {
			const handle = await fixture.lifecycle.spawnChild("fail", { name: "broken", model: "provider/model" });
			const job = requireAsyncJob(fixture.manager, handle.rlm_child_id);
			await job.promise;

			expect(requireAsyncJob(fixture.manager, handle.rlm_child_id)).toMatchObject({
				status: "failed",
				errorText: "worker exploded",
			});
		} finally {
			await fixture.manager.dispose();
		}
	});

	it("rejects failed durable admission without registering a manager job", async () => {
		const admissionError = new Error("registry unavailable");
		const registry = new FakeRlmChildRegistry(false, admissionError);
		const fixture = makeAsyncLifecycleFixture({ registry });

		try {
			await expect(
				fixture.lifecycle.spawnChild("admit", { name: "blocked", model: "provider/model" }),
			).rejects.toThrow("registry unavailable");
			expect(registry.admitCalls).toHaveLength(0);
			expect(fixture.manager.getRunningJobCount()).toBe(0);
			expect(fixture.manager.getAllJobs()).toHaveLength(0);
		} finally {
			await fixture.manager.dispose();
		}
	});

	it("propagates manager cancellation to the child AbortSignal and keeps the job cancelled", async () => {
		const spawnStarted = deferred<void>();
		const abortObserved = deferred<void>();
		let childSignal: AbortSignal | undefined;
		const fixture = makeAsyncLifecycleFixture({
			spawnSubagent: async (_prompt, options) => {
				childSignal = options.signal;
				spawnStarted.resolve(undefined);
				return await new Promise<RlmSpawnedSubagent>((_resolve, reject) => {
					const abort = () => {
						abortObserved.resolve(undefined);
						reject(new Error("child cancelled"));
					};
					if (options.signal.aborted) abort();
					else options.signal.addEventListener("abort", abort, { once: true });
				});
			},
		});

		try {
			const handle = await fixture.lifecycle.spawnChild("cancel", { name: "cancelled", model: "provider/model" });
			await spawnStarted.promise;
			const job = requireAsyncJob(fixture.manager, handle.rlm_child_id);

			expect(fixture.manager.cancel(handle.rlm_child_id)).toBe(true);
			await abortObserved.promise;
			if (!childSignal) throw new Error("Expected spawnSubagent to receive an AbortSignal");
			expect(childSignal.aborted).toBe(true);
			await job.promise;

			expect(requireAsyncJob(fixture.manager, handle.rlm_child_id).status).toBe("cancelled");
		} finally {
			await fixture.manager.dispose();
		}
	});
	it("carries nested child depth and caller identity into the task adapter", async () => {
		const fixture = makeFixture({ currentDepth: 2, maxDepth: 4 });
		const handle = await fixture.lifecycle.spawnChild("nested work", {
			name: "nested",
			model: "provider/model",
		});

		const call = fixture.spawnCalls[0];
		if (!call) throw new Error("Expected nested child dispatch");
		expect(fixture.registry.admitCalls).toEqual([
			expect.objectContaining({
				rlmChildId: handle.rlm_child_id,
				taskDepth: 3,
				maxDepth: 4,
			}),
		]);
		expect(call.options).toMatchObject({
			rlmChildId: handle.rlm_child_id,
			sessionDir: handle.session_dir,
			parentAgentId: "parent-agent",
			depth: 3,
			maxDepth: 4,
		});
		expect(await fixture.registry.waitForSettled(handle.rlm_child_id)).toEqual({ status: "completed" });
	});

	it("treats a negative RLM depth cap as unbounded", async () => {
		const fixture = makeFixture({ currentDepth: 42, maxDepth: -1 });
		const handle = await fixture.lifecycle.spawnChild("unbounded work", {
			name: "deep-worker",
			model: "provider/model",
		});

		expect(fixture.registry.admitCalls).toEqual([
			expect.objectContaining({
				rlmChildId: handle.rlm_child_id,
				taskDepth: 43,
				maxDepth: -1,
			}),
		]);
		expect(await fixture.registry.waitForSettled(handle.rlm_child_id)).toEqual({ status: "completed" });
	});

	it("keeps a failed terminal receipt pending until a later successful retry, then remains idempotent", async () => {
		const fixture = makeFixture({
			registerJob: true,
			sendMessages: true,
			sendStatuses: ["failed", "delivered"],
		});
		const handle = await fixture.lifecycle.spawnChild("complete", { name: "retryable", model: "provider/model" });
		await fixture.jobs.registrations[0]!.runPromise;

		expect(fixture.registry.current(handle.rlm_child_id).terminal_notice).toBe("pending");
		expect(fixture.sentMessages).toHaveLength(1);
		expect(fixture.registry.markTerminalNoticeCalls).toEqual([{ childId: handle.rlm_child_id, status: "pending" }]);

		await fixture.registry.retryPendingTerminalNotices();
		expect(fixture.registry.current(handle.rlm_child_id).terminal_notice).toBe("sent");
		expect(fixture.sentMessages).toHaveLength(2);
		expect(fixture.registry.markTerminalNoticeCalls).toEqual([
			{ childId: handle.rlm_child_id, status: "pending" },
			{ childId: handle.rlm_child_id, status: "sent" },
		]);

		await fixture.registry.retryPendingTerminalNotices();
		expect(fixture.sentMessages).toHaveLength(2);
	});

	it("restricts agent messaging to the parent, direct children, and siblings", async () => {
		const fixture = makeFixture({
			sendMessages: true,
			ownerAgentId: "nested-owner",
			parentAgentId: "root-owner",
			siblings: [
				{
					rlm_child_id: "sibling-worker",
					active_session_id: "sibling-session",
					session_id: "sibling-session",
					session_name: "sibling",
					session_dir: "/fake/rlm/sibling-worker",
					status: "running",
				},
			],
		});
		await fixture.registry.admit({
			rlmChildId: "direct-child",
			name: "direct",
			model: "provider/model",
			taskDepth: 3,
			maxDepth: 4,
		});

		if (!fixture.lifecycle.listAgents || !fixture.lifecycle.sendMessage) {
			throw new Error("Expected RLM family message adapter");
		}
		expect(fixture.lifecycle.listAgents()).toEqual([
			{ relationship: "parent", name: "parent", id: "root-owner", status: "running" },
			{ relationship: "child", name: "direct", id: "direct-child", status: "running" },
			{ relationship: "sibling", name: "sibling", id: "sibling-worker", status: "running" },
		]);

		const delivered = await fixture.lifecycle.sendMessage("family update", {
			receiverRole: "sibling",
			receiverName: "sibling-worker",
		});
		const denied = await fixture.lifecycle.sendMessage("escape attempt", {
			receiverRole: "child",
			receiverName: "not-a-direct-child",
		});

		expect(delivered).toEqual({ deliveryStatus: "delivered", receiverId: "sibling-worker" });
		expect(denied).toEqual({ deliveryStatus: "failed" });
		expect(fixture.sentMessages).toEqual([{ agentId: "sibling-worker", message: "family update", mode: "steer" }]);
	});

	it("waits for a child session-file publication until its session identity arrives", async () => {
		const fixture = makeFixture({ sendMessages: true });
		const childId = "file-only-child";
		await fixture.registry.admit({
			rlmChildId: childId,
			name: "file-only",
			model: "provider/model",
			taskDepth: 1,
			maxDepth: 3,
		});
		await fixture.registry.markRunning(childId, {
			sessionFile: "/fake/rlm/file-only-child/child.jsonl",
		});

		if (!fixture.lifecycle.sendMessage) throw new Error("Expected RLM message adapter");
		const receiptPromise = fixture.lifecycle.sendMessage("wake child", {
			receiverRole: "child",
			receiverName: childId,
		});
		await flushMicrotasks();

		expect(fixture.sentMessages).toEqual([]);
		expect(fixture.registry.awaitPublicationCalls).toEqual([childId]);

		await fixture.registry.markRunning(childId, {
			agentId: childId,
			sessionId: "child-session",
			sessionFile: "/fake/rlm/file-only-child/child.jsonl",
		});

		expect(await receiptPromise).toEqual({ deliveryStatus: "delivered", receiverId: childId });
		expect(fixture.sentMessages).toEqual([{ agentId: childId, message: "wake child", mode: "steer" }]);
	});

	it("waits through the parent sibling registry and routes completed or parked children", async () => {
		const siblingId = "parent-sibling";
		let siblingEntry: RlmChildRegistryEntry = {
			rlm_child_id: siblingId,
			active_session_id: null,
			session_id: null,
			session_name: "sibling",
			session_dir: `/fake/rlm/${siblingId}`,
			status: "running",
		};
		const siblingRelease = deferred<void>();
		const siblingAwaitCalls: string[] = [];
		const siblingRegistry: SiblingRegistry = {
			list: () => [siblingEntry],
			get: childId => (childId === siblingId ? siblingEntry : undefined),
			awaitPublication: async childId => {
				siblingAwaitCalls.push(childId);
				await siblingRelease.promise;
				siblingEntry = {
					...siblingEntry,
					active_session_id: "sibling-session",
					session_id: "sibling-session",
				};
			},
		};
		const fixture = makeFixture({
			sendMessages: true,
			ownerAgentId: "nested-owner",
			parentAgentId: "root-owner",
			siblings: [siblingEntry],
			siblingRegistry,
		});

		const completedId = "completed-child";
		await fixture.registry.admit({
			rlmChildId: completedId,
			name: "completed",
			model: "provider/model",
			taskDepth: 1,
			maxDepth: 3,
		});
		await fixture.registry.markRunning(completedId, {
			sessionId: "completed-session",
			sessionFile: `/fake/rlm/${completedId}/child.jsonl`,
		});
		await fixture.registry.markSettled(completedId, { status: "completed" });

		const parkedId = "parked-child";
		await fixture.registry.admit({
			rlmChildId: parkedId,
			name: "parked",
			model: "provider/model",
			taskDepth: 1,
			maxDepth: 3,
		});
		await fixture.registry.markRunning(parkedId, {
			sessionId: "parked-session",
			sessionFile: `/fake/rlm/${parkedId}/child.jsonl`,
		});
		fixture.registry.park(parkedId);

		if (!fixture.lifecycle.sendMessage) throw new Error("Expected RLM message adapter");
		const siblingReceiptPromise = fixture.lifecycle.sendMessage("wake sibling", {
			receiverRole: "sibling",
			receiverName: siblingId,
		});
		await flushMicrotasks();
		expect(siblingAwaitCalls).toEqual([siblingId]);
		expect(fixture.sentMessages).toEqual([]);

		siblingRelease.resolve(undefined);
		expect(await siblingReceiptPromise).toEqual({ deliveryStatus: "delivered", receiverId: siblingId });
		expect(
			await fixture.lifecycle.sendMessage("completed ping", {
				receiverRole: "child",
				receiverName: completedId,
			}),
		).toEqual({ deliveryStatus: "delivered", receiverId: completedId });
		expect(
			await fixture.lifecycle.sendMessage("parked ping", {
				receiverRole: "child",
				receiverName: parkedId,
			}),
		).toEqual({ deliveryStatus: "delivered", receiverId: parkedId });

		expect(fixture.sentMessages).toEqual([
			{ agentId: siblingId, message: "wake sibling", mode: "steer" },
			{ agentId: completedId, message: "completed ping", mode: "steer" },
			{ agentId: parkedId, message: "parked ping", mode: "steer" },
		]);
	});
});
