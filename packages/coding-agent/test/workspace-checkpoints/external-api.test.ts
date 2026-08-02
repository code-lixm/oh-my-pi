import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { commands, isSubcommand } from "@oh-my-pi/pi-coding-agent/cli-commands";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getDefault, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { WorkspaceCheckpointAccessResult } from "@oh-my-pi/pi-coding-agent/session/workspace-checkpoint-coordinator";
import type {
	WorkspaceCheckpointRecord,
	WorkspaceCheckpointService,
	WorkspaceRestorePlan,
	WorkspaceRestoreResult,
} from "@oh-my-pi/pi-coding-agent/workspace-checkpoints/types";
import { getAgentDir, getProjectDir, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { runCli } from "../../src/cli";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

class ProcessExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
	}
}

const cleanupRoots: string[] = [];
const createdSdkSessions: Array<{ dispose(): Promise<void> }> = [];
let settingsState: SettingsTestState | undefined;
let sharedRegistryRoot: string;
let sharedAuthStorage: AuthStorage;
let sharedModelRegistry: ModelRegistry;

function isoNow(): string {
	return new Date("2026-07-27T00:00:00.000Z").toISOString();
}

function makeCheckpointRecord(rootPath: string): WorkspaceCheckpointRecord {
	return {
		id: "ckpt_001",
		workspaceId: "ws_001",
		rootPath,
		manifestObjectId: "cas:manifest-001",
		parentId: null,
		sessionId: null,
		sessionEntryId: null,
		promptEntryId: null,
		label: "before-edit",
		reason: "manual",
		completeness: "complete",
		createdAt: isoNow(),
		fileCount: 1,
		totalBytes: 6,
		pinned: false,
	};
}

function makeRestorePlan(
	rootPath: string,
	metadata: Pick<WorkspaceRestorePlan, "scope" | "strategy">,
): WorkspaceRestorePlan {
	return {
		id: "plan_001",
		checkpointId: "ckpt_001",
		rootPath,
		scope: metadata.scope,
		strategy: metadata.strategy,
		operations: [{ path: "note.txt", kind: "update", objectId: "cas:file-001" }],
		conflicts: [],
		conversationEntryId: null,
		createdAt: isoNow(),
	};
}

function makeRestoreResult(
	plan: Pick<WorkspaceRestorePlan, "checkpointId" | "scope" | "strategy">,
): WorkspaceRestoreResult {
	return {
		transactionId: "tx_001",
		checkpointId: plan.checkpointId,
		guardCheckpointId: "ckpt_guard_001",
		restoredPaths: ["note.txt"],
		skippedPaths: [],
		conversationEntryId: null,
		redoAvailable: true,
		scope: plan.scope,
		strategy: plan.strategy,
	};
}
function appendUserMessage(sessionManager: SessionManager, text: string, timestamp: number): string {
	return sessionManager.appendMessage({ role: "user", content: text, timestamp });
}

function appendAssistantMessage(sessionManager: SessionManager, text: string, timestamp: number): string {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
	return sessionManager.appendMessage(message);
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.flatMap(part => (part?.type === "text" ? [part.text] : [])).join("");
}

function transcriptShape(messages: readonly AgentMessage[]): Array<{ role: AgentMessage["role"]; text: string }> {
	return messages.map(message => ({ role: message.role, text: messageText(message) }));
}

function syncSessionMessages(session: {
	agent: { replaceMessages(messages: AgentMessage[]): void };
	sessionManager: SessionManager;
}): void {
	session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
}

async function makeRoot(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanupRoots.push(root);
	return root;
}

function makeInputStream(lines: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(`${lines.join("\n")}\n`));
			controller.close();
		},
	});
}

function parseJsonLines(output: string): Array<Record<string, unknown>> {
	return output
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

async function runCliCapture(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	});
	const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
		stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	});
	const originalExitCode = process.exitCode;
	process.exitCode = 0;
	try {
		await runCli(argv);
		return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: process.exitCode ?? 0 };
	} finally {
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
		process.exitCode = originalExitCode;
	}
}

async function runCliJson<T>(argv: string[]): Promise<T> {
	const result = await runCliCapture(argv);
	expect(result.exitCode, result.stderr || result.stdout).toBe(0);
	expect(result.stderr).toBe("");
	return JSON.parse(result.stdout) as T;
}

interface OfflineCliWorkspace {
	agentDir: string;
	cwd: string;
}

function restoreEnvValue(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		delete Bun.env[name];
		return;
	}
	process.env[name] = value;
	Bun.env[name] = value;
}

