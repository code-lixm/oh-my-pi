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
const ESCAPE = "\x1b";

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

function restoreResult(
	checkpointId: string,
	scope: WorkspaceRestoreScope,
	strategy: WorkspaceRestorePlan["strategy"],
): WorkspaceRestoreResult {
	return {
		transactionId: "transaction-1",
		checkpointId,
		guardCheckpointId: null,
		restoredPaths: ["src/restored.ts"],
		skippedPaths: [],
		conversationEntryId: null,
		redoAvailable: true,
		scope,
		strategy,
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
				return { available: true, value: restoreResult(checkpoint.id, plan.scope, plan.strategy) };
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
				requestRender: () => {},
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

	it("renders every restore operation path and each conflict path in the preview", async () => {
		const checkpoint = checkpointRecord();
		const plan: WorkspaceRestorePlan = {
			...restorePlan(checkpoint.id, "code"),
			operations: [
				{ kind: "create", path: "src/created.ts" },
				{ kind: "update", path: "src/updated.ts" },
				{ kind: "delete", path: "src/deleted.ts" },
				{ kind: "chmod", path: "bin/runner" },
				{ kind: "symlink", path: "links/current" },
			],
			conflicts: [
				{
					kind: "current_state_changed",
					path: "src/conflicted.ts",
					message: "working tree differs",
				},
			],
		};
		const selector = new CheckpointSelectorComponent({
			checkpoints: [checkpoint],
			onPick: () => {},
			onCancel: () => {},
			preview: async () => ({ available: true, value: plan }),
			apply: async () => ({ available: true, value: restoreResult(checkpoint.id, plan.scope, plan.strategy) }),
			isMutatorActive: () => false,
			requestRender: () => {},
		});

		selector.handleInput(ENTER);
		selector.handleInput(ENTER);
		await Promise.resolve();

		const preview = Bun.stripANSI(selector.render(140).join("\n"));
		expect(preview).toContain("+ create  src/created.ts");
		expect(preview).toContain("~ update  src/updated.ts");
		expect(preview).toContain("- delete  src/deleted.ts");
		expect(preview).toContain("m chmod  bin/runner");
		expect(preview).toContain("l symlink  links/current");
		expect(preview).toContain("src/conflicted.ts: current_state_changed: working tree differs");
	});

	it("requests a redraw when an async preview starts and completes", async () => {
		const checkpoint = checkpointRecord();
		const plan = restorePlan(checkpoint.id, "code");
		const previewStarted = Promise.withResolvers<void>();
		const previewGate = Promise.withResolvers<WorkspaceCheckpointAccessResult<WorkspaceRestorePlan>>();
		let renderRequests = 0;
		const selector = new CheckpointSelectorComponent({
			checkpoints: [checkpoint],
			onPick: () => {},
			onCancel: () => {},
			preview: () => {
				previewStarted.resolve();
				return previewGate.promise;
			},
			apply: async () => ({ available: true, value: restoreResult(checkpoint.id, plan.scope, plan.strategy) }),
			isMutatorActive: () => false,
			requestRender: () => {
				renderRequests += 1;
			},
		});

		selector.handleInput(ENTER);
		selector.handleInput(ENTER);
		await previewStarted.promise;

		expect(renderRequests).toBe(1);
		previewGate.resolve({ available: true, value: plan });
		await Promise.resolve();

		expect(renderRequests).toBe(2);
		expect(Bun.stripANSI(selector.render(100).join("\n"))).toContain("Preview restore");
	});

	it("requests a redraw and surfaces an async preview failure", async () => {
		const checkpoint = checkpointRecord();
		const previewStarted = Promise.withResolvers<void>();
		const previewGate = Promise.withResolvers<WorkspaceCheckpointAccessResult<WorkspaceRestorePlan>>();
		let renderRequests = 0;
		const selector = new CheckpointSelectorComponent({
			checkpoints: [checkpoint],
			onPick: () => {},
			onCancel: () => {},
			preview: () => {
				previewStarted.resolve();
				return previewGate.promise;
			},
			apply: async () => ({ available: true, value: restoreResult(checkpoint.id, "code", "preserve") }),
			isMutatorActive: () => false,
			requestRender: () => {
				renderRequests += 1;
			},
		});

		selector.handleInput(ENTER);
		selector.handleInput(ENTER);
		await previewStarted.promise;

		expect(renderRequests).toBe(1);
		previewGate.reject(new Error("preview storage unavailable"));
		await Promise.resolve();

		expect(renderRequests).toBe(2);
		expect(Bun.stripANSI(selector.render(100).join("\n"))).toContain(
			"Cannot preview restore: preview storage unavailable",
		);
	});

	it("starts only one preview when Enter is repeated while preview is pending", async () => {
		const checkpoint = checkpointRecord();
		const plan = restorePlan(checkpoint.id, "code");
		const previewGate = Promise.withResolvers<WorkspaceCheckpointAccessResult<WorkspaceRestorePlan>>();
		let previewCalls = 0;
		const selector = new CheckpointSelectorComponent({
			checkpoints: [checkpoint],
			onPick: () => {},
			onCancel: () => {},
			preview: () => {
				previewCalls += 1;
				return previewGate.promise;
			},
			apply: async () => ({ available: true, value: restoreResult(checkpoint.id, plan.scope, plan.strategy) }),
			isMutatorActive: () => false,
			requestRender: () => {},
		});

		selector.handleInput(ENTER);
		selector.handleInput(ENTER);
		selector.handleInput(ENTER);

		expect(previewCalls).toBe(1);
		previewGate.resolve({ available: true, value: plan });
		await Promise.resolve();
		expect(Bun.stripANSI(selector.render(100).join("\n"))).toContain("Preview restore");
	});

	it("applies a resolved preview only once when Enter is repeated while apply is pending", async () => {
		const checkpoint = checkpointRecord();
		const plan = restorePlan(checkpoint.id, "code");
		const applyGate = Promise.withResolvers<WorkspaceCheckpointAccessResult<WorkspaceRestoreResult>>();
		const picked = Promise.withResolvers<void>();
		let applyCalls = 0;
		let pickedCalls = 0;
		const selector = new CheckpointSelectorComponent({
			checkpoints: [checkpoint],
			onPick: () => {
				pickedCalls += 1;
				picked.resolve();
			},
			onCancel: () => {},
			preview: async () => ({ available: true, value: plan }),
			apply: () => {
				applyCalls += 1;
				return applyGate.promise;
			},
			isMutatorActive: () => false,
			requestRender: () => {},
		});

		selector.handleInput(ENTER);
		selector.handleInput(ENTER);
		await Promise.resolve();
		selector.handleInput(ENTER);
		selector.handleInput(ENTER);

		expect(applyCalls).toBe(1);
		applyGate.resolve({ available: true, value: restoreResult(checkpoint.id, plan.scope, plan.strategy) });
		await picked.promise;
		expect(pickedCalls).toBe(1);
	});

	it("does not restore a canceled pending preview after Escape", async () => {
		const checkpoint = { ...checkpointRecord(), id: "ckpt_stale", label: "stale checkpoint" };
		const stalePreviewStarted = Promise.withResolvers<void>();
		const stalePreview = Promise.withResolvers<WorkspaceCheckpointAccessResult<WorkspaceRestorePlan>>();
		const selector = new CheckpointSelectorComponent({
			checkpoints: [checkpoint],
			onPick: () => {},
			onCancel: () => {},
			preview: () => {
				stalePreviewStarted.resolve();
				return stalePreview.promise;
			},
			apply: async () => ({ available: true, value: restoreResult(checkpoint.id, "code", "preserve") }),
			isMutatorActive: () => false,
			requestRender: () => {},
		});

		selector.handleInput(ENTER);
		selector.handleInput(ENTER);
		await stalePreviewStarted.promise;
		selector.handleInput(ESCAPE);
		stalePreview.resolve({ available: true, value: restorePlan(checkpoint.id, "code") });
		await Promise.resolve();

		const rendered = Bun.stripANSI(selector.render(100).join("\n"));
		expect(rendered).toContain("Choose restore scope");
		expect(rendered).not.toContain("Preview restore");
	});
});
