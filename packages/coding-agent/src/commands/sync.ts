import { Args, Command, Flags, renderCommandHelp } from "../cli/command-runtime";
import { runSyncCommand, type SyncAction, type SyncCommandArgs } from "../cli/sync-cli";

const ACTIONS: SyncAction[] = ["init", "status", "push", "pull", "conflict", "resolve", "gc"];

export default class Sync extends Command {
	static description = "Synchronize encrypted OMP configuration through S3-compatible storage";

	static args = {
		action: Args.string({ description: "Sub-command", required: false, options: ACTIONS }),
		target: Args.string({ description: "Conflict key for resolve", required: false }),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		endpoint: Flags.string({ description: "S3-compatible endpoint URL" }),
		bucket: Flags.string({ description: "S3 bucket" }),
		region: Flags.string({ description: "S3 region" }),
		prefix: Flags.string({ description: "Object key prefix" }),
		"virtual-hosted-style": Flags.boolean({ description: "Use virtual-hosted-style S3 URLs" }),
		"passphrase-env": Flags.string({ description: "Environment variable containing the bundle passphrase" }),
		"access-key-id-env": Flags.string({ description: "Environment variable containing the S3 access key ID" }),
		"secret-access-key-env": Flags.string({
			description: "Environment variable containing the S3 secret access key",
		}),
		"session-token-env": Flags.string({ description: "Environment variable containing the S3 session token" }),
		"auto-push": Flags.boolean({ description: "Push after successful settings persistence" }),
		ours: Flags.boolean({ description: "Resolve with the local value" }),
		theirs: Flags.boolean({ description: "Resolve with the remote value" }),
		"dry-run": Flags.boolean({ description: "Preview without changing local or remote state" }),
		apply: Flags.boolean({ description: "Apply config sync garbage collection" }),
		editor: Flags.boolean({ description: "Open the conflict document in $VISUAL or $EDITOR" }),
	};

	static examples = [
		"omp sync init --bucket omp-config --prefix personal/default",
		"omp sync push",
		"omp sync pull",
		"omp sync status --json",
		"omp sync resolve settings/config.yml --ours",
		"omp sync gc --dry-run",
		"omp sync gc --apply",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Sync);
		if (!args.action) {
			renderCommandHelp("omp", "sync", Sync);
			return;
		}
		await runSyncCommand({
			action: args.action as SyncAction,
			target: args.target,
			flags: {
				json: flags.json,
				endpoint: flags.endpoint,
				bucket: flags.bucket,
				region: flags.region,
				prefix: flags.prefix,
				virtualHostedStyle: flags["virtual-hosted-style"],
				passphraseEnv: flags["passphrase-env"],
				accessKeyIdEnv: flags["access-key-id-env"],
				secretAccessKeyEnv: flags["secret-access-key-env"],
				sessionTokenEnv: flags["session-token-env"],
				autoPush: flags["auto-push"],
				ours: flags.ours,
				theirs: flags.theirs,
				dryRun: flags["dry-run"],
				apply: flags.apply,
				editor: flags.editor,
			},
		} satisfies SyncCommandArgs);
	}
}
