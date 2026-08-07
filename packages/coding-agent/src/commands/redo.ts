/**
 * `omp redo` — replay the most recently undone workspace restore.
 *
 * Without `--session`, redo only affects the current working tree. Pass
 * `--session <session.jsonl>` to route through the attached `AgentSession`
 * when conversation/all restore state is involved.
 */
import { getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Command, Flags } from "../cli/command-runtime";
import { Settings } from "../config/settings";
import type { WorkspaceRestoreResult } from "../workspace-checkpoints";
import {
	createOfflineWorkspaceCheckpointService,
	openWorkspaceCheckpointSession,
	unwrapWorkspaceCheckpointAccess,
} from "./workspace-checkpoint-support";

export default class Redo extends Command {
	static description = "Redo the most recently undone workspace restore";

	static flags = {
		session: Flags.string({
			description: "Path to the session.jsonl that should own conversation/all restore semantics",
			required: false,
		}),
		json: Flags.boolean({ char: "j", description: "Emit the redo result as JSON", default: false }),
	};

	static examples = ["omp redo", "omp redo --session ./.omp/agent/sessions/<id>/session.jsonl"];

	async run(): Promise<void> {
		const { flags } = await this.parse(Redo);
		const rootPath = getProjectDir();
		const agentDir = getAgentDir();
		const settings = await Settings.init({ cwd: rootPath, agentDir });
		const enabled = settings.get("workspaceCheckpoint.enabled") !== false;
		if (!enabled) {
			throw new Error("workspaceCheckpoint.enabled is false in settings; refusing to redo");
		}
		const retention = {
			maxPerSession: settings.get("workspaceCheckpoint.retention.maxPerSession"),
			maxAgeDays: settings.get("workspaceCheckpoint.retention.maxAgeDays"),
		};
		const sessionPath = typeof flags.session === "string" ? flags.session : undefined;

		try {
			let result: WorkspaceRestoreResult;
			if (sessionPath) {
				const { session } = await openWorkspaceCheckpointSession({ sessionPath, agentDir });
				try {
					result = unwrapWorkspaceCheckpointAccess(await session.redoWorkspace(), "workspace redo unavailable");
				} finally {
					await session.dispose();
				}
			} else {
				const service = await createOfflineWorkspaceCheckpointService({ rootPath, agentDir, enabled, retention });
				result = await service.redo({ rootPath });
			}
			if (flags.json) {
				process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
				return;
			}
			process.stdout.write(
				`${chalk.green("✓")} redo ${chalk.bold(result.transactionId)} restored ` +
					`${result.restoredPaths.length} paths · skipped ${result.skippedPaths.length}\n`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`${chalk.red("error:")} ${message}\n`);
			process.exitCode = 1;
		}
	}
}
