import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createSchedulingProvider } from "../../src/scheduling/runtime";
import { SetTimeoutScheduleScheduler } from "../../src/scheduling/scheduler";
import { JsonScheduleStore } from "../../src/scheduling/store";
import type {
	ScheduleDeliveryReceipt,
	ScheduleDispatch,
	ScheduleJob,
	ScheduleSessionBinding,
} from "../../src/scheduling/types";
import type { AgentSession } from "../../src/session/agent-session";

const T0 = new Date("2026-08-10T12:00:00.000Z");
const INTERVAL_MS = 10_000;
const BINDING: ScheduleSessionBinding = {
	generation: 7,
	sessionId: "session-current",
	sessionFile: "/tmp/session-current.jsonl",
	cwd: "/tmp/project",
	artifactsDir: "/tmp/session-current",
};

function at(offsetMs: number): Date {
	return new Date(T0.getTime() + offsetMs);
}

type QueueEntry = { details?: unknown; content: string; customType: string };

/** A queue-owning session boundary: scheduled prompts stay present until an agent consumes them. */
class QueueSession {
	readonly steering: QueueEntry[] = [];
	readonly followUps: QueueEntry[] = [];
	readonly deliveries: string[] = [];
	isStreaming = false;
	blockedBy: string | undefined;
	get isReadyForScheduledDelivery(): boolean {
		return this.blockedBy === undefined;
	}
	readonly agent = {
		peekSteeringQueue: (): readonly QueueEntry[] => this.steering,
		peekFollowUpQueue: (): readonly QueueEntry[] => this.followUps,
	};

	async sendCustomMessage(
		message: { customType: string; content: string; details?: unknown },
		options?: {
			deliverAs?: "steer" | "followUp" | "nextTurn";
			expectedScheduleBinding?: ScheduleSessionBinding;
			scheduleReceipt?: ScheduleDeliveryReceipt;
		},
	): Promise<boolean> {
		this.deliveries.push(message.content);
		const entry = { customType: message.customType, content: message.content, details: message.details };
		if (options?.deliverAs === "followUp") this.followUps.push(entry);
		else this.steering.push(entry);
		return false;
	}

	queuedScheduleJobIds(): string[] {
		return [...this.steering, ...this.followUps].flatMap(entry => {
			if (!entry.details || typeof entry.details !== "object" || !("scheduleJobId" in entry.details)) return [];
			const jobId = entry.details.scheduleJobId;
			return typeof jobId === "string" ? [jobId] : [];
		});
	}

	consumeScheduledPrompts(): void {
		this.steering.splice(0);
		this.followUps.splice(0);
	}
}

function makeDueJob(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
	return {
		id: "direct-job",
		source: "cron",
		status: "active",
		deliveryMode: "steer",
		sessionId: BINDING.sessionId,
		sessionFile: BINDING.sessionFile,
		cwd: BINDING.cwd,
		prompt: "Inspect the direct scheduled delivery",
		schedule: { kind: "interval", expression: "every 10s", intervalMs: INTERVAL_MS },
		createdAt: T0.toISOString(),
		updatedAt: T0.toISOString(),
		nextRunAt: T0.toISOString(),
		runCount: 0,
		...overrides,
	};
}

