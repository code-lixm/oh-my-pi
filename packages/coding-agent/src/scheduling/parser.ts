import type {
	HeartbeatDefaults,
	ParsedHeartbeatInput,
	ParsedSchedule,
	ScheduleDeliveryMode,
	ScheduleJob,
	ScheduleSpec,
} from "./types";

const ONE_SECOND_MS = 1_000;
const ONE_MINUTE_MS = 60 * ONE_SECOND_MS;
const MINIMUM_INTERVAL_MS = 10 * ONE_SECOND_MS;
const DEFAULT_HEARTBEAT_INTERVAL = "every 5m";

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

/** Compatibility alias for the Prime scheduler's original parser name. */
export const parseAgentCronSchedule = parseSchedule;

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

/** Normalize a heartbeat interval while preserving a supplied recurring expression. */
export function normalizeHeartbeatSchedule(
	input: string | undefined,
	defaultInterval: string = DEFAULT_HEARTBEAT_INTERVAL,
): string {
	const text = input?.trim();
	if (!text) return defaultInterval.trim();
	if (/^\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.test(text)) {
		return `every ${text}`;
	}
	return text;
}

/** Validate and normalize a persisted heartbeat delivery mode. */
export function normalizeHeartbeatDeliveryMode(value: unknown): ScheduleDeliveryMode | undefined {
	if (value === undefined || value === null) return undefined;
	if (value === "steer" || value === "follow_up") return value;
	throw new Error('Heartbeat delivery mode must be "steer" or "follow_up"');
}

/** Map persisted delivery names to AgentSession's queue names. */
export function resolveHeartbeatStreamingBehavior(
	deliveryMode: ScheduleDeliveryMode | undefined,
): "steer" | "followUp" {
	return deliveryMode === "follow_up" ? "followUp" : "steer";
}

/** Parse the /heartbeat command's management verbs and edge-positioned flags. */
export function parseHeartbeatInput(input: string, defaults: HeartbeatDefaults = {}): ParsedHeartbeatInput {
	const text = input.replace(/^\/heartbeat\b/i, "").trim();
	if (!text || text.toLowerCase() === "status") return { action: "status" };
	if (text.toLowerCase() === "pause") return { action: "pause" };
	if (text.toLowerCase() === "resume") return { action: "resume" };
	if (text.toLowerCase() === "clear" || text.toLowerCase() === "stop") return { action: "clear" };

	const leadingDelivery = consumeDeliveryOption(text);
	let deliveryMode = leadingDelivery.deliveryMode;
	let remaining = leadingDelivery.rest;

	const everyOption = consumeEveryOption(remaining);
	if (everyOption) {
		const trailingDelivery = consumeDeliveryOption(everyOption.rest);
		deliveryMode = trailingDelivery.deliveryMode ?? deliveryMode;
		if (!trailingDelivery.rest) throw heartbeatUsageError();
		return {
			action: "create",
			interval: normalizeHeartbeatSchedule(everyOption.interval, defaultInterval(defaults)),
			instruction: trailingDelivery.rest,
			...(deliveryMode ? { deliveryMode } : {}),
		};
	}

	const leadingSchedule = consumeLeadingEverySchedule(remaining);
	if (leadingSchedule) {
		const trailingDelivery = consumeDeliveryOption(leadingSchedule.rest);
		deliveryMode = trailingDelivery.deliveryMode ?? deliveryMode;
		if (!trailingDelivery.rest) throw heartbeatUsageError();
		return {
			action: "create",
			interval: normalizeHeartbeatSchedule(leadingSchedule.interval, defaultInterval(defaults)),
			instruction: trailingDelivery.rest,
			...(deliveryMode ? { deliveryMode } : {}),
		};
	}

	remaining = remaining.trim();
	if (!remaining) throw heartbeatUsageError();
	return {
		action: "create",
		interval: defaultInterval(defaults),
		instruction: remaining,
		...((deliveryMode ?? defaults.defaultDeliveryMode ?? defaults.deliveryMode)
			? { deliveryMode: deliveryMode ?? defaults.defaultDeliveryMode ?? defaults.deliveryMode }
			: {}),
	};
}

/** Compatibility alias for callers migrated from Prime's command parser. */
export const parseHeartbeatCommand = parseHeartbeatInput;

