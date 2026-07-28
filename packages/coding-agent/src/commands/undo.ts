/**
 * `omp undo` — roll back the most recent workspace restore.
 *
 * Without `--session`, only code restores for the current working tree can be
 * undone. Pass `--session <session.jsonl>` for `conversation`/`all` undos so
 * the command routes through a live `AgentSession` conversation adapter.
 */
import { getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import chalk from "chalk";
import { Settings } from "../config/settings";
import type { WorkspaceRestoreResult, WorkspaceRestoreScope } from "../workspace-checkpoints";
import {
	createOfflineWorkspaceCheckpointService,
	openWorkspaceCheckpointSession,
	unwrapWorkspaceCheckpointAccess,
} from "./workspace-checkpoint-support";

const SCOPE_OPTIONS = ["code", "conversation", "all"] as const;

export default class Undo extends Command {
	static description = "Undo the most recent workspace restore transaction";

	static flags = {
		scope: Flags.string({
			char: "s",
			description: "Restore scope to undo (defaults to the last restore scope)",
			options: SCOPE_OPTIONS as unknown as string[],
			required: false,
		}),
		session: Flags.string({
			description: "Path to the session.jsonl that should own conversation/all restore semantics",
			required: false,
		}),
		json: Flags.boolean({ char: "j", description: "Emit the undo result as JSON", default: false }),
	};

	static examples = [
		"omp undo",
		"omp undo --scope code",
		"omp undo --scope all --session ./.omp/agent/sessions/<id>/session.jsonl",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Undo);
		const rootPath = getProjectDir();
		const agentDir = getAgentDir();
		const settings = await Settings.init({ cwd: rootPath, agentDir });
		const enabled = settings.get("workspaceCheckpoint.enabled") !== false;
		if (!enabled) {
			throw new Error("workspaceCheckpoint.enabled is false in settings; refusing to undo");
		}
		const retention = {
			maxPerSession: settings.get("workspaceCheckpoint.retention.maxPerSession"),
			maxAgeDays: settings.get("workspaceCheckpoint.retention.maxAgeDays"),
		};
		const scope = typeof flags.scope === "string" ? (flags.scope as WorkspaceRestoreScope) : undefined;
		const sessionPath = typeof flags.session === "string" ? flags.session : undefined;
		if ((scope === "conversation" || scope === "all") && !sessionPath) {
			throw new Error(`--scope ${scope} requires --session <session.jsonl>`);
		}

		try {
			let result: WorkspaceRestoreResult;
			if (sessionPath) {
				const { session } = await openWorkspaceCheckpointSession({ sessionPath, agentDir });
				try {
					result = unwrapWorkspaceCheckpointAccess(
						await session.undoWorkspace(scope),
						"workspace undo unavailable",
					);
				} finally {
					await session.dispose();
				}
			} else {
				const service = await createOfflineWorkspaceCheckpointService({ rootPath, agentDir, enabled, retention });
				result = await service.undo({ rootPath, scope });
			}
			if (flags.json) {
				process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
				return;
			}
			process.stdout.write(
				`${chalk.green("✓")} undo ${chalk.bold(result.transactionId)} restored ` +
					`${result.restoredPaths.length} paths · skipped ${result.skippedPaths.length}\n`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`${chalk.red("error:")} ${message}\n`);
			process.exitCode = 1;
		}
	}
}
