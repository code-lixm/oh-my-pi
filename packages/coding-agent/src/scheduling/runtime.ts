import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ScheduledPromptDelivery } from "../prime-integration/contracts";
import type { AgentSession } from "../session/agent-session";
import { normalizeHeartbeatSchedule, parseSchedule } from "./parser";
import { SetTimeoutScheduleScheduler } from "./scheduler";
import { JsonScheduleStore, sidecarPathForArtifacts } from "./store";
import type {
	CreateScheduleInput,
	HeartbeatDefaults,
	ScheduleDeliveryReceipt,
	ScheduleJob,
	ScheduleRunResult,
	ScheduleSessionBinding,
	ScheduleSource,
	ScheduleSpec,
	SetHeartbeatInput,
	UpdateScheduleJobInput,
} from "./types";

const DEFAULT_HEARTBEAT_INTERVAL = "every 5m";
const DEFAULT_HEARTBEAT_DELIVERY_MODE = "steer";
const DEFAULT_SCHEDULE_DELIVERY_MODE = "follow_up";
const PERSISTED_SESSION_REQUIRED_ERROR = "Scheduling requires a persisted session and artifacts";

export interface SessionScheduleRuntimeOptions {
	now?: () => Date;
	heartbeatDefaults?: HeartbeatDefaults;
	scheduleDefaultDeliveryMode?: ScheduleJob["deliveryMode"];
	isSourceEnabled?: (source: ScheduleSource) => boolean;
}

export interface ListScheduledJobsOptions {
	includeInactive?: boolean;
	source?: ScheduleSource | readonly ScheduleSource[];
}

export type ScheduleManagementAction = "pause" | "resume" | "cancel";
export type HeartbeatManagementAction = "pause" | "resume" | "clear";

interface ScheduledPromptDeliveryContext {
	expectedScheduleBinding: ScheduleSessionBinding;
	scheduledFor: string;
}

interface RuntimeScheduledPromptDelivery {
	deliverScheduledPrompt(job: ScheduleJob, context?: ScheduledPromptDeliveryContext): Promise<ScheduleRunResult>;
}

interface BoundScheduleRuntime {
	binding: ScheduleSessionBinding;
	store: JsonScheduleStore;
	scheduler: SetTimeoutScheduleScheduler;
}

/**
 * Creates the delivery adapter injected into AgentSession. It deliberately owns
 * no timer or persistent state: those belong to the session-owned runtime.
 */
export function createSchedulingProvider(session: AgentSession): RuntimeScheduledPromptDelivery {
	return {
		async deliverScheduledPrompt(
			job: ScheduleJob,
			context?: ScheduledPromptDeliveryContext,
		): Promise<ScheduleRunResult> {
			if (!context) return "skipped";
			if (!canDeliverScheduledPromptNow(session)) return "skipped";
			if (hasQueuedScheduleJob(session, job.id)) return "skipped";
			const customType = job.source === "cron" ? "scheduled-prompt" : "heartbeat-prompt";
			const options = {
				deliverAs: job.deliveryMode === "follow_up" ? "followUp" : "steer",
				triggerTurn: true,
				expectedScheduleBinding: context.expectedScheduleBinding,
			} as const;
			const receipt: ScheduleDeliveryReceipt = { outcome: "ran" };
			await session.sendCustomMessage(
				{
					customType,
					content: job.prompt,
					display: true,
					details: {
						scheduleJobId: job.id,
						source: job.source,
						scheduledFor: context.scheduledFor,
					},
					attribution: "agent",
				},
				{ ...options, scheduleReceipt: receipt },
			);
			return receipt.outcome;
		},
	};
}

/**
 * Owns one persisted scheduling sidecar for the current AgentSession. Session
 * lifecycle code must stop and rebind this runtime around session transitions.
 */
export class SessionScheduleRuntime implements ScheduledPromptDelivery {
	readonly #session: AgentSession;
	readonly #now: () => Date;
	readonly #heartbeatDefaults: HeartbeatDefaults;
	readonly #delivery: RuntimeScheduledPromptDelivery;
	readonly #scheduleDefaultDeliveryMode: ScheduleJob["deliveryMode"];
	readonly #isSourceEnabled: (source: ScheduleSource) => boolean;
	#binding: ScheduleSessionBinding | undefined;
	#store: JsonScheduleStore | undefined;
	#scheduler: SetTimeoutScheduleScheduler | undefined;
	#generation = 0;
	#disposed = false;
	#ready: Promise<void> = Promise.resolve();