export function isHeartbeatScheduleJob(job: ScheduleJob): boolean {
	return job.source === "heartbeat" || job.source === "rlm_heartbeat";
}

function defaultInterval(defaults: HeartbeatDefaults): string {
	return defaults.defaultInterval ?? defaults.interval ?? DEFAULT_HEARTBEAT_INTERVAL;
}

function heartbeatUsageError(): Error {
	return new Error("Usage: /heartbeat [--every <interval>] [--steer|--follow-up] <instruction>");
}

function consumeDeliveryOption(text: string): { deliveryMode: ScheduleDeliveryMode | undefined; rest: string } {
	let rest = text.trim();
	if (/(?:^|\s)--deliver=?$/i.test(rest)) {
		throw new Error('Heartbeat delivery mode must be "steer" or "follow_up"');
	}
	let deliveryMode: ScheduleDeliveryMode | undefined;
	let leading = consumeLeadingDeliveryFlag(rest);
	while (leading) {
		deliveryMode = leading.deliveryMode;
		rest = leading.rest.trim();
		leading = consumeLeadingDeliveryFlag(rest);
	}

	let trailing = consumeTrailingDeliveryFlag(rest);
	let trailingDeliveryMode: ScheduleDeliveryMode | undefined;
	while (trailing) {
		trailingDeliveryMode ??= trailing.deliveryMode;
		rest = trailing.rest.trim();
		trailing = consumeTrailingDeliveryFlag(rest);
	}
	return { deliveryMode: trailingDeliveryMode ?? deliveryMode, rest };
}

function consumeLeadingDeliveryFlag(text: string): { deliveryMode: ScheduleDeliveryMode; rest: string } | undefined {
	const match = /^--(?:deliver(?:=|\s+)(\S+)|(steer)|(follow[-_]up))(?:\s+|$)([\s\S]*)$/i.exec(text);
	if (!match) return undefined;
	return {
		deliveryMode: parseDeliveryModeToken(match[1] ?? match[2] ?? match[3] ?? ""),
		rest: match[4]?.trim() ?? "",
	};
}

function consumeTrailingDeliveryFlag(text: string): { deliveryMode: ScheduleDeliveryMode; rest: string } | undefined {
	const deliverWithSpace = /^([\s\S]*?)\s+--deliver\s+(\S+)$/i.exec(text);
	if (deliverWithSpace) {
		return { deliveryMode: parseDeliveryModeToken(deliverWithSpace[2] ?? ""), rest: deliverWithSpace[1] ?? "" };
	}
	const deliverWithEquals = /^([\s\S]*?)\s+--deliver=(\S+)$/i.exec(text);
	if (deliverWithEquals) {
		return { deliveryMode: parseDeliveryModeToken(deliverWithEquals[2] ?? ""), rest: deliverWithEquals[1] ?? "" };
	}
	const shorthand = /^([\s\S]*?)\s+--(steer|follow[-_]up)$/i.exec(text);
	if (shorthand) {
		return { deliveryMode: parseDeliveryModeToken(shorthand[2] ?? ""), rest: shorthand[1] ?? "" };
	}
	return undefined;
}

function parseDeliveryModeToken(token: string): ScheduleDeliveryMode {
	const normalized = token.toLowerCase().replace("-", "_");
	if (normalized === "steer" || normalized === "follow_up") return normalized;
	throw new Error('Heartbeat delivery mode must be "steer" or "follow_up"');
}

function consumeEveryOption(text: string): { interval: string; rest: string } | undefined {
	const match =
		/^--every(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours))|(\S+))(?:\s+|$)([\s\S]*)$/i.exec(
			text,
		);
	if (!match) return undefined;
	return {
		interval: match[1] ?? match[2] ?? match[3] ?? match[4] ?? "",
		rest: match[5]?.trim() ?? "",
	};
}

function consumeLeadingEverySchedule(text: string): { interval: string; rest: string } | undefined {
	const match =
		/^(every|each)\s+\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i.exec(text);
	if (!match) return undefined;
	return {
		interval: match[0],
		rest: text
			.slice(match[0].length)
			.trim()
			.replace(/^--(?=\s|$)/, "")
			.trim(),
	};
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
