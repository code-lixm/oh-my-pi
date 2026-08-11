import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { nextRunAtForSchedule } from "./parser";
import {
	type CreateScheduleJobInput,
	type ParsedSchedule,
	SCHEDULED_JOBS_FILENAME,
	type ScheduleDispatch,
	type ScheduleDispatchRecord,
	type ScheduleFileState,
	type ScheduleJob,
	type ScheduleJobSource,
	type ScheduleJobStatus,
	type ScheduleRunResult,
	type ScheduleSpec,
	type ScheduleStore,
} from "./types";

const SCHEDULE_FILE_VERSION = 1 as const;
const INTERRUPTED_DISPATCH_ERROR = "Interrupted before scheduled operation completion";

export interface JsonScheduleStoreOptions {
	filePath: string;
	now?: () => Date;
	createId?: () => string;
}

interface MutationResult<T> {
	value: T;
	changed: boolean;
}

/** A crash-safe JSON sidecar store for one session's scheduled jobs. */
export class JsonScheduleStore implements ScheduleStore {
	readonly #filePath: string;
	readonly #now: () => Date;
	readonly #createId: () => string;

	constructor(options: JsonScheduleStoreOptions) {
		if (!options.filePath.trim()) throw new Error("Schedule sidecar path is required");
		this.#filePath = options.filePath;
		this.#now = options.now ?? (() => new Date());
		this.#createId = options.createId ?? (() => crypto.randomUUID());
	}

