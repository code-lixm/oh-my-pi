import { afterEach, describe, expect, it, vi } from "bun:test";
import { SCHEDULE_STATUS_TTL_MS, ScheduleStatusCache } from "@oh-my-pi/pi-coding-agent/scheduling/status-summary";
import type { ScheduleJob } from "@oh-my-pi/pi-coding-agent/scheduling/types";

function job(overrides: Partial<ScheduleJob>): ScheduleJob {
	return {
		id: "job",
		source: "cron",
		status: "active",
		sessionId: "session",
		sessionFile: "/tmp/session.json",
		cwd: "/tmp",
		prompt: "scheduled prompt",
		schedule: { kind: "once", expression: "2026-09-12T12:00:00Z" },
		createdAt: "2026-09-12T10:00:00Z",
		updatedAt: "2026-09-12T10:00:00Z",
		runCount: 0,
		...overrides,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ScheduleStatusCache", () => {
	it("starts empty then publishes only active and paused jobs with the earliest active run", async () => {
		const changed = Promise.withResolvers<void>();
		const earliestRun = "2026-09-12T12:00:00Z";
		const jobs = [
			job({ id: "active-earlier", nextRunAt: earliestRun }),
			job({ id: "active-later", nextRunAt: "2026-09-12T12:05:00Z" }),
			job({ id: "paused", status: "paused", nextRunAt: "2026-09-12T11:00:00Z" }),
			job({ id: "completed", status: "completed", nextRunAt: "2026-09-12T10:00:00Z" }),
		];
		const cache = new ScheduleStatusCache({
			getSource: () => ({ list: async () => jobs }),
			onChange: () => changed.resolve(),
		});

		expect(cache.read()).toBeNull();
		await changed.promise;

		expect(cache.read()).toEqual({
			nextRunAt: Date.parse(earliestRun),
			activeCount: 2,
			pausedCount: 1,
		});
	});

	it("discards an in-flight pre-reset read while allowing the new generation to refresh", async () => {
		const first = Promise.withResolvers<readonly ScheduleJob[]>();
		const second = Promise.withResolvers<readonly ScheduleJob[]>();
		const changed = Promise.withResolvers<void>();
		let listCalls = 0;
		const source = {
			list: async () => {
				listCalls++;
				return listCalls === 1 ? first.promise : second.promise;
			},
		};
		const cache = new ScheduleStatusCache({
			getSource: () => source,
			onChange: () => changed.resolve(),
		});

		expect(cache.read()).toBeNull();
		expect(listCalls).toBe(1);

		cache.reset();
		expect(cache.read()).toBeNull();
		expect(listCalls).toBe(2);

		first.resolve([job({ id: "old-session", nextRunAt: "2026-09-12T12:00:00Z" })]);
		await first.promise;
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(cache.read()).toBeNull();
		expect(listCalls).toBe(2);

		second.resolve([job({ id: "new-session", nextRunAt: "2026-09-12T12:05:00Z" })]);
		await changed.promise;

		expect(cache.read()).toEqual({
			nextRunAt: Date.parse("2026-09-12T12:05:00Z"),
			activeCount: 1,
			pausedCount: 0,
		});
	});

	it("clears a stale snapshot after a failed read, cools down, then retries after its TTL", async () => {
		let now = Date.parse("2026-09-12T12:00:00Z");
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const firstChanged = Promise.withResolvers<void>();
		const failedChanged = Promise.withResolvers<void>();
		const retriedChanged = Promise.withResolvers<void>();
		const changes = [firstChanged, failedChanged, retriedChanged];
		let changeCount = 0;
		let listCalls = 0;
		const source = {
			list: async () => {
				listCalls++;
				if (listCalls === 1) return [job({ id: "old", nextRunAt: "2026-09-12T12:00:00Z" })];
				if (listCalls === 2) throw new Error("schedule source unavailable");
				return [job({ id: "retried", nextRunAt: "2026-09-12T12:05:00Z" })];
			},
		};
		const cache = new ScheduleStatusCache({
			getSource: () => source,
			onChange: () => changes[changeCount++]?.resolve(),
		});

		expect(cache.read()).toBeNull();
		await firstChanged.promise;
		expect(cache.read()).toEqual({
			nextRunAt: Date.parse("2026-09-12T12:00:00Z"),
			activeCount: 1,
			pausedCount: 0,
		});

		now += SCHEDULE_STATUS_TTL_MS;
		expect(cache.read()).toEqual({
			nextRunAt: Date.parse("2026-09-12T12:00:00Z"),
			activeCount: 1,
			pausedCount: 0,
		});
		expect(listCalls).toBe(2);
		await failedChanged.promise;

		expect(cache.read()).toBeNull();
		expect(listCalls).toBe(2);

		now += SCHEDULE_STATUS_TTL_MS + 1;
		expect(cache.read()).toBeNull();
		expect(listCalls).toBe(3);
		await retriedChanged.promise;
		expect(cache.read()).toEqual({
			nextRunAt: Date.parse("2026-09-12T12:05:00Z"),
			activeCount: 1,
			pausedCount: 0,
		});
	});

	it("serves a fresh snapshot without rereading, then refreshes after its TTL", async () => {
		let now = Date.parse("2026-09-12T12:00:00Z");
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const firstChanged = Promise.withResolvers<void>();
		const refreshedChanged = Promise.withResolvers<void>();
		const changes = [firstChanged, refreshedChanged];
		let changeCount = 0;
		let listCalls = 0;
		const source = {
			list: async () => {
				listCalls++;
				return listCalls === 1
					? [job({ id: "initial", nextRunAt: "2026-09-12T12:00:00Z" })]
					: [job({ id: "refreshed", nextRunAt: "2026-09-12T12:05:00Z" })];
			},
		};
		const cache = new ScheduleStatusCache({
			getSource: () => source,
			onChange: () => changes[changeCount++]?.resolve(),
		});

		expect(cache.read()).toBeNull();
		expect(listCalls).toBe(1);
		await firstChanged.promise;
		expect(cache.read()).toEqual({
			nextRunAt: Date.parse("2026-09-12T12:00:00Z"),
			activeCount: 1,
			pausedCount: 0,
		});
		expect(listCalls).toBe(1);

		now += SCHEDULE_STATUS_TTL_MS + 1;
		expect(cache.read()).toEqual({
			nextRunAt: Date.parse("2026-09-12T12:00:00Z"),
			activeCount: 1,
			pausedCount: 0,
		});
		expect(listCalls).toBe(2);
		await refreshedChanged.promise;
		expect(cache.read()).toEqual({
			nextRunAt: Date.parse("2026-09-12T12:05:00Z"),
			activeCount: 1,
			pausedCount: 0,
		});
	});
});
