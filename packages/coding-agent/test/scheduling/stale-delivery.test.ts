import { describe, expect, it } from "bun:test";
import { createSchedulingProvider } from "../../src/scheduling/runtime";
import { SetTimeoutScheduleScheduler } from "../../src/scheduling/scheduler";
import type {
	ScheduleDeliveryReceipt,
	ScheduleDispatch,
	ScheduleFileState,
	ScheduleJob,
	ScheduleRunResult,
	ScheduleSessionBinding,
	ScheduleStore,
} from "../../src/scheduling/types";
import type { AgentSession } from "../../src/session/agent-session";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const JOB_DUE_AT = "2026-08-10T11:59:00.000Z";

const OLD_BINDING: ScheduleSessionBinding = {
	generation: 0,
	sessionId: "session-old",
	sessionFile: "/tmp/project/session-old.md",
	cwd: "/tmp/project",
	artifactsDir: "/tmp/project/.omp/artifacts",
};

/** The session was rebound to a new generation while a delivery was in flight. */
const NEW_BINDING: ScheduleSessionBinding = {
	...OLD_BINDING,
	generation: 1,
	sessionId: "session-new",
	sessionFile: "/tmp/project/session-new.md",
};

function makeJob(sessionId: string, sessionFile: string): ScheduleJob {
	return {
		id: "job-1",
		source: "cron",
		status: "active",
		deliveryMode: "follow_up",
		sessionId,
		sessionFile,
		cwd: "/tmp/project",
		prompt: "Check on my todo list",
		schedule: { kind: "once", expression: "in 1m" },
		createdAt: "2026-08-10T11:58:00.000Z",
		updatedAt: "2026-08-10T11:58:00.000Z",
		nextRunAt: JOB_DUE_AT,
		runCount: 0,
	};
}

interface FakeDeliverySession {
	writes: Array<{ customType: string; content: string }>;
	enteredNormalization: Promise<void>;
	sendCustomMessage: (
		message: { customType: string; content: string },
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
			expectedScheduleBinding?: ScheduleSessionBinding;
			scheduleReceipt?: ScheduleDeliveryReceipt;
		},
	) => Promise<boolean>;
	rebind(binding: ScheduleSessionBinding): void;
	releaseNormalization(): void;
}

/**
 * Fake AgentSession mirroring the two schedule-binding checks in the real
 * `sendCustomMessage`: one before processing and one after the asynchronous
 * image-normalization step. When the binding went stale during that await, the
 * real code flips the dedicated `scheduleReceipt` to `skipped` and returns
 * without writing the message to the (old) session.
 */
function createFakeSession(initialBinding: ScheduleSessionBinding): FakeDeliverySession {
	let currentBinding = initialBinding;
	let releaseGate: (() => void) | undefined;
	let resolveEntered: () => void = () => {};
	const enteredNormalization = new Promise<void>(resolve => {
		resolveEntered = resolve;
	});
	const writes: Array<{ customType: string; content: string }> = [];

	return {
		writes,
		enteredNormalization,
		rebind(binding: ScheduleSessionBinding): void {
			currentBinding = binding;
		},
		releaseNormalization(): void {
			releaseGate?.();
		},
		async sendCustomMessage(
			message: { customType: string; content: string },
			options?: {
				triggerTurn?: boolean;
				deliverAs?: "steer" | "followUp" | "nextTurn";
				expectedScheduleBinding?: ScheduleSessionBinding;
				scheduleReceipt?: ScheduleDeliveryReceipt;
			},
		): Promise<boolean> {
			// First check: binding already stale before any work.
			if (
				options?.expectedScheduleBinding &&
				options.expectedScheduleBinding.generation !== currentBinding.generation
			) {
				if (options.scheduleReceipt) options.scheduleReceipt.outcome = "skipped";
				return false;
			}
			// Stand in for `#normalizeAgentMessageImages`: an async wait during
			// which the session may be rebound.
			const gate = new Promise<void>(resolve => {
				releaseGate = resolve;
			});
			resolveEntered();
			await gate;
			// Second check: the binding became stale during normalization.
			if (
				options?.expectedScheduleBinding &&
				options.expectedScheduleBinding.generation !== currentBinding.generation
			) {
				if (options.scheduleReceipt) options.scheduleReceipt.outcome = "skipped";
				return false;
			}
			writes.push({ customType: message.customType, content: message.content });
			return false;
		},
	};
}

/** Minimal in-memory store: enough of `claimDue`/`recordDispatchResult` for the scheduler. */
class MemoryScheduleStore implements ScheduleStore {
	readonly jobs = new Map<string, ScheduleJob>();
	readonly dispatchResults: Array<{ dispatchId: string; outcome: ScheduleRunResult }> = [];
	#dispatchSeq = 0;

	async load(): Promise<ScheduleFileState> {
		return { version: 1, jobs: [...this.jobs.values()], dispatches: [] };
	}