	async load(): Promise<ScheduleFileState> {
		return await withFileLock(this.#filePath, async () => clone(await this.#readState()));
	}

	async listBySession(sessionId: string): Promise<ScheduleJob[]> {
		const state = await this.load();
		return state.jobs
			.filter(job => job.sessionId === sessionId)
			.map(clone)
			.sort(compareJobs);
	}

	async save(job: ScheduleJob): Promise<ScheduleJob> {
		const candidate = clone(job);
		assertScheduleJob(candidate);
		return await this.#mutate(state => {
			const index = state.jobs.findIndex(current => current.id === candidate.id);
			const current = index === -1 ? undefined : state.jobs[index]!;
			if (current && isTerminalScheduleStatus(current.status)) {
				return { value: clone(current), changed: false };
			}
			if (index === -1) state.jobs.push(candidate);
			else state.jobs[index] = candidate;
			return { value: clone(candidate), changed: true };
		});
	}

	async update(id: string, mutate: (job: ScheduleJob) => ScheduleJob | undefined): Promise<ScheduleJob | undefined> {
		return await this.#mutate(state => {
			const index = state.jobs.findIndex(job => job.id === id);
			if (index === -1) return { value: undefined, changed: false };
			const current = state.jobs[index]!;
			if (isTerminalScheduleStatus(current.status)) {
				return { value: clone(current), changed: false };
			}
			const next = mutate(clone(current));
			if (!next) return { value: undefined, changed: false };
			assertScheduleJob(next);
			state.jobs[index] = clone(next);
			return { value: clone(next), changed: true };
		});
	}

	async cancel(id: string, now: Date = this.#now()): Promise<ScheduleJob | undefined> {
		assertValidDate(now, "cancel time");
		return await this.#mutate(state => {
			const index = state.jobs.findIndex(job => job.id === id);
			if (index === -1) return { value: undefined, changed: false };
			const current = state.jobs[index]!;
			if (isTerminalScheduleStatus(current.status)) {
				return { value: clone(current), changed: false };
			}
			const cancelled = withoutNextRunAt({ ...current, status: "cancelled", updatedAt: now.toISOString() });
			state.jobs[index] = cancelled;
			return { value: clone(cancelled), changed: true };
		});
	}

	/** Create a general cron/interval/once job in this sidecar. */
	async create(input: CreateScheduleJobInput, parsed: ParsedSchedule): Promise<ScheduleJob> {
		return await this.#createJob(input, parsed, input.source ?? "cron", false);
	}

	/** Create/replace the one user-visible heartbeat for a session. */
	async createHeartbeat(input: CreateScheduleJobInput, parsed: ParsedSchedule): Promise<ScheduleJob> {
		return await this.#createJob(input, parsed, "heartbeat", true);
	}

	/** Create an RLM heartbeat without replacing other RLM heartbeats. */
	async createRlmHeartbeat(input: CreateScheduleJobInput, parsed: ParsedSchedule): Promise<ScheduleJob> {
		return await this.#createJob(input, parsed, "rlm_heartbeat", false);
	}

	async pause(id: string, now: Date = this.#now()): Promise<ScheduleJob | undefined> {
		assertValidDate(now, "pause time");
		return await this.#mutate(state => {
			const index = state.jobs.findIndex(job => job.id === id);
			if (index === -1) return { value: undefined, changed: false };
			const current = state.jobs[index]!;
			if (isTerminalScheduleStatus(current.status)) {
				return { value: clone(current), changed: false };
			}
			if (current.schedule.kind === "once") throw new Error("One-shot schedules cannot be paused");
			if (current.status === "paused") return { value: clone(current), changed: false };
			const paused = withoutNextRunAt({ ...current, status: "paused", updatedAt: now.toISOString() });
			state.jobs[index] = paused;
			return { value: clone(paused), changed: true };
		});
	}

	async resume(id: string, now: Date = this.#now()): Promise<ScheduleJob | undefined> {
		assertValidDate(now, "resume time");
		return await this.#mutate(state => {
			const index = state.jobs.findIndex(job => job.id === id);
			if (index === -1) return { value: undefined, changed: false };
			const current = state.jobs[index]!;
			if (isTerminalScheduleStatus(current.status)) {
				return { value: clone(current), changed: false };
			}
			if (current.schedule.kind === "once") throw new Error("One-shot schedules cannot be resumed");
			if (current.status === "active") return { value: clone(current), changed: false };
			const nextRunAt = nextRunAtForSchedule(current.schedule, now);
			if (!nextRunAt) throw new Error("Only recurring schedules can be resumed");
			const resumed = {
				...current,
				status: "active" as const,
				nextRunAt: nextRunAt.toISOString(),
				updatedAt: now.toISOString(),
			};
			state.jobs[index] = resumed;
			return { value: clone(resumed), changed: true };
		});
	}

	async claimDue(dueAt: Date = this.#now(), claimedAt: Date = dueAt): Promise<ScheduleDispatch[]> {
		assertValidDate(dueAt, "due time");
		assertValidDate(claimedAt, "claim time");
		return await this.#mutate(state => {
			const dispatches: ScheduleDispatch[] = [];
			const claimedJobIds = new Set(state.dispatches.map(dispatch => dispatch.jobId));
			let changed = false;

			state.jobs = state.jobs.map(job => {
				if (!isDueJob(job, dueAt)) return job;
				const alreadyClaimed = claimedJobIds.has(job.id);
				// A one-shot keeps its due time while the durable lease is outstanding.
				// That preserves the active-job invariant without creating a second delivery.
				if (alreadyClaimed && job.schedule.kind === "once") return job;
				changed = true;
				const scheduledFor = job.nextRunAt!;
				const advanced = advanceJobForClaim(job, claimedAt);
				if (alreadyClaimed) {
					return { ...advanced, lastSkippedAt: claimedAt.toISOString() };
				}
				const record: ScheduleDispatchRecord = {
					id: this.#createId(),
					jobId: job.id,
					claimedAt: claimedAt.toISOString(),
					scheduledFor,
				};
				state.dispatches.push(record);
				claimedJobIds.add(job.id);
				dispatches.push({ ...clone(record), job: clone(advanced) });
				return advanced;
			});
			return { value: dispatches, changed };
		});
	}

	async recordDispatchResult(
		dispatchId: string,
		result: { outcome: ScheduleRunResult; now?: Date; error?: unknown },
	): Promise<ScheduleJob | undefined> {
		const now = result.now ?? this.#now();
		assertValidDate(now, "dispatch result time");
		return await this.#mutate(state => {
			const dispatch = state.dispatches.find(candidate => candidate.id === dispatchId);
			if (!dispatch) return { value: undefined, changed: false };
			state.dispatches = state.dispatches.filter(candidate => candidate.id !== dispatchId);
			const index = state.jobs.findIndex(job => job.id === dispatch.jobId);
			if (index === -1) return { value: undefined, changed: true };
			const current = state.jobs[index]!;
			if (current.status !== "active") return { value: clone(current), changed: true };

			let updated: ScheduleJob;
			if (result.outcome === "skipped") {
				const nextRunAt = nextRunAtForSchedule(current.schedule, now);
				updated = withScheduleCompletion(
					{
						...current,
						lastSkippedAt: now.toISOString(),
						updatedAt: now.toISOString(),
						...(nextRunAt ? { nextRunAt: nextRunAt.toISOString() } : {}),
					},
					current.schedule,
				);
			} else {
				const error = result.error === undefined ? undefined : errorMessage(result.error);
				updated = withScheduleCompletion(
					{
						...current,
						lastRunAt: now.toISOString(),
						runCount: current.runCount + 1,
						updatedAt: now.toISOString(),
						...(error === undefined ? {} : { lastError: error }),
					},
					current.schedule,
				);
				if (error === undefined) updated = withoutLastError(updated);
			}
			state.jobs[index] = updated;
			return { value: clone(updated), changed: true };
		});
	}

	async recoverInterruptedDispatches(now: Date = this.#now()): Promise<ScheduleJob[]> {
		assertValidDate(now, "recovery time");
		return await this.#mutate(state => {
			if (state.dispatches.length === 0) return { value: [], changed: false };
			const interruptedJobIds = new Set(state.dispatches.map(dispatch => dispatch.jobId));
			state.dispatches = [];
			const recovered: ScheduleJob[] = [];
			state.jobs = state.jobs.map(job => {
				if (!interruptedJobIds.has(job.id) || job.status !== "active") return job;
				const next = withScheduleCompletion(
					{
						...job,
						lastError: INTERRUPTED_DISPATCH_ERROR,
						updatedAt: now.toISOString(),
					},
					job.schedule,
				);
				recovered.push(clone(next));
				return next;
			});
			return { value: recovered, changed: true };
		});
	}

	async nextActiveRunAt(): Promise<Date | undefined> {
		const state = await this.load();
		const claimedJobIds = new Set(state.dispatches.map(dispatch => dispatch.jobId));
		let earliest: Date | undefined;
		for (const job of state.jobs) {
			if (job.status !== "active" || !job.nextRunAt) continue;
			if (job.schedule.kind === "once" && claimedJobIds.has(job.id)) continue;
			const date = new Date(job.nextRunAt);
			if (!earliest || date.getTime() < earliest.getTime()) earliest = date;
		}
		return earliest ? new Date(earliest.getTime()) : undefined;
	}

	async #createJob(
		input: CreateScheduleJobInput,
		parsed: ParsedSchedule,
		source: ScheduleJobSource,
		replaceHeartbeat: boolean,
	): Promise<ScheduleJob> {
		const now = this.#now();
		assertValidDate(now, "creation time");
		assertParsedSchedule(parsed);
		if (source !== "cron" && parsed.schedule.kind === "once") {
			throw new Error("Heartbeat schedule must be recurring");
		}
		const prompt = input.prompt.trim();
		if (!prompt)
			throw new Error(
				source === "cron" ? "Schedule prompt cannot be empty" : "Heartbeat instruction cannot be empty",
			);

		const job = createScheduleJob(
			{
				...input,
				source,
				prompt,
				id: input.id ?? this.#createId(),
				createdAt: input.createdAt ?? now,
				updatedAt: input.updatedAt ?? now,
			},
			parsed,
		);
		return await this.#mutate(state => {
			if (state.jobs.some(current => current.id === job.id)) {
				throw new Error(`Schedule job already exists: ${job.id}`);
			}
			if (replaceHeartbeat) {
				state.jobs = state.jobs.map(current => {
					if (
						current.sessionId === job.sessionId &&
						current.source === "heartbeat" &&
						(current.status === "active" || current.status === "paused")
					) {
						return withoutNextRunAt({ ...current, status: "cancelled", updatedAt: now.toISOString() });
					}
					return current;
				});
			}
			state.jobs.push(job);
			return { value: clone(job), changed: true };
		});
	}

	async #mutate<T>(action: (state: ScheduleFileState) => MutationResult<T>): Promise<T> {
		return await withFileLock(this.#filePath, async () => {
			const state = await this.#readState();
			const result = action(state);
			if (result.changed) await this.#writeState(state);
			return clone(result.value);
		});
	}

	async #readState(): Promise<ScheduleFileState> {
		const file = Bun.file(this.#filePath);
		if (!(await file.exists())) return emptyState();
		let text: string;
		try {
			text = await file.text();
		} catch (error) {
			if (isEnoent(error)) return emptyState();
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text) as unknown;
		} catch (error) {
			throw corruptionError(`invalid JSON (${errorMessage(error)})`);
		}
		try {
			assertScheduleFileState(parsed);
		} catch (error) {
			throw corruptionError(errorMessage(error));
		}
		return clone(parsed);
	}

	async #writeState(state: ScheduleFileState): Promise<void> {
		assertScheduleFileState(state);
		const directory = path.dirname(this.#filePath);
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		const tempPath = `${this.#filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
		let renameCompleted = false;
		try {
			await Bun.write(tempPath, `${JSON.stringify(state, null, 2)}\n`);
			await fs.chmod(tempPath, 0o600);
			const descriptor = await fs.open(tempPath, "r");
			try {
				await descriptor.sync();
			} finally {
				await descriptor.close();
			}
			await fs.rename(tempPath, this.#filePath);
			renameCompleted = true;
			try {
				const directoryDescriptor = await fs.open(directory, "r");
				try {
					await directoryDescriptor.sync();
				} finally {
					await directoryDescriptor.close();
				}
			} catch {
				// Some filesystems cannot fsync directories; the renamed file remains atomic.
			}
		} finally {
			if (!renameCompleted) await fs.rm(tempPath, { force: true }).catch(() => {});
		}
	}
}

export function sidecarPathForArtifacts(artifactsDir: string): string {
	return path.join(artifactsDir, SCHEDULED_JOBS_FILENAME);
}

export function createScheduleJob(input: CreateScheduleJobInput, parsed: ParsedSchedule): ScheduleJob {
	assertParsedSchedule(parsed);
	const id = input.id ?? crypto.randomUUID();
	const createdAt = toIso(input.createdAt ?? new Date(), "creation time");
	const updatedAt = toIso(input.updatedAt ?? createdAt, "update time");
	const prompt = input.prompt.trim();
	if (!prompt) throw new Error("Schedule prompt cannot be empty");
	const job: ScheduleJob = {
		id,
		source: input.source ?? "cron",
		status: "active",
		...(input.deliveryMode ? { deliveryMode: input.deliveryMode } : {}),
		...(input.activeSessionId ? { activeSessionId: input.activeSessionId } : {}),
		sessionId: input.sessionId,
		sessionFile: input.sessionFile,
		cwd: input.cwd,
		...(normalizeOptional(input.label) ? { label: normalizeOptional(input.label) } : {}),
		prompt,
		schedule: clone(parsed.schedule),
		createdAt,
		updatedAt,
		nextRunAt: parsed.nextRunAt.toISOString(),
		runCount: 0,
	};
	assertScheduleJob(job);
	return job;
}

function emptyState(): ScheduleFileState {
	return { version: SCHEDULE_FILE_VERSION, jobs: [], dispatches: [] };
}

function advanceJobForClaim(job: ScheduleJob, claimedAt: Date): ScheduleJob {
	if (job.schedule.kind === "once") return job;
	const nextRunAt = nextRunAtForSchedule(job.schedule, claimedAt);
	const advanced = { ...job, updatedAt: claimedAt.toISOString() };
	return nextRunAt ? { ...advanced, nextRunAt: nextRunAt.toISOString() } : withoutNextRunAt(advanced);
}

function withScheduleCompletion(job: ScheduleJob, schedule: ScheduleSpec): ScheduleJob {
	if (schedule.kind !== "once") return job;
	return withoutNextRunAt({ ...job, status: "completed" });
}

function withoutNextRunAt(job: ScheduleJob): ScheduleJob {
	const { nextRunAt: _nextRunAt, ...rest } = job;
	return rest;
}

function withoutLastError(job: ScheduleJob): ScheduleJob {
	const { lastError: _lastError, ...rest } = job;
	return rest;
}

function isTerminalScheduleStatus(status: ScheduleJobStatus): boolean {
	return status === "cancelled" || status === "completed" || status === "failed";
}

function isDueJob(job: ScheduleJob, dueAt: Date): boolean {
	return job.status === "active" && job.nextRunAt !== undefined && Date.parse(job.nextRunAt) <= dueAt.getTime();
}

function assertParsedSchedule(parsed: ParsedSchedule): void {
	if (!parsed || typeof parsed !== "object" || !(parsed.nextRunAt instanceof Date)) {
		throw new Error("Invalid parsed schedule");
	}
	assertValidDate(parsed.nextRunAt, "next run time");
	assertScheduleSpec(parsed.schedule);
}

function assertScheduleFileState(value: unknown): asserts value is ScheduleFileState {
	if (!isRecord(value)) throw new Error("expected an object");
	if (value.version !== SCHEDULE_FILE_VERSION) throw new Error("unsupported version");
	if (!Array.isArray(value.jobs) || !Array.isArray(value.dispatches))
		throw new Error("jobs and dispatches must be arrays");
	const jobIds = new Set<string>();
	for (const job of value.jobs) {
		assertScheduleJob(job);
		if (jobIds.has(job.id)) throw new Error(`duplicate job id: ${job.id}`);
		jobIds.add(job.id);
	}
	const dispatchIds = new Set<string>();
	const dispatchedJobIds = new Set<string>();
	for (const dispatch of value.dispatches) {
		assertDispatchRecord(dispatch);
		if (dispatchIds.has(dispatch.id)) throw new Error(`duplicate dispatch id: ${dispatch.id}`);
		if (dispatchedJobIds.has(dispatch.jobId)) throw new Error(`multiple dispatches for job: ${dispatch.jobId}`);
		if (!jobIds.has(dispatch.jobId)) throw new Error(`dispatch references unknown job: ${dispatch.jobId}`);
		dispatchIds.add(dispatch.id);
		dispatchedJobIds.add(dispatch.jobId);
	}
}

function assertScheduleJob(value: unknown): asserts value is ScheduleJob {
	if (!isRecord(value)) throw new Error("job must be an object");
	assertString(value.id, "job id");
	if (!isScheduleJobSource(value.source)) throw new Error(`invalid job source: ${String(value.source)}`);
	if (!isScheduleJobStatus(value.status)) throw new Error(`invalid job status: ${String(value.status)}`);
	if (value.deliveryMode !== undefined && value.deliveryMode !== "steer" && value.deliveryMode !== "follow_up") {
		throw new Error(`invalid delivery mode: ${String(value.deliveryMode)}`);
	}
	if (value.activeSessionId !== undefined) assertString(value.activeSessionId, "active session id");
	assertString(value.sessionId, "session id");
	assertString(value.sessionFile, "session file");
	assertString(value.cwd, "cwd");
	if (value.label !== undefined) assertString(value.label, "label");
	assertString(value.prompt, "prompt");
	assertScheduleSpec(value.schedule);
	assertIso(value.createdAt, "createdAt");
	assertIso(value.updatedAt, "updatedAt");
	if (value.nextRunAt !== undefined) assertIso(value.nextRunAt, "nextRunAt");
	if (value.lastRunAt !== undefined) assertIso(value.lastRunAt, "lastRunAt");
	if (value.lastSkippedAt !== undefined) assertIso(value.lastSkippedAt, "lastSkippedAt");
	if (value.lastError !== undefined) assertString(value.lastError, "lastError");
	const runCount = value.runCount;
	if (typeof runCount !== "number" || !Number.isSafeInteger(runCount) || runCount < 0) {
		throw new Error("runCount must be a non-negative integer");
	}
	if (value.status !== "active" && value.nextRunAt !== undefined) {
		throw new Error(`${value.status} job must not have nextRunAt`);
	}
	if (value.status === "active" && value.nextRunAt === undefined) {
		throw new Error("active job must have nextRunAt");
	}
}

function assertScheduleSpec(value: unknown): asserts value is ScheduleSpec {
	if (!isRecord(value)) throw new Error("schedule must be an object");
	if (value.kind !== "once" && value.kind !== "cron" && value.kind !== "interval") {
		throw new Error(`invalid schedule kind: ${String(value.kind)}`);
	}
	assertString(value.expression, "schedule expression");
	if (value.kind === "interval") {
		if (!Number.isSafeInteger(value.intervalMs) || (value.intervalMs as number) < 10_000) {
			throw new Error("intervalMs must be at least 10000");
		}
	} else if (value.intervalMs !== undefined) {
		throw new Error("only interval schedules may have intervalMs");
	}
}

function assertDispatchRecord(value: unknown): asserts value is ScheduleDispatchRecord {
	if (!isRecord(value)) throw new Error("dispatch must be an object");
	assertString(value.id, "dispatch id");
	assertString(value.jobId, "dispatch job id");
	assertIso(value.claimedAt, "dispatch claimedAt");
	assertIso(value.scheduledFor, "dispatch scheduledFor");
}

function assertString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function assertIso(value: unknown, label: string): asserts value is string {
	assertString(value, label);
	if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO date`);
}

function assertValidDate(value: Date, label: string): void {
	if (!Number.isFinite(value.getTime())) throw new Error(`${label} must be valid`);
}

function toIso(value: string | Date, label: string): string {
	const date = typeof value === "string" ? new Date(value) : value;
	assertValidDate(date, label);
	return date.toISOString();
}

function normalizeOptional(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScheduleJobSource(value: unknown): value is ScheduleJobSource {
	return value === "cron" || value === "heartbeat" || value === "rlm_heartbeat";
}

function isScheduleJobStatus(value: unknown): value is ScheduleJobStatus {
	return (
		value === "active" || value === "paused" || value === "completed" || value === "cancelled" || value === "failed"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function corruptionError(reason: string): Error {
	return new Error(`Schedule store corruption: ${reason}`);
}

function isEnoent(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function compareJobs(left: ScheduleJob, right: ScheduleJob): number {
	if (!left.nextRunAt && !right.nextRunAt) return left.id.localeCompare(right.id);
	if (!left.nextRunAt) return 1;
	if (!right.nextRunAt) return -1;
	return left.nextRunAt.localeCompare(right.nextRunAt) || left.id.localeCompare(right.id);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}
