import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime(handler: () => Promise<void>) {
	const handleRetry = vi.fn(handler);
	return {
		handleRetry,
		runtime: {
			ctx: {
				handleRetry,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/retry slash command", () => {
	it("awaits the context-owned view-session retry lifecycle", async () => {
		const deferred = Promise.withResolvers<void>();
		const harness = createRuntime(() => deferred.promise);

		let settled = false;
		const execution = executeBuiltinSlashCommand("/retry", harness.runtime).then(result => {
			settled = true;
			return result;
		});

		await Promise.resolve();

		expect(harness.handleRetry).toHaveBeenCalledTimes(1);
		expect(settled).toBe(false);

		deferred.resolve();

		expect(await execution).toBe(true);
		expect(settled).toBe(true);
	});
});