	async listBySession(sessionId: string): Promise<ScheduleJob[]> {
		return [...this.jobs.values()].filter(job => job.sessionId === sessionId);
	}

	async save(job: ScheduleJob): Promise<ScheduleJob> {
		this.jobs.set(job.id, { ...job });
		return job;
	}

	async update(id: string, mutate: (job: ScheduleJob) => ScheduleJob | undefined): Promise<ScheduleJob | undefined> {
		const job = this.jobs.get(id);
		if (!job) return undefined;
		const updated = mutate(job);
		if (updated) this.jobs.set(id, updated);
		return updated;
	}

	async cancel(id: string, now: Date = NOW): Promise<ScheduleJob | undefined> {
		const job = this.jobs.get(id);
		if (!job) return undefined;
		const updated: ScheduleJob = { ...job, status: "cancelled", updatedAt: now.toISOString() };
		this.jobs.set(id, updated);
		return updated;
	}

	async claimDue(dueAt: Date = NOW, claimedAt: Date = dueAt): Promise<ScheduleDispatch[]> {
		const dispatches: ScheduleDispatch[] = [];
		for (const job of this.jobs.values()) {
			if (job.status !== "active" || job.nextRunAt === undefined) continue;
			if (Date.parse(job.nextRunAt) > dueAt.getTime()) continue;
			const dispatchId = `dispatch-${++this.#dispatchSeq}`;
			dispatches.push({
				id: dispatchId,
				jobId: job.id,
				claimedAt: claimedAt.toISOString(),
				scheduledFor: job.nextRunAt,
				job: { ...job },
			});
		}
		return dispatches;
	}

	async recordDispatchResult(
		dispatchId: string,
		result: { outcome: ScheduleRunResult; now?: Date; error?: unknown },
	): Promise<ScheduleJob | undefined> {
		this.dispatchResults.push({ dispatchId, outcome: result.outcome });
		return undefined;
	}

	async recoverInterruptedDispatches(): Promise<ScheduleJob[]> {
		return [];
	}

	async nextActiveRunAt(): Promise<Date | undefined> {
		return undefined;
	}
}

interface SchedulerHarness {
	scheduler: SetTimeoutScheduleScheduler;
	settlement: { outcome: ScheduleRunResult | undefined };
}

function createScheduler(store: MemoryScheduleStore, fake: FakeDeliverySession): SchedulerHarness {
	const settlement: SchedulerHarness["settlement"] = { outcome: undefined };
	const provider = createSchedulingProvider(fake as unknown as AgentSession);
	const scheduler = new SetTimeoutScheduleScheduler(store, {
		now: () => NOW,
		runJob: async (job: ScheduleJob, dispatch: ScheduleDispatch) => {
			settlement.outcome = await provider.deliverScheduledPrompt(job, {
				expectedScheduleBinding: OLD_BINDING,
				scheduledFor: dispatch.scheduledFor,
			});
			return settlement.outcome;
		},
	});
	return { scheduler, settlement };
}

describe("scheduling stale-delivery receipt propagation", () => {
	it("settles a skipped outcome and writes nothing when the session rebinds during image normalization", async () => {
		const fake = createFakeSession(OLD_BINDING);
		const store = new MemoryScheduleStore();
		await store.save(makeJob(OLD_BINDING.sessionId, OLD_BINDING.sessionFile));
		const { scheduler, settlement } = createScheduler(store, fake);

		const due = scheduler.runDue(NOW);
		// Wait until the delivery is parked inside the normalization await.
		await fake.enteredNormalization;
		// The session is rebound to a new generation while the delivery is in flight.
		fake.rebind(NEW_BINDING);
		fake.releaseNormalization();
		const ranCount = await due;

		// The dedicated receipt was flipped to `skipped` and returned by the provider.
		expect(settlement.outcome).toBe("skipped");
		// The scheduler settled the dispatch with the provider's outcome.
		expect(store.dispatchResults).toEqual([{ dispatchId: "dispatch-1", outcome: "skipped" }]);
		// Nothing was written into the now-stale session.
		expect(fake.writes).toEqual([]);
		// `ran` is the only outcome counted by runDue.
		expect(ranCount).toBe(0);
	});

	it("settles a ran outcome when the binding remains current across normalization", async () => {
		const fake = createFakeSession(OLD_BINDING);
		const store = new MemoryScheduleStore();
		await store.save(makeJob(OLD_BINDING.sessionId, OLD_BINDING.sessionFile));
		const { scheduler, settlement } = createScheduler(store, fake);

		const due = scheduler.runDue(NOW);
		await fake.enteredNormalization;
		// No rebind: the delivery completes against the current binding.
		fake.releaseNormalization();
		const ranCount = await due;

		expect(settlement.outcome).toBe("ran");
		expect(store.dispatchResults).toEqual([{ dispatchId: "dispatch-1", outcome: "ran" }]);
		expect(fake.writes).toEqual([{ customType: "scheduled-prompt", content: "Check on my todo list" }]);
		expect(ranCount).toBe(1);
	});
});
