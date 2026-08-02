import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { createMockModel, type MockModel, type MockModelOptions } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { BashResult } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { LoadedCustomCommand } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type {
	SessionEntry,
	WorkspaceCheckpointEntry,
	WorkspaceRestoreEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type {
	ApplyWorkspaceRestoreRequest,
	CaptureIgnoredPathBaselineRequest,
	CreateWorkspaceCheckpointRequest,
	ListWorkspaceCheckpointsRequest,
	PreviewWorkspaceRestoreRequest,
	RedoWorkspaceRequest,
	UndoWorkspaceRequest,
	WorkspaceCheckpointMutatorGuard,
	WorkspaceCheckpointRecord,
	WorkspaceCheckpointService,
	WorkspaceRestorePlan,
	WorkspaceRestoreResult,
} from "@oh-my-pi/pi-coding-agent/workspace-checkpoints/types";
import { TempDir } from "@oh-my-pi/pi-utils";

type CreateRequest = CreateWorkspaceCheckpointRequest;
type CaptureRequest = CaptureIgnoredPathBaselineRequest;
type CheckpointRecord = WorkspaceCheckpointRecord;
type ListRequest = ListWorkspaceCheckpointsRequest;
type PreviewRequest = PreviewWorkspaceRestoreRequest;
type RestoreRequest = ApplyWorkspaceRestoreRequest;
type RestoreResult = WorkspaceRestoreResult;
type UndoRequest = UndoWorkspaceRequest;
type UndoResult = WorkspaceRestoreResult;
type RedoRequest = RedoWorkspaceRequest;
type RedoResult = WorkspaceRestoreResult;
type PreviewPlan = WorkspaceRestorePlan;

type Harness = {
	tempDir: TempDir;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	sessionManager: SessionManager;
	session: AgentSession;
	service: RecordingCheckpointService;
	mock: MockModel;
	extraSessions: AgentSession[];
};

const activeHarnesses: Harness[] = [];

const BASH_RESULT: BashResult = {
	output: "ok\n",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	totalLines: 1,
	totalBytes: 3,
	outputLines: 1,
	outputBytes: 3,
};

class RecordingCheckpointService implements WorkspaceCheckpointService {
	createCalls: CreateRequest[] = [];
	listCalls: ListRequest[] = [];
	previewCalls: PreviewRequest[] = [];
	restoreCalls: RestoreRequest[] = [];
	undoCalls: UndoRequest[] = [];
	redoCalls: RedoRequest[] = [];
	captureIgnoredCalls: CaptureRequest[] = [];
	records: CheckpointRecord[] = [];
	plans = new Map<string, PreviewPlan>();
	nextPreviewPlan: PreviewPlan | undefined;
	nextRestoreResult: RestoreResult | undefined;
	nextUndoResult: UndoResult | undefined;
	nextRedoResult: RedoResult | undefined;
	#createIndex = 0;
	#restoreIndex = 0;
	#undoIndex = 0;
	#redoIndex = 0;

	async create(request: CreateRequest): Promise<CheckpointRecord> {
		this.createCalls.push({ ...request });
		const record: CheckpointRecord = {
			id: `cp-${++this.#createIndex}`,
			workspaceId: `ws-${this.#createIndex}`,
			rootPath: request.rootPath,
			manifestObjectId: `manifest-${this.#createIndex}`,
			parentId: request.parentId ?? null,
			sessionId: request.sessionId ?? null,
			sessionEntryId: request.sessionEntryId ?? null,
			promptEntryId: null,
			label: request.label ?? null,
			reason: request.reason,
			completeness: "complete",
			createdAt: `2026-01-01T00:00:0${this.#createIndex}.000Z`,
			fileCount: 1,
			totalBytes: 10,
			pinned: request.pinned ?? false,
		};
		this.records.unshift(record);
		return record;
	}

	async list(request: ListRequest): Promise<CheckpointRecord[]> {
		this.listCalls.push({ ...request });
		const filtered = this.records.filter(record => {
			if (record.rootPath !== request.rootPath) return false;
			if (request.sessionId !== undefined && record.sessionId !== request.sessionId) return false;
			return true;
		});
		return request.limit === undefined ? filtered : filtered.slice(0, request.limit);
	}

	async previewRestore(request: PreviewRequest): Promise<PreviewPlan> {
		this.previewCalls.push({ ...request, paths: request.paths ? [...request.paths] : undefined });
		const plan =
			this.nextPreviewPlan ??
			({
				id: `plan-${this.previewCalls.length}`,
				checkpointId: request.checkpointId,
				rootPath: this.records.find(record => record.id === request.checkpointId)?.rootPath ?? "/workspace",
				scope: request.scope,
				strategy: request.strategy,
				operations: (request.paths ?? ["src/app.ts"]).map(pathname => ({
					path: pathname,
					kind: "update" as const,
					objectId: `obj-${pathname}`,
				})),
				conflicts: [],
				conversationEntryId: null,
				createdAt: `2026-01-02T00:00:0${this.previewCalls.length}.000Z`,
			} satisfies PreviewPlan);
		this.plans.set(plan.id, plan);
		this.nextPreviewPlan = undefined;
		return plan;
	}

	async restore(request: RestoreRequest): Promise<RestoreResult> {
		this.restoreCalls.push({ ...request });
		if (this.nextRestoreResult) {
			const result = this.nextRestoreResult;
			this.nextRestoreResult = undefined;
			return result;
		}
		const plan = this.plans.get(request.planId);
		return {
			transactionId: `tx-restore-${++this.#restoreIndex}`,
			checkpointId: plan?.checkpointId ?? this.records[0]?.id ?? "cp-missing",
			guardCheckpointId: null,
			restoredPaths: plan?.operations.map(operation => operation.path) ?? ["src/app.ts"],
			skippedPaths: [],
			conversationEntryId: plan?.conversationEntryId ?? null,
			redoAvailable: true,
			scope: plan?.scope ?? "code",
			strategy: plan?.strategy ?? "preserve",
		};
	}

	async undo(request: UndoRequest): Promise<UndoResult> {
		this.undoCalls.push({ ...request });
		if (this.nextUndoResult) {
			const result = this.nextUndoResult;
			this.nextUndoResult = undefined;
			return result;
		}
		return {
			transactionId: `tx-undo-${++this.#undoIndex}`,
			checkpointId: this.records[0]?.id ?? "cp-missing",
			guardCheckpointId: null,
			restoredPaths: ["src/app.ts"],
			skippedPaths: [],
			conversationEntryId: null,
			redoAvailable: true,
			scope: request.scope ?? "code",
			strategy: "preserve",
		};
	}

	async redo(request: RedoRequest): Promise<RedoResult> {
		this.redoCalls.push({ ...request });
		if (this.nextRedoResult) {
			const result = this.nextRedoResult;
			this.nextRedoResult = undefined;
			return result;
		}
		return {
			transactionId: `tx-redo-${++this.#redoIndex}`,
			checkpointId: this.records[0]?.id ?? "cp-missing",
			guardCheckpointId: null,
			restoredPaths: ["src/app.ts"],
			skippedPaths: [],
			conversationEntryId: null,
			redoAvailable: false,
			scope: "code",
			strategy: "preserve",
		};
	}

	async captureIgnoredPathBaseline(request: CaptureRequest): Promise<CheckpointRecord | null> {
		this.captureIgnoredCalls.push({ ...request });
		return null;
	}

	dispose(): void {}
}

function workspaceCheckpointEntries(entries: SessionEntry[]): WorkspaceCheckpointEntry[] {
	return entries.filter((entry): entry is WorkspaceCheckpointEntry => entry.type === "workspace_checkpoint");
}

function workspaceRestoreEntries(entries: SessionEntry[]): WorkspaceRestoreEntry[] {
	return entries.filter((entry): entry is WorkspaceRestoreEntry => entry.type === "workspace_restore");
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(1);
	}
	throw new Error("Timed out waiting for condition");
}

