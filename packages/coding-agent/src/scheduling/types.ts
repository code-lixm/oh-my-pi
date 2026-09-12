export type ScheduleJobSource = "cron";
export type ScheduleSource = ScheduleJobSource;
export type ScheduleJobStatus = "active" | "paused" | "completed" | "cancelled" | "failed";
export type ScheduleStatus = ScheduleJobStatus;
export type ScheduleKind = "once" | "cron" | "interval";
export type ScheduleDeliveryMode = "steer" | "follow_up";
export type ScheduleRunResult = "ran" | "skipped";
/** Mutation verbs accepted by {@link ScheduleStore}/{@link SessionScheduleRuntime.manageSchedule}. */
export type ScheduleManagementAction = "pause" | "resume" | "cancel";

export interface ScheduleDeliveryReceipt {
	outcome: ScheduleRunResult;
}

export const SCHEDULED_JOBS_FILENAME = "scheduled-jobs.json";

export interface ScheduleSpec {
	kind: ScheduleKind;
	expression: string;
	intervalMs?: number;
}

export interface ScheduleJob {
	id: string;
	source: ScheduleJobSource;
	status: ScheduleJobStatus;
	deliveryMode?: ScheduleDeliveryMode;
	/** Session identity captured when the job was created. */
	activeSessionId?: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	label?: string;
	prompt: string;
	schedule: ScheduleSpec;
	createdAt: string;
	updatedAt: string;
	nextRunAt?: string;
	lastRunAt?: string;
	lastSkippedAt?: string;
	lastError?: string;
	runCount: number;
}

export interface ScheduleDispatchRecord {
	id: string;
	jobId: string;
	claimedAt: string;
	scheduledFor: string;
}

export interface ScheduleDispatch extends ScheduleDispatchRecord {
	job: ScheduleJob;
}

export interface ScheduleFileState {
	version: 1;
	jobs: ScheduleJob[];
	dispatches: ScheduleDispatchRecord[];
}

export interface ScheduleSessionBinding {
	generation: number;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	artifactsDir: string;
}

export interface CreateScheduleJobInput {
	source?: ScheduleJobSource;
	deliveryMode?: ScheduleDeliveryMode;
	sessionId: string;
	/** Optional active-session identity retained for RLM/daemon integrations. */
	activeSessionId?: string;
	sessionFile: string;
	cwd: string;
	prompt: string;
	label?: string;
	id?: string;
	createdAt?: string | Date;
	updatedAt?: string | Date;
}

export interface UpdateScheduleJobInput {
	id: string;
	schedule: string | ScheduleSpec;
	prompt?: string;
	label?: string;
	deliveryMode?: ScheduleDeliveryMode;
}

export interface CreateScheduleInput {
	schedule: string | ScheduleSpec;
	prompt: string;
	label?: string;
	deliveryMode?: ScheduleDeliveryMode;
}

export interface ParsedSchedule {
	schedule: ScheduleSpec;
	nextRunAt: Date;
}

export interface ScheduleStore {
	load(): Promise<ScheduleFileState>;
	listBySession(sessionId: string): Promise<ScheduleJob[]>;
	save(job: ScheduleJob): Promise<ScheduleJob>;
	update(id: string, mutate: (job: ScheduleJob) => ScheduleJob | undefined): Promise<ScheduleJob | undefined>;
	cancel(id: string, now?: Date): Promise<ScheduleJob | undefined>;
	claimDue(dueAt?: Date, claimedAt?: Date): Promise<ScheduleDispatch[]>;
	recordDispatchResult(
		dispatchId: string,
		result: { outcome: ScheduleRunResult; now?: Date; error?: unknown },
	): Promise<ScheduleJob | undefined>;
	recoverInterruptedDispatches(now?: Date): Promise<ScheduleJob[]>;
	nextActiveRunAt(): Promise<Date | undefined>;
}

export interface ScheduleSchedulerHooks {
	runJob: (job: ScheduleJob, dispatch: ScheduleDispatch) => Promise<ScheduleRunResult | undefined>;
	now?: () => Date;
	onError?: (job: ScheduleJob, error: unknown) => void;
}

export interface Scheduler {
	start(): Promise<void>;
	stop(): void;
	wake(): void;
	register(job: ScheduleJob): Promise<ScheduleJob>;
	cancel(id: string): Promise<ScheduleJob | undefined>;
	runDue(now?: Date): Promise<number>;
}