	constructor(session: AgentSession, options: SessionScheduleRuntimeOptions = {}) {
		this.#session = session;
		this.#now = options.now ?? (() => new Date());
		this.#heartbeatDefaults = options.heartbeatDefaults ?? {};
		this.#scheduleDefaultDeliveryMode = options.scheduleDefaultDeliveryMode ?? DEFAULT_SCHEDULE_DELIVERY_MODE;
		this.#isSourceEnabled = options.isSourceEnabled ?? (() => true);
		this.#delivery = createSchedulingProvider(session);
		this.#ready = this.rebind();
	}

	async ready(): Promise<void> {
		await this.#ready;
	}

	async rebind(): Promise<void> {
		const task = this.#rebind();
		this.#ready = task;

		await task;
	}

	stopForTransition(): void {
		this.#generation++;
		this.#scheduler?.stop();
		this.#scheduler = undefined;
		this.#store = undefined;
		this.#binding = undefined;
	}

	dispose(): void {
		this.#disposed = true;
		this.stopForTransition();
	}

	/** Whether a binding still identifies this live runtime generation. */
	isCurrentBinding(binding: ScheduleSessionBinding): boolean {
		const current = this.#binding;
		return (
			!this.#disposed &&
			current !== undefined &&
			binding.generation === this.#generation &&
			sameScheduleBinding(current, binding) &&
			this.#matchesLiveSession(binding)
		);
	}