async function createHarness(options?: {
	persist?: boolean;
	settings?: Record<string, unknown>;
	service?: RecordingCheckpointService;
	guard?: WorkspaceCheckpointMutatorGuard;
	customCommands?: LoadedCustomCommand[];
	extensionRunner?: ExtensionRunner;
	includeModel?: boolean;
	providerSessionId?: string;
	streamHandler?: MockModelOptions["handler"];
}): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-workspace-checkpoint-session-lifecycle-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	const service = options?.service ?? new RecordingCheckpointService();
	const mock = createMockModel({
		handler:
			options?.streamHandler ??
			(async () => ({
				content: ["done"],
				stopReason: "stop",
			})),
	});
	authStorage.setRuntimeApiKey(mock.provider, "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const sessionDir = path.join(tempDir.path(), "sessions");
	const sessionManager = options?.persist
		? SessionManager.create(tempDir.path(), sessionDir)
		: SessionManager.inMemory(tempDir.path());
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.eager": "default",
		"todo.reminders": false,
		"workspaceCheckpoint.enabled": true,
		"workspaceCheckpoint.auto": "turn",
		"workspaceCheckpoint.failurePolicy": "block",
		...options?.settings,
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: options?.includeModel === false ? (undefined as never) : mock,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		providerSessionId: options?.providerSessionId,
		workspaceCheckpointService: service,
		workspaceCheckpointMutatorGuard: options?.guard,
		customCommands: options?.customCommands,
		extensionRunner: options?.extensionRunner,
	});
	const harness: Harness = {
		tempDir,
		authStorage,
		modelRegistry,
		sessionManager,
		session,
		service,
		mock,
		extraSessions: [],
	};
	activeHarnesses.push(harness);
	return harness;
}

