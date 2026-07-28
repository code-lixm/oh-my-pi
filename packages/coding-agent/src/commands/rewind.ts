/**
 * `omp rewind` — preview or apply a restore back to a prior workspace checkpoint.
 *
 * Without `--session`, the command operates on the current working tree only
 * (scope `code`). Pass `--session <session.jsonl>` for `conversation`/`all`
 * restores so the live `AgentSession` conversation adapter can be used.
 */
import { getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import chalk from "chalk";
import { Settings } from "../config/settings";
import type {
	ApplyWorkspaceRestoreRequest,
	WorkspaceCheckpointRecord,
	WorkspaceRestorePlan,
	WorkspaceRestoreResult,
	WorkspaceRestoreScope,
	WorkspaceRestoreStrategy,
} from "../workspace-checkpoints";
import {
	createOfflineWorkspaceCheckpointService,
	openWorkspaceCheckpointSession,
	unwrapWorkspaceCheckpointAccess,
} from "./workspace-checkpoint-support";

const ACTION_OPTIONS = ["list", "preview", "apply"] as const;
const SCOPE_OPTIONS = ["code", "conversation", "all"] as const;
const STRATEGY_OPTIONS = ["preserve", "exact"] as const;

export default class Rewind extends Command {
	static description = "List, preview, or apply a restore to a workspace checkpoint";

	static args = {
		action: Args.string({
			description: "Restore action",
			required: false,
			options: ACTION_OPTIONS as unknown as string[],
			default: "apply",
		}),
		checkpoint: Args.string({ description: "Checkpoint id (required for preview/apply)", required: false }),
	};

	static flags = {
		scope: Flags.string({
			char: "s",
			description: "Restore scope (default: code)",
			options: SCOPE_OPTIONS as unknown as string[],
			default: "code",
		}),
		strategy: Flags.string({
			description: "Conflict strategy",
			options: STRATEGY_OPTIONS as unknown as string[],
			default: "preserve",
		}),
		session: Flags.string({
			description: "Path to the session.jsonl that should own conversation/all restore semantics",
			required: false,
		}),
		paths: Flags.string({
			char: "p",
			description: "Restrict restore to these workspace-relative paths (repeatable)",
			required: false,
			multiple: true,
		}),
		"allow-conflicts": Flags.boolean({
			description: "Apply the plan even when preview reported conflicts",
			default: false,
		}),
		json: Flags.boolean({ char: "j", description: "Emit the plan/result as JSON", default: false }),
	};

	static examples = [
		"omp rewind list",
		"omp rewind preview ckpt_2025_04_01T10_00_00Z",
		"omp rewind apply ckpt_2025_04_01T10_00_00Z --scope code",
		"omp rewind apply ckpt_2025_04_01T10_00_00Z --scope all --session ./.omp/agent/sessions/<id>/session.jsonl",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Rewind);
		const rootPath = getProjectDir();
		const agentDir = getAgentDir();
		const settings = await Settings.init({ cwd: rootPath, agentDir });
		const enabled = settings.get("workspaceCheckpoint.enabled") !== false;
		if (!enabled) {
			throw new Error("workspaceCheckpoint.enabled is false in settings; refusing to restore");
		}
		const retention = {
			maxPerSession: settings.get("workspaceCheckpoint.retention.maxPerSession"),
			maxAgeDays: settings.get("workspaceCheckpoint.retention.maxAgeDays"),
		};
		const scope = flags.scope as WorkspaceRestoreScope;
		const strategy = flags.strategy as WorkspaceRestoreStrategy;
		const paths = collectPaths(flags.paths);
		const sessionPath = typeof flags.session === "string" ? flags.session : undefined;
		if ((scope === "conversation" || scope === "all") && !sessionPath) {
			throw new Error(`--scope ${scope} requires --session <session.jsonl>`);
		}

		try {
			if (args.action === "list") {
				const records = sessionPath
					? await withSessionRecords(sessionPath, agentDir)
					: await (await createOfflineWorkspaceCheckpointService({ rootPath, agentDir, enabled, retention })).list(
							{
								rootPath,
							},
						);
				renderRecords(records, flags.json);
				return;
			}

			const checkpointId = typeof args.checkpoint === "string" ? args.checkpoint : undefined;
			if (!checkpointId) {
				throw new Error("checkpoint id is required for `preview` and `apply`");
			}

			let plan: WorkspaceRestorePlan;
			if (sessionPath) {
				const { rootPath: sessionRootPath, session } = await openWorkspaceCheckpointSession({
					sessionPath,
					agentDir,
				});
				try {
					plan = unwrapWorkspaceCheckpointAccess(
						await session.previewWorkspaceRestore({
							checkpointId,
							scope,
							strategy,
							paths,
							rootPath: sessionRootPath,
						}),
						"workspace restore preview unavailable",
					);
					if (args.action === "preview") {
						renderPlan(plan, flags.json);
						return;
					}
					if (plan.conflicts.length > 0 && !flags["allow-conflicts"]) {
						throw new Error(
							`preview reported ${plan.conflicts.length} conflict(s); pass --allow-conflicts to apply anyway`,
						);
					}
					const result = unwrapWorkspaceCheckpointAccess(
						await session.applyWorkspaceRestore(plan.id, flags["allow-conflicts"]),
						"workspace restore unavailable",
					);
					renderResult(result, flags.json);
					return;
				} finally {
					await session.dispose();
				}
			}

			const service = await createOfflineWorkspaceCheckpointService({ rootPath, agentDir, enabled, retention });
			plan = await service.previewRestore({ checkpointId, scope, strategy, paths });
			if (args.action === "preview") {
				renderPlan(plan, flags.json);
				return;
			}
			if (plan.conflicts.length > 0 && !flags["allow-conflicts"]) {
				throw new Error(
					`preview reported ${plan.conflicts.length} conflict(s); pass --allow-conflicts to apply anyway`,
				);
			}
			const applyRequest: ApplyWorkspaceRestoreRequest = {
				planId: plan.id,
				allowConflicts: flags["allow-conflicts"],
			};
			const result = await service.restore(applyRequest);
			renderResult(result, flags.json);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`${chalk.red("error:")} ${message}\n`);
			process.exitCode = 1;
		}
	}
}