	async list(options: ListScheduledJobsOptions = {}): Promise<ScheduleJob[]> {
		const { binding, store } = await this.#currentRuntime();
		const jobs = await store.listBySession(binding.sessionId);
		this.#assertCurrentBinding(binding);
		const sources =
			options.source === undefined
				? undefined
				: new Set(Array.isArray(options.source) ? options.source : [options.source]);
		return jobs.filter(job => {
			if (!this.#isBoundJob(job, binding)) return false;
			if (!options.includeInactive && job.status !== "active" && job.status !== "paused") return false;
			return sources === undefined || sources.has(job.source);
		});
	}

	async createSchedule(input: CreateScheduleInput): Promise<ScheduleJob> {
		this.#assertSourceEnabled("cron");
		const runtime = await this.#currentRuntime();
		const parsed = parseScheduleInput(input.schedule, this.#now());
		const job = await runtime.store.create(
			{
				source: "cron",
				deliveryMode: input.deliveryMode ?? this.#scheduleDefaultDeliveryMode,
				sessionId: runtime.binding.sessionId,
				sessionFile: runtime.binding.sessionFile,
				cwd: runtime.binding.cwd,
				prompt: input.prompt,
				...(input.label === undefined ? {} : { label: input.label }),
			},
			parsed,
		);
		this.#assertCurrentBinding(runtime.binding);
		runtime.scheduler.wake();
		return job;
	}

	async updateSchedule(input: UpdateScheduleJobInput): Promise<ScheduleJob> {
		const runtime = await this.#currentRuntime();
		const current = await this.#getBoundJob(runtime, input.id, "cron");
		if (current.status === "cancelled" || current.status === "completed" || current.status === "failed") {
			throw new Error("Completed, cancelled, or failed schedules cannot be updated");
		}
		const parsed = parseScheduleInput(input.schedule, this.#now());
		if (current.status === "paused" && parsed.schedule.kind === "once") {
			throw new Error("Paused schedules must remain recurring");
		}
		const updated = await runtime.store.update(current.id, job => {
			if (!this.#isBoundJob(job, runtime.binding) || job.source !== "cron") return undefined;
			const prompt = input.prompt === undefined ? job.prompt : input.prompt.trim();
			if (!prompt) throw new Error("Schedule prompt cannot be empty");
			const label = input.label === undefined ? job.label : input.label.trim() || undefined;
			const deliveryMode = input.deliveryMode ?? job.deliveryMode;
			const base: ScheduleJob = {
				...job,
				...(label === undefined ? {} : { label }),
				prompt,
				schedule: parsed.schedule,
				...(deliveryMode === undefined ? {} : { deliveryMode }),
				updatedAt: this.#now().toISOString(),
			};
			if (job.status === "paused") {
				const { nextRunAt: _nextRunAt, ...paused } = base;
				return paused;
			}
			return { ...base, nextRunAt: parsed.nextRunAt.toISOString() };
		});
		if (!updated) throw new Error(`Schedule not found: ${input.id}`);
		this.#assertCurrentBinding(runtime.binding);
		runtime.scheduler.wake();
		return updated;
	}

	async manageSchedule(id: string, action: ScheduleManagementAction): Promise<ScheduleJob | undefined> {
		const runtime = await this.#currentRuntime();
		await this.#getBoundJob(runtime, id, "cron");
		const result =
			action === "pause"
				? await runtime.store.pause(id, this.#now())
				: action === "resume"
					? await runtime.store.resume(id, this.#now())
					: await runtime.store.cancel(id, this.#now());
		this.#assertCurrentBinding(runtime.binding);
		if (result) runtime.scheduler.wake();
		return result;
	}

	async setHeartbeat(input: SetHeartbeatInput): Promise<ScheduleJob> {
		this.#assertSourceEnabled("heartbeat");
		const runtime = await this.#currentRuntime();
		const interval = normalizeHeartbeatSchedule(
			input.interval?.trim() || this.#heartbeatDefaults.defaultInterval || DEFAULT_HEARTBEAT_INTERVAL,
		);
		const parsed = parseSchedule(interval, this.#now());
		if (parsed.schedule.kind === "once") throw new Error("Heartbeat schedule must be recurring");
		const job = await runtime.store.createHeartbeat(
			{
				deliveryMode:
					input.deliveryMode ?? this.#heartbeatDefaults.defaultDeliveryMode ?? DEFAULT_HEARTBEAT_DELIVERY_MODE,
				sessionId: runtime.binding.sessionId,
				sessionFile: runtime.binding.sessionFile,
				cwd: runtime.binding.cwd,
				prompt: input.instruction,
				...(input.label === undefined ? {} : { label: input.label }),
			},
			parsed,
		);
		this.#assertCurrentBinding(runtime.binding);
		runtime.scheduler.wake();
		return job;
	}

	async manageHeartbeat(action: HeartbeatManagementAction): Promise<ScheduleJob | undefined> {
		const runtime = await this.#currentRuntime();
		const jobs = await runtime.store.listBySession(runtime.binding.sessionId);
		const heartbeat = jobs.find(
			job =>
				this.#isBoundJob(job, runtime.binding) &&
				job.source === "heartbeat" &&
				(job.status === "active" || job.status === "paused"),
		);
		if (!heartbeat) return undefined;
		const result =
			action === "pause"
				? await runtime.store.pause(heartbeat.id, this.#now())
				: action === "resume"
					? await runtime.store.resume(heartbeat.id, this.#now())
					: await runtime.store.cancel(heartbeat.id, this.#now());
		this.#assertCurrentBinding(runtime.binding);
		if (result) runtime.scheduler.wake();
		return result;
	}

	async deliverScheduledPrompt(job: ScheduleJob): Promise<void> {
		await this.ready();
		const binding = this.#binding;
		if (!binding || !this.isCurrentBinding(binding) || !this.#isBoundJob(job, binding)) {
			throw new Error(PERSISTED_SESSION_REQUIRED_ERROR);
		}
		await this.#delivery.deliverScheduledPrompt(job, {
			expectedScheduleBinding: binding,
			scheduledFor: job.nextRunAt ?? this.#now().toISOString(),
		});
	}

	async #rebind(): Promise<void> {
		this.stopForTransition();
		if (this.#disposed) return;
		const binding = this.#captureBinding();
		if (!binding) return;
		const generation = this.#generation;
		await fs.mkdir(binding.artifactsDir, { recursive: true, mode: 0o700 });
		if (this.#disposed || this.#generation !== generation || !this.#matchesLiveSession(binding)) return;
		const store = new JsonScheduleStore({ filePath: sidecarPathForArtifacts(binding.artifactsDir), now: this.#now });
		const scheduler = new SetTimeoutScheduleScheduler(store, {
			now: this.#now,
			runJob: async (job, dispatch) => await this.#runBoundJob(job, dispatch.scheduledFor, binding, generation),
		});
		this.#binding = binding;
		this.#store = store;
		this.#scheduler = scheduler;
		try {
			await scheduler.start();
		} catch (error) {
			if (this.#disposed || this.#generation !== generation || this.#scheduler !== scheduler) {
				scheduler.stop();
				return;
			}
			this.stopForTransition();
			throw error;
		}
		if (this.#disposed || this.#generation !== generation || this.#scheduler !== scheduler) scheduler.stop();
	}

	async #runBoundJob(
		job: ScheduleJob,
		scheduledFor: string,
		binding: ScheduleSessionBinding,
		generation: number,
	): Promise<ScheduleRunResult> {
		if (this.#disposed || generation !== this.#generation || !this.#isBoundJob(job, binding)) return "skipped";
		if (!this.#isSourceEnabled(job.source)) return "skipped";
		if (!this.#matchesLiveSession(binding)) return "skipped";
		return await this.#delivery.deliverScheduledPrompt(job, {
			expectedScheduleBinding: binding,
			scheduledFor,
		});
	}

	async #currentRuntime(): Promise<BoundScheduleRuntime> {
		await this.ready();
		const binding = this.#binding;
		const store = this.#store;
		const scheduler = this.#scheduler;
		if (!binding || !store || !scheduler) {
			throw new Error("Current session is not persisted; scheduling requires a persisted session");
		}
		this.#assertCurrentBinding(binding);
		return { binding, store, scheduler };
	}

	async #getBoundJob(runtime: BoundScheduleRuntime, id: string, source: ScheduleSource): Promise<ScheduleJob> {
		const jobs = await runtime.store.listBySession(runtime.binding.sessionId);
		this.#assertCurrentBinding(runtime.binding);
		const job = jobs.find(candidate => candidate.id === id && this.#isBoundJob(candidate, runtime.binding));
		if (!job || job.source !== source) throw new Error(`Schedule not found: ${id}`);
		return job;
	}

	#captureBinding(): ScheduleSessionBinding | undefined {
		const sessionId = this.#session.sessionManager.getSessionId();
		const sessionFile = this.#session.sessionManager.getSessionFile();
		const artifactsDir = this.#session.sessionManager.getArtifactsDir();
		if (!sessionId || !sessionFile || !artifactsDir) return undefined;
		return {
			generation: this.#generation,
			sessionId,
			sessionFile: path.resolve(sessionFile),
			cwd: this.#session.sessionManager.getCwd(),
			artifactsDir,
		};
	}

	#assertCurrentBinding(binding: ScheduleSessionBinding): void {
		if (this.#disposed || this.#binding !== binding || !this.#matchesLiveSession(binding)) {
			throw new Error("Scheduling runtime is no longer bound to the current session");
		}
	}

	#matchesLiveSession(binding: ScheduleSessionBinding): boolean {
		const sessionFile = this.#session.sessionManager.getSessionFile();
		return (
			this.#session.sessionManager.getSessionId() === binding.sessionId &&
			sessionFile !== undefined &&
			path.resolve(sessionFile) === binding.sessionFile
		);
	}

	#isBoundJob(job: ScheduleJob, binding: ScheduleSessionBinding): boolean {
		return job.sessionId === binding.sessionId && path.resolve(job.sessionFile) === binding.sessionFile;
	}

	#assertSourceEnabled(source: ScheduleSource): void {
		if (!this.#isSourceEnabled(source)) throw new Error(`${source} scheduling is disabled`);
	}
}

interface QueueInspectableSession {
	agent?: {
		peekSteeringQueue?: () => readonly { details?: unknown }[];
		peekFollowUpQueue?: () => readonly { details?: unknown }[];
	};
	isDisposed?: boolean;
	isStreaming?: boolean;
	isReadyForScheduledDelivery?: boolean;
}

/** A queued prompt remains agent-owned until it is consumed by a turn. */
function hasQueuedScheduleJob(session: AgentSession, jobId: string): boolean {
	const agent = (session as unknown as QueueInspectableSession).agent;
	const steering = agent?.peekSteeringQueue?.();
	if (steering?.some(message => isRecord(message.details) && message.details.scheduleJobId === jobId)) {
		return true;
	}
	const followUp = agent?.peekFollowUpQueue?.();
	return followUp?.some(message => isRecord(message.details) && message.details.scheduleJobId === jobId) ?? false;
}

/** Streaming deliveries join the live queue; idle delivery requires no competing session work. */
function canDeliverScheduledPromptNow(session: AgentSession): boolean {
	const state = session as unknown as QueueInspectableSession;
	if (state.isDisposed === true) return false;
	if (state.isStreaming === true) return true;
	return state.isReadyForScheduledDelivery ?? true;
}

function sameScheduleBinding(left: ScheduleSessionBinding, right: ScheduleSessionBinding): boolean {
	return (
		left.generation === right.generation &&
		left.sessionId === right.sessionId &&
		left.sessionFile === right.sessionFile &&
		left.cwd === right.cwd &&
		left.artifactsDir === right.artifactsDir
	);
}

function parseScheduleInput(schedule: string | ScheduleSpec, now: Date) {
	return parseSchedule(typeof schedule === "string" ? schedule : schedule.expression, now);
}
