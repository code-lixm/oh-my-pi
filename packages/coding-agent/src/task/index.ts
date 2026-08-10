/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Discovers agent definitions from:
 *   - Bundled agents (shipped with omp-coding-agent)
 *   - ~/.omp/agent/agents/*.md (user-level)
 *   - .omp/agents/*.md (project-level)
 *
 * Supports:
 *   - Single agent spawn per call (parallelism = parallel task calls)
 *   - Batch spawning + shared context per call when `task.batch` is enabled
 *   - Background execution through AsyncJobManager when `async.enabled` is enabled
 *   - Progress tracking via JSON events
 *   - Session artifacts for debugging
 */
import path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { $env, logger, prompt } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "..";
import { tSettingsUi } from "../i18n/settings-locale";
import type { Theme } from "../modes/theme/theme";
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import subagentUserPromptTemplateZh from "../prompts/system/subagent-user-prompt.zh-CN.md" with { type: "text" };
import taskDescriptionTemplate from "../prompts/tools/task.md" with { type: "text" };
import taskDescriptionTemplateZh from "../prompts/tools/task.zh-CN.md" with { type: "text" };
import taskAsyncContractTemplate from "../prompts/tools/task-async-contract.md" with { type: "text" };
import taskSummaryTemplate from "../prompts/tools/task-summary.md" with { type: "text" };
import taskSummaryTemplateZh from "../prompts/tools/task-summary.zh-CN.md" with { type: "text" };
import { TASK_EFFORTS, type TaskEffort } from "../thinking";
import { truncateForPrompt } from "../tools/approval";
import { isIrcEnabled } from "../tools/hub";
import { formatBytes, formatDuration } from "../tools/render-utils";
import { isReadOnlyAgent } from "./read-only-policy";
import { isScoutSpawnable, resolveSpawnPolicy } from "./spawn-policy";
import {
	type AgentDefinition,
	type AgentProgress,
	canSpawnAtDepth,
	getTaskSchema,
	type SingleResult,
	type TaskItem,
	type TaskParams,
	type TaskToolDetails,
	type TaskToolSchemaInstance,
} from "./types";
// Import review tools for side effects (registers subagent tool handlers)
import "../tools/review";
import type { AsyncJobManager } from "../async";
import { hasResolvableTranscript } from "../internal-urls/registry-helpers";
import { selectPrompt } from "../prompts/prompt-locale";
import { AgentRegistry } from "../registry/agent-registry";
import { type DiscoveryResult, discoverAgents } from "./discovery";
import { generateTaskName } from "./name-generator";
import { AgentOutputManager } from "./output-manager";
import { mapWithConcurrencyLimitAllSettled } from "./parallel";
import { renderResult, renderCall as renderTaskCall } from "./render";
import { repairTaskParams } from "./repair-args";
import { resolveEffectiveSubagentPolicy, runStructuredSubagent, StructuredSubagentError } from "./structured-subagent";

function renderSubagentUserPrompt(assignment: string): string {
	return prompt.render(selectPrompt(subagentUserPromptTemplate, subagentUserPromptTemplateZh), {
		assignment: assignment.trim(),
	});
}

function createUsageTotals(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost =
		usage.cost ??
		({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		} satisfies Usage["cost"]);

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
}

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export { AgentOutputManager } from "./output-manager";
export * from "./read-only-policy";
export type {
	AgentDefinition,
	AgentProgress,
	AsyncJobDeliveryStatus,
	SingleResult,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	TaskParams,
	TaskToolDetails,
} from "./types";
export {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	taskSchema,
} from "./types";

/**
 * Preview text for a child result. Falls back to "(no output)" — annotated
 * with the request count when the child actually did work, so the parent can
 * tell a no-op child from one that burned requests before being cancelled.
 */
export function formatResultOutputFallback(result: Pick<SingleResult, "output" | "stderr" | "requests">): string {
	const base = result.output.trim() || result.stderr.trim();
	if (base) return base;
	return result.requests > 0 ? `(no output) after ${result.requests} req` : "(no output)";
}

interface TaskDescriptionOptions {
	agents: AgentDefinition[];
	isolationEnabled: boolean;
	applyIsolatedChanges: boolean;
	disabledAgents: string[];
	batchEnabled: boolean;
	effortEnabled: boolean;
	asyncEnabled: boolean;
	ircEnabled: boolean;
	parentSpawns: string;
}

/** Render the tool description from a cached agent list and current settings. */
function renderDescription(options: TaskDescriptionOptions): string {
	const spawnPolicy = resolveSpawnPolicy(options.parentSpawns);
	const spawningDisabled = !spawnPolicy.enabled;
	let filteredAgents =
		options.disabledAgents.length > 0
			? options.agents.filter(agent => !options.disabledAgents.includes(agent.name))
			: options.agents;
	if (spawningDisabled) {
		filteredAgents = [];
	} else if (spawnPolicy.allowedAgents !== null) {
		const allowed = new Set(spawnPolicy.allowedAgents);
		filteredAgents = filteredAgents.filter(agent => allowed.has(agent.name));
	}
	const renderedAgents = filteredAgents.map(agent => ({
		name: agent.name,
		description: agent.description,
		readOnly: isReadOnlyAgent(agent),
		blocking: agent.blocking === true,
	}));
	const scoutAvailable = isScoutSpawnable(options.disabledAgents, options.parentSpawns);
	return prompt.render(selectPrompt(taskDescriptionTemplate, taskDescriptionTemplateZh), {
		agents: renderedAgents,
		scoutAvailable,
		spawningDisabled,
		defaultAgent: spawnPolicy.defaultAgent,
		isolationEnabled: options.isolationEnabled,
		applyIsolatedChanges: options.applyIsolatedChanges,
		batchEnabled: options.batchEnabled,
		effortEnabled: options.effortEnabled,
		asyncEnabled: options.asyncEnabled,
		hasBlockingAgents: renderedAgents.some(agent => agent.blocking),
		ircEnabled: options.ircEnabled,
	});
}

function createTaskModeError(text: string): AgentToolResult<TaskToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
	};
}

/**
 * Reject legacy fields and shape/configuration combinations the current tool
 * cannot accept. `outputSchema` is a first-class per-spawn field; stale
 * `schema` remains an eval-only alias and is rejected.
 */
function validateShapeParams(batchEnabled: boolean, params: TaskParams): string | undefined {
	if (Object.hasOwn(params, "schema")) {
		return tSettingsUi(
			"The task tool uses `outputSchema`; rename the stale `schema` field. In `task.batch`, each task entry uses `outputSchema`; flat task calls use top-level `outputSchema`. Otherwise rely on the selected agent definition's `output` schema or the inherited session schema; workflows needing ad-hoc structured output use eval `agent(prompt, schema)`.",
		);
	}
	if (!batchEnabled) {
		const disallowed = (["tasks", "context"] as const).filter(field => params[field] !== undefined);
		if (disallowed.length > 0) {
			return tSettingsUi(
				"task.batch is disabled, so the task tool does not accept {fields}. Spawn one agent per call with `task`, or enable the task.batch setting.",
				{ fields: disallowed.map(f => `\`${f}\``).join(" or ") },
			);
		}
	}
	return undefined;
}

/**
 * Validate the spawn parameter contract against the wire shapes. With
 * `task.batch` the model-facing shape is `{ context, tasks[] }` — `tasks`
 * non-empty with per-item `task` instructions and unique names, `context`
 * non-empty, no top-level `task` alongside. The flat `{ agent?, ...item }`
 * form stays accepted at runtime under either setting (internal callers, stale
 * transcripts). Missing `agent` values resolve against the session spawn
 * policy later, in `spawnParamsFor`. Returns a problem description, or
 * undefined when valid.
 */

