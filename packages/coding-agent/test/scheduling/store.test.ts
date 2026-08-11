import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { JsonScheduleStore } from "../../src/scheduling/store";
import type { ScheduleFileState, ScheduleJob } from "../../src/scheduling/types";

const T0 = new Date("2026-08-10T12:00:00.000Z");
const INTERVAL_MS = 10_000;

function at(offsetMs: number): Date {
	return new Date(T0.getTime() + offsetMs);
}

function makeJob(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
	return {
		id: "job-1",
		source: "cron",
		status: "active",
		deliveryMode: "steer",
		sessionId: "session-1",
		sessionFile: "/tmp/session-1.jsonl",
		cwd: "/tmp/project",
		prompt: "Inspect the deployment queue",
		schedule: { kind: "interval", expression: "every 10s", intervalMs: INTERVAL_MS },
		createdAt: T0.toISOString(),
		updatedAt: T0.toISOString(),
		nextRunAt: T0.toISOString(),
		runCount: 0,
		...overrides,
	};
}

function onlyJob(state: ScheduleFileState): ScheduleJob {
	const job = state.jobs[0];
	if (!job) throw new Error("Expected one scheduled job");
	return job;
}

describe("JsonScheduleStore durable scheduling contracts", () => {
	let tempDir: TempDir;
	let filePath: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-schedule-store-");
		filePath = tempDir.join("scheduled-jobs.json");
	});

	afterEach(async () => {
		await tempDir.remove();
	});

	function createStore(options: { now?: () => Date; ids?: readonly string[] } = {}): JsonScheduleStore {
		let nextId = 0;
		return new JsonScheduleStore({
			filePath,
			now: options.now ?? (() => T0),
			createId: () => options.ids?.[nextId++] ?? `generated-${nextId}`,
		});
	}

	it.each([
		{
			name: "malformed JSON",
			content: "{ this is not JSON",
			error: "Schedule store corruption: invalid JSON",
		},
		{
			name: "an active recurring job with no next run",
			content: JSON.stringify({
				version: 1,
				jobs: [{ ...makeJob(), nextRunAt: undefined }],
				dispatches: [],
			}),
			error: "Schedule store corruption: active job must have nextRunAt",
		},
		{
			name: "two outstanding dispatches for one job",
			content: JSON.stringify({
				version: 1,
				jobs: [makeJob()],
				dispatches: [
					{
						id: "dispatch-1",
						jobId: "job-1",
						claimedAt: T0.toISOString(),
						scheduledFor: T0.toISOString(),
					},
					{
						id: "dispatch-2",
						jobId: "job-1",
						claimedAt: at(1).toISOString(),
						scheduledFor: at(1).toISOString(),
					},
				],
			}),
			error: "Schedule store corruption: multiple dispatches for job: job-1",
		},
		{
			name: "an active one-shot with no next run",
			content: JSON.stringify({
				version: 1,
				jobs: [
					makeJob({
						schedule: { kind: "once", expression: "at 2026-08-10T12:00:00.000Z" },
						nextRunAt: undefined,
					}),
				],
				dispatches: [],
			}),
			error: "Schedule store corruption: active job must have nextRunAt",
		},
	] as const)("rejects persisted state containing $name", async ({ content, error }) => {
		await Bun.write(filePath, content);

		await expect(createStore().load()).rejects.toThrow(error);
	});

	it("keeps one outstanding recurring dispatch, records a skipped overlap, and permits the next settled run", async () => {
		const store = createStore({ ids: ["dispatch-1", "dispatch-2"] });
		await store.save(makeJob());

		const first = await store.claimDue(T0, T0);
		expect(first).toMatchObject([
			{
				id: "dispatch-1",
				jobId: "job-1",
				scheduledFor: T0.toISOString(),
				job: { nextRunAt: at(INTERVAL_MS).toISOString() },
			},
		]);

		const overlapAt = at(INTERVAL_MS);
		expect(await store.claimDue(overlapAt, overlapAt)).toEqual([]);

		const held = await store.load();
		expect(held.dispatches).toEqual([
			{
				id: "dispatch-1",
				jobId: "job-1",
				claimedAt: T0.toISOString(),
				scheduledFor: T0.toISOString(),
			},
		]);
		expect(onlyJob(held)).toMatchObject({
			id: "job-1",
			runCount: 0,
			lastSkippedAt: overlapAt.toISOString(),
			nextRunAt: at(2 * INTERVAL_MS).toISOString(),
		});

		const settled = await store.recordDispatchResult("dispatch-1", { outcome: "ran", now: overlapAt });
		expect(settled).toMatchObject({
			id: "job-1",
			runCount: 1,
			lastRunAt: overlapAt.toISOString(),
			nextRunAt: at(2 * INTERVAL_MS).toISOString(),
		});

		const next = await store.claimDue(at(2 * INTERVAL_MS), at(2 * INTERVAL_MS));
		expect(next).toMatchObject([{ id: "dispatch-2", jobId: "job-1" }]);
	});

	it("does not resurrect a cancelled job when its already-claimed dispatch settles", async () => {
		const store = createStore({ ids: ["dispatch-1"] });
		await store.save(makeJob());
		const [dispatch] = await store.claimDue(T0, T0);
		if (!dispatch) throw new Error("Expected a claimed dispatch");

		const cancelledAt = at(2_000);
		const cancelled = await store.cancel("job-1", cancelledAt);
		if (!cancelled) throw new Error("Expected claimed job cancellation to persist");
		expect(cancelled).toMatchObject({ id: "job-1", status: "cancelled", updatedAt: cancelledAt.toISOString() });
		expect(cancelled).not.toHaveProperty("nextRunAt");

		const settled = await store.recordDispatchResult(dispatch.id, { outcome: "ran", now: at(3_000) });
		expect(settled).toEqual(cancelled);

		const state = await store.load();
		expect(state.dispatches).toEqual([]);
		expect(onlyJob(state)).toEqual(cancelled);
	});

	it("recovers an interrupted lease without losing the recurring job's already-advanced run time", async () => {
		const store = createStore({ ids: ["dispatch-before-restart"] });
		await store.save(makeJob());
		const [claimed] = await store.claimDue(T0, T0);
		if (!claimed) throw new Error("Expected a claimed dispatch");

		const recoveryAt = at(5_000);
		const reopened = createStore({ now: () => recoveryAt, ids: ["dispatch-after-recovery"] });
		const recovered = await reopened.recoverInterruptedDispatches(recoveryAt);
		expect(recovered).toMatchObject([
			{
				id: "job-1",
				status: "active",
				lastError: "Interrupted before scheduled operation completion",
				updatedAt: recoveryAt.toISOString(),
				nextRunAt: at(INTERVAL_MS).toISOString(),
			},
		]);

		const state = await reopened.load();
		expect(state.dispatches).toEqual([]);
		expect(onlyJob(state)).toMatchObject({
			status: "active",
			lastError: "Interrupted before scheduled operation completion",
			nextRunAt: at(INTERVAL_MS).toISOString(),
		});

		const next = await reopened.claimDue(at(INTERVAL_MS), at(INTERVAL_MS));
		expect(next).toMatchObject([{ id: "dispatch-after-recovery", jobId: "job-1" }]);
	});

	it("recovers an interrupted one-shot as completed without a next run", async () => {
		const store = createStore({ ids: ["dispatch-once"] });
		await store.save(
			makeJob({
				schedule: { kind: "once", expression: "at 2026-08-10T12:00:00.000Z" },
			}),
		);
		const [claimed] = await store.claimDue(T0, T0);
		if (!claimed) throw new Error("Expected a claimed one-shot dispatch");

		const recoveryAt = at(5_000);
		const reopened = createStore({ now: () => recoveryAt });
		const recovered = await reopened.recoverInterruptedDispatches(recoveryAt);
		expect(recovered).toMatchObject([
			{
				id: "job-1",
				status: "completed",
				lastError: "Interrupted before scheduled operation completion",
				updatedAt: recoveryAt.toISOString(),
			},
		]);
		expect(recovered[0]).not.toHaveProperty("nextRunAt");

		const state = await reopened.load();
		expect(state.dispatches).toEqual([]);
		expect(onlyJob(state)).toEqual(recovered[0]);
	});

	it("clears an interrupted lease after cancellation without resurrecting the job", async () => {
		const store = createStore({ ids: ["dispatch-1"] });
		await store.save(makeJob());
		const [claimed] = await store.claimDue(T0, T0);
		if (!claimed) throw new Error("Expected a claimed dispatch");

		const cancelledAt = at(2_000);
		const cancelled = await store.cancel("job-1", cancelledAt);
		if (!cancelled) throw new Error("Expected cancellation to persist");

		const recoveryAt = at(5_000);
		const reopened = createStore({ now: () => recoveryAt });
		expect(await reopened.recoverInterruptedDispatches(recoveryAt)).toEqual([]);

		const state = await reopened.load();
		expect(state.dispatches).toEqual([]);
		expect(onlyJob(state)).toEqual(cancelled);
	});
});
