/**
 * `omp checkpoint` — create a workspace checkpoint.
 *
 * Offline invocation captures the file tree and git state only. To attach a
 * conversation reference, pass `--session <session.jsonl>` so the command can
 * route through a live `AgentSession`; without that, the command always creates
 * a code-only checkpoint and does NOT advertise conversation/all scopes.
 */
import { getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Args, Command, Flags } from "../cli/command-runtime";
import { Settings } from "../config/settings";
import type { CreateWorkspaceCheckpointRequest, WorkspaceCheckpointRecord } from "../workspace-checkpoints";
import {
	createOfflineWorkspaceCheckpointService,
	openWorkspaceCheckpointSession,
	unwrapWorkspaceCheckpointAccess,
} from "./workspace-checkpoint-support";

export default class Checkpoint extends Command {
	static description = "Create a workspace checkpoint";

	static args = {
		label: Args.string({ description: "Optional human-readable label", required: false }),
	};

	static flags = {
		session: Flags.string({
			description: "Path to the session.jsonl that should own the checkpoint's conversation reference",
			required: false,
		}),
		reason: Flags.string({
			description: "Override the default `manual` reason (advanced)",
			options: ["manual", "user_bash", "task_merge"],
			required: false,
		}),
		json: Flags.boolean({ char: "j", description: "Emit the checkpoint record as JSON", default: false }),
	};

	static examples = [
		"omp checkpoint",
		'omp checkpoint "before schema rewrite"',
		"omp checkpoint --session ./.omp/agent/sessions/<id>/session.jsonl",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Checkpoint);
		const rootPath = getProjectDir();
		const agentDir = getAgentDir();
		const settings = await Settings.init({ cwd: rootPath, agentDir });
		const enabled = settings.get("workspaceCheckpoint.enabled") !== false;
		if (!enabled) {
			throw new Error("workspaceCheckpoint.enabled is false in settings; refusing to create checkpoint");
		}
		const retention = {
			maxPerSession: settings.get("workspaceCheckpoint.retention.maxPerSession"),
			maxAgeDays: settings.get("workspaceCheckpoint.retention.maxAgeDays"),
			maxTotalMiB: settings.get("workspaceCheckpoint.retention.maxTotalMiB"),
		};
		const reason = (flags.reason ?? "manual") as CreateWorkspaceCheckpointRequest["reason"];
		const label = typeof args.label === "string" ? args.label : undefined;
		if (typeof flags.session === "string" && reason !== "manual") {
			throw new Error(
				"--reason is only supported for offline checkpoints; session-backed checkpoints always use the session manual path",
			);
		}

		try {
			let record: WorkspaceCheckpointRecord;
			if (typeof flags.session === "string") {
				const { rootPath: sessionRootPath, session } = await openWorkspaceCheckpointSession({
					sessionPath: flags.session,
					agentDir,
				});
				try {
					record = unwrapWorkspaceCheckpointAccess(
						await session.createWorkspaceCheckpoint(label ?? null, { rootPath: sessionRootPath }),
						"workspace checkpoint unavailable",
					);
				} finally {
					await session.dispose();
				}
			} else {
				const service = await createOfflineWorkspaceCheckpointService({ rootPath, agentDir, enabled, retention });
				record = await service.create({ rootPath, reason, label });
			}
			if (flags.json) {
				process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
				return;
			}
			process.stdout.write(
				`${chalk.green("✓")} checkpoint ${chalk.bold(record.id)} (${record.completeness}) ` +
					`· ${record.fileCount} files · ${(record.totalBytes / 1024).toFixed(1)} KiB\n`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`${chalk.red("error:")} ${message}\n`);
			process.exitCode = 1;
		}
	}
}