/** Reject an out-of-range `effort` selector on internal/stale-transcript calls that bypass the wire schema. */
function validateEffort(effort: TaskEffort | undefined, label: string): string | undefined {
	if (effort === undefined || TASK_EFFORTS.includes(effort)) return undefined;
	return `${label} has an invalid \`effort\` value ${JSON.stringify(effort)}. Use "lo", "med", or "hi".`;
}

function validateSpawnParams(params: TaskParams, batchEnabled: boolean): string | undefined {
	const hasTask = typeof params.task === "string" && params.task.trim() !== "";
	const tasks = params.tasks;
	if (batchEnabled && tasks !== undefined) {
		if (!Array.isArray(tasks) || tasks.length === 0) {
			return tSettingsUi("Missing `tasks`. Provide at least one task item ({ name?, agent?, task }).");
		}
		if (hasTask) {
			return tSettingsUi("Top-level `task` is not part of the batch shape. Put the work in `tasks[]` items.");
		}
		for (let i = 0; i < tasks.length; i++) {
			const item = tasks[i];
			if (!item || typeof item.task !== "string" || item.task.trim() === "") {
				return tSettingsUi(
					"Task {index}{nameSuffix} is missing `task`. Every task needs complete, self-contained instructions.",
					{ index: i + 1, nameSuffix: item?.name ? ` (\`${item.name}\`)` : "" },
				);
			}
			const effortError = validateEffort(item.effort, `Task ${i + 1}${item.name ? ` (\`${item.name}\`)` : ""}`);
			if (effortError) return effortError;
		}
		const seen = new Map<string, string>();
		for (const item of tasks) {
			const name = item.name?.trim();
			if (!name) continue;
			const key = name.toLowerCase();
			const existing = seen.get(key);
			if (existing !== undefined) {
				return tSettingsUi(
					"Duplicate task name {name}. Provided names must be unique within a call (case-insensitive).",
					{ name: existing === name ? `\`${name}\`` : `\`${existing}\` / \`${name}\`` },
				);
			}
			seen.set(key, name);
		}
		if (typeof params.context !== "string" || params.context.trim() === "") {
			return tSettingsUi(
				"Missing `context`. Provide the shared background for this batch — goal, constraints, and any contract the tasks share.",
			);
		}
		return undefined;
	}
	if (!hasTask) {
		return batchEnabled
			? tSettingsUi("Missing `tasks`. Provide a `tasks` array (one subagent per item) with a shared `context`.")
			: tSettingsUi("Missing `task`. Provide complete, self-contained instructions for the agent.");
	}
	return validateEffort(params.effort, "The call");
}

/**
 * Normalize a validated call into its spawn list: the `tasks[]` batch when
 * provided, otherwise the single top-level spawn. The flat form's `isolated`
 * flag is only materialized when the caller sent one — `#runSpawn`
 * distinguishes an absent key from an explicit value.
 */
function resolveSpawnItems(params: TaskParams): TaskItem[] {
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		return params.tasks;
	}
	const item: TaskItem = { name: params.name, agent: params.agent, task: params.task };
	if ("outputSchema" in params) item.outputSchema = params.outputSchema;
	if ("schemaMode" in params) item.schemaMode = params.schemaMode;
	if ("effort" in params) item.effort = params.effort;
	if ("isolated" in params) item.isolated = params.isolated;
	return [item];
}

/**
 * Per-spawn params handed to the executor path: top-level call fields with the
 * item's identity substituted in. Each spawn's `agent` resolves here —
 * the item's own value, else `defaultAgent` from the session spawn policy.
 * `tasks` never leaks into a spawn; the shared `context` rides along
 * unchanged. Keys are only materialized when present — `#runSpawn`
 * distinguishes an absent `isolated` from an explicit one. The item's
 * `isolated` (batch form) wins over the top-level flag (flat form).
 */
function spawnParamsFor(params: TaskParams, item: TaskItem, defaultAgent: string): TaskParams {
	const spawn: TaskParams = { agent: item.agent?.trim() || defaultAgent };
	if (item.name !== undefined) spawn.name = item.name;
	if (item.task !== undefined) spawn.task = item.task;
	if (params.context !== undefined) spawn.context = params.context;
	if ("outputSchema" in item) spawn.outputSchema = item.outputSchema;
	if ("schemaMode" in item) spawn.schemaMode = item.schemaMode;
	if ("effort" in item) spawn.effort = item.effort;
	if (item.isolated !== undefined) {
		spawn.isolated = item.isolated;
	} else if ("isolated" in params) {
		spawn.isolated = params.isolated;
	}
	return spawn;
}

/** One sync-executed spawn: its item, position in the original call, and (for mixed calls) a pre-claimed agent id. */
interface SyncSpawnRef {
	item: TaskItem;
	index: number;
	preAllocatedId?: string;
	/** Queue time retained when this sync spawn shares a mixed task call. */
	startedAtMs?: number;
}

/** Merged view of a sync spawn set's payloads: joined text plus flattened results/usage/paths. */
interface MergedSyncPayloads {
	contentParts: string[];
	results: SingleResult[];
	usage?: Usage;
	outputPaths?: string[];
	projectAgentsDir: string | null;
}

/**
 * Merge per-spawn sync payloads into one result view. `index` is each spawn's
 * position in the original call so batch rows keep stable ordering; a missing
 * payload (cancelled before start) becomes an explanatory content line.
 */
