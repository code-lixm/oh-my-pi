import { afterEach, describe, expect, it, vi } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";

function createContext(formatAdvisorHistoryAsText: (options: { compact?: boolean }) => Promise<string | null>) {
	const showStatus = vi.fn();
	const showError = vi.fn();
	const ctx = {
		session: { formatAdvisorHistoryAsText },
		showStatus,
		showError,
	} as unknown as InteractiveModeContext;
	return { ctx, showStatus, showError };
}

describe("CommandController /advisor dump", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("awaits remote advisor history and maps text or null to the visible outcome", async () => {
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const historyReady = Promise.withResolvers<string | null>();
		const formatAdvisorHistoryAsText = vi.fn(() => historyReady.promise);
		const available = createContext(formatAdvisorHistoryAsText);
		const controller = new CommandController(available.ctx);

		const pending = controller.handleAdvisorDumpCommand();
		expect(formatAdvisorHistoryAsText).toHaveBeenCalledWith({ compact: true });
		expect(copySpy).not.toHaveBeenCalled();
		expect(available.showStatus).not.toHaveBeenCalled();

		historyReady.resolve("Advisor security-reviewer: no unresolved findings.");
		await pending;

		expect(copySpy).toHaveBeenCalledWith("Advisor security-reviewer: no unresolved findings.");
		expect(available.showStatus).toHaveBeenCalledWith("Advisor history copied to clipboard");

		const unavailableFormatAdvisorHistoryAsText = vi.fn(async () => null);
		const unavailable = createContext(unavailableFormatAdvisorHistoryAsText);
		await new CommandController(unavailable.ctx).handleAdvisorDumpCommand(true);

		expect(unavailableFormatAdvisorHistoryAsText).toHaveBeenCalledWith({ compact: false });
		expect(unavailable.showError).toHaveBeenCalledWith("Advisor is not active for this session.");
		expect(copySpy).toHaveBeenCalledTimes(1);
	});
});
