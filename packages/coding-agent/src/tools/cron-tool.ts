import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { tSettingsUi } from "../i18n/settings-locale";
import { selectPrompt } from "../prompts/prompt-locale";
import cronToolDescription from "../prompts/scheduling/cron-tool.md" with { type: "text" };
import cronToolDescriptionZh from "../prompts/scheduling/cron-tool.zh-CN.md" with { type: "text" };
import type { SessionScheduleRuntime } from "../scheduling/runtime";
import type { ScheduleJob } from "../scheduling/types";

const cronSchema = type({
	op: type("'add' | 'list' | 'pause' | 'resume' | 'cancel' | 'update'").describe("cron management operation"),
	"schedule?": type("string").describe("schedule expression: in 30m, every 10m, at <ISO>, or five-field cron"),
	"prompt?": type("string").describe("full instruction delivered into the session when the job fires"),
	"label?": type("string").describe("short human-readable label"),
	"deliveryMode?": type("'steer' | 'follow_up'").describe(
		"steer injects at the next model boundary; follow_up waits for the turn to finish",
	),
	"jobId?": type("string").describe("job id for pause/resume/cancel/update"),
});

interface CronToolInput {
	op: "add" | "list" | "pause" | "resume" | "cancel" | "update";
	schedule?: string;
	prompt?: string;
	label?: string;
	deliveryMode?: "steer" | "follow_up";
	jobId?: string;
}

export interface CronToolDetails {
	op: CronToolInput["op"];
	job?: ScheduleJob;
	jobs?: ScheduleJob[];
	message: string;
}

/** Format one scheduled job as the confirmation/inspection line shown to the model and user. */
export function formatCronJobSummary(job: ScheduleJob): string {
	return [
		tSettingsUi("[{id}] {status}", { id: job.id, status: tSettingsUi(job.status) }),
		...(job.label ? [`label=${job.label}`] : []),
		`schedule=${job.schedule.expression}`,
		`delivery=${job.deliveryMode ?? "follow_up"}`,
		`nextRun=${job.nextRunAt ?? "—"}`,
		`runCount=${job.runCount}`,
		`prompt=${job.prompt.replace(/\s+/g, " ").slice(0, 160)}`,
	].join(" · ");
}

/**
 * Session-scoped cron management for the agent. Every job is created bound to
 * the current session (its sidecar lives in the session artifacts dir), so the
 * job's lifecycle is the session's lifecycle: it stops firing when the session
 * ends and is rebound across resume/switch by the schedule runtime.
 */
export class CronTool implements AgentTool<typeof cronSchema, CronToolDetails> {
	readonly name = "cron";
	readonly label = "Cron";
	readonly description = selectPrompt(cronToolDescription, cronToolDescriptionZh);
	readonly parameters = cronSchema;

	readonly #getRuntime: () => SessionScheduleRuntime | undefined;
	readonly #isEnabled: () => boolean;

	constructor(getRuntime: () => SessionScheduleRuntime | undefined, isEnabled: () => boolean = () => true) {
		this.#getRuntime = getRuntime;
		this.#isEnabled = isEnabled;
	}

	async execute(
		_toolCallId: string,
		params: CronToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<CronToolDetails>> {
		const runtime = this.#getRuntime();
		if (!this.#isEnabled() || !runtime) {
			return {
				content: [{ type: "text", text: tSettingsUi("Scheduling is unavailable in this session.") }],
			};
		}
		try {
			switch (params.op) {
				case "add":
					return await this.#add(runtime, params);
				case "list":
					return await this.#list(runtime);
				case "pause":
				case "resume":
				case "cancel":
					return await this.#manage(runtime, params);
				case "update":
					return await this.#update(runtime, params);
			}
		} catch (error) {
			throw new Error(tSettingsUi(String(error instanceof Error ? error.message : error)), { cause: error });
		}
	}

	async #add(runtime: SessionScheduleRuntime, params: CronToolInput): Promise<AgentToolResult<CronToolDetails>> {
		if (!params.schedule?.trim()) throw new Error(tSettingsUi("schedule is required for add"));
		if (!params.prompt?.trim()) throw new Error(tSettingsUi("prompt is required for add"));
		const job = await runtime.createSchedule({
			schedule: params.schedule,
			prompt: params.prompt,
			...(params.label === undefined ? {} : { label: params.label }),
			...(params.deliveryMode === undefined ? {} : { deliveryMode: params.deliveryMode }),
		});
		const message = tSettingsUi("Scheduled prompt created (follows this session's lifecycle): {job}", {
			job: formatCronJobSummary(job),
		});
		return { content: [{ type: "text", text: message }], details: { op: "add", job, message } };
	}

	async #list(runtime: SessionScheduleRuntime): Promise<AgentToolResult<CronToolDetails>> {
		const jobs = await runtime.list({ includeInactive: true, source: "cron" });
		if (jobs.length === 0) {
			const message = tSettingsUi("No scheduled prompts.");
			return { content: [{ type: "text", text: message }], details: { op: "list", jobs: [], message } };
		}
		const message = jobs.map(formatCronJobSummary).join("\n");
		return { content: [{ type: "text", text: message }], details: { op: "list", jobs, message } };
	}

	async #manage(runtime: SessionScheduleRuntime, params: CronToolInput): Promise<AgentToolResult<CronToolDetails>> {
		if (!params.jobId) throw new Error(tSettingsUi("jobId is required for {op}", { op: params.op }));
		const job = await runtime.manageSchedule(params.jobId, params.op);
		if (!job) throw new Error(tSettingsUi("Schedule not found: {id}", { id: params.jobId }));
		const message = formatCronJobSummary(job);
		return { content: [{ type: "text", text: message }], details: { op: params.op, job, message } };
	}

	async #update(runtime: SessionScheduleRuntime, params: CronToolInput): Promise<AgentToolResult<CronToolDetails>> {
		if (!params.jobId) throw new Error(tSettingsUi("jobId is required for update"));
		if (!params.schedule?.trim()) throw new Error(tSettingsUi("schedule is required for update"));
		const job = await runtime.updateSchedule({
			id: params.jobId,
			schedule: params.schedule,
			...(params.prompt === undefined ? {} : { prompt: params.prompt }),
			...(params.label === undefined ? {} : { label: params.label }),
			...(params.deliveryMode === undefined ? {} : { deliveryMode: params.deliveryMode }),
		});
		const message = formatCronJobSummary(job);
		return { content: [{ type: "text", text: message }], details: { op: "update", job, message } };
	}
}
