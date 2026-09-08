import type { ParsedSchedule, ScheduleDeliveryMode, ScheduleSpec } from "./types";

const ONE_SECOND_MS = 1_000;
const ONE_MINUTE_MS = 60 * ONE_SECOND_MS;
const MINIMUM_INTERVAL_MS = 10 * ONE_SECOND_MS;

interface CronFields {
	minute: Set<number>;
	hour: Set<number>;
	dayOfMonth: Set<number>;
	month: Set<number>;
	dayOfWeek: Set<number>;
}

interface ParsedDuration {
	amount: number;
	unit: string;
}

/** Parse an absolute, relative, interval, or five-field numeric cron schedule. */
export function parseSchedule(input: string, now: Date = new Date()): ParsedSchedule {
	const text = stripMatchingQuotes(input.trim());
	if (!text) throw new Error("Schedule cannot be empty");
	assertValidNow(now);

	const relative = parseDuration(text.slice(3), ["m", "h", "d"]);
	if (/^in\s+/i.test(text) && relative) {
		return {
			schedule: { kind: "once", expression: text },
			nextRunAt: new Date(now.getTime() + relative.amount * relativeDurationMultiplier(relative.unit)),
		};
	}
	if (/^in\s+/i.test(text)) {
		throw new Error("Invalid one-shot schedule. Use: in <number>m|h|d");
	}

	const intervalMatch = /^(?:every|each)\s+([\s\S]+)$/i.exec(text);
	if (intervalMatch) {
		const interval = parseDuration(intervalMatch[1] ?? "", ["s", "m", "h"]);
		if (!interval) throw new Error("Invalid recurring interval. Use: every <number>s|m|h");
		const intervalMs = interval.amount * intervalDurationMultiplier(interval.unit);
		if (intervalMs < MINIMUM_INTERVAL_MS) {
			throw new Error("Recurring interval must be at least 10 seconds");
		}
		return {
			schedule: { kind: "interval", expression: text, intervalMs },
			nextRunAt: new Date(now.getTime() + intervalMs),
		};
	}

	if (/^at\s+/i.test(text)) {
		const when = new Date(text.slice(3).trim());
		if (!Number.isFinite(when.getTime())) {
			throw new Error("Invalid one-shot schedule. Use: at <ISO date>");
		}
		if (when.getTime() <= now.getTime()) {
			throw new Error("One-shot schedule must be in the future");
		}
		return { schedule: { kind: "once", expression: text }, nextRunAt: when };
	}

	const expression = normalizeCronAlias(text);
	return { schedule: { kind: "cron", expression }, nextRunAt: nextCronRunAfter(expression, now) };
}

/** Return the next occurrence after a claim/settlement time for a recurring schedule. */
export function nextRunAtForSchedule(schedule: ScheduleSpec, after: Date): Date | undefined {
	assertValidNow(after);
	if (schedule.kind === "once") return undefined;
	if (schedule.kind === "interval") {
		const intervalMs = schedule.intervalMs;
		if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs <= 0) {
			throw new Error(`Invalid interval schedule: ${schedule.expression}`);
		}
		return new Date(after.getTime() + intervalMs);
	}
	return nextCronRunAfter(schedule.expression, after);
}

/** Validate and normalize a persisted delivery mode. */
export function normalizeDeliveryMode(value: unknown): ScheduleDeliveryMode | undefined {
	if (value === undefined || value === null) return undefined;
	if (value === "steer" || value === "follow_up") return value;
	throw new Error('Delivery mode must be "steer" or "follow_up"');
}