async function withSessionRecords(sessionPath: string, agentDir: string): Promise<WorkspaceCheckpointRecord[]> {
	const { rootPath, session } = await openWorkspaceCheckpointSession({ sessionPath, agentDir });
	try {
		return unwrapWorkspaceCheckpointAccess(
			await session.listWorkspaceCheckpoints({ rootPath }),
			"workspace checkpoint list unavailable",
		);
	} finally {
		await session.dispose();
	}
}

function renderRecords(records: WorkspaceCheckpointRecord[], json: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
		return;
	}
	for (const record of records) {
		process.stdout.write(
			`${chalk.bold(record.id)}  ${record.createdAt}  ${record.reason}  ` +
				`${record.fileCount} files${record.label ? `  ${chalk.dim(record.label)}` : ""}\n`,
		);
	}
}

function renderPlan(plan: WorkspaceRestorePlan, json: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
		return;
	}
	process.stdout.write(
		`${chalk.bold(`plan ${plan.id}`)} for checkpoint ${chalk.bold(plan.checkpointId)}\n` +
			`  operations: ${plan.operations.length} · conflicts: ${plan.conflicts.length}\n`,
	);
}

function renderResult(result: WorkspaceRestoreResult, json: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}
	process.stdout.write(
		`${chalk.green("✓")} restored ${result.restoredPaths.length} paths ` +
			`(skipped ${result.skippedPaths.length}) · redo ${result.redoAvailable ? "available" : "unavailable"}\n`,
	);
}

function collectPaths(input: string | string[] | undefined): string[] | undefined {
	if (input === undefined) return undefined;
	if (Array.isArray(input)) return input.length > 0 ? input : undefined;
	return [input];
}
