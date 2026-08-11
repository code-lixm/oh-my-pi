import { describe, expect, it } from "bun:test";
import {
	nextRunAtForSchedule,
	normalizeHeartbeatSchedule,
	parseHeartbeatInput,
	parseSchedule,
} from "../../src/scheduling/parser";

const NOW = new Date(2026, 7, 9, 12, 34, 56, 789);

describe("parseSchedule", () => {
	it("schedules an `in` expression relative to the supplied clock", () => {
		expect(parseSchedule("in 2h", NOW)).toEqual({
			schedule: { kind: "once", expression: "in 2h" },
			nextRunAt: new Date(NOW.getTime() + 2 * 60 * 60 * 1_000),
		});
	});

	it("keeps a future `at` timestamp as the one-shot run time", () => {
		const future = new Date(NOW.getTime() + 90 * 60 * 1_000);

		expect(parseSchedule(`at ${future.toISOString()}`, NOW)).toEqual({
			schedule: { kind: "once", expression: `at ${future.toISOString()}` },
			nextRunAt: future,
		});
	});

	it.each([
		{
			label: "a past timestamp",
			input: `at ${new Date(NOW.getTime() - 1).toISOString()}`,
			error: "One-shot schedule must be in the future",
		},
		{
			label: "a malformed timestamp",
			input: "at not-an-ISO-date",
			error: "Invalid one-shot schedule. Use: at <ISO date>",
		},
	] as const)("rejects $label", ({ input, error }) => {
		expect(() => parseSchedule(input, NOW)).toThrow(error);
	});

	it.each([
		{ input: "every 10s", intervalMs: 10_000 },
		{ input: "each 2m", intervalMs: 2 * 60 * 1_000 },
	] as const)("parses $input as a recurring interval", ({ input, intervalMs }) => {
		expect(parseSchedule(input, NOW)).toEqual({
			schedule: { kind: "interval", expression: input, intervalMs },
			nextRunAt: new Date(NOW.getTime() + intervalMs),
		});
	});

	it("rejects recurring intervals shorter than ten seconds", () => {
		expect(() => parseSchedule("every 9s", NOW)).toThrow("Recurring interval must be at least 10 seconds");
	});

	it("expands cron aliases and schedules the next matching local minute", () => {
		expect(parseSchedule("@hourly", NOW)).toEqual({
			schedule: { kind: "cron", expression: "0 * * * *" },
			nextRunAt: new Date(2026, 7, 9, 13, 0, 0, 0),
		});
	});

	it("finds a leap-day cron occurrence beyond one year", () => {
		const after = new Date(2026, 7, 11, 12, 0, 0, 0);

		expect(parseSchedule("0 0 29 2 *", after)).toEqual({
			schedule: { kind: "cron", expression: "0 0 29 2 *" },
			nextRunAt: new Date(2028, 1, 29, 0, 0, 0, 0),
		});
	});

	it.each(["* * * *", "* * * * * *"] as const)(
		"rejects cron expressions without exactly five fields: %s",
		expression => {
			expect(() => parseSchedule(expression, NOW)).toThrow("Unsupported cron schedule");
		},
	);
});

describe("nextRunAtForSchedule", () => {
	it("advances an interval from the supplied settlement time", () => {
		expect(
			nextRunAtForSchedule({ kind: "interval", expression: "each 2m", intervalMs: 2 * 60 * 1_000 }, NOW),
		).toEqual(new Date(NOW.getTime() + 2 * 60 * 1_000));
	});

	it("does not reschedule a one-shot schedule", () => {
		expect(nextRunAtForSchedule({ kind: "once", expression: "in 2h" }, NOW)).toBeUndefined();
	});
});

describe("normalizeHeartbeatSchedule", () => {
	it.each([
		{ input: " 15 minutes ", expected: "every 15 minutes" },
		{ input: " each 2h ", expected: "each 2h" },
	] as const)("normalizes $input", ({ input, expected }) => {
		expect(normalizeHeartbeatSchedule(input)).toBe(expected);
	});
});

describe("parseHeartbeatInput", () => {
	it.each([
		{ input: "/heartbeat status", expected: { action: "status" } },
		{ input: "/heartbeat pause", expected: { action: "pause" } },
		{ input: "/heartbeat resume", expected: { action: "resume" } },
		{ input: "/heartbeat clear", expected: { action: "clear" } },
		{ input: "/heartbeat stop", expected: { action: "clear" } },
	] as const)("maps $input to its management action", ({ input, expected }) => {
		expect(parseHeartbeatInput(input)).toEqual(expected);
	});

	it.each([
		{
			label: "a leading follow-up flag",
			input: "/heartbeat --follow-up --every 15m inspect the queue",
			expected: {
				action: "create",
				interval: "every 15m",
				instruction: "inspect the queue",
				deliveryMode: "follow_up",
			},
		},
		{
			label: "a trailing steer flag",
			input: "/heartbeat each 2h inspect the queue --steer",
			expected: {
				action: "create",
				interval: "each 2h",
				instruction: "inspect the queue",
				deliveryMode: "steer",
			},
		},
	] as const)("captures $label without retaining it in the instruction", ({ input, expected }) => {
		expect(parseHeartbeatInput(input)).toEqual(expected);
	});
});
