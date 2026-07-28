import { beforeAll, describe, expect, it, vi } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { WorkspaceCheckpointAccessResult } from "@oh-my-pi/pi-coding-agent/session/workspace-checkpoint-coordinator";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import type {
	WorkspaceCheckpointRecord,
	WorkspaceRestoreResult,
} from "@oh-my-pi/pi-coding-agent/workspace-checkpoints/types";

function checkpointRecord(id: string, label: string | null): WorkspaceCheckpointRecord {
	return {
		id,
		workspaceId: "workspace-1",
		rootPath: "/workspace",
		manifestObjectId: "sha256:manifest",
		parentId: null,
		sessionId: "session-1",
		sessionEntryId: null,
		promptEntryId: null,
		label,
		reason: "manual",
		completeness: "complete",
		createdAt: "2026-07-28T12:00:00.000Z",
		fileCount: 1,
		totalBytes: 12,
		pinned: false,
	};
}

function restoreResult(checkpointId: string): WorkspaceRestoreResult {
	return {
		transactionId: `transaction-${checkpointId}`,
		checkpointId,
		guardCheckpointId: null,
		restoredPaths: ["src/restored.ts"],
		skippedPaths: [],
		conversationEntryId: null,
		redoAvailable: true,
	};
}

function available<T>(value: T): WorkspaceCheckpointAccessResult<T> {
	return { available: true, value };
}

function createTuiRuntime() {
	const setText = vi.fn();
	const statusMessages: string[] = [];
	const showStatus = vi.fn((message: string) => {
		statusMessages.push(message);
	});
	const showError = vi.fn();
	const handleCheckpointCommand = vi.fn(
		async (label: string | undefined): Promise<WorkspaceCheckpointAccessResult<WorkspaceCheckpointRecord>> =>
			available(checkpointRecord("ckpt-created", label ?? null)),
	);
	const showCheckpointSelector = vi.fn(async (_options?: { checkpointId?: string }): Promise<void> => {});
	const undoWorkspace = vi.fn(
		async (): Promise<WorkspaceCheckpointAccessResult<WorkspaceRestoreResult>> =>
			available(restoreResult("ckpt-undo")),
	);
	const redoWorkspace = vi.fn(
		async (): Promise<WorkspaceCheckpointAccessResult<WorkspaceRestoreResult>> =>
			available(restoreResult("ckpt-redo")),
	);

	const runtime = {
		ctx: {
			editor: { setText } as unknown as InteractiveModeContext["editor"],
			handleCheckpointCommand,
			showCheckpointSelector,
			session: { undoWorkspace, redoWorkspace } as unknown as InteractiveModeContext["session"],
			showStatus,
			showError,
		} as unknown as InteractiveModeContext,
	};

	return {
		handleCheckpointCommand,
		redoWorkspace,
		runtime,
		setText,
		showCheckpointSelector,
		showError,
		showStatus,
		statusMessages,
		undoWorkspace,
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("workspace checkpoint slash commands", () => {
	it("passes a TUI checkpoint label to the checkpoint entry and reports the created checkpoint", async () => {
		const harness = createTuiRuntime();

		expect(await executeBuiltinSlashCommand("/checkpoint before-migration", harness.runtime)).toBe(true);

		expect(harness.handleCheckpointCommand).toHaveBeenCalledWith("before-migration");
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.statusMessages).toHaveLength(1);
		expect(harness.statusMessages[0]).toContain("ckpt-created");
		expect(harness.showError).not.toHaveBeenCalled();
	});

	it("opens the TUI rewind selector at the requested checkpoint", async () => {
		const harness = createTuiRuntime();

		expect(await executeBuiltinSlashCommand("/rewind ckpt_42", harness.runtime)).toBe(true);

		expect(harness.showCheckpointSelector).toHaveBeenCalledWith({ checkpointId: "ckpt_42" });
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("keeps ACP rewind non-mutating and directs callers to the TUI, RPC, or CLI", async () => {
		const output: string[] = [];
		let mutationAttempts = 0;
		const unexpectedMutation = async (): Promise<never> => {
			mutationAttempts += 1;
			throw new Error("ACP /rewind must not restore the workspace");
		};
		const runtime = {
			session: {
				applyWorkspaceRestore: unexpectedMutation,
				redoWorkspace: unexpectedMutation,
				undoWorkspace: unexpectedMutation,
			},
			output: (message: string) => {
				output.push(message);
			},
		} as unknown as SlashCommandRuntime;

		expect(await executeAcpBuiltinSlashCommand("/rewind ckpt_non_tui", runtime)).toEqual({ consumed: true });

		expect(mutationAttempts).toBe(0);
		expect(output).toHaveLength(1);
		expect(output[0]).toContain("ckpt_non_tui");
		expect(output[0]).toContain("interactive TUI");
		expect(output[0]).toContain("RPC/CLI");
	});

	for (const command of [
		{ command: "/undo", completed: "Undo completed", method: "undoWorkspace" },
		{ command: "/redo", completed: "Redo completed", method: "redoWorkspace" },
	] as const) {
		it(`routes TUI ${command.command} to session.${command.method}`, async () => {
			const harness = createTuiRuntime();

			expect(await executeBuiltinSlashCommand(command.command, harness.runtime)).toBe(true);

			expect(harness[command.method]).toHaveBeenCalledTimes(1);
			expect(harness[command.method === "undoWorkspace" ? "redoWorkspace" : "undoWorkspace"]).not.toHaveBeenCalled();
			expect(harness.statusMessages).toHaveLength(1);
			expect(harness.statusMessages[0]).toContain(command.completed);
		});
	}
});