afterEach(async () => {
	vi.restoreAllMocks();
	while (activeHarnesses.length > 0) {
		const harness = activeHarnesses.pop();
		for (const extraSession of harness?.extraSessions ?? []) {
			await extraSession.dispose();
		}
		await harness?.session.dispose();
		harness?.service.dispose();
		harness?.authStorage.close();
		harness?.tempDir.removeSync();
	}
});

describe("AgentSession workspace checkpoint lifecycle", () => {
	it("creates exactly one turn checkpoint before the provider sees a top-level user prompt", async () => {
		let createCountSeenByProvider = -1;
		const harness = await createHarness({
			streamHandler: async () => {
				createCountSeenByProvider = harness.service.createCalls.length;
				return { content: ["answer"], stopReason: "stop" };
			},
		});

		expect(await harness.session.prompt("implement the fix")).toBe(true);
		await harness.session.waitForIdle();

		expect(createCountSeenByProvider).toBe(1);
		expect(harness.service.createCalls).toHaveLength(1);
		expect(harness.service.createCalls[0]).toMatchObject({
			reason: "turn",
			rootPath: harness.tempDir.path(),
			sessionId: harness.session.sessionId,
		});
		expect(
			harness.sessionManager
				.getEntries()
				.map(entry => entry.type)
				.slice(0, 3),
		).toEqual(["workspace_checkpoint", "message", "message"]);
	});

	it("does not checkpoint or mutate state when no model is selected", async () => {
		const harness = await createHarness({ includeModel: false });

		await expect(harness.session.prompt("should fail before any checkpoint")).rejects.toThrow("No model selected");

		expect(harness.service.createCalls).toHaveLength(0);
		expect(harness.sessionManager.getEntries()).toHaveLength(0);
		expect(harness.mock.calls).toHaveLength(0);
	});

	it("does not checkpoint or start the provider when API-key preflight fails", async () => {
		const harness = await createHarness();
		vi.spyOn(harness.modelRegistry, "getApiKey").mockResolvedValue(undefined as never);

		await expect(harness.session.prompt("missing credentials")).rejects.toThrow(
			`No API key found for ${harness.mock.provider}`,
		);

		expect(harness.service.createCalls).toHaveLength(0);
		expect(harness.sessionManager.getEntries()).toHaveLength(0);
		expect(harness.mock.calls).toHaveLength(0);
	});

	it("does not duplicate checkpoints for synthetic prompts, manual retry, or manual compaction", async () => {
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "compact summary",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const harness = await createHarness({
			settings: { "compaction.enabled": true, "compaction.keepRecentTokens": 1 },
			streamHandler: (() => {
				let call = 0;
				return async () => {
					call += 1;
					if (call === 1) return { throw: "retry once" };
					if (call === 2) return { content: ["recovered"], stopReason: "stop" };
					if (call === 3) return { content: ["synthetic done"], stopReason: "stop" };
					return { content: ["more visible history"], stopReason: "stop" };
				};
			})(),
		});

		expect(await harness.session.prompt("fail once")).toBe(true);
		await harness.session.waitForIdle();
		expect(harness.service.createCalls).toHaveLength(1);

		expect(await harness.session.retry()).toBe(true);
		await harness.session.waitForIdle();
		expect(harness.service.createCalls).toHaveLength(1);

		expect(await harness.session.prompt("hidden reminder", { synthetic: true })).toBe(true);
		await harness.session.waitForIdle();
		expect(harness.service.createCalls).toHaveLength(1);

		expect(await harness.session.prompt("create real history")).toBe(true);
		await harness.session.waitForIdle();
		expect(harness.service.createCalls).toHaveLength(2);

		expect(await harness.session.prompt("create enough history to compact")).toBe(true);
		await harness.session.waitForIdle();
		expect(harness.service.createCalls).toHaveLength(3);

		await harness.session.compact();

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(harness.service.createCalls).toHaveLength(3);
	});

	it("does not checkpoint a consumed extension slash command", async () => {
		const extensionHandler = vi.fn(async () => undefined);
		const harness = await createHarness({
			extensionRunner: {
				getCommand: (name: string) =>
					name === "local-ext" ? { name, description: "local", handler: extensionHandler } : undefined,
				createCommandContext: () => ({}) as never,
				emitError: vi.fn(),
				hasHandlers: vi.fn(() => false),
				emit: vi.fn(async () => undefined),
				clearManagedTimers: vi.fn(),
			} as unknown as ExtensionRunner,
		});

		expect(await harness.session.prompt("/local-ext")).toBe(false);

		expect(extensionHandler).toHaveBeenCalledTimes(1);
		expect(harness.service.createCalls).toHaveLength(0);
		expect(harness.mock.calls).toHaveLength(0);
		expect(harness.sessionManager.getEntries()).toHaveLength(0);
	});

	it("does not checkpoint a consumed custom slash command", async () => {
		const customExecute = vi.fn(async () => undefined);
		const harness = await createHarness({
			customCommands: [
				{
					path: "custom.ts",
					resolvedPath: "custom.ts",
					source: "project",
					command: {
						name: "local-custom",
						description: "local custom",
						execute: customExecute,
					},
				},
			],
		});

		expect(await harness.session.prompt("/local-custom alpha beta")).toBe(false);

		expect(customExecute).toHaveBeenCalledWith(["alpha", "beta"], expect.any(Object));
		expect(harness.service.createCalls).toHaveLength(0);
		expect(harness.mock.calls).toHaveLength(0);
		expect(harness.sessionManager.getEntries()).toHaveLength(0);
	});

	it("captures a queued steer only when the queued user turn is actually consumed", async () => {
		const firstTurnStarted = Promise.withResolvers<void>();
		const releaseFirstTurn = Promise.withResolvers<void>();
		let providerCalls = 0;
		let createCountAtSecondTurn = -1;
		const harness = await createHarness({
			streamHandler: async () => {
				providerCalls += 1;
				if (providerCalls === 1) {
					firstTurnStarted.resolve();
					await releaseFirstTurn.promise;
					return { content: ["first turn done"], stopReason: "stop" };
				}
				createCountAtSecondTurn = harness.service.createCalls.length;
				return { content: ["queued steer applied"], stopReason: "stop" };
			},
		});

		const firstPrompt = harness.session.prompt("start working");
		await firstTurnStarted.promise;
		await waitFor(() => harness.session.isStreaming);
		expect(harness.service.createCalls).toHaveLength(1);

		await harness.session.steer("queued steer");
		expect(harness.service.createCalls).toHaveLength(1);

		releaseFirstTurn.resolve();
		await firstPrompt;
		await waitFor(() => providerCalls === 2, 2_000);
		await harness.session.waitForIdle();

		expect(createCountAtSecondTurn).toBe(2);
		expect(harness.service.createCalls).toHaveLength(2);
		expect(harness.service.createCalls.map(call => call.reason)).toEqual(["turn", "turn"]);
	});

	it("captures a queued follow-up only when the queued user turn is actually consumed", async () => {
		const firstTurnStarted = Promise.withResolvers<void>();
		const releaseFirstTurn = Promise.withResolvers<void>();
		let providerCalls = 0;
		let createCountAtSecondTurn = -1;
		const harness = await createHarness({
			streamHandler: async () => {
				providerCalls += 1;
				if (providerCalls === 1) {
					firstTurnStarted.resolve();
					await releaseFirstTurn.promise;
					return { content: ["first turn done"], stopReason: "stop" };
				}
				createCountAtSecondTurn = harness.service.createCalls.length;
				return { content: ["queued follow-up applied"], stopReason: "stop" };
			},
		});

		const firstPrompt = harness.session.prompt("start working");
		await firstTurnStarted.promise;
		await waitFor(() => harness.session.isStreaming);
		expect(harness.service.createCalls).toHaveLength(1);

		await harness.session.followUp("queued follow-up");
		expect(harness.service.createCalls).toHaveLength(1);

		releaseFirstTurn.resolve();
		await firstPrompt;
		await waitFor(() => providerCalls === 2, 2_000);
		await harness.session.waitForIdle();

		expect(createCountAtSecondTurn).toBe(2);
		expect(harness.service.createCalls).toHaveLength(2);
		expect(harness.service.createCalls.map(call => call.reason)).toEqual(["turn", "turn"]);
	});

	it("respects disabled and auto-off settings for automatic turn checkpoints", async () => {
		const disabled = await createHarness({
			settings: { "workspaceCheckpoint.enabled": false },
			streamHandler: async () => ({ content: ["disabled ok"], stopReason: "stop" }),
		});

		expect(await disabled.session.prompt("disabled boundary")).toBe(true);
		await disabled.session.waitForIdle();
		expect(disabled.service.createCalls).toHaveLength(0);
		expect(disabled.mock.calls).toHaveLength(1);

		const autoOff = await createHarness({
			settings: { "workspaceCheckpoint.auto": "off" },
			streamHandler: async () => ({ content: ["auto off ok"], stopReason: "stop" }),
		});

		expect(await autoOff.session.prompt("auto off boundary")).toBe(true);
		await autoOff.session.waitForIdle();
		expect(autoOff.service.createCalls).toHaveLength(0);

		const manual = await autoOff.session.createWorkspaceCheckpoint("manual after auto-off", { pinned: true });
		expect(manual).toMatchObject({
			available: true,
			value: expect.objectContaining({ label: "manual after auto-off", reason: "manual", pinned: true }),
		});
		expect(autoOff.service.createCalls).toHaveLength(1);
		expect(autoOff.service.createCalls[0]?.reason).toBe("manual");
	});

	it("delegates the six public workspace-checkpoint methods with typed requests and responses", async () => {
		const harness = await createHarness();
		harness.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: 1 });
		const leafId = harness.sessionManager.getLeafId();
		if (!leafId) throw new Error("expected seeded leaf id");
		const previewPlan: PreviewPlan = {
			id: "plan-7",
			checkpointId: "cp-1",
			rootPath: harness.tempDir.path(),
			scope: "conversation",
			strategy: "exact",
			operations: [{ path: "src/a.ts", kind: "update", objectId: "obj-a" }],
			conflicts: [{ path: "src/b.ts", kind: "current_state_changed" as const, message: "changed" }],
			conversationEntryId: "conv-preview",
			createdAt: "2026-01-03T00:00:00.000Z",
		};
		harness.service.nextPreviewPlan = previewPlan;
		harness.service.nextRestoreResult = {
			transactionId: "tx-restore-explicit",
			checkpointId: "cp-1",
			guardCheckpointId: "cp-guard",
			restoredPaths: ["src/a.ts"],
			skippedPaths: ["src/b.ts"],
			conversationEntryId: "conv-restore",
			redoAvailable: true,
			scope: "conversation",
			strategy: "exact",
		};
		harness.service.nextUndoResult = {
			transactionId: "tx-undo-explicit",
			checkpointId: "cp-1",
			guardCheckpointId: null,
			restoredPaths: ["src/c.ts"],
			skippedPaths: [],
			conversationEntryId: "conv-undo",
			redoAvailable: true,
			scope: "code",
			strategy: "preserve",
		};
		harness.service.nextRedoResult = {
			transactionId: "tx-redo-explicit",
			checkpointId: "cp-1",
			guardCheckpointId: null,
			restoredPaths: ["src/d.ts"],
			skippedPaths: [],
			conversationEntryId: "conv-redo",
			redoAvailable: false,
			scope: "code",
			strategy: "preserve",
		};

		expect(harness.session.hasWorkspaceCheckpoint()).toBe(true);

		const created = await harness.session.createWorkspaceCheckpoint("manual-label", {
			parentId: "parent-cp",
			pinned: true,
		});
		if (!created.available) throw new Error(`expected checkpoint create to succeed: ${created.reason}`);
		const createdRecord = created.value;
		if (!createdRecord) throw new Error("expected checkpoint create to return a record");
		expect(created).toMatchObject({
			available: true,
			value: expect.objectContaining({ id: "cp-1", label: "manual-label", reason: "manual", pinned: true }),
		});
		expect(harness.service.createCalls[0]).toMatchObject({
			reason: "manual",
			label: "manual-label",
			parentId: "parent-cp",
			pinned: true,
			sessionId: harness.session.sessionId,
			sessionEntryId: leafId,
		});

		const listed = await harness.session.listWorkspaceCheckpoints({ limit: 1 });
		expect(listed).toMatchObject({
			available: true,
			value: [expect.objectContaining({ id: "cp-1", label: "manual-label" })],
		});
		expect(harness.service.listCalls.at(-1)).toMatchObject({
			rootPath: harness.tempDir.path(),
			sessionId: harness.session.sessionId,
			limit: 1,
		});

		const preview = await harness.session.previewWorkspaceRestore({
			checkpointId: "cp-1",
			scope: "conversation",
			strategy: "exact",
			paths: ["src/a.ts"],
		});
		expect(preview).toEqual({ available: true, value: previewPlan });
		expect(harness.service.previewCalls[0]).toEqual({
			checkpointId: "cp-1",
			sessionId: harness.sessionManager.getSessionId(),
			scope: "conversation",
			strategy: "exact",
			paths: ["src/a.ts"],
		});

		const applied = await harness.session.applyWorkspaceRestore("plan-7", true);
		expect(applied).toMatchObject({
			available: true,
			value: expect.objectContaining({
				transactionId: "tx-restore-explicit",
				conversationEntryId: "conv-restore",
			}),
		});
		expect(harness.service.restoreCalls[0]).toEqual({ planId: "plan-7", allowConflicts: true });

		const undone = await harness.session.undoWorkspace("code");
		expect(undone).toMatchObject({
			available: true,
			value: expect.objectContaining({
				transactionId: "tx-undo-explicit",
				conversationEntryId: "conv-undo",
			}),
		});
		expect(harness.service.undoCalls[0]).toEqual({
			rootPath: harness.tempDir.path(),
			sessionId: harness.session.sessionId,
			scope: "code",
		});

		const redone = await harness.session.redoWorkspace();
		expect(redone).toMatchObject({
			available: true,
			value: expect.objectContaining({
				transactionId: "tx-redo-explicit",
				conversationEntryId: "conv-redo",
			}),
		});
		expect(harness.service.redoCalls[0]).toEqual({
			rootPath: harness.tempDir.path(),
			sessionId: harness.session.sessionId,
		});
	});

	it("preserves previewed restore scope and strategy in persistent restore entries", async () => {
		const harness = await createHarness({ persist: true });
		const scenarios = [
			{
				planId: "plan-code-exact",
				checkpointId: "cp-code-exact",
				scope: "code" as const,
				strategy: "exact" as const,
			},
			{ planId: "plan-all-exact", checkpointId: "cp-all-exact", scope: "all" as const, strategy: "exact" as const },
		];

		for (const scenario of scenarios) {
			const plan: PreviewPlan = {
				id: scenario.planId,
				checkpointId: scenario.checkpointId,
				rootPath: harness.tempDir.path(),
				scope: scenario.scope,
				strategy: scenario.strategy,
				operations: [{ path: "src/app.ts", kind: "update", objectId: `object-${scenario.planId}` }],
				conflicts: [],
				conversationEntryId: null,
				createdAt: "2026-01-04T00:00:00.000Z",
			};
			harness.service.nextPreviewPlan = plan;

			const preview = await harness.session.previewWorkspaceRestore({
				checkpointId: scenario.checkpointId,
				scope: scenario.scope,
				strategy: scenario.strategy,
			});
			expect(preview).toEqual({ available: true, value: plan });

			const applied = await harness.session.applyWorkspaceRestore(scenario.planId);
			expect(applied).toMatchObject({
				available: true,
				value: expect.objectContaining({ checkpointId: scenario.checkpointId }),
			});
		}

		const expectedEntries = scenarios.map(({ planId, scope, strategy }) => ({ planId, scope, strategy }));
		expect(
			workspaceRestoreEntries(harness.sessionManager.getEntries()).map(entry => ({
				planId: entry.planId,
				scope: entry.scope,
				strategy: entry.strategy,
			})),
		).toEqual(expectedEntries);

		await harness.sessionManager.flush();
		const sessionFile = harness.session.sessionFile;
		if (!sessionFile) throw new Error("expected persisted session file");
		const reopened = await SessionManager.open(sessionFile, path.join(harness.tempDir.path(), "sessions"));
		expect(
			workspaceRestoreEntries(reopened.getEntries()).map(entry => ({
				planId: entry.planId,
				scope: entry.scope,
				strategy: entry.strategy,
			})),
		).toEqual(expectedEntries);
	});

	it("persists restore-result metadata without a local preview and rebuilds the cursor after reopen", async () => {
		const harness = await createHarness({ persist: true });
		const created = await harness.session.createWorkspaceCheckpoint("persisted checkpoint");
		if (!created.available) throw new Error(`expected checkpoint create to succeed: ${created.reason}`);
		const createdRecord = created.value;
		if (!createdRecord) throw new Error("expected checkpoint create to return a record");
		harness.service.nextRestoreResult = {
			transactionId: "tx-persisted-restore",
			checkpointId: createdRecord.id,
			guardCheckpointId: null,
			restoredPaths: ["src/persisted.ts"],
			skippedPaths: [],
			conversationEntryId: "conv-persisted",
			redoAvailable: true,
			scope: "code",
			strategy: "exact",
		};
		await harness.session.applyWorkspaceRestore("plan-persisted", true);
		await harness.sessionManager.flush();

		const sessionFile = harness.session.sessionFile;
		if (!sessionFile) throw new Error("expected persisted session file");

		const reopenedManager = await SessionManager.open(sessionFile, path.join(harness.tempDir.path(), "sessions"));
		const reopenedEntriesBeforeSession = reopenedManager.getEntries();
		expect(workspaceCheckpointEntries(harness.sessionManager.getEntries())).toHaveLength(1);
		expect(workspaceRestoreEntries(harness.sessionManager.getEntries())).toHaveLength(1);
		expect(workspaceCheckpointEntries(reopenedEntriesBeforeSession)).toHaveLength(1);
		expect(workspaceRestoreEntries(reopenedEntriesBeforeSession)).toHaveLength(1);
		expect(workspaceRestoreEntries(reopenedEntriesBeforeSession)).toEqual([
			expect.objectContaining({
				planId: "plan-persisted",
				checkpointId: createdRecord.id,
				scope: "code",
				strategy: "exact",
			}),
		]);

		const reopenedAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: harness.mock,
				systemPrompt: ["Test"],
				tools: [],
				messages: reopenedManager.buildSessionContext().messages,
			},
			streamFn: harness.mock.stream,
		});
		const reopened = new AgentSession({
			agent: reopenedAgent,
			sessionManager: reopenedManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"workspaceCheckpoint.enabled": true,
				"workspaceCheckpoint.auto": "turn",
			}),
			modelRegistry: harness.modelRegistry,
			workspaceCheckpointService: harness.service,
		});
		harness.extraSessions.push(reopened);

		const reopenedEntriesAfterSession = reopenedManager.getEntries();
		expect(workspaceCheckpointEntries(reopenedEntriesAfterSession)).toHaveLength(1);
		expect(workspaceRestoreEntries(reopenedEntriesAfterSession)).toHaveLength(1);

		expect(reopened.workspaceCheckpointCursor).toBeUndefined();
		const cursor = await reopened.refreshWorkspaceCheckpointCursor();
		expect(cursor).toEqual({
			undoHeadCheckpointId: createdRecord.id,
			redoHeadCheckpointId: null,
			lastCheckpointId: createdRecord.id,
		});
		expect(reopened.workspaceCheckpointCursor).toEqual(cursor);
	});

	it("uses SessionManager transcript IDs for checkpoint calls despite a shared providerSessionId", async () => {
		const providerSessionId = "provider-session-shared-across-transcripts";
		const harness = await createHarness({ providerSessionId });
		const firstRoot = harness.sessionManager.getCwd();
		const firstTranscriptId = harness.sessionManager.getSessionId();
		expect(firstTranscriptId).not.toBe(providerSessionId);
		expect(harness.session.sessionId).toBe(providerSessionId);

		await harness.session.createWorkspaceCheckpoint("before session transition");
		await harness.session.captureIgnoredMutationBaseline(path.join(firstRoot, "ignored", "before.txt"));
		await harness.session.listWorkspaceCheckpoints();
		await harness.session.undoWorkspace("code");
		await harness.session.redoWorkspace();
		expect(harness.service.createCalls.at(-1)).toMatchObject({ rootPath: firstRoot, sessionId: firstTranscriptId });
		expect(harness.service.captureIgnoredCalls.at(-1)).toMatchObject({
			rootPath: firstRoot,
			path: path.join(firstRoot, "ignored", "before.txt"),
			sessionId: firstTranscriptId,
		});
		expect(harness.service.listCalls.at(-1)).toMatchObject({ rootPath: firstRoot, sessionId: firstTranscriptId });
		expect(harness.service.undoCalls.at(-1)).toMatchObject({ rootPath: firstRoot, sessionId: firstTranscriptId });
		expect(harness.service.redoCalls.at(-1)).toMatchObject({ rootPath: firstRoot, sessionId: firstTranscriptId });

		const movedRoot = path.join(harness.tempDir.path(), "moved-workspace");
		fs.mkdirSync(movedRoot);
		expect(await harness.session.newSession()).toBe(true);
		await harness.session.moveSession(movedRoot);
		const movedTranscriptId = harness.sessionManager.getSessionId();
		expect(movedTranscriptId).not.toBe(firstTranscriptId);
		expect(movedTranscriptId).not.toBe(providerSessionId);
		expect(harness.session.sessionId).toBe(providerSessionId);

		await harness.session.createWorkspaceCheckpoint("after session transition");
		await harness.session.captureIgnoredMutationBaseline(path.join(movedRoot, "ignored", "after.txt"));
		await harness.session.listWorkspaceCheckpoints();
		await harness.session.undoWorkspace("code");
		await harness.session.redoWorkspace();
		expect(harness.service.createCalls.at(-1)).toMatchObject({ rootPath: movedRoot, sessionId: movedTranscriptId });
		expect(harness.service.captureIgnoredCalls.at(-1)).toMatchObject({
			rootPath: movedRoot,
			path: path.join(movedRoot, "ignored", "after.txt"),
			sessionId: movedTranscriptId,
		});
		expect(harness.service.listCalls.at(-1)).toMatchObject({ rootPath: movedRoot, sessionId: movedTranscriptId });
		expect(harness.service.undoCalls.at(-1)).toMatchObject({ rootPath: movedRoot, sessionId: movedTranscriptId });
		expect(harness.service.redoCalls.at(-1)).toMatchObject({ rootPath: movedRoot, sessionId: movedTranscriptId });
	});

	it("waits for active mutators or reports mutator_active before restoring", async () => {
		const idleGate = Promise.withResolvers<void>();
		const waitingGuard = {
			active: true,
			isMutatorActive() {
				return this.active;
			},
			async waitForIdle() {
				await idleGate.promise;
				this.active = false;
			},
		} satisfies WorkspaceCheckpointMutatorGuard & { active: boolean };
		const waiting = await createHarness({ guard: waitingGuard });

		const restorePromise = waiting.session.applyWorkspaceRestore("plan-wait", true);
		await Bun.sleep(10);
		expect(waiting.service.restoreCalls).toHaveLength(0);

		idleGate.resolve();
		const restored = await restorePromise;
		expect(restored).toMatchObject({
			available: true,
			value: expect.objectContaining({ transactionId: "tx-restore-1" }),
		});
		expect(waiting.service.restoreCalls).toEqual([{ planId: "plan-wait", allowConflicts: true }]);

		const blockedGuard = {
			isMutatorActive: () => true,
			waitForIdle: vi.fn(async () => {
				throw new Error("task merge still mutating");
			}),
		} satisfies WorkspaceCheckpointMutatorGuard;
		const blocked = await createHarness({ guard: blockedGuard });

		const blockedUndo = await blocked.session.undoWorkspace("all");
		expect(blockedUndo).toEqual({ available: false, reason: "mutator_active" });
		expect(blockedGuard.waitForIdle).toHaveBeenCalledWith(5_000);
		expect(blocked.service.undoCalls).toHaveLength(0);
	});

	it("creates a user_bash checkpoint before executing the bash mutator", async () => {
		let createCountSeenByBashExecutor = -1;
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async () => {
			createCountSeenByBashExecutor = harness.service.createCalls.length;
			return BASH_RESULT;
		});
		const harness = await createHarness();

		const result = await harness.session.executeBash("printf 'hello'", undefined, { excludeFromContext: false });

		expect(result).toEqual(BASH_RESULT);
		expect(createCountSeenByBashExecutor).toBe(1);
		expect(harness.service.createCalls).toHaveLength(1);
		expect(harness.service.createCalls[0]).toMatchObject({
			reason: "user_bash",
			label: "user_bash",
			rootPath: harness.tempDir.path(),
		});
		expect(workspaceCheckpointEntries(harness.sessionManager.getEntries())).toHaveLength(1);
	});
});
