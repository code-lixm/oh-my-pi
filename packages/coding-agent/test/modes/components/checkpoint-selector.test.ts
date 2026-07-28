import { beforeAll, describe, expect, it } from "bun:test";
import { CheckpointSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/checkpoint-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { WorkspaceCheckpointAccessResult } from "@oh-my-pi/pi-coding-agent/session/workspace-checkpoint-coordinator";
import type {
	WorkspaceCheckpointRecord,
	WorkspaceRestorePlan,
	WorkspaceRestoreResult,
	WorkspaceRestoreScope,
} from "@oh-my-pi/pi-coding-agent/workspace-checkpoints/types";

const DOWN = "\x1b[B";
const ENTER = "\n";

function checkpointRecord(): WorkspaceCheckpointRecord {
	return {
		id: "ckpt_scope",
		workspaceId: "workspace-1",
		rootPath: "/workspace",
		manifestObjectId: "sha256:manifest",
		parentId: null,
		sessionId: "session-1",
		sessionEntryId: null,
		promptEntryId: null,
		label: "before refactor",
		reason: "manual",
		completeness: "complete",
		createdAt: "2026-07-28T12:00:00.000Z",
		fileCount: 1,
		totalBytes: 12,
		pinned: false,
	};
}

function restorePlan(checkpointId: string, scope: WorkspaceRestoreScope): WorkspaceRestorePlan {
	return {
		id: `plan-${scope}`,
		checkpointId,
		rootPath: "/workspace",
		scope,
		strategy: "preserve",
		operations: [{ path: "src/restored.ts", kind: "update" }],
		conflicts: [],
		conversationEntryId: null,
		createdAt: "2026-07-28T12:01:00.000Z",
	};
}

function restoreResult(checkpointId: string): WorkspaceRestoreResult {
	return {
		transactionId: "transaction-1",
		checkpointId,
		guardCheckpointId: null,
		restoredPaths: ["src/restored.ts"],
		skippedPaths: [],
		conversationEntryId: null,
		redoAvailable: true,
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("CheckpointSelectorComponent restore confirmation", () => {
	for (const testCase of [
		{ input: [], scope: "code" },
		{ input: [DOWN, DOWN], scope: "all" },
	] as const) {
		it(`previews the selected ${testCase.scope} scope before applying its plan after confirmation`, async () => {
			const checkpoint = checkpointRecord();
			const plan = restorePlan(checkpoint.id, testCase.scope);
			const previewStarted = Promise.withResolvers<void>();
			const previewGate = Promise.withResolvers<WorkspaceCheckpointAccessResult<WorkspaceRestorePlan>>();
			const picked = Promise.withResolvers<void>();
			const previewRequests: Array<[string, WorkspaceRestoreScope]> = [];
			const preview = (checkpointId: string, scope: WorkspaceRestoreScope) => {
				previewRequests.push([checkpointId, scope]);
				previewStarted.resolve();
				return previewGate.promise;
			};
			let applyCalls = 0;
			let appliedPlanId: string | undefined;
			const apply = async (planId: string): Promise<WorkspaceCheckpointAccessResult<WorkspaceRestoreResult>> => {
				applyCalls += 1;
				appliedPlanId = planId;
				return { available: true, value: restoreResult(checkpoint.id) };
			};
			const selector = new CheckpointSelectorComponent({
				checkpoints: [checkpoint],
				onPick: () => {
					picked.resolve();
				},
				onCancel: () => {},
				preview,
				apply,
				isMutatorActive: () => false,
			});

			selector.handleInput(ENTER);
			for (const input of testCase.input) selector.handleInput(input);
			selector.handleInput(ENTER);

			await previewStarted.promise;
			expect(previewRequests).toEqual([[checkpoint.id, testCase.scope]]);
			expect(applyCalls).toBe(0);

			previewGate.resolve({ available: true, value: plan });
			await Promise.resolve();

			expect(Bun.stripANSI(selector.render(100).join("\n"))).toContain("Preview restore");
			expect(applyCalls).toBe(0);

			selector.handleInput(ENTER);
			await picked.promise;

			expect(applyCalls).toBe(1);
			expect(appliedPlanId).toBe(plan.id);
		});
	}
});