async function withOfflineCliWorkspace<T>(
	prefix: string,
	callback: (workspace: OfflineCliWorkspace) => Promise<T>,
): Promise<T> {
	const root = await makeRoot(prefix);
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });

	const previousAgentDir = getAgentDir();
	const previousProjectDir = getProjectDir();
	const previousProcessCwd = process.cwd();
	const previousEnv = {
		NO_COLOR: process.env.NO_COLOR,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		PI_NO_TITLE: process.env.PI_NO_TITLE,
	};
	restoreEnvValue("NO_COLOR", "1");
	restoreEnvValue("PI_CODING_AGENT_DIR", agentDir);
	restoreEnvValue("PI_NO_TITLE", "1");
	setAgentDir(agentDir);
	setProjectDir(cwd);
	process.chdir(cwd);
	try {
		return await callback({ agentDir, cwd });
	} finally {
		process.chdir(previousProcessCwd);
		setProjectDir(previousProjectDir);
		setAgentDir(previousAgentDir);
		restoreEnvValue("NO_COLOR", previousEnv.NO_COLOR);
		restoreEnvValue("PI_CODING_AGENT_DIR", previousEnv.PI_CODING_AGENT_DIR);
		restoreEnvValue("PI_NO_TITLE", previousEnv.PI_NO_TITLE);
	}
}

type WorkspaceRpcMethod =
	| "createWorkspaceCheckpoint"
	| "listWorkspaceCheckpoints"
	| "previewWorkspaceRestore"
	| "applyWorkspaceRestore"
	| "undoWorkspace"
	| "redoWorkspace";

async function runWorkspaceRpcCase(input: {
	command: RpcCommand;
	method: WorkspaceRpcMethod;
	access: WorkspaceCheckpointAccessResult<unknown>;
}): Promise<{ response: RpcResponse; calls: unknown[][] }> {
	const cwd = await makeRoot("omp-rpc-workspace-");
	const writes: string[] = [];
	const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	});
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new ProcessExitSignal(code ?? 0);
	}) as typeof process.exit);
	const calls: unknown[][] = [];
	const invoke = vi.fn(async (...args: unknown[]) => {
		calls.push(args);
		return input.access;
	});
	const session = {
		extensionRunner: undefined,
		customCommands: [],
		skills: [],
		skillsSettings: undefined,
		sessionManager: { getCwd: () => cwd },
		setSlashCommands: () => {},
		subscribe: () => {},
		subscribeCommandMetadataChanged: () => {},
		dispose: async () => {},
		createWorkspaceCheckpoint: input.method === "createWorkspaceCheckpoint" ? invoke : vi.fn(),
		listWorkspaceCheckpoints: input.method === "listWorkspaceCheckpoints" ? invoke : vi.fn(),
		previewWorkspaceRestore: input.method === "previewWorkspaceRestore" ? invoke : vi.fn(),
		applyWorkspaceRestore: input.method === "applyWorkspaceRestore" ? invoke : vi.fn(),
		undoWorkspace: input.method === "undoWorkspace" ? invoke : vi.fn(),
		redoWorkspace: input.method === "redoWorkspace" ? invoke : vi.fn(),
	};
	try {
		await runRpcMode(session as never, undefined, undefined, makeInputStream([JSON.stringify(input.command)]));
		throw new Error("runRpcMode unexpectedly returned");
	} catch (error) {
		if (!(error instanceof ProcessExitSignal)) throw error;
		expect(error.code).toBe(0);
	} finally {
		stdoutSpy.mockRestore();
		exitSpy.mockRestore();
	}
	const frames = parseJsonLines(writes.join(""));
	const response = frames.find(frame => frame.type === "response" && frame.id === input.command.id) as
		| RpcResponse
		| undefined;
	expect(response).toBeDefined();
	return { response: response!, calls };
}

beforeAll(async () => {
	sharedRegistryRoot = await makeRoot("omp-workspace-external-sdk-");
	sharedAuthStorage = await AuthStorage.create(path.join(sharedRegistryRoot, "auth.db"));
	sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedRegistryRoot, "models.yml"));
});

beforeEach(() => {
	settingsState = beginSettingsTest();
});

afterEach(async () => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	AsyncJobManager.resetForTests();
	while (cleanupRoots.length > 1) {
		const root = cleanupRoots.pop();
		if (root) await fs.rm(root, { recursive: true, force: true });
	}
});

afterAll(async () => {
	for (const session of createdSdkSessions.splice(0)) {
		await session.dispose().catch(() => undefined);
	}
	sharedAuthStorage.close();
	AsyncJobManager.resetForTests();
	while (cleanupRoots.length > 0) {
		const root = cleanupRoots.pop();
		if (root) await fs.rm(root, { recursive: true, force: true });
	}
});

