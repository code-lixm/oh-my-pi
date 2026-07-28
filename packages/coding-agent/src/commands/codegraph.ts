/**
 * Manage project-out CodeGraph indexes (~/.omp/codegraph/v1/indexes).
 *
 * Subcommands:
 *   - status    (default) — show the resolved index slot for the current
 *                          project
 *   - list                — enumerate slots under the indexes root, or the
 *                          slots for one project under `--cwd`
 *   - clear               — remove one slot (current project, `--cwd`, or
 *                          `--key`)
 *   - clear-all           — remove every slot belonging to the resolved
 *                          project; never touches other projects
 *   - prune               — sweep legacy/invalid entries and apply LRU
 *                          (`--keep` / `--older-than-days` plus the auto
 *                          caps)
 *
 * All mutations go through the public Location facade
 * (`../codegraph/location`) so deletion stays limited to validated children
 * of `~/.omp/codegraph/v1/indexes/<key>`.
 *
 * The CLI does not run an automatic policy pass during `prune` — without
 * `--max-*` flags, the legacy `--keep 10` default is preserved so a
 * parameterless invocation stays predictable.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import {
	type CodeGraphClearAllOptions,
	type CodeGraphClearOptions,
	type CodeGraphListOptions,
	type CodeGraphPruneOptions,
	type CodeGraphStatusOptions,
	runCodeGraphClear,
	runCodeGraphClearAll,
	runCodeGraphList,
	runCodeGraphPrune,
	runCodeGraphStatus,
} from "../cli/codegraph-cli";

type CodeGraphAction = "status" | "list" | "clear" | "clear-all" | "prune";

const ACTIONS: CodeGraphAction[] = ["status", "list", "clear", "clear-all", "prune"];

const BYTE_SIZE_RE = /^(\d+(?:\.\d+)?)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib|t|tb|tib)?$/i;
const BYTE_MULTIPLIERS: Record<string, number> = {
	b: 1,
	k: 1024,
	kb: 1024,
	kib: 1024,
	m: 1024 ** 2,
	mb: 1024 ** 2,
	mib: 1024 ** 2,
	g: 1024 ** 3,
	gb: 1024 ** 3,
	gib: 1024 ** 3,
	t: 1024 ** 4,
	tb: 1024 ** 4,
	tib: 1024 ** 4,
};

function parseByteSize(value: string | undefined, flag: string): number | undefined {
	if (value === undefined) return undefined;
	const match = BYTE_SIZE_RE.exec(value.trim());
	if (!match) throw new Error(`${flag} must be bytes or a size such as 512m, 2g, or 8GiB.`);
	const amount = Number(match[1]);
	const multiplier = BYTE_MULTIPLIERS[(match[2] ?? "b").toLowerCase()];
	const bytes = amount * multiplier;
	if (!Number.isSafeInteger(bytes) || bytes < 0) {
		throw new Error(`${flag} resolves outside the supported integer byte range.`);
	}
	return bytes;
}

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
		cwd: Flags.string({ description: "Project root to resolve the index slot for (status/clear/list/clear-all)" }),
		key: Flags.string({ description: "Index slot key (sha256 hex) — clear only" }),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
		"dry-run": Flags.boolean({
			char: "n",
			description: "Print what would change without touching the filesystem",
			default: false,
		}),
		"include-orphans": Flags.boolean({
			description: "List slots whose sourceRoot is missing or no longer a Git repo",
			default: true,
		}),
		keep: Flags.integer({
			description: "Prune: keep newest N indexes by lastUsedAt (default 10 when no other prune flag is given)",
		}),
		"older-than-days": Flags.integer({
			description: "Prune: remove indexes older than N days (mutually exclusive with --keep)",
		}),
		"max-total-bytes": Flags.string({
			description: "Prune: cap total indexes size (bytes or 512m/2g/8GiB)",
		}),
		"max-project-bytes": Flags.string({
			description: "Prune: cap per-project indexes size (bytes or 512m/2g/8GiB)",
		}),
		"max-project-indexes": Flags.integer({
			description: "Prune: cap slots per project",
		}),
		"delete-orphans": Flags.boolean({
			description: "Prune: also drop slots whose sourceRoot is missing or no longer a Git repo",
			default: false,
			allowNo: true,
		}),
	};

	static examples = [
		"# Inspect the resolved index for the current project\n  omp codegraph",
		"# Inspect an explicit project root\n  omp codegraph status --cwd ~/work/foo",
		"# List every slot under the indexes root\n  omp codegraph list --json",
		"# List slots for the current project only\n  omp codegraph list --cwd .",
		"# Remove the current project's index\n  omp codegraph clear",
		"# Remove every slot belonging to the current project\n  omp codegraph clear-all --dry-run",
		"# Remove a specific index slot by key\n  omp codegraph clear --key <sha256-hex>",
		"# Preview a clear without touching disk\n  omp codegraph clear --dry-run",
		"# Sweep legacy/invalid entries, keep the 5 most recently used\n  omp codegraph prune --keep 5",
		"# Remove indexes not used in the last 30 days (preview)\n  omp codegraph prune --older-than-days 30 --dry-run",
		"# Bound per-project + global size + orphan cleanup\n  omp codegraph prune --max-project-indexes 8 --max-project-bytes 2g --max-total-bytes 8g --delete-orphans",
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
			case "list": {
				const opts: CodeGraphListOptions = {
					json: Boolean(flags.json),
					cwd: flags.cwd,
					includeOrphans: Boolean(flags["include-orphans"]),
				};
				await runCodeGraphList(opts);
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
			case "clear-all": {
				const opts: CodeGraphClearAllOptions = {
					json: Boolean(flags.json),
					dryRun: Boolean(flags["dry-run"]),
					cwd: flags.cwd,
				};
				await runCodeGraphClearAll(opts);
				return;
			}
			case "prune": {
				const olderThanDays = flags["older-than-days"];
				const explicitKeep = flags.keep;
				if (olderThanDays !== undefined && explicitKeep !== undefined) {
					throw new Error("Use either --keep or --older-than-days, not both.");
				}
				const maxTotalBytes = parseByteSize(flags["max-total-bytes"], "--max-total-bytes");
				const maxProjectBytes = parseByteSize(flags["max-project-bytes"], "--max-project-bytes");
				const maxProjectIndexes = flags["max-project-indexes"];
				const deleteOrphans = flags["delete-orphans"];
				// Manual `omp codegraph prune` keeps the legacy `--keep 10`
				// default only when no other prune criterion was supplied;
				const hasExplicitCriterion =
					olderThanDays !== undefined ||
					explicitKeep !== undefined ||
					maxTotalBytes !== undefined ||
					maxProjectBytes !== undefined ||
					maxProjectIndexes !== undefined;
				const keep = !hasExplicitCriterion ? 10 : olderThanDays === undefined ? explicitKeep : undefined;
				const opts: CodeGraphPruneOptions = {
					json: Boolean(flags.json),
					dryRun: Boolean(flags["dry-run"]),
					keep,
					olderThanDays,
					maxTotalBytes,
					maxProjectBytes,
					maxProjectIndexes,
					deleteOrphans,
				};
				await runCodeGraphPrune(opts);
				return;
			}
		}
	}
}