function mergeSyncPayloads(
	spawns: SyncSpawnRef[],
	payloads: (AgentToolResult<TaskToolDetails> | undefined)[],
): MergedSyncPayloads {
	const results: SingleResult[] = [];
	const contentParts: string[] = [];
	const outputPaths: string[] = [];
	const usageTotals = createUsageTotals();
	let hasUsage = false;
	let projectAgentsDir: string | null = null;
	for (let position = 0; position < spawns.length; position++) {
		const payload = payloads[position];
		const { item, index } = spawns[position];
		if (!payload) {
			contentParts.push(`Task ${item.name?.trim() || `#${index + 1}`}: cancelled before start.`);
			continue;
		}
		projectAgentsDir ??= payload.details?.projectAgentsDir ?? null;
		const text = payload.content.find(part => part.type === "text")?.text;
		if (text) contentParts.push(text);
		for (const result of payload.details?.results ?? []) {
			results.push({ ...result, index });
			if (result.usage) {
				addUsageTotals(usageTotals, result.usage);
				hasUsage = true;
			}
			if (result.outputPath) outputPaths.push(result.outputPath);
		}
	}
	return {
		contentParts,
		results,
		usage: hasUsage ? usageTotals : undefined,
		outputPaths: outputPaths.length > 0 ? outputPaths : undefined,
		projectAgentsDir,
	};
}

/** Generic worker agent types; several in one call usually means a more specific type exists. */
const GENERIC_SPAWN_AGENTS: ReadonlySet<string> = new Set(["task", "sonic"]);

/**
 * Advisory — never a rejection — nudging the spawner toward tailored
 * specific agent types when one call resolves ≥2 items to a generic
 * `task`/`sonic` worker and the spawner still holds spawn capacity
 * (DepthCapacity: it currently has the `task` tool). `agentNames` are the
 * per-item resolved agent types. Returns undefined when no nudge applies.
 */
export function buildSpecializationAdvisory(
	agentNames: string[],
	depthCapacity: boolean,
	scoutAvailable = true,
): string | undefined {
	if (!depthCapacity) return undefined;
	const generics = agentNames.filter(name => GENERIC_SPAWN_AGENTS.has(name));
	if (generics.length < 2) return undefined;
	const specialist = scoutAvailable
		? `Check the agent list for a closer specialist type — e.g. read-only research belongs on ` +
			`\`agent: "scout"\`, which runs on a faster model.`
		: `Check the agent list for a closer specialist type.`;
	return `Tip: this call spawned ${generics.length} generic \`${generics[0]}\` workers. ${specialist}`;
}

/**
 * Suggestion — never a rejection — nudging the spawner to coordinate via the
 * hub when one call creates ≥2 live siblings and it still holds spawn
 * capacity. Returns undefined when there is nothing to coordinate or peer
 * messaging is unavailable.
 */
export function buildCoordinationAdvisory(
	items: TaskItem[],
	depthCapacity: boolean,
	ircEnabled: boolean,
): string | undefined {
	if (!depthCapacity || !ircEnabled || items.length < 2) return undefined;
	return tSettingsUi(
		"{count} subagents are running in parallel. Results return automatically; do not poll.\nWork may overlap? Use `hub` `send` so the relevant agents confirm ownership first.",
		{ count: items.length },
	);
}

/**
 * Compose the non-blocking advisory appended to a `task` result: the
 * specialization nudge (from the per-item resolved agent types), plus — only
 * when some spawns keep running after this call (`willRunAsync`) — the
 * coordination suggestion over those still-live spawns (`items`). Coordination
 * is gated on async because a sync spawn has already finished by the time the
 * call returns, so a "coordinate while they run" hint would misfire. Returns
 * undefined when neither applies.
 */
export function composeSpawnAdvisory(args: {
	agents: string[];
	items: TaskItem[];
	depthCapacity: boolean;
	ircEnabled: boolean;
	willRunAsync: boolean;
	scoutAvailable?: boolean;
}): string | undefined {
	return (
		[
			buildSpecializationAdvisory(args.agents, args.depthCapacity, args.scoutAvailable),
			args.willRunAsync ? buildCoordinationAdvisory(args.items, args.depthCapacity, args.ircEnabled) : undefined,
		]
			.filter(Boolean)
			.join("\n\n") || undefined
	);
}

/** Sentinel for async jobs whose subagent finished with a failing result; progress is already updated. */
class TaskJobError extends Error {}

/**
 * Process-level create-time discovery memo and published reload snapshots,
 * keyed by resolved cwd.
 *
 * `TaskTool.create` runs for every (sub)agent session in this process and the
 * walk-up + plugin-registry scan in `discoverAgents` is identical for a given
 * cwd, so repeat creations reuse the first scan. Explicit plugin reloads
 * replace the matching snapshot so already-created tools advertise the latest
 * definitions. Execution-time discovery (`#runSpawn`) intentionally stays
 * fresh. The memo also tracks the live `discoverAgents` binding: test spies
 * swap that binding, which invalidates both caches automatically.
 */
const discoveryMemo = new Map<string, Promise<DiscoveryResult>>();
const discoverySnapshots = new Map<string, AgentDefinition[]>();
let discoveryMemoFn: typeof discoverAgents | undefined;

function discoverAgentsForCreate(cwd: string): Promise<DiscoveryResult> {
	const fn = discoverAgents;
	if (discoveryMemoFn !== fn) {
		discoveryMemoFn = fn;
		discoveryMemo.clear();
		discoverySnapshots.clear();
	}
	const key = path.resolve(cwd);
	let pending = discoveryMemo.get(key);
	if (!pending) {
		pending = fn(cwd);
		discoveryMemo.set(key, pending);
		pending.catch(() => {
			if (discoveryMemo.get(key) === pending) discoveryMemo.delete(key);
		});
	}
	return pending;
}

/** Rescan one cwd and publish its definitions to existing and future task tools. */
export async function refreshAgentDiscovery(cwd: string): Promise<void> {
	const key = path.resolve(cwd);
	discoveryMemo.delete(key);
	const pending = discoverAgentsForCreate(cwd);
	const { agents } = await pending;
	if (discoveryMemo.get(key) === pending) {
		discoverySnapshots.set(key, agents);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Each call spawns one subagent — or, with `task.batch`, one per `tasks[]`
 * item. When `async.enabled` is on, spawns run as AsyncJobManager jobs; when
 * disabled, the tool blocks until every spawn finishes.
 */
export class TaskTool implements AgentTool<TaskToolSchemaInstance, TaskToolDetails, Theme> {
	readonly name = "task";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<TaskParams>;
		const lines: string[] = [];
		if (typeof params.agent === "string") {
			lines.push(`Agent: ${truncateForPrompt(params.agent)}`);
		}
		if (typeof params.name === "string" && params.name.trim()) {
			lines.push(`Name: ${truncateForPrompt(params.name)}`);
		}
		if (typeof params.task === "string") {
			lines.push(`Task:\n${truncateForPrompt(params.task)}`);
		}
		if (typeof params.context === "string" && params.context.trim()) {
			lines.push(`Context:\n${truncateForPrompt(params.context)}`);
		}
		const tasks: unknown[] = Array.isArray(params.tasks) ? params.tasks : [];
		if (tasks.length > 0) {
			const defaultAgent = resolveSpawnPolicy(this.session.getSessionSpawns()).defaultAgent;
			const effectiveAgent = (item: unknown): string => {
				if (item && typeof item === "object" && "agent" in item) {
					const agent = item.agent;
					if (typeof agent === "string" && agent.trim()) return agent.trim();
				}
				return defaultAgent;
			};
			const agentCounts = new Map<string, number>();
			for (const item of tasks) {
				const agent = effectiveAgent(item);
				agentCounts.set(agent, (agentCounts.get(agent) ?? 0) + 1);
			}
			const agentSummary = [...agentCounts].map(([agent, count]) => `${agent} ×${count}`).join(", ");
			lines.push(`Batch agents: ${truncateForPrompt(agentSummary)}`);

			const firstTask = tasks[0];
			if (firstTask && typeof firstTask === "object") {
				if ("name" in firstTask && typeof firstTask.name === "string" && firstTask.name.trim()) {
					lines.push(`Name: ${truncateForPrompt(firstTask.name)}`);
				}
				lines.push(`Agent: ${truncateForPrompt(effectiveAgent(firstTask))}`);
				if ("task" in firstTask && typeof firstTask.task === "string") {
					lines.push(`Task:\n${truncateForPrompt(firstTask.task)}`);
				}
			}
			if (tasks.length > 1) {
				lines.push(`+${tasks.length - 1} more task${tasks.length === 2 ? "" : "s"}`);
			}
		}
		return lines;
	};
	readonly label = "Task";
	readonly summary = "Spawn subagents to complete delegated tasks";
	readonly strict = false;
	readonly loadMode = "essential";
	// Arktype validates model calls against the active wire schema, but the flat
	// single-spawn schema carries `"+": "delete"`: a batch `{ context, tasks[] }`
	// payload has those keys stripped, then fails on the now-missing `task` with
	// the misleading `task must be a string (was missing)`. That preempts the
	// tool's own actionable shape checks (`validateShapeParams` /
	// `validateSpawnParams`), which never run. Lenient validation forwards the
	// raw args to `execute()` on any arktype failure so those checks surface the
	// real reason ("enable task.batch, or use the flat `task` shape"). Valid
	// calls still normalize through arktype; `execute()` resolves `agent`
	// defaults independently, so the success path is unchanged.
	readonly lenientArgValidation = true;
	readonly renderResult = renderResult;
	// Suppress the streaming call preview once a (partial or final) result exists
	// so the task renders as ONE block that transitions in place — not a pending
	// call frame stacked above the result frame. Mirrors `taskToolRenderer`.
	readonly mergeCallAndResult = true;
	readonly #discoveredAgents: AgentDefinition[];
	readonly #blockedAgent: string | undefined;

	get parameters(): TaskToolSchemaInstance {
		const planMode = this.session.getPlanModeState?.()?.enabled === true;
		const isolationEnabled = !planMode && this.session.settings.get("task.isolation.mode") !== "none";
		const defaultAgent = resolveSpawnPolicy(this.session.getSessionSpawns()).defaultAgent;
		return getTaskSchema({
			isolationEnabled,
			batchEnabled: this.#isBatchEnabled(),
			effortEnabled: this.session.settings.get("task.enableEffort"),
			defaultAgent,
		});
	}

	renderCall(args: unknown, options: Parameters<typeof renderTaskCall>[1], theme: Theme) {
		return renderTaskCall(repairTaskParams(args as TaskParams), options, theme);
	}

	/** Dynamic description that reflects current task settings. */
	get description(): string {
		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		const planMode = this.session.getPlanModeState?.()?.enabled === true;
		const isolationMode = this.session.settings.get("task.isolation.mode");
		return renderDescription({
			agents: discoverySnapshots.get(path.resolve(this.session.cwd)) ?? this.#discoveredAgents,
			isolationEnabled: !planMode && isolationMode !== "none",
			applyIsolatedChanges: this.session.settings.get("task.isolation.apply"),
			disabledAgents,
			batchEnabled: this.#isBatchEnabled(),
			effortEnabled: this.session.settings.get("task.enableEffort"),
			asyncEnabled: this.session.settings.get("async.enabled"),
			ircEnabled: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
			parentSpawns: this.session.getSessionSpawns() ?? "*",
		});
	}
	private constructor(
		private readonly session: ToolSession,
		discoveredAgents: AgentDefinition[],
	) {
		this.#blockedAgent = $env.PI_BLOCKED_AGENT;
		this.#discoveredAgents = discoveredAgents;
	}

	#isBatchEnabled(): boolean {
		return this.session.settings.get("task.batch");
	}

	#withRunnableAgentSuspended<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.session.withRunnableAgentSuspended?.(run, signal) ?? run();
	}

	/**
	 * Resolve the shared policy before detached work exists. The resulting
	 * policy intentionally stays local: executor dispatch resolves again from
	 * normalized task params rather than smuggling internal policy over the
	 * task wire contract.
	 */
	#resolveSpawnPreflight(params: TaskParams) {
		return resolveEffectiveSubagentPolicy({
			session: this.session,
			invocationKind: "task",
			assignment: (params.task ?? "").trim(),
			context: this.#isBatchEnabled() ? params.context?.trim() || undefined : undefined,
			agent: params.agent,
			...(Object.hasOwn(params, "outputSchema") ? { outputSchema: params.outputSchema } : {}),
			...(Object.hasOwn(params, "schemaMode") ? { schemaMode: params.schemaMode } : {}),
			...(params.effort !== undefined ? { effort: params.effort } : {}),
			...("isolated" in params ? { isolation: { requested: params.isolated } } : {}),
			blockedAgent: this.#blockedAgent,
			enableLsp: (this.session.enableLsp ?? true) && this.session.settings.get("task.enableLsp"),
			enableIrc: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
			maxRuntimeMs: this.session.settings.get("task.maxRuntimeMs"),
		});
	}

	/**
	 * Create a TaskTool instance with async agent discovery.
	 */
	static async create(session: ToolSession): Promise<TaskTool> {
		const { agents } = await discoverAgentsForCreate(session.cwd);
		return new TaskTool(session, agents);
	}

	async execute(
		toolCallId: string,
		rawParams: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const params = repairTaskParams(rawParams as TaskParams);
		// Schema defaults fill `agent` for model calls, but internal callers
		// and stale transcripts can bypass arktype. `spawnParamsFor` resolves each
		// item's agent type against the session's actual default agent.
		const defaultAgent = resolveSpawnPolicy(this.session.getSessionSpawns()).defaultAgent;
		const batchEnabled = this.#isBatchEnabled();
		const validationError = validateShapeParams(batchEnabled, params) ?? validateSpawnParams(params, batchEnabled);
		if (validationError) {
			return createTaskModeError(validationError);
		}

		const spawnItems = resolveSpawnItems(params);
		const normalizedSpawnParams = spawnItems.map(item => spawnParamsFor(params, item, defaultAgent));
		const resolvedAgents = normalizedSpawnParams.map(spawn => spawn.agent ?? defaultAgent);
		// Resolve every item before choosing an execution path. No executor or
		// job manager may observe a batch unless every effective policy is valid.
		const preflights = await Promise.all(
			normalizedSpawnParams.map(async spawn => {
				try {
					return { policy: await this.#resolveSpawnPreflight(spawn) };
				} catch (error) {
					return { error: error instanceof StructuredSubagentError ? error.message : String(error) };
				}
			}),
		);
		const preflightFailures = preflights
			.map((preflight, index) => ("error" in preflight ? { index, error: preflight.error } : undefined))
			.filter((failure): failure is { index: number; error: string } => failure !== undefined);
		if (preflightFailures.length > 0) {
			if (!batchEnabled) {
				return createTaskModeError(`Task execution failed: ${preflightFailures[0]!.error}`);
			}
			return createTaskModeError(
				preflightFailures
					.map(({ index, error }) => {
						const item = spawnItems[index]!;
						return `Task ${item.name?.trim() || `#${index + 1}`} failed preflight: ${error}`;
					})
					.join("\n"),
			);
		}
		const policies = preflights.map(preflight => preflight.policy!);
		const itemBlocking = policies.map(policy => policy.effectiveAgent.blocking === true);

		// Execution mode is per item: an item whose agent type declares
		// `blocking: true` runs inline on this turn (the parent waits on its
		// result); every other item becomes a background job when async
		// execution is available.
		const asyncEnabled = this.session.settings.get("async.enabled");
		const manager = asyncEnabled ? this.session.asyncJobManager : undefined;
		const asyncItems = manager ? spawnItems.filter((_, index) => !itemBlocking[index]) : [];
		const depthCapacity = canSpawnAtDepth(
			this.session.settings.get("task.maxRecursionDepth") ?? 2,
			this.session.taskDepth ?? 0,
		);
		const ircEnabled = isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0);

		// AgentRegistry is process-global while output managers are session-scoped.
		// Seed the session allocator from every live process address before either
		// sync or async allocation so a same-named child cannot overwrite Hub state.
		let outputManager = this.session.agentOutputManager;
		if (!outputManager) {
			outputManager = new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
			this.session.agentOutputManager = outputManager;
		}
		await outputManager.reserve(
			AgentRegistry.global()
				.list()
				.map(ref => ref.id),
		);

		if (!manager || asyncItems.length === 0) {
			// Sync fallback: async execution disabled, orphaned host that never
			// wired a job manager, or every item's agent type declares
			// `blocking: true`.
			if (asyncEnabled && !this.session.asyncJobManager) {
				logger.warn("task: no AsyncJobManager registered; falling back to sync execution");
			}
			const advisory = this.session.suppressSpawnAdvisory
				? undefined
				: composeSpawnAdvisory({
						agents: resolvedAgents,
						items: asyncItems,
						depthCapacity,
						ircEnabled,
						willRunAsync: false,
						scoutAvailable: isScoutSpawnable(
							this.session.settings.get("task.disabledAgents") as string[] | undefined,
							this.session.getSessionSpawns?.() ?? "*",
						),
					});
			const result = await this.#withRunnableAgentSuspended(
				() =>
					this.#executeSyncFanout(
						toolCallId,
						params,
						spawnItems.map((item, index) => ({ item, index })),
						defaultAgent,
						signal,
						onUpdate,
					),
				signal,
			);
			if (!advisory) return result;
			let appended = false;
			const content = result.content.map(part => {
				if (!appended && part.type === "text" && typeof part.text === "string") {
					appended = true;
					return { ...part, text: `${part.text}\n\n${advisory}` };
				}
				return part;
			});
			if (!appended) content.push({ type: "text", text: advisory });
			return { ...result, content };
		}

		// Coordination only makes sense for spawns that keep running after this
		// call returns (the async subset). Blocking items have already completed
		// by then, so a "coordinate while they run" hint would misfire.
		const advisory = this.session.suppressSpawnAdvisory
			? undefined
			: composeSpawnAdvisory({
					agents: resolvedAgents,
					items: asyncItems,
					depthCapacity,
					ircEnabled,
					willRunAsync: asyncItems.length > 0,
					scoutAvailable: isScoutSpawnable(
						this.session.settings.get("task.disabledAgents") as string[] | undefined,
						this.session.getSessionSpawns?.() ?? "*",
					),
				});
		// Returns a fresh result (copied content array, copied text part) rather
		// than mutating the caller's — task results are short-lived here, but an
		// in-place edit on a shared/cached AgentToolResult would be a hidden trap.
		const withAdvisory = (result: AgentToolResult<TaskToolDetails>): AgentToolResult<TaskToolDetails> => {
			if (!advisory) return result;
			let appended = false;
			const content = result.content.map(part => {
				if (!appended && part.type === "text" && typeof part.text === "string") {
					appended = true;
					return { ...part, text: `${part.text}\n\n${advisory}` };
				}
				return part;
			});
			if (!appended) content.push({ type: "text", text: advisory });
			return { ...result, content };
		};
		if (asyncItems.length === 0) {
			return withAdvisory(
				await this.#withRunnableAgentSuspended(
					() =>
						this.#executeSyncFanout(
							toolCallId,
							params,
							spawnItems.map((item, index) => ({ item, index })),
							defaultAgent,
							signal,
							onUpdate,
						),
					signal,
				),
			);
		}

		const callStartedAt = Date.now();
		const spawns: Array<{
			agentId: string;
			item: TaskItem;
			index: number;
			blocking: boolean;
			progress: AgentProgress;
		}> = [];
		for (const [index, item] of spawnItems.entries()) {
			const agentType = resolvedAgents[index]!;
			const policy = policies[index]!;
			const agentSource = policy.agent.source;
			const agentId = await outputManager.allocate(item.name?.trim() || generateTaskName());
			const assignment = (item.task ?? "").trim();
			const queuedAtMs = Date.now();
			spawns.push({
				agentId,
				item,
				index,
				blocking: itemBlocking[index],
				progress: {
					index,
					id: agentId,
					agent: agentType,
					agentSource,
					modelRole: policy.modelRole,
					status: "pending",
					startedAtMs: queuedAtMs,
					activity: {
						phase: "queued",
						label: "Queued",
						phaseStartedAtMs: queuedAtMs,
						lastActivityAtMs: queuedAtMs,
					},
					task: renderSubagentUserPrompt(assignment),
					assignment,
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 0,
					tokens: 0,
					cost: 0,
					durationMs: 0,
				},
			});
		}
		const asyncSpawns = spawns.filter(spawn => !spawn.blocking);
		const syncSpawns = spawns.filter(spawn => spawn.blocking);
		const agentLabel = [...new Set(asyncSpawns.map(spawn => spawn.progress.agent))].join(", ");

		// Aggregate state for the one tool call. Async spawns report into the
		// shared progress snapshot through their jobs: the async half stays
		// "running" until every job settles, then turns "failed" if any spawn
		// failed. Blocking spawns run inline below and land in `results` before
		// the call returns, so post-return job updates never drop them.
		let settledCount = 0;
		let failedCount = 0;
		let primaryJobId = asyncSpawns[0].agentId;
		const syncResults: SingleResult[] = [];
		let syncUsage: Usage | undefined;
		let syncOutputPaths: string[] | undefined;
		let syncProjectAgentsDir: string | null = null;
		const buildAsyncDetails = (): TaskToolDetails => ({
			projectAgentsDir: syncProjectAgentsDir,
			results: [...syncResults],
			totalDurationMs: Date.now() - callStartedAt,
			usage: syncUsage,
			outputPaths: syncOutputPaths,
			progress: spawns.map(spawn => ({ ...spawn.progress })),
			async: {
				state: settledCount < asyncSpawns.length ? "running" : failedCount > 0 ? "failed" : "completed",
				jobId: primaryJobId,
				type: "task",
			},
		});

		const started: Array<{ agentId: string; jobId: string }> = [];
		const failedSchedules: string[] = [];
		for (const spawn of asyncSpawns) {
			try {
				const jobId = this.#registerSpawnJob({
					manager,
					toolCallId,
					spawnParams: spawnParamsFor(params, spawn.item, defaultAgent),
					agentId: spawn.agentId,
					progress: spawn.progress,
					ircEnabled,
					buildDetails: buildAsyncDetails,
					onUpdate,
					onSettled: failed => {
						settledCount += 1;
						if (failed) failedCount += 1;
					},
				});
				if (started.length === 0) primaryJobId = jobId;
				started.push({ agentId: spawn.agentId, jobId });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failedSchedules.push(`${spawn.agentId}: ${message}`);
				spawn.progress.status = "failed";
				const completedAtMs = Date.now();
				spawn.progress.completedAtMs = completedAtMs;
				spawn.progress.durationMs = Math.max(0, completedAtMs - (spawn.progress.startedAtMs ?? completedAtMs));
				settledCount += 1;
				failedCount += 1;
			}
		}

		if (started.length === 0 && syncSpawns.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: tSettingsUi("Failed to start background task job{plural}: {details}", {
							plural: failedSchedules.length === 1 ? "" : "s",
							details: failedSchedules.join("; "),
						}),
					},
				],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: 0,
					progress: spawns.map(spawn => ({ ...spawn.progress })),
				},
			};
		}

		const scheduleFailureSummary =
			failedSchedules.length > 0
				? tSettingsUi(" Failed to schedule {count} spawn{plural}: {details}.", {
						count: failedSchedules.length,
						plural: failedSchedules.length === 1 ? "" : "s",
						details: failedSchedules.join("; "),
					})
				: "";
		const coordinationHint = [
			started.length === 1
				? ircEnabled
					? tSettingsUi(
							"DM `{agentId}` via `hub` send to coordinate while it runs; use `hub` only to inspect (`jobs`), wait, or cancel a stuck task.",
							{ agentId: started[0].agentId },
						)
					: tSettingsUi("Use `hub` to inspect (`jobs`), wait, or cancel a stuck task.")
				: ircEnabled
					? tSettingsUi(
							"DM these ids via `hub` send to coordinate while they run; use `hub` only to inspect (`jobs`), wait, or cancel a stuck task.",
						)
					: tSettingsUi("Use `hub` to inspect (`jobs`), wait, or cancel a stuck task by id."),
			taskAsyncContractTemplate.trim(),
		].join("\n");

		if (syncSpawns.length === 0) {
			if (spawns.length === 1) {
				const { agentId, jobId } = started[0];
				onUpdate?.({
					content: [{ type: "text", text: tSettingsUi("Spawned agent `{agentId}`...", { agentId }) }],
					details: buildAsyncDetails(),
				});
				return withAdvisory({
					content: [
						{
							type: "text",
							text: tSettingsUi(
								"Spawned agent `{agentId}` (job `{jobId}`). Its result auto-delivers on yield unless a settled `hub jobs`/`wait` snapshot consumes it first. {coordinationHint}",
								{ agentId, jobId, coordinationHint },
							),
						},
					],
					details: buildAsyncDetails(),
				});
			}
			const startedListing = started.map(({ agentId, jobId }) => `- \`${agentId}\` (job \`${jobId}\`)`).join("\n");
			onUpdate?.({
				content: [
					{
						type: "text",
						text: tSettingsUi("Spawned {count} agent{plural}...", { count: started.length, plural: "s" }),
					},
				],
				details: buildAsyncDetails(),
			});
			return withAdvisory({
				content: [
					{
						type: "text",
						text: tSettingsUi(
							"Spawned {count} background agent{plural} using {agentLabel}.{scheduleFailureSummary} Each result auto-delivers on yield unless a settled `hub jobs`/`wait` snapshot consumes it first.\n{startedListing}\n{coordinationHint}",
							{
								count: started.length,
								plural: started.length === 1 ? "" : "s",
								agentLabel,
								scheduleFailureSummary,
								startedListing,
								coordinationHint,
							},
						),
					},
				],
				details: buildAsyncDetails(),
			});
		}

		// Mixed call: the async jobs above already run detached; the blocking
		// subset runs inline and gates the call's return — exactly what each
		// agent type declares (`blocking: true` = the parent waits on it).
		const syncLabel = syncSpawns.map(spawn => `\`${spawn.agentId}\``).join(", ");
		onUpdate?.({
			content: [
				{
					type: "text",
					text: tSettingsUi("Running {syncLabel} inline; {count} background agent{plural} spawned...", {
						syncLabel,
						count: started.length,
						plural: started.length === 1 ? "" : "s",
					}),
				},
			],
			details: buildAsyncDetails(),
		});
		const payloads = await this.#withRunnableAgentSuspended(
			() =>
				this.#runSyncSpawns({
					toolCallId,
					params,
					defaultAgent,
					signal,
					spawns: syncSpawns.map(spawn => ({
						item: spawn.item,
						index: spawn.index,
						preAllocatedId: spawn.agentId,
						startedAtMs: spawn.progress.startedAtMs,
					})),
					onItemProgress: (index, progress) => {
						const spawn = spawns.find(candidate => candidate.index === index);
						if (spawn) spawn.progress = { ...progress, index };
						if (!onUpdate) return;
						onUpdate({
							content: [{ type: "text", text: tSettingsUi("Running {syncLabel} inline...", { syncLabel }) }],
							details: buildAsyncDetails(),
						});
					},
				}),
			signal,
		);
		const merged = mergeSyncPayloads(
			syncSpawns.map(spawn => ({ item: spawn.item, index: spawn.index })),
			payloads,
		);
		syncResults.push(...merged.results);
		syncUsage = merged.usage;
		syncOutputPaths = merged.outputPaths;
		syncProjectAgentsDir = merged.projectAgentsDir;
		// Settle the inline spawns' progress rows from their merged results so
		// post-return job updates carry final statuses, not the last snapshot.
		for (let position = 0; position < syncSpawns.length; position++) {
			const spawn = syncSpawns[position];
			const result = merged.results.find(r => r.id === spawn.agentId);
			if (result) {
				spawn.progress.status = result.aborted
					? "aborted"
					: result.exitCode === 0 && !result.error
						? "completed"
						: "failed";
				spawn.progress.durationMs = result.durationMs;
				const resultText = result.output || result.stderr;
				if (spawn.progress.resultText === undefined && resultText) spawn.progress.resultText = resultText;
			} else {
				spawn.progress.status = payloads[position] ? "failed" : "aborted";
			}
			const completedAtMs = spawn.progress.completedAtMs ?? Date.now();
			spawn.progress.completedAtMs = completedAtMs;
			if (spawn.progress.startedAtMs !== undefined) {
				spawn.progress.durationMs = Math.max(0, completedAtMs - spawn.progress.startedAtMs);
			}
		}

		const spawnedSummary =
			started.length > 0
				? tSettingsUi(
						"Spawned {count} background agent{plural}.{scheduleFailureSummary} Each result auto-delivers on yield unless a settled `hub jobs`/`wait` snapshot consumes it first.\n{startedListing}\n{coordinationHint}",
						{
							count: started.length,
							plural: started.length === 1 ? "" : "s",
							scheduleFailureSummary,
							startedListing: started
								.map(({ agentId, jobId }) => `- \`${agentId}\` (job \`${jobId}\`)`)
								.join("\n"),
							coordinationHint,
						},
					)
				: scheduleFailureSummary.trim();
		const text = [merged.contentParts.join("\n\n"), spawnedSummary]
			.filter(section => section.trim().length > 0)
			.join("\n\n");
		return withAdvisory({
			content: [{ type: "text", text: text.length > 0 ? text : tSettingsUi("No results.") }],
			details: buildAsyncDetails(),
		});
	}

	/**
	 * Register one background job that runs a single spawn to completion and
	 * delivers its yield text. The job body mirrors the sync path; `buildDetails`
	 * supplies the (possibly batch-shared) progress snapshot and `onSettled`
	 * feeds the caller's aggregate counters.
	 */
	#registerSpawnJob(options: {
		manager: AsyncJobManager;
		toolCallId: string;
		spawnParams: TaskParams;
		agentId: string;
		progress: AgentProgress;
		ircEnabled: boolean;
		buildDetails: () => TaskToolDetails;
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>;
		onSettled?: (failed: boolean) => void;
	}): string {
		const { manager, toolCallId, spawnParams, agentId, progress, ircEnabled, buildDetails, onUpdate, onSettled } =
			options;
		const buildFollowUpHint = async (aborted: boolean): Promise<string> => {
			if (aborted) {
				const ref = AgentRegistry.global().get(agentId);
				const transcript = (await hasResolvableTranscript(agentId))
					? tSettingsUi("transcript at history://{agentId}", { agentId })
					: tSettingsUi("transcript unavailable");
				if (ref?.status === "idle" || ref?.status === "parked") {
					const followUp = ircEnabled ? tSettingsUi("message it via `hub` to resume; ") : "";
					return `\n\n${tSettingsUi("{agentId} was stopped but is still resumable — {followUp}{transcript}", { agentId, followUp, transcript })}`;
				}
				return `\n\n${tSettingsUi("{agentId} was aborted — {transcript}", { agentId, transcript })}`;
			}
			const followUp = ircEnabled ? tSettingsUi("message it via `hub` to follow up; ") : "";
			return `\n\n${tSettingsUi("{agentId} is now idle — {followUp}transcript at history://{agentId}", { agentId, followUp })}`;
		};
		return manager.register(
			"task",
			agentId,
			async ({ signal: runSignal, reportProgress, markRunning }) => {
				const startedAt = Date.now();
				const acquiredAt = startedAt;
				if (runSignal.aborted) {
					progress.status = "aborted";
					progress.completedAtMs = startedAt;
					progress.durationMs = Math.max(0, startedAt - (progress.startedAtMs ?? startedAt));
					onSettled?.(true);
					throw new Error(tSettingsUi("Aborted before execution"));
				}
				try {
					markRunning();
					await reportProgress(
						tSettingsUi("Running background task {agentId}...", { agentId }),
						() => buildDetails() as unknown as Record<string, unknown>,
					);
					const forwardSyncProgress: AgentToolUpdateCallback<TaskToolDetails> = async update => {
						if (runSignal.aborted) return;
						const nextProgress = update.details?.progress?.[0];
						if (nextProgress) {
							// Agent progress tracks the child lifecycle independently of the
							// async-job state: leave it queued/pending until the child emits
							// `agent_start`, while retaining the resolved role and live metrics.
							progress.status = nextProgress.status;
							progress.startedAtMs ??= nextProgress.startedAtMs;
							if (nextProgress.completedAtMs === undefined) delete progress.completedAtMs;
							else progress.completedAtMs = nextProgress.completedAtMs;
							progress.durationMs = nextProgress.durationMs;
							progress.modelRole = nextProgress.modelRole ?? progress.modelRole;
							progress.resolvedModel = nextProgress.resolvedModel;
							progress.resolvedModelIsFallback =
								nextProgress.resolvedModelIsFallback ?? progress.resolvedModelIsFallback;
							progress.tokens = nextProgress.tokens;
							progress.requests = nextProgress.requests;
							progress.contextTokens = nextProgress.contextTokens;
							progress.contextWindow = nextProgress.contextWindow;
							progress.cost = nextProgress.cost;
							progress.toolCount = nextProgress.toolCount;
							progress.currentTool = nextProgress.currentTool;
							progress.currentToolArgs = nextProgress.currentToolArgs;
							progress.currentToolStartMs = nextProgress.currentToolStartMs;
							progress.lastIntent = nextProgress.lastIntent;
							progress.recentTools = nextProgress.recentTools.slice();
							progress.recentOutput = nextProgress.recentOutput.slice();
							progress.retryState = nextProgress.retryState;
							progress.retryFailure = nextProgress.retryFailure;
							if (nextProgress.resultText === undefined) delete progress.resultText;
							else progress.resultText = nextProgress.resultText;
							const inflightTaskDetails = nextProgress.inflightTaskDetails;
							progress.inflightTaskDetails = inflightTaskDetails
								? {
										...inflightTaskDetails,
										results: inflightTaskDetails.results.slice(),
										...(inflightTaskDetails.outputPaths
											? { outputPaths: inflightTaskDetails.outputPaths.slice() }
											: {}),
										...(inflightTaskDetails.progress
											? { progress: inflightTaskDetails.progress.slice() }
											: {}),
										...(inflightTaskDetails.async ? { async: { ...inflightTaskDetails.async } } : {}),
									}
								: undefined;
							const activity = nextProgress.activity;
							progress.activity = activity
								? {
										...activity,
										...(activity.progress ? { progress: { ...activity.progress } } : {}),
									}
								: undefined;
						}
						const updateText =
							update.content.find(part => part.type === "text")?.text ??
							tSettingsUi("Running background task {agentId}...", { agentId });
						await reportProgress(updateText, () => buildDetails() as unknown as Record<string, unknown>);
					};
					const result = await this.#executeSync(
						toolCallId,
						spawnParams,
						runSignal,
						forwardSyncProgress,
						agentId,
						progress.index,
						true,
						{ invokedAt: progress.startedAtMs ?? startedAt, acquiredAt },
					);
					const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
					const singleResult = result.details?.results[0];
					// A missing result means the sync path failed at the tool level
					// (results: []) — treat it as a failure, not success.
					const resultFailed =
						!singleResult || singleResult.abortOutcome === "failed" || singleResult.exitCode !== 0;
					progress.status = singleResult?.aborted
						? singleResult.abortOutcome === "failed"
							? "failed"
							: "aborted"
						: resultFailed
							? "failed"
							: "completed";
					const completedAtMs = progress.completedAtMs ?? Date.now();
					progress.completedAtMs = completedAtMs;
					progress.durationMs =
						progress.startedAtMs === undefined
							? (singleResult?.durationMs ?? Math.max(0, completedAtMs - startedAt))
							: Math.max(0, completedAtMs - progress.startedAtMs);
					progress.tokens = singleResult?.tokens ?? 0;
					progress.requests = singleResult?.requests ?? 0;
					progress.contextTokens = singleResult?.contextTokens;
					progress.contextWindow = singleResult?.contextWindow;
					progress.cost = singleResult?.usage?.cost.total ?? 0;
					progress.extractedToolData = singleResult?.extractedToolData;
					progress.retryFailure = singleResult?.retryFailure;
					const resultText = singleResult ? singleResult.output || singleResult.stderr : undefined;
					if (progress.resultText === undefined && resultText) progress.resultText = resultText;
					progress.retryState = undefined;
					progress.modelRole = singleResult?.modelRole ?? progress.modelRole;
					if (singleResult?.resolvedModel) {
						progress.resolvedModel = singleResult.resolvedModel;
						progress.resolvedModelIsFallback =
							singleResult.resolvedModelIsFallback ?? progress.resolvedModelIsFallback;
					} else {
						delete progress.resolvedModel;
						delete progress.resolvedModelIsFallback;
					}
					onSettled?.(resultFailed);
					const statusText = resultFailed
						? tSettingsUi("Background task {agentId} failed.", { agentId })
						: tSettingsUi("Background task {agentId} complete.", { agentId });
					await reportProgress(statusText, () => buildDetails() as unknown as Record<string, unknown>, {
						terminal: true,
					});
					const deliveryText = `${finalText}${await buildFollowUpHint(singleResult?.aborted === true)}`;
					if (resultFailed) {
						// Mark the job itself failed; the failed agent stays interrogable.
						throw new TaskJobError(deliveryText);
					}
					return deliveryText;
				} catch (error) {
					if (error instanceof TaskJobError) {
						throw error;
					}
					progress.status = "failed";
					const completedAtMs = progress.completedAtMs ?? Date.now();
					progress.completedAtMs = completedAtMs;
					progress.durationMs = Math.max(0, completedAtMs - (progress.startedAtMs ?? startedAt));
					onSettled?.(true);
					const statusText = tSettingsUi("Background task {agentId} failed.", { agentId });
					await reportProgress(statusText, () => buildDetails() as unknown as Record<string, unknown>, {
						terminal: true,
					});
					const message = error instanceof Error ? error.message : String(error);
					const hint = AgentRegistry.global().get(agentId) ? await buildFollowUpHint(false) : "";
					throw new TaskJobError(`${message}${hint}`);
				}
			},
			{
				id: agentId,
				agentId,
				description: progress.assignment ?? progress.task,
				queued: true,
				progressKey: toolCallId,
				ownerId: this.session.getAgentId?.() ?? undefined,
				onProgress: (text, details) => {
					const taskDetails = details ? (details as unknown as TaskToolDetails) : buildDetails();
					onUpdate?.({ content: [{ type: "text", text }], details: taskDetails });
				},
			},
		);
	}

	/**
	 * Sync fan-out (async unavailable, or every item's agent type is
	 * `blocking: true`): run every spawn to completion inline and merge the
	 * per-spawn payloads. The root request limiter applies inside each child
	 * session's provider stream rather than around the child lifecycle.
	 */
	async #executeSyncFanout(
		toolCallId: string,
		params: TaskParams,
		spawns: SyncSpawnRef[],
		defaultAgent: string,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		if (spawns.length === 1) {
			const spawn = spawns[0]!;
			const invokedAt = Date.now();
			return this.#executeSync(
				toolCallId,
				spawnParamsFor(params, spawn.item, defaultAgent),
				signal,
				onUpdate,
				spawn.preAllocatedId,
				spawn.index,
				false,
				{ invokedAt, acquiredAt: invokedAt },
			);
		}

		const startTime = Date.now();
		const latestProgress = new Map<number, AgentProgress>();
		const emitCombined = () => {
			onUpdate?.({
				content: [{ type: "text", text: `Running ${spawns.length} agents...` }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: Date.now() - startTime,
					progress: Array.from(latestProgress.entries())
						.sort((a, b) => a[0] - b[0])
						.map(([, progress]) => progress),
				},
			});
		};

		const payloads = await this.#runSyncSpawns({
			toolCallId,
			params,
			defaultAgent,
			signal,
			spawns,
			onItemProgress: (index, progress) => {
				latestProgress.set(index, { ...progress, index });
				emitCombined();
			},
		});

		const merged = mergeSyncPayloads(spawns, payloads);
		return {
			content: [{ type: "text", text: merged.contentParts.join("\n\n") }],
			details: {
				projectAgentsDir: merged.projectAgentsDir,
				results: merged.results,
				totalDurationMs: Date.now() - startTime,
				usage: merged.usage,
				outputPaths: merged.outputPaths,
				progress: Array.from(latestProgress.entries())
					.sort((a, b) => a[0] - b[0])
					.map(([, progress]) => progress),
			},
		};
	}

	/**
	 * Run a set of spawns to completion inline. `preAllocatedId` reuses an id
	 * claimed up front (mixed calls); `index` is each item's position in the
	 * original call so progress rows and merged results keep stable ordering.
	 * Provider requests inside every child share the root request limiter.
	 */
	async #runSyncSpawns(args: {
		toolCallId: string;
		params: TaskParams;
		defaultAgent: string;
		spawns: SyncSpawnRef[];
		signal?: AbortSignal;
		onItemProgress?: (index: number, progress: AgentProgress) => void;
	}): Promise<(AgentToolResult<TaskToolDetails> | undefined)[]> {
		const { toolCallId, params, defaultAgent, spawns, signal, onItemProgress } = args;
		const { results } = await mapWithConcurrencyLimitAllSettled(
			spawns,
			spawns.length,
			async (spawn, _position, workerSignal) => {
				const invokedAt = spawn.startedAtMs ?? Date.now();
				const itemOnUpdate: AgentToolUpdateCallback<TaskToolDetails> | undefined = onItemProgress
					? update => {
							const progress = update.details?.progress?.[0];
							if (progress) onItemProgress(spawn.index, progress);
						}
					: undefined;
				return this.#executeSync(
					toolCallId,
					spawnParamsFor(params, spawn.item, defaultAgent),
					workerSignal,
					itemOnUpdate,
					spawn.preAllocatedId,
					spawn.index,
					false,
					{ invokedAt, acquiredAt: invokedAt },
				);
			},
			signal,
		);
		return results.map((settled, position) => {
			if (!settled) return undefined;
			if (settled.status === "fulfilled") return settled.value;
			const message = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
			const item = spawns[position].item;
			return {
				content: [
					{
						type: "text",
						text: `Task ${item.name?.trim() || `#${spawns[position].index + 1}`} failed: ${message}`,
					},
				],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		});
	}

	/**
	 * Synchronous execution of one spawn. Used as the body of every
	 * async job and directly by the sync fallback (no job manager / blocking
	 * agent) and by in-process callers that need the result inline (e.g. the
	 * commit flow's analyze_files tool).
	 */
	async #executeSync(
		toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedId?: string,
		spawnIndex = 0,
		detached = false,
		launchTiming?: { invokedAt: number; acquiredAt: number },
	): Promise<AgentToolResult<TaskToolDetails>> {
		return this.#runSpawn(toolCallId, params, signal, onUpdate, preAllocatedId, spawnIndex, detached, launchTiming);
	}

	/** Spawn a fresh subagent and run it to completion. */
	async #runSpawn(
		toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedId?: string,
		spawnIndex = 0,
		detached = false,
		launchTiming?: { invokedAt: number; acquiredAt: number },
	): Promise<AgentToolResult<TaskToolDetails>> {
		const startTime = Date.now();
		const assignment = (params.task ?? "").trim();
		const context = this.#isBatchEnabled() ? params.context?.trim() || undefined : undefined;
		let latestProgress: AgentProgress | undefined;
		let releaseRunnable: (() => void) | undefined;
		try {
			const taskRunnableConcurrency = this.session.taskRunnableConcurrency;
			if (preAllocatedId && taskRunnableConcurrency) {
				releaseRunnable = await taskRunnableConcurrency.acquire(preAllocatedId, signal);
			}
			const runnableAcquiredAt = releaseRunnable ? Date.now() : launchTiming?.acquiredAt;
			const execution = await runStructuredSubagent({
				session: this.session,
				invocationKind: "task",
				assignment,
				context,
				agent: params.agent,
				...(Object.hasOwn(params, "outputSchema") ? { outputSchema: params.outputSchema } : {}),
				...(Object.hasOwn(params, "schemaMode") ? { schemaMode: params.schemaMode } : {}),
				...(params.effort !== undefined ? { effort: params.effort } : {}),
				identity: { id: preAllocatedId, label: params.name },
				index: spawnIndex,
				parentToolCallId: toolCallId,
				detached,
				invokedAt: launchTiming?.invokedAt,
				acquiredAt: runnableAcquiredAt,
				...("isolated" in params ? { isolation: { requested: params.isolated } } : {}),
				blockedAgent: this.#blockedAgent,
				enableLsp: (this.session.enableLsp ?? true) && this.session.settings.get("task.enableLsp"),
				enableIrc: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
				maxRuntimeMs: this.session.settings.get("task.maxRuntimeMs"),
				signal,
				onProgress: progress => {
					latestProgress = { ...progress, recentTools: progress.recentTools.slice() };
					onUpdate?.({
						content: [{ type: "text", text: `Running agent ${progress.id}...` }],
						details: {
							projectAgentsDir: null,
							results: [],
							totalDurationMs: Date.now() - startTime,
							progress: [latestProgress],
						},
					});
				},
			});
			return this.#buildResultPayload(
				execution.result,
				execution.policy.discovery.projectAgentsDir,
				Date.now() - startTime,
				execution.mergeSummary,
				latestProgress,
			);
		} catch (error) {
			const message = error instanceof StructuredSubagentError ? error.message : String(error);
			return {
				content: [{ type: "text", text: `Task execution failed: ${message}` }],
				details: {
					projectAgentsDir: null,
					results: [],
					...(latestProgress ? { progress: [latestProgress] } : {}),
					totalDurationMs: Date.now() - startTime,
				},
			};
		} finally {
			releaseRunnable?.();
		}
	}

	#buildResultPayload(
		result: SingleResult,
		projectAgentsDir: string | null,
		totalDurationMs: number,
		mergeSummary: string,
		progress?: AgentProgress,
	): AgentToolResult<TaskToolDetails> {
		const status = result.aborted
			? "cancelled"
			: result.exitCode === 0 && result.error
				? "merge failed"
				: result.exitCode === 0
					? "completed"
					: `failed (exit ${result.exitCode})`;
		const output = formatResultOutputFallback(result);
		const outputCharCount = result.outputMeta?.charCount ?? output.length;
		const fullOutputThreshold = 5000;
		let preview = output;
		let truncated = false;
		if (outputCharCount > fullOutputThreshold) {
			const slice = output.slice(0, fullOutputThreshold);
			const lastNewline = slice.lastIndexOf("\n");
			preview = lastNewline >= 0 ? slice.slice(0, lastNewline) : slice;
			truncated = true;
		}
		// A stopped-but-adopted agent (soft-budget stop) stays messageable; tell
		// the parent so it can resume via irc instead of redoing the work.
		const refStatus = AgentRegistry.global().get(result.id)?.status;
		const resumable = result.aborted && (refStatus === "idle" || refStatus === "parked");
		const failed = !result.aborted && (result.exitCode !== 0 || result.error !== undefined);
		const summary = prompt.render(selectPrompt(taskSummaryTemplate, taskSummaryTemplateZh), {
			agentName: result.agent,
			id: result.id,
			status,
			duration: formatDuration(totalDurationMs),
			abortReason: result.aborted ? result.abortReason : undefined,
			failed,
			resumable,
			preview,
			truncated,
			meta: result.outputMeta
				? {
						lineCount: result.outputMeta.lineCount,
						charSize: formatBytes(result.outputMeta.charCount),
					}
				: undefined,
			mergeSummary,
		});

		return {
			content: [{ type: "text", text: summary }],
			details: {
				projectAgentsDir,
				results: [result],
				totalDurationMs,
				usage: result.usage,
				outputPaths: result.outputPath ? [result.outputPath] : undefined,
				...(progress ? { progress: [progress] } : {}),
			},
		};
	}
}