describe("workspace checkpoint external API contracts", () => {
	it("registers checkpoint/rewind/undo/redo as top-level CLI commands", () => {
		for (const name of ["checkpoint", "rewind", "undo", "redo"] as const) {
			expect(commands.some(command => command.name === name)).toBe(true);
			expect(isSubcommand(name)).toBe(true);
		}
	});

	it("keeps legacy and workspace checkpoint settings independent while preserving double-escape default", () => {
		expect(getDefault("doubleEscapeAction")).toBe("none");

		const legacyOnly = Settings.isolated({ "checkpoint.enabled": true });
		expect(legacyOnly.get("checkpoint.enabled")).toBe(true);
		expect(legacyOnly.get("workspaceCheckpoint.enabled")).toBe(true);

		const workspaceOnly = Settings.isolated({ "workspaceCheckpoint.enabled": false });
		expect(workspaceOnly.get("workspaceCheckpoint.enabled")).toBe(false);
		expect(workspaceOnly.get("checkpoint.enabled")).toBe(false);

		const split = Settings.isolated({
			"checkpoint.enabled": true,
			"workspaceCheckpoint.enabled": false,
		});
		expect(split.get("checkpoint.enabled")).toBe(true);
		expect(split.get("workspaceCheckpoint.enabled")).toBe(false);
		expect(split.get("doubleEscapeAction")).toBe("none");
	});

	it("keeps workspace checkpoint RPC command/response unions compile-safe", () => {
		const checkpointRequest = {
			rootPath: "/tmp/workspace",
			label: "before-edit",
			parentId: "parent-1",
			pinned: true,
		} satisfies Extract<RpcCommand, { type: "workspace_checkpoint_create" }>["request"];
		const previewRequest = {
			checkpointId: "ckpt_001",
			scope: "code",
			strategy: "preserve",
			paths: ["note.txt"],
			rootPath: "/tmp/workspace",
		} satisfies Extract<RpcCommand, { type: "workspace_restore_preview" }>["request"];
		const record = makeCheckpointRecord("/tmp/workspace");
		const plan = makeRestorePlan("/tmp/workspace", previewRequest);
		const result = makeRestoreResult(plan);

		const createCommand = {
			type: "workspace_checkpoint_create",
			request: checkpointRequest,
		} satisfies Extract<RpcCommand, { type: "workspace_checkpoint_create" }>;
		const listCommand = {
			type: "workspace_checkpoint_list",
			rootPath: "/tmp/workspace",
			limit: 10,
		} satisfies Extract<RpcCommand, { type: "workspace_checkpoint_list" }>;
		const previewCommand = {
			type: "workspace_restore_preview",
			request: previewRequest,
		} satisfies Extract<RpcCommand, { type: "workspace_restore_preview" }>;
		const applyCommand = {
			type: "workspace_restore_apply",
			request: { planId: plan.id, allowConflicts: true },
		} satisfies Extract<RpcCommand, { type: "workspace_restore_apply" }>;
		const undoCommand = {
			type: "workspace_undo",
			scope: "all",
		} satisfies Extract<RpcCommand, { type: "workspace_undo" }>;
		const redoCommand = {
			type: "workspace_redo",
		} satisfies Extract<RpcCommand, { type: "workspace_redo" }>;

		const createResponse = {
			type: "response",
			command: "workspace_checkpoint_create",
			success: true,
			data: { record },
		} satisfies Extract<RpcResponse, { command: "workspace_checkpoint_create"; success: true }>;
		const listResponse = {
			type: "response",
			command: "workspace_checkpoint_list",
			success: true,
			data: { records: [record] },
		} satisfies Extract<RpcResponse, { command: "workspace_checkpoint_list"; success: true }>;
		const previewResponse = {
			type: "response",
			command: "workspace_restore_preview",
			success: true,
			data: { plan },
		} satisfies Extract<RpcResponse, { command: "workspace_restore_preview"; success: true }>;
		const applyResponse = {
			type: "response",
			command: "workspace_restore_apply",
			success: true,
			data: { result },
		} satisfies Extract<RpcResponse, { command: "workspace_restore_apply"; success: true }>;
		const undoResponse = {
			type: "response",
			command: "workspace_undo",
			success: true,
			data: { result },
		} satisfies Extract<RpcResponse, { command: "workspace_undo"; success: true }>;
		const redoResponse = {
			type: "response",
			command: "workspace_redo",
			success: true,
			data: { result },
		} satisfies Extract<RpcResponse, { command: "workspace_redo"; success: true }>;

		expectTypeOf(createCommand).toExtend<RpcCommand>();
		expectTypeOf(listCommand).toExtend<RpcCommand>();
		expectTypeOf(previewCommand).toExtend<RpcCommand>();
		expectTypeOf(applyCommand).toExtend<RpcCommand>();
		expectTypeOf(undoCommand).toExtend<RpcCommand>();
		expectTypeOf(redoCommand).toExtend<RpcCommand>();
		expectTypeOf(createResponse).toExtend<RpcResponse>();
		expectTypeOf(listResponse).toExtend<RpcResponse>();
		expectTypeOf(previewResponse).toExtend<RpcResponse>();
		expectTypeOf(applyResponse).toExtend<RpcResponse>();
		expectTypeOf(undoResponse).toExtend<RpcResponse>();
		expectTypeOf(redoResponse).toExtend<RpcResponse>();
		expect(createCommand.type).toBe("workspace_checkpoint_create");
		expect(redoResponse.command).toBe("workspace_redo");
	});

	it("routes all six workspace RPC commands to the corresponding AgentSession methods", async () => {
		const createRequest = {
			rootPath: "/tmp/workspace",
			label: "before-edit",
			parentId: "parent-1",
			pinned: true,
		} satisfies Extract<RpcCommand, { type: "workspace_checkpoint_create" }>["request"];
		const previewRequest = {
			checkpointId: "ckpt_001",
			scope: "code",
			strategy: "preserve",
			paths: ["note.txt"],
			rootPath: "/tmp/workspace",
		} satisfies Extract<RpcCommand, { type: "workspace_restore_preview" }>["request"];
		const record = makeCheckpointRecord("/tmp/workspace");
		const plan = makeRestorePlan("/tmp/workspace", previewRequest);
		const result = makeRestoreResult(plan);

		const cases: Array<{
			method: WorkspaceRpcMethod;
			command: RpcCommand;
			expectedArgs: unknown[];
			expectedResponse: RpcResponse;
			access: WorkspaceCheckpointAccessResult<unknown>;
		}> = [
			{
				method: "createWorkspaceCheckpoint",
				command: { id: "create-1", type: "workspace_checkpoint_create", request: createRequest },
				expectedArgs: ["before-edit", { rootPath: "/tmp/workspace", parentId: "parent-1", pinned: true }],
				expectedResponse: {
					id: "create-1",
					type: "response",
					command: "workspace_checkpoint_create",
					success: true,
					data: { record },
				},
				access: { available: true, value: record },
			},
			{
				method: "listWorkspaceCheckpoints",
				command: {
					id: "list-1",
					type: "workspace_checkpoint_list",
					rootPath: "/tmp/workspace",
					limit: 5,
				},
				expectedArgs: [{ rootPath: "/tmp/workspace", limit: 5 }],
				expectedResponse: {
					id: "list-1",
					type: "response",
					command: "workspace_checkpoint_list",
					success: true,
					data: { records: [record] },
				},
				access: { available: true, value: [record] },
			},
			{
				method: "previewWorkspaceRestore",
				command: {
					id: "preview-1",
					type: "workspace_restore_preview",
					request: previewRequest,
				},
				expectedArgs: [previewRequest],
				expectedResponse: {
					id: "preview-1",
					type: "response",
					command: "workspace_restore_preview",
					success: true,
					data: { plan },
				},
				access: { available: true, value: plan },
			},
			{
				method: "applyWorkspaceRestore",
				command: {
					id: "apply-1",
					type: "workspace_restore_apply",
					request: { planId: "plan_001", allowConflicts: true },
				},
				expectedArgs: ["plan_001", true],
				expectedResponse: {
					id: "apply-1",
					type: "response",
					command: "workspace_restore_apply",
					success: true,
					data: { result },
				},
				access: { available: true, value: result },
			},
			{
				method: "undoWorkspace",
				command: {
					id: "undo-1",
					type: "workspace_undo",
					scope: "all",
				},
				expectedArgs: ["all"],
				expectedResponse: {
					id: "undo-1",
					type: "response",
					command: "workspace_undo",
					success: true,
					data: { result },
				},
				access: { available: true, value: result },
			},
			{
				method: "redoWorkspace",
				command: {
					id: "redo-1",
					type: "workspace_redo",
				},
				expectedArgs: [],
				expectedResponse: {
					id: "redo-1",
					type: "response",
					command: "workspace_redo",
					success: true,
					data: { result },
				},
				access: { available: true, value: result },
			},
		];

		for (const testCase of cases) {
			const { response, calls } = await runWorkspaceRpcCase(testCase);
			expect(calls).toEqual([testCase.expectedArgs]);
			expect(response).toEqual(testCase.expectedResponse);
		}
	});

	it("surfaces unavailable workspace RPC access results as command errors", async () => {
		const cases: Array<{
			method: WorkspaceRpcMethod;
			command: RpcCommand;
			reason: NonNullable<WorkspaceCheckpointAccessResult<never>["reason"]>;
		}> = [
			{
				method: "createWorkspaceCheckpoint",
				command: {
					id: "create-unavailable",
					type: "workspace_checkpoint_create",
					request: { rootPath: "/tmp/workspace" },
				},
				reason: "service_unavailable",
			},
			{
				method: "listWorkspaceCheckpoints",
				command: {
					id: "list-unavailable",
					type: "workspace_checkpoint_list",
					rootPath: "/tmp/workspace",
				},
				reason: "service_unavailable",
			},
			{
				method: "previewWorkspaceRestore",
				command: {
					id: "preview-unavailable",
					type: "workspace_restore_preview",
					request: { checkpointId: "ckpt_001", scope: "code", strategy: "preserve", rootPath: "/tmp/workspace" },
				},
				reason: "service_unavailable",
			},
			{
				method: "applyWorkspaceRestore",
				command: {
					id: "apply-unavailable",
					type: "workspace_restore_apply",
					request: { planId: "plan_001", allowConflicts: false },
				},
				reason: "mutator_active",
			},
			{
				method: "undoWorkspace",
				command: {
					id: "undo-unavailable",
					type: "workspace_undo",
					scope: "all",
				},
				reason: "no_undo",
			},
			{
				method: "redoWorkspace",
				command: {
					id: "redo-unavailable",
					type: "workspace_redo",
				},
				reason: "service_unavailable",
			},
		];

		for (const testCase of cases) {
			const { response } = await runWorkspaceRpcCase({
				command: testCase.command,
				method: testCase.method,
				access: { available: false, reason: testCase.reason },
			});
			expect(response).toEqual({
				id: testCase.command.id,
				type: "response",
				command: testCase.command.type,
				success: false,
				error: testCase.reason,
			});
		}
	});

	it("restores persisted SDK conversation history for conversation and all scopes", async () => {
		const { createAgentSession } = await import("@oh-my-pi/pi-coding-agent/sdk");
		const cases = [
			{ scope: "conversation" as const, expectedFile: "after\n", expectCodeRestore: false },
			{ scope: "all" as const, expectedFile: "before\n", expectCodeRestore: true },
		];

		for (const testCase of cases) {
			const root = await makeRoot(`omp-sdk-restore-${testCase.scope}-`);
			const cwd = path.join(root, "project");
			const agentDir = path.join(root, "agent");
			const sessionDir = path.join(agentDir, "sessions");
			const notePath = path.join(cwd, "note.txt");
			await fs.mkdir(cwd, { recursive: true });
			await fs.mkdir(agentDir, { recursive: true });
			await fs.writeFile(notePath, "before\n", "utf8");

			const created = await createAgentSession({
				cwd,
				agentDir,
				modelRegistry: sharedModelRegistry,
				sessionManager: SessionManager.create(cwd, sessionDir),
				settings: Settings.isolated({}),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
			});
			createdSdkSessions.push(created.session);
			expect(created.session.hasWorkspaceCheckpoint()).toBe(true);

			appendUserMessage(created.session.sessionManager, `checkpoint ${testCase.scope} question`, 1);
			const checkpointLeafId = appendAssistantMessage(
				created.session.sessionManager,
				`checkpoint ${testCase.scope} answer`,
				2,
			);
			syncSessionMessages(created.session);
			await created.session.sessionManager.flush();
			const checkpointTranscript = transcriptShape(created.session.buildDisplaySessionContext().messages);

			const checkpointAccess = await created.session.createWorkspaceCheckpoint(`sdk-${testCase.scope}`, {
				rootPath: cwd,
			});
			expect(checkpointAccess.available).toBe(true);
			if (!checkpointAccess.available || !checkpointAccess.value) {
				throw new Error(`expected SDK checkpoint for ${testCase.scope} to succeed`);
			}
			const checkpoint = checkpointAccess.value;
			expect(checkpoint.sessionEntryId).toBe(checkpointLeafId);

			await fs.writeFile(notePath, "after\n", "utf8");
			appendUserMessage(created.session.sessionManager, `follow-up ${testCase.scope}`, 3);
			appendAssistantMessage(created.session.sessionManager, `follow-up ${testCase.scope} answer`, 4);
			syncSessionMessages(created.session);
			await created.session.sessionManager.flush();
			expect(transcriptShape(created.session.buildDisplaySessionContext().messages)).not.toEqual(
				checkpointTranscript,
			);

			const previewRequest = {
				checkpointId: checkpoint.id,
				scope: testCase.scope,
				strategy: "preserve" as const,
				rootPath: cwd,
			};
			const previewAccess = await created.session.previewWorkspaceRestore(previewRequest);
			expect(previewAccess.available).toBe(true);
			if (!previewAccess.available || !previewAccess.value) {
				throw new Error(`expected SDK preview for ${testCase.scope} to succeed`);
			}
			const preview = previewAccess.value;
			expect(preview.conversationEntryId).toBe(checkpointLeafId);
			if (testCase.expectCodeRestore) {
				expect(preview.operations.some(operation => operation.path === "note.txt")).toBe(true);
			} else {
				expect(preview.operations).toEqual([]);
			}

			const applyAccess = await created.session.applyWorkspaceRestore(preview.id, true);
			if (!applyAccess.available || !applyAccess.value) {
				throw new Error(`expected SDK restore for ${testCase.scope} to succeed: ${JSON.stringify(applyAccess)}`);
			}
			expect(applyAccess.available).toBe(true);
			expect(applyAccess.value.conversationEntryId).toBe(checkpointLeafId);
			expect(applyAccess.value.scope).toBe(previewRequest.scope);
			expect(applyAccess.value.strategy).toBe(previewRequest.strategy);
			const restoredConversationLeaf = [...created.session.sessionManager.getBranch()]
				.reverse()
				.find(entry => entry.type === "message");
			expect(restoredConversationLeaf?.id).toBe(checkpointLeafId);
			expect(transcriptShape(created.session.buildDisplaySessionContext().messages)).toEqual(checkpointTranscript);
			expect(await fs.readFile(notePath, "utf8")).toBe(testCase.expectedFile);
		}
	});

	it("does not inject workspace checkpoints into disabled or subagent SDK sessions", async () => {
		const { createAgentSession } = await import("@oh-my-pi/pi-coding-agent/sdk");
		const disabledRoot = await makeRoot("omp-sdk-disabled-");
		const disabledCwd = path.join(disabledRoot, "project");
		const disabledAgentDir = path.join(disabledRoot, "agent");
		await fs.mkdir(disabledCwd, { recursive: true });
		await fs.mkdir(disabledAgentDir, { recursive: true });
		await fs.writeFile(path.join(disabledCwd, "note.txt"), "disabled\n", "utf8");

		const disabled = await createAgentSession({
			cwd: disabledCwd,
			agentDir: disabledAgentDir,
			modelRegistry: sharedModelRegistry,
			sessionManager: SessionManager.inMemory(disabledCwd),
			settings: Settings.isolated({ "workspaceCheckpoint.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		createdSdkSessions.push(disabled.session);
		expect(disabled.session.hasWorkspaceCheckpoint()).toBe(false);
		const disabledAccess = await disabled.session.createWorkspaceCheckpoint("sdk-disabled", {
			rootPath: disabledCwd,
		});
		expect(disabledAccess).toMatchObject({ available: false, reason: "service_unavailable" });

		const subRoot = await makeRoot("omp-sdk-sub-");
		const subCwd = path.join(subRoot, "project");
		const subAgentDir = path.join(subRoot, "agent");
		await fs.mkdir(subCwd, { recursive: true });
		await fs.mkdir(subAgentDir, { recursive: true });
		await fs.writeFile(path.join(subCwd, "note.txt"), "sub\n", "utf8");

		const subagent = await createAgentSession({
			cwd: subCwd,
			agentDir: subAgentDir,
			modelRegistry: sharedModelRegistry,
			sessionManager: SessionManager.inMemory(subCwd),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			taskDepth: 1,
			parentTaskPrefix: "ChildAgent",
		});
		createdSdkSessions.push(subagent.session);
		expect(subagent.session.hasWorkspaceCheckpoint()).toBe(false);
		const subAccess = await subagent.session.createWorkspaceCheckpoint("sdk-sub", { rootPath: subCwd });
		expect(subAccess).toMatchObject({ available: false, reason: "service_unavailable" });
	});

	it("runs offline checkpoint, list, and preview flows against an isolated non-git workspace", async () => {
		const root = await makeRoot("omp-workspace-checkpoint-cli-");
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		const notePath = path.join(cwd, "note.txt");
		await fs.writeFile(notePath, "before\n", "utf8");

		const workspaceCheckpointModule = await import("../../src/workspace-checkpoints");
		const originalFactory = workspaceCheckpointModule.createWorkspaceCheckpointService;
		const createdServices: Promise<WorkspaceCheckpointService>[] = [];
		vi.spyOn(workspaceCheckpointModule, "createWorkspaceCheckpointService").mockImplementation((options => {
			const promise = originalFactory(options);
			createdServices.push(promise);
			return promise;
		}) as typeof workspaceCheckpointModule.createWorkspaceCheckpointService);

		const previousNoColor = process.env.NO_COLOR;
		const previousPiNoTitle = process.env.PI_NO_TITLE;
		const previousProcessCwd = process.cwd();
		process.env.NO_COLOR = "1";
		process.env.PI_NO_TITLE = "1";
		process.env.PI_CODING_AGENT_DIR = agentDir;
		setAgentDir(agentDir);
		setProjectDir(cwd);
		process.chdir(cwd);
		try {
			const checkpoint = await runCliJson<WorkspaceCheckpointRecord>(["checkpoint", "before-edit", "--json"]);
			expect(checkpoint.rootPath).toBe(cwd);
			expect(checkpoint.reason).toBe("manual");
			expect(checkpoint.label).toBe("before-edit");
			expect(checkpoint.sessionId).toBeNull();
			expect(checkpoint.fileCount).toBeGreaterThanOrEqual(1);

			await fs.writeFile(notePath, "after\n", "utf8");

			const listed = await runCliJson<WorkspaceCheckpointRecord[]>(["rewind", "list", checkpoint.id, "--json"]);
			expect(listed.map(entry => entry.id)).toContain(checkpoint.id);
			expect(listed[0]?.rootPath).toBe(cwd);

			const preview = await runCliJson<WorkspaceRestorePlan>(["rewind", "preview", checkpoint.id, "--json"]);
			expect(preview.checkpointId).toBe(checkpoint.id);
			expect(preview.rootPath).toBe(cwd);
			expect(preview.conversationEntryId).toBeNull();
			expect(preview.operations.some(operation => operation.path === "note.txt")).toBe(true);
		} finally {
			for (const service of await Promise.all(createdServices)) service.dispose();
			process.chdir(previousProcessCwd);
			if (previousNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = previousNoColor;
			if (previousPiNoTitle === undefined) delete process.env.PI_NO_TITLE;
			else process.env.PI_NO_TITLE = previousPiNoTitle;
		}
	});
	it("leaves files unchanged when rewind apply reports preview conflicts until --allow-conflicts is explicit", async () => {
		await withOfflineCliWorkspace("omp-workspace-checkpoint-cli-conflict-", async ({ cwd }) => {
			const conflictingPath = path.join(cwd, "conflicting.txt");
			const restoredPath = path.join(cwd, "restored.txt");
			await fs.writeFile(conflictingPath, "checkpoint conflict target\n", "utf8");
			await fs.writeFile(restoredPath, "checkpoint restore target\n", "utf8");
			const checkpoint = await runCliJson<WorkspaceCheckpointRecord>([
				"checkpoint",
				"before-conflicting-apply",
				"--json",
			]);

			await fs.rm(conflictingPath);
			await fs.mkdir(conflictingPath);
			await fs.writeFile(restoredPath, "live workspace content\n", "utf8");

			const blocked = await runCliCapture([
				"rewind",
				"apply",
				checkpoint.id,
				"--scope",
				"code",
				"--strategy",
				"preserve",
				"--json",
			]);
			expect(blocked.exitCode).toBe(1);
			expect(blocked.stdout).toBe("");
			expect(blocked.stderr).toContain("preview reported");
			expect(blocked.stderr).toContain("--allow-conflicts");
			expect(await fs.readFile(restoredPath, "utf8")).toBe("live workspace content\n");
			expect((await fs.lstat(conflictingPath)).isDirectory()).toBe(true);

			const applied = await runCliCapture([
				"rewind",
				"apply",
				checkpoint.id,
				"--scope",
				"code",
				"--strategy",
				"preserve",
				"--allow-conflicts",
				"--json",
			]);
			expect(applied.exitCode, applied.stderr).toBe(0);
			expect(applied.stderr).toBe("");
			const result = JSON.parse(applied.stdout) as WorkspaceRestoreResult;
			expect(result.scope).toBe("code");
			expect(result.strategy).toBe("preserve");
			expect(result.restoredPaths).toContain("restored.txt");
			expect(await fs.readFile(restoredPath, "utf8")).toBe("checkpoint restore target\n");
		});
	});

	it("rejects omp redo until a successful apply has been undone", async () => {
		await withOfflineCliWorkspace("omp-workspace-checkpoint-cli-redo-boundary-", async ({ cwd }) => {
			const notePath = path.join(cwd, "note.txt");
			await fs.writeFile(notePath, "checkpoint content\n", "utf8");
			const checkpoint = await runCliJson<WorkspaceCheckpointRecord>([
				"checkpoint",
				"before-redo-boundary",
				"--json",
			]);
			await fs.writeFile(notePath, "pre-apply content\n", "utf8");

			const applied = await runCliCapture([
				"rewind",
				"apply",
				checkpoint.id,
				"--scope",
				"code",
				"--strategy",
				"preserve",
				"--json",
			]);
			expect(applied.exitCode, applied.stderr).toBe(0);
			expect(applied.stderr).toBe("");
			const applyResult = JSON.parse(applied.stdout) as WorkspaceRestoreResult;
			expect(applyResult.scope).toBe("code");
			expect(applyResult.strategy).toBe("preserve");
			expect(applyResult.restoredPaths).toContain("note.txt");
			expect(await fs.readFile(notePath, "utf8")).toBe("checkpoint content\n");

			const prematureRedo = await runCliCapture(["redo", "--json"]);
			expect(prematureRedo.exitCode).toBe(1);
			expect(prematureRedo.stdout).toBe("");
			expect(prematureRedo.stderr).toContain("no redo");
			expect(await fs.readFile(notePath, "utf8")).toBe("checkpoint content\n");
		});
	});

	it("restores pre-apply files with undo, checkpoint files with redo, and pre-apply files with a second undo", async () => {
		await withOfflineCliWorkspace("omp-workspace-checkpoint-cli-undo-redo-", async ({ cwd }) => {
			const notePath = path.join(cwd, "note.txt");
			await fs.writeFile(notePath, "checkpoint content\n", "utf8");
			const checkpoint = await runCliJson<WorkspaceCheckpointRecord>(["checkpoint", "before-undo-redo", "--json"]);
			await fs.writeFile(notePath, "pre-apply content\n", "utf8");

			const applied = await runCliCapture([
				"rewind",
				"apply",
				checkpoint.id,
				"--scope",
				"code",
				"--strategy",
				"preserve",
				"--json",
			]);
			expect(applied.exitCode, applied.stderr).toBe(0);
			expect(applied.stderr).toBe("");
			const applyResult = JSON.parse(applied.stdout) as WorkspaceRestoreResult;
			expect(applyResult.scope).toBe("code");
			expect(applyResult.strategy).toBe("preserve");
			expect(applyResult.restoredPaths).toContain("note.txt");
			expect(await fs.readFile(notePath, "utf8")).toBe("checkpoint content\n");

			const undone = await runCliCapture(["undo", "--scope", "code", "--json"]);
			expect(undone.exitCode, undone.stderr).toBe(0);
			expect(undone.stderr).toBe("");
			const undoResult = JSON.parse(undone.stdout) as WorkspaceRestoreResult;
			expect(undoResult.scope).toBe("code");
			expect(undoResult.strategy).toBe("preserve");
			const afterUndo = await fs.readFile(notePath, "utf8");

			const redone = await runCliCapture(["redo", "--json"]);
			expect(redone.exitCode, redone.stderr).toBe(0);
			expect(redone.stderr).toBe("");
			const redoResult = JSON.parse(redone.stdout) as WorkspaceRestoreResult;
			expect(redoResult.scope).toBe("code");
			expect(redoResult.strategy).toBe("preserve");
			const afterRedo = await fs.readFile(notePath, "utf8");

			const undoneAgain = await runCliCapture(["undo", "--scope", "code", "--json"]);
			expect(undoneAgain.exitCode, undoneAgain.stderr).toBe(0);
			expect(undoneAgain.stderr).toBe("");
			const secondUndoResult = JSON.parse(undoneAgain.stdout) as WorkspaceRestoreResult;
			expect(secondUndoResult.scope).toBe("code");
			expect(secondUndoResult.strategy).toBe("preserve");
			const afterSecondUndo = await fs.readFile(notePath, "utf8");
			expect({ afterUndo, afterRedo, afterSecondUndo }).toEqual({
				afterUndo: "pre-apply content\n",
				afterRedo: "checkpoint content\n",
				afterSecondUndo: "pre-apply content\n",
			});
			expect(undoResult.restoredPaths).toContain("note.txt");
			expect(redoResult.restoredPaths).toContain("note.txt");
			expect(secondUndoResult.restoredPaths).toContain("note.txt");
		});
	});
});
