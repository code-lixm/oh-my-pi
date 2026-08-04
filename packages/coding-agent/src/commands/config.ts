/**
 * Manage configuration settings.
 */

import { configHelp as commandHelp } from "../cli/command-help";
import { Args, Command, Flags } from "../cli/command-runtime";
import { type ConfigAction, type ConfigCommandArgs, runConfigCommand } from "../cli/config-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: ConfigAction[] = ["list", "get", "set", "reset", "path", "init-xdg", "export", "import"];

export default class Config extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Config action",
			required: false,
			options: ACTIONS,
		}),
		key: Args.string({
			description: "Setting key or configuration bundle path",
			required: false,
		}),
		value: Args.string({
			description: "Value (for set/reset)",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		"passphrase-env": Flags.string({ description: "Environment variable containing the bundle passphrase" }),
		"dry-run": Flags.boolean({ description: "Validate and preview an import without applying it" }),
		replace: Flags.boolean({ description: "Replace synchronized files and credentials missing from the bundle" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Config);
		const action = (args.action ?? "list") as ConfigAction;
		const value = Array.isArray(args.value) ? args.value.join(" ") : args.value;

		const cmd: ConfigCommandArgs = {
			action,
			key: args.key,
			value,
			flags: {
				json: flags.json,
				passphraseEnv: flags["passphrase-env"],
				dryRun: flags["dry-run"],
				replace: flags.replace,
			},
		};

		await initTheme();
		await runConfigCommand(cmd);
	}
}
