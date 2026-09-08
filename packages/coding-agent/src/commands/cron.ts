/** List the persisted scheduled tasks (session-bound cron jobs) across sessions. */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { cronHelp as commandHelp } from "../cli/command-help";
import { runCronCommand } from "../cli/cron-cli";

export default class Cron extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "list (default)",
			required: false,
			options: ["list"],
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON" }),
	};

	static examples = ["omp cron", "omp cron list", "omp cron --json"];

	async run(): Promise<void> {
		const { flags } = await this.parse(Cron);
		await runCronCommand({ json: flags.json ?? false });
	}
}
