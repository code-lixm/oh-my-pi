import { describe, expect, it } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	buildTuiBuiltinSlashCommands,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	let editorText = "draft command";
	let sessionHistoryShowCount = 0;

	const editor = {
		setText(text: string) {
			editorText = text;
		},
	};
	const showSessionHistory = () => {
		sessionHistoryShowCount += 1;
	};

	return {
		getEditorText: () => editorText,
		getSessionHistoryShowCount: () => sessionHistoryShowCount,
		runtime: {
			ctx: {
				editor: editor as unknown as InteractiveModeContext["editor"],
				showSessionHistory,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/history slash command", () => {
	it("replaces /last and opens the session history viewer", async () => {
		const harness = createRuntime();
		const commandNames = buildTuiBuiltinSlashCommands(harness.runtime).map(command => command.name);

		expect(commandNames).toContain("history");
		expect(commandNames).not.toContain("last");

		const handled = await executeBuiltinSlashCommand("/history", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getEditorText()).toBe("");
		expect(harness.getSessionHistoryShowCount()).toBe(1);
	});
});
