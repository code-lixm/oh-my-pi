import { describe, expect, it } from "bun:test";
import { SetTimeoutScheduleScheduler } from "../../src/scheduling/scheduler";
import type {
	ScheduleDispatch,
	ScheduleFileState,
	ScheduleJob,
	ScheduleRunResult,
	ScheduleStore,
} from "../../src/scheduling/types";

const NOW = new Date("2026-08-10T12:00:00.000Z");

function makeDispatch(id: string, sessionId: string): ScheduleDispatch {
	const jobId = `job-${id}`;
	return {
		id,
		jobId,
		claimedAt: NOW.toISOString(),
		scheduledFor: NOW.toISOString(),
		job: {
			id: jobId,
			source: "cron",
			status: "active",
			deliveryMode: "steer",
			sessionId,
			sessionFile: `/tmp/${sessionId}.jsonl`,
			cwd: "/tmp/project",
			prompt: `Run ${id}`,
			schedule: { kind: "once", expression: "at 2026-08-10T12:00:00.000Z" },
			createdAt: NOW.toISOString(),
			updatedAt: NOW.toISOString(),
			nextRunAt: NOW.toISOString(),
			runCount: 0,
		},
	};
}

class DispatchStore implements ScheduleStore {
	readonly settlements: Array<{ dispatchId: string; outcome: ScheduleRunResult }> = [];
	#claimed = false;
	#recovered: boolean;

	constructor(
		readonly dispatches: readonly ScheduleDispatch[],
		readonly onSettlement?: (dispatchId: string) => void,
		options: { requireRecovery?: boolean } = {},
	) {
		this.#recovered = options.requireRecovery !== true;
	}

	async load(): Promise<ScheduleFileState> {
		return { version: 1, jobs: this.dispatches.map(dispatch => structuredClone(dispatch.job)), dispatches: [] };
	}

	async listBySession(sessionId: string): Promise<ScheduleJob[]> {
		return this.dispatches
			.filter(dispatch => dispatch.job.sessionId === sessionId)
			.map(dispatch => structuredClone(dispatch.job));
	}

	async save(job: ScheduleJob): Promise<ScheduleJob> {
		return structuredClone(job);
	}

	async update(_id: string, _mutate: (job: ScheduleJob) => ScheduleJob | undefined): Promise<ScheduleJob | undefined> {
		return undefined;
	}

	async cancel(_id: string, _now?: Date): Promise<ScheduleJob | undefined> {
		return undefined;
	}

	async claimDue(_dueAt?: Date, _claimedAt?: Date): Promise<ScheduleDispatch[]> {
		if (!this.#recovered || this.#claimed) return [];
		this.#claimed = true;
		return this.dispatches.map(dispatch => structuredClone(dispatch));
	}

	async recordDispatchResult(
		dispatchId: string,
		result: { outcome: ScheduleRunResult; now?: Date; error?: unknown },
	): Promise<ScheduleJob | undefined> {
		this.settlements.push({ dispatchId, outcome: result.outcome });
		this.onSettlement?.(dispatchId);
		return undefined;
	}

	async recoverInterruptedDispatches(_now?: Date): Promise<ScheduleJob[]> {
		this.#recovered = true;
		return [];
	}

	async nextActiveRunAt(): Promise<Date | undefined> {
		return undefined;
	}
}

describe("SetTimeoutScheduleScheduler session lanes", () => {
	it("runs different sessions concurrently while preserving dispatch order within one session", async () => {
		const firstA = makeDispatch("dispatch-a1", "session-a");
		const secondA = makeDispatch("dispatch-a2", "session-a");
		const firstB = makeDispatch("dispatch-b1", "session-b");
		const started: string[] = [];
		const firstAStarted = Promise.withResolvers<void>();
		const secondAStarted = Promise.withResolvers<void>();
		const firstBStarted = Promise.withResolvers<void>();
		const firstARelease = Promise.withResolvers<void>();
		const secondARelease = Promise.withResolvers<void>();
		const firstBRelease = Promise.withResolvers<void>();
		const firstBSettled = Promise.withResolvers<void>();

		const store = new DispatchStore([firstA, secondA, firstB], dispatchId => {
			if (dispatchId === firstB.id) firstBSettled.resolve();
		});
		const scheduler = new SetTimeoutScheduleScheduler(store, {
			now: () => NOW,
			runJob: async (_job, dispatch) => {
				started.push(dispatch.id);
				switch (dispatch.id) {
					case "dispatch-a1":
						firstAStarted.resolve();
						await firstARelease.promise;
						return "ran";
					case "dispatch-a2":
						secondAStarted.resolve();
						await secondARelease.promise;
						return "ran";
					case "dispatch-b1":
						firstBStarted.resolve();
						await firstBRelease.promise;
						return "ran";
					default:
						throw new Error(`Unexpected dispatch: ${dispatch.id}`);
				}
			},
		});

		const due = scheduler.runDue(NOW);
		await Promise.all([firstAStarted.promise, firstBStarted.promise]);

		// B started before A's first job was released: lanes do not globally serialize sessions.
		expect(started).toContain(firstA.id);
		expect(started).toContain(firstB.id);
		expect(started).not.toContain(secondA.id);

		firstBRelease.resolve();
		await firstBSettled.promise;
		// Settling B cannot unblock A2; only A1's own lane predecessor can do that.
		expect(started).not.toContain(secondA.id);

		firstARelease.resolve();
		await secondAStarted.promise;
		expect(started.indexOf(secondA.id)).toBeGreaterThan(started.indexOf(firstA.id));

		secondARelease.resolve();
		expect(await due).toBe(3);
		expect(store.settlements.map(settlement => settlement.dispatchId).sort()).toEqual(
			[firstA.id, secondA.id, firstB.id].sort(),
		);
	});

	it("recovers interrupted leases before it claims its first due dispatch", async () => {
		const dispatch = makeDispatch("dispatch-after-recovery", "session-recovery");
		const delivered: string[] = [];
		const store = new DispatchStore([dispatch], undefined, { requireRecovery: true });
		const scheduler = new SetTimeoutScheduleScheduler(store, {
			now: () => NOW,
			runJob: async (_job, candidate) => {
				delivered.push(candidate.id);
				return "ran";
			},
		});

		await scheduler.start();
		expect(await scheduler.runDue(NOW)).toBe(1);
		expect(delivered).toEqual([dispatch.id]);
		expect(store.settlements).toEqual([{ dispatchId: dispatch.id, outcome: "ran" }]);
		scheduler.stop();
	});

	it("continues a session lane after a failed predecessor", async () => {
		const first = makeDispatch("dispatch-failed", "session-a");
		const second = makeDispatch("dispatch-after-failure", "session-a");
		const started: string[] = [];
		const store = new DispatchStore([first, second]);
		const scheduler = new SetTimeoutScheduleScheduler(store, {
			now: () => NOW,
			runJob: async (_job, dispatch) => {
				started.push(dispatch.id);
				if (dispatch.id === first.id) throw new Error("synthetic dispatch failure");
				return "ran";
			},
		});

		expect(await scheduler.runDue(NOW)).toBe(2);
		expect(started).toEqual([first.id, second.id]);
		expect(store.settlements).toEqual([
			{ dispatchId: first.id, outcome: "ran" },
			{ dispatchId: second.id, outcome: "ran" },
		]);
	});
});
