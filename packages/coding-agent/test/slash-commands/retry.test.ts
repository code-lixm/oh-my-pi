import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

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

function acpRuntime({
	isStreaming = false,
	retryResult = false,
	withKeepOpen = true,
}: {
	isStreaming?: boolean;
	retryResult?: boolean;
	withKeepOpen?: boolean;
}) {
	const retry = vi.fn(async () => retryResult);
	const keepTurnOpenUntilIdle = vi.fn(async () => {});
	const output = vi.fn();
	const runtime = {
		session: { isStreaming, retry },
		output,
		...(withKeepOpen ? { keepTurnOpenUntilIdle } : {}),
	} as unknown as SlashCommandRuntime;
	return { retry, keepTurnOpenUntilIdle, output, runtime };
}

describe("/retry dispatch (ACP)", () => {
	it("refuses to retry while streaming", async () => {
		const h = acpRuntime({ isStreaming: true });
		const result = await executeAcpBuiltinSlashCommand("/retry", h.runtime);
		expect(h.retry).not.toHaveBeenCalled();
		expect(result).toEqual({ consumed: true });
		expect((h.output.mock.calls[0]?.[0] as string) ?? "").toContain("before retrying");
	});

	it("reports when there is nothing to retry", async () => {
		const h = acpRuntime({ retryResult: false });
		const result = await executeAcpBuiltinSlashCommand("/retry", h.runtime);
		expect(h.output).toHaveBeenCalledWith("Nothing to retry.");
		expect(h.keepTurnOpenUntilIdle).not.toHaveBeenCalled();
		expect(result).toEqual({ consumed: true });
	});

	it("announces the retry and holds the ACP turn open for the retried turn", async () => {
		const h = acpRuntime({ retryResult: true });
		const result = await executeAcpBuiltinSlashCommand("/retry", h.runtime);
		expect(h.output.mock.calls[0]?.[0]).toBe("Retrying the last failed turn.");
		expect(h.keepTurnOpenUntilIdle).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ consumed: true, agentInvoked: true });
	});

	it("returns immediately for hosts that stream the continuation themselves (RPC/TUI)", async () => {
		// RPC's `prompt` awaits this dispatcher before responding and serializes
		// later frames, so blocking here would break `RpcClient.prompt()`'s
		// documented immediate return and strand a follow-up `abort`.
		const h = acpRuntime({ retryResult: true, withKeepOpen: false });
		const result = await executeAcpBuiltinSlashCommand("/retry", h.runtime);
		expect(h.retry).toHaveBeenCalledTimes(1);
		expect(h.output.mock.calls[0]?.[0]).toBe("Retrying the last failed turn.");
		expect(result).toEqual({ consumed: true, agentInvoked: true });
	});

	it("reports a scheduled retry as agent work, and a no-op retry as local-only", async () => {
		// RPC maps a bare `{ consumed: true }` to `agentInvoked: false`. A
		// successful retry schedules an `agent.continue()` turn, so reporting
		// local-only there would have the host finalize the request while the
		// retried turn is still streaming.
		const scheduled = await executeAcpBuiltinSlashCommand("/retry", acpRuntime({ retryResult: true }).runtime);
		const noop = await executeAcpBuiltinSlashCommand("/retry", acpRuntime({ retryResult: false }).runtime);
		expect(scheduled).toEqual({ consumed: true, agentInvoked: true });
		expect(noop).toEqual({ consumed: true });
	});

	it("is advertised to ACP clients", () => {
		expect(ACP_BUILTIN_SLASH_COMMANDS.find(c => c.name === "retry")).toBeDefined();
	});
});
