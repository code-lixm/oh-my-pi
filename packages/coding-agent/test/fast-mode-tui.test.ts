import { describe, expect, it, vi } from "bun:test";
import { BUILTIN_MODE_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-modes";

describe("/fast TUI command", () => {
	it("toggles through the session-port-compatible fast-mode methods", async () => {
		const command = BUILTIN_MODE_SLASH_COMMANDS.find(candidate => candidate.name === "fast");
		if (!command?.handleTui) throw new Error("Expected /fast TUI handler");

		let enabled = false;
		const setFastMode = vi.fn((next: boolean) => {
			enabled = next;
			return true;
		});
		const showStatus = vi.fn();
		const showError = vi.fn();
		const ctx = {
			session: {
				isFastModeEnabled: () => enabled,
				setFastMode,
			},
			statusLine: { invalidate: vi.fn() },
			ui: { requestRender: vi.fn() },
			showStatus,
			showError,
			editor: { setText: vi.fn() },
		};

		await command.handleTui({ name: "fast", args: "", text: "/fast" }, { ctx } as never);

		expect(setFastMode).toHaveBeenCalledWith(true);
		expect(showStatus).toHaveBeenCalledWith("Fast mode enabled.");
	});
});