describe("scheduled prompt queue ownership", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-schedule-runtime-");
	});

	afterEach(async () => {
		await tempDir.remove();
	});

	it("skips a due recurrence already queued for the busy session, then delivers again after consumption", async () => {
		let now = T0;
		let nextId = 0;
		const store = new JsonScheduleStore({
			filePath: tempDir.join("scheduled-jobs.json"),
			now: () => now,
			createId: () => `dispatch-${++nextId}`,
		});
		const job = await store.create(
			{
				id: "job-1",
				source: "cron",
				deliveryMode: "steer",
				sessionId: BINDING.sessionId,
				sessionFile: BINDING.sessionFile,
				cwd: BINDING.cwd,
				prompt: "Inspect the blocked deployment",
			},
			{
				schedule: { kind: "interval", expression: "every 10s", intervalMs: INTERVAL_MS },
				nextRunAt: T0,
			},
		);
		const session = new QueueSession();
		const provider = createSchedulingProvider(session as unknown as AgentSession);
		const scheduler = new SetTimeoutScheduleScheduler(store, {
			now: () => now,
			runJob: async (candidate: ScheduleJob, dispatch: ScheduleDispatch) =>
				await provider.deliverScheduledPrompt(candidate, {
					expectedScheduleBinding: BINDING,
					scheduledFor: dispatch.scheduledFor,
				}),
		});

		expect(await scheduler.runDue(now)).toBe(1);
		expect(session.deliveries).toEqual([job.prompt]);
		expect(session.queuedScheduleJobIds()).toEqual([job.id]);

		now = at(INTERVAL_MS);
		expect(await scheduler.runDue(now)).toBe(0);
		// The second due tick settled as skipped: it did not enqueue a duplicate prompt.
		expect(session.deliveries).toEqual([job.prompt]);
		expect(session.queuedScheduleJobIds()).toEqual([job.id]);
		const afterSkippedTick = await store.load();
		expect(afterSkippedTick.dispatches).toEqual([]);
		expect(afterSkippedTick.jobs).toMatchObject([
			{
				id: job.id,
				runCount: 1,
				lastSkippedAt: now.toISOString(),
				nextRunAt: at(2 * INTERVAL_MS).toISOString(),
			},
		]);

		session.consumeScheduledPrompts();
		now = at(2 * INTERVAL_MS);
		expect(await scheduler.runDue(now)).toBe(1);
		expect(session.deliveries).toEqual([job.prompt, job.prompt]);
		expect(session.queuedScheduleJobIds()).toEqual([job.id]);
		const afterConsumption = await store.load();
		expect(afterConsumption.jobs).toMatchObject([
			{
				id: job.id,
				runCount: 2,
				lastRunAt: now.toISOString(),
				nextRunAt: at(3 * INTERVAL_MS).toISOString(),
			},
		]);
	});

	it("deduplicates a queued follow-up for the busy session", async () => {
		let now = T0;
		let nextId = 0;
		const store = new JsonScheduleStore({
			filePath: tempDir.join("scheduled-jobs.json"),
			now: () => now,
			createId: () => `dispatch-${++nextId}`,
		});
		const job = await store.create(
			{
				id: "job-follow-up",
				source: "cron",
				deliveryMode: "follow_up",
				sessionId: BINDING.sessionId,
				sessionFile: BINDING.sessionFile,
				cwd: BINDING.cwd,
				prompt: "Inspect the blocked deployment in follow-up",
			},
			{
				schedule: { kind: "interval", expression: "every 10s", intervalMs: INTERVAL_MS },
				nextRunAt: T0,
			},
		);
		const session = new QueueSession();
		const provider = createSchedulingProvider(session as unknown as AgentSession);
		const scheduler = new SetTimeoutScheduleScheduler(store, {
			now: () => now,
			runJob: async (candidate: ScheduleJob, dispatch: ScheduleDispatch) =>
				await provider.deliverScheduledPrompt(candidate, {
					expectedScheduleBinding: BINDING,
					scheduledFor: dispatch.scheduledFor,
				}),
		});

		expect(await scheduler.runDue(now)).toBe(1);
		expect(session.steering).toEqual([]);
		expect(session.followUps).toMatchObject([{ customType: "scheduled-prompt", content: job.prompt }]);

		now = at(INTERVAL_MS);
		expect(await scheduler.runDue(now)).toBe(0);
		expect(session.deliveries).toEqual([job.prompt]);
		expect(session.queuedScheduleJobIds()).toEqual([job.id]);
		expect((await store.load()).jobs).toMatchObject([
			{
				id: job.id,
				runCount: 1,
				lastSkippedAt: now.toISOString(),
				nextRunAt: at(2 * INTERVAL_MS).toISOString(),
			},
		]);
	});
});
describe("scheduled prompt delivery gates", () => {
	it.each([
		{ name: "steer", deliveryMode: "steer" as const },
		{ name: "follow-up", deliveryMode: "follow_up" as const },
	])("routes a streaming $name schedule into its live queue", async ({ deliveryMode }) => {
		const session = new QueueSession();
		session.isStreaming = true;
		session.blockedBy = "post-prompt work";
		const job = makeDueJob({ id: `streaming-${deliveryMode}`, deliveryMode });

		const outcome = await createSchedulingProvider(session as unknown as AgentSession).deliverScheduledPrompt(job, {
			expectedScheduleBinding: BINDING,
			scheduledFor: T0.toISOString(),
		});

		expect(outcome).toBe("ran");
		expect(session.deliveries).toEqual([job.prompt]);
		const expectedQueue = deliveryMode === "follow_up" ? session.followUps : session.steering;
		const otherQueue = deliveryMode === "follow_up" ? session.steering : session.followUps;
		expect(expectedQueue).toMatchObject([
			{
				customType: "scheduled-prompt",
				content: job.prompt,
				details: { scheduleJobId: job.id, scheduledFor: T0.toISOString() },
			},
		]);
		expect(otherQueue).toEqual([]);
	});

	it.each(["maintenance", "bash", "eval", "retry", "handoff", "queued agent message", "post-prompt work"] as const)(
		"skips a non-streaming delivery while $busy reports the session unsafe",
		async busy => {
			const session = new QueueSession();
			session.blockedBy = busy;
			const job = makeDueJob({ id: `busy-${busy.replaceAll(" ", "-")}` });

			const outcome = await createSchedulingProvider(session as unknown as AgentSession).deliverScheduledPrompt(
				job,
				{
					expectedScheduleBinding: BINDING,
					scheduledFor: T0.toISOString(),
				},
			);

			expect(outcome).toBe("skipped");
			expect(session.deliveries).toEqual([]);
			expect(session.queuedScheduleJobIds()).toEqual([]);
		},
	);
});