function parseDuration(text: string, allowedKinds: readonly ("s" | "m" | "h" | "d")[]): ParsedDuration | undefined {
	const match =
		/^\s*(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*$/i.exec(
			text,
		);
	if (!match) return undefined;
	const amount = Number.parseInt(match[1] ?? "", 10);
	if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
	const unit = match[2]?.toLowerCase() ?? "";
	const kind = unit.startsWith("s") ? "s" : unit.startsWith("m") ? "m" : unit.startsWith("h") ? "h" : "d";
	return allowedKinds.includes(kind) ? { amount, unit } : undefined;
}

function relativeDurationMultiplier(unit: string): number {
	return unit.startsWith("m") ? ONE_MINUTE_MS : unit.startsWith("h") ? 60 * ONE_MINUTE_MS : 24 * 60 * ONE_MINUTE_MS;
}

function intervalDurationMultiplier(unit: string): number {
	return unit.startsWith("s") ? ONE_SECOND_MS : unit.startsWith("m") ? ONE_MINUTE_MS : 60 * ONE_MINUTE_MS;
}

function nextCronRunAfter(expression: string, after: Date): Date {
	const fields = parseCronExpression(expression);
	const candidate = new Date(after.getTime());
	candidate.setSeconds(0, 0);
	candidate.setMinutes(candidate.getMinutes() + 1);
	const hours = [...fields.hour].sort((left, right) => left - right);
	const minutes = [...fields.minute].sort((left, right) => left - right);
	const deadline = new Date(candidate.getTime());
	// Gregorian calendars repeat every 400 years. Searching matching dates
	// rather than every minute keeps sparse schedules such as Feb 29 bounded.
	deadline.setFullYear(deadline.getFullYear() + 400);

	while (candidate.getTime() <= deadline.getTime()) {
		const day = candidate.getDay();
		const dayMatches = fields.dayOfWeek.has(day) || (day === 0 && fields.dayOfWeek.has(7));
		if (fields.month.has(candidate.getMonth() + 1) && fields.dayOfMonth.has(candidate.getDate()) && dayMatches) {
			for (const hour of hours) {
				for (const minute of minutes) {
					const match = new Date(candidate.getTime());
					match.setHours(hour, minute, 0, 0);
					if (match.getTime() >= candidate.getTime() && matchesCronFields(match, fields)) return match;
				}
			}
		}
		candidate.setDate(candidate.getDate() + 1);
		candidate.setHours(0, 0, 0, 0);
	}
	throw new Error(`Cron schedule did not match within the Gregorian cycle: ${expression}`);
}

function parseCronExpression(expression: string): CronFields {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(
			"Unsupported cron schedule. Use 'in 10m', 'at <ISO date>', @hourly, or five fields: minute hour day month weekday",
		);
	}
	return {
		minute: parseCronField(parts[0] ?? "", 0, 59),
		hour: parseCronField(parts[1] ?? "", 0, 23),
		dayOfMonth: parseCronField(parts[2] ?? "", 1, 31),
		month: parseCronField(parts[3] ?? "", 1, 12),
		dayOfWeek: parseCronField(parts[4] ?? "", 0, 7),
	};
}

function parseCronField(field: string, min: number, max: number): Set<number> {
	const values = new Set<number>();
	for (const part of field.split(",")) {
		if (!part) throw new Error(`Invalid cron field: ${field}`);
		const segments = part.split("/");
		if (segments.length > 2) throw new Error(`Invalid cron field: ${field}`);
		const rangeText = segments[0] ?? "";
		const step = segments[1] === undefined ? 1 : parseCronNumber(segments[1], 1, max);
		let start: number;
		let end: number;
		if (rangeText === "*") {
			start = min;
			end = max;
		} else if (rangeText.includes("-")) {
			const range = rangeText.split("-");
			if (range.length !== 2) throw new Error(`Invalid cron range: ${rangeText}`);
			start = parseCronNumber(range[0], min, max);
			end = parseCronNumber(range[1], min, max);
			if (start > end) throw new Error(`Invalid cron range: ${rangeText}`);
		} else {
			start = parseCronNumber(rangeText, min, max);
			end = start;
		}
		for (let value = start; value <= end; value += step) values.add(value);
	}
	return values;
}

function parseCronNumber(value: string | undefined, min: number, max: number): number {
	if (!value || !/^\d+$/.test(value)) throw new Error(`Invalid cron number: ${value ?? ""}`);
	const parsed = Number.parseInt(value, 10);
	if (parsed < min || parsed > max) throw new Error(`Cron number out of range: ${value}`);
	return parsed;
}

function matchesCronFields(date: Date, fields: CronFields): boolean {
	const day = date.getDay();
	const dayMatches = fields.dayOfWeek.has(day) || (day === 0 && fields.dayOfWeek.has(7));
	return (
		fields.minute.has(date.getMinutes()) &&
		fields.hour.has(date.getHours()) &&
		fields.dayOfMonth.has(date.getDate()) &&
		fields.month.has(date.getMonth() + 1) &&
		dayMatches
	);
}

function normalizeCronAlias(text: string): string {
	switch (text.toLowerCase()) {
		case "@hourly":
			return "0 * * * *";
		case "@daily":
			return "0 0 * * *";
		case "@weekly":
			return "0 0 * * 0";
		case "@monthly":
			return "0 0 1 * *";
		default:
			return text;
	}
}

function stripMatchingQuotes(value: string): string {
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function assertValidNow(now: Date): void {
	if (!Number.isFinite(now.getTime())) throw new Error("Invalid current time");
}
