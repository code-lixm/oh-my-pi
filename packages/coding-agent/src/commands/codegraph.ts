/**
 * Manage project-out CodeGraph indexes (~/.omp/codegraph/v1/indexes).
 *
 * Subcommands:
 *   - status  (default) — show the resolved index slot for the current project
 *   - clear             — remove the slot for the current project, an explicit
 *                          `--cwd` project, or a validated `--key`
 *   - prune             — sweep legacy/invalid entries and apply LRU via
 *                          `--keep` / `--older-than-days`
 *
 * All mutations go through the public Location facade
 * (`../codegraph/location`) so deletion stays limited to validated children
 * of `~/.omp/codegraph/v1/indexes/<key>`.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import {
	type CodeGraphClearOptions,
	type CodeGraphPruneOptions,
	type CodeGraphStatusOptions,
	runCodeGraphClear,
	runCodeGraphPrune,
	runCodeGraphStatus,
} from "../cli/codegraph-cli";

type CodeGraphAction = "status" | "clear" | "prune";

const ACTIONS: CodeGraphAction[] = ["status", "clear", "prune"];

export default class CodeGraph extends Command {
	static description = "Manage project-out CodeGraph indexes (~/.omp/codegraph/v1/indexes)";
	static aliases = ["cg"];

	static args = {
		action: Args.string({
			description: "Management action",
			required: false,
			options: ACTIONS,
			default: "status",
		}),
	};

	static flags = {
		cwd: Flags.string({ description: "Project root to resolve the index slot for (status/clear)" }),
		key: Flags.string({ description: "Index slot key (sha256 hex) — clear only" }),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
		"dry-run": Flags.boolean({
			char: "n",
			description: "Print what would change without touching the filesystem",
			default: false,
		}),
		keep: Flags.integer({
			description: "Prune: keep newest N indexes by lastUsedAt (default 10 when --older-than-days is omitted)",
		}),
		"older-than-days": Flags.integer({
			description: "Prune: remove indexes older than N days (mutually exclusive with --keep)",
		}),
	};

	static examples = [
		"# Inspect the resolved index for the current project\n  omp codegraph",
		"# Inspect an explicit project root\n  omp codegraph status --cwd ~/work/foo",
		"# Remove the current project's index\n  omp codegraph clear",
		"# Remove a specific index slot by key\n  omp codegraph clear --key <sha256-hex>",
		"# Preview a clear without touching disk\n  omp codegraph clear --dry-run",
		"# Sweep legacy/invalid entries, keep the 5 most recently used\n  omp codegraph prune --keep 5",
		"# Remove indexes not used in the last 30 days (preview)\n  omp codegraph prune --older-than-days 30 --dry-run",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(CodeGraph);
		const action = (args.action ?? "status") as CodeGraphAction;

		switch (action) {
			case "status": {
				const opts: CodeGraphStatusOptions = {
					json: Boolean(flags.json),
					cwd: flags.cwd,
				};
				await runCodeGraphStatus(opts);
				return;
			}
			case "clear": {
				const opts: CodeGraphClearOptions = {
					json: Boolean(flags.json),
					dryRun: Boolean(flags["dry-run"]),
					cwd: flags.cwd,
					key: flags.key,
				};
				await runCodeGraphClear(opts);
				return;
			}
			case "prune": {
				const olderThanDays = flags["older-than-days"];
				const explicitKeep = flags.keep;
				if (olderThanDays !== undefined && explicitKeep !== undefined) {
					throw new Error("Use either --keep or --older-than-days, not both.");
				}
				const opts: CodeGraphPruneOptions = {
					json: Boolean(flags.json),
					dryRun: Boolean(flags["dry-run"]),
					keep: olderThanDays === undefined ? (explicitKeep ?? 10) : undefined,
					olderThanDays,
				};
				await runCodeGraphPrune(opts);
				return;
			}
		}
	}
}
