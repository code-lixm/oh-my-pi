import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { RlmChildRegistry } from "@oh-my-pi/pi-coding-agent/registry/rlm-child-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { TempDir } from "@oh-my-pi/pi-utils";

const TASK_AGENT: AgentDefinition = {
	name: "task",
	description: "RLM task fixture",
	systemPrompt: "Complete the assigned RLM task.",
	source: "bundled",
	tools: ["read"],
};

interface RlmSessionFixture {
	session: AgentSession;
	authStorage: AuthStorage;
}

function taskResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "RLM child task",
		assignment: "Complete the RLM child task.",
		exitCode: 0,
		output: "child completed",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

async function createRlmSession(tempDir: TempDir): Promise<RlmSessionFixture> {
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Claude model for RLM SDK fixture");

	try {
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.join("agent"),
			agentId: "rlm-root",
			agentDisplayName: "rlm root",
			model,
			modelRegistry,
			settings: Settings.isolated({
				"async.enabled": true,
				"async.maxJobs": 4,
				"rlm.maxDepth": 3,
				"task.maxRecursionDepth": -1,
			}),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		return { session, authStorage };
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

function requireRlmJob(session: AgentSession, childId: string) {
	const manager = session.asyncJobManager;
	if (!manager) throw new Error("Expected the SDK RLM fixture to install an async job manager");
	const job = manager.getJob(childId);
	if (!job) throw new Error(`Expected RLM job ${childId}`);
	return job;
}

beforeEach(() => {
	AsyncJobManager.resetForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
	AsyncJobManager.resetForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

describe("SDK RLM task-session integration", () => {
	it("publishes an RLM child before task dispatch and retains its caller-owned task boundary", async () => {
		using tempDir = TempDir.createSync("@omp-rlm-session-");
		const fixture = await createRlmSession(tempDir);
		try {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [TASK_AGENT],
				projectAgentsDir: null,
			});
			const lifecycle = fixture.session.getRlmLifecycle();
			if (!lifecycle) throw new Error("Expected RLM lifecycle on explicitly enabled root SDK session");
			const dispatched: ExecutorOptions[] = [];
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				dispatched.push(options);
				const liveChild = lifecycle.listChildren().find(child => child.rlm_child_id === options.id);
				expect(liveChild).toMatchObject({ rlm_child_id: options.id, status: "running" });
				return taskResult(options.id);
			});

			const handle = await lifecycle.spawnChild("inspect lifecycle", {
				name: "lifecycle-worker",
				model: "anthropic/claude-sonnet-4-5",
			});
			await requireRlmJob(fixture.session, handle.rlm_child_id).promise;

			expect(dispatched).toHaveLength(1);
			expect(dispatched[0]).toMatchObject({
				id: handle.rlm_child_id,
				parentAgentId: "rlm-root",
				taskDepth: 0,
				artifactsDir: handle.session_dir,
				sessionFile: path.join(handle.session_dir, `${handle.rlm_child_id}.jsonl`),
				keepAlive: true,
			});
			expect(lifecycle.listChildren()).toEqual([
				expect.objectContaining({ rlm_child_id: handle.rlm_child_id, status: "completed" }),
			]);
		} finally {
			await fixture.session.dispose();
			fixture.authStorage.close();
		}
	});

	it("maps aborted, nonzero, and errored SingleResults to non-completed RLM children", async () => {
		using tempDir = TempDir.createSync("@omp-rlm-settlement-");
		const fixture = await createRlmSession(tempDir);
		try {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [TASK_AGENT],
				projectAgentsDir: null,
			});
			const cases: Array<{
				name: string;
				result: Partial<SingleResult>;
				expectedStatus: "cancelled" | "failed";
			}> = [
				{
					name: "aborted",
					result: {
						exitCode: 1,
						aborted: true,
						abortReason: "Cancelled by parent",
						error: "Cancelled by parent",
					},
					expectedStatus: "cancelled",
				},
				{
					name: "nonzero",
					result: { exitCode: 2, stderr: "worker exited 2" },
					expectedStatus: "failed",
				},
				{
					name: "errored",
					result: { error: "structured task failure" },
					expectedStatus: "failed",
				},
			];
			let next = 0;
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				const testCase = cases[next++];
				if (!testCase) throw new Error("Unexpected extra RLM task dispatch");
				return taskResult(options.id, testCase.result);
			});

			const lifecycle = fixture.session.getRlmLifecycle();
			if (!lifecycle) throw new Error("Expected RLM lifecycle on explicitly enabled root SDK session");
			for (const testCase of cases) {
				const handle = await lifecycle.spawnChild(`exercise ${testCase.name}`, {
					name: `${testCase.name}-worker`,
					model: "anthropic/claude-sonnet-4-5",
				});
				const job = requireRlmJob(fixture.session, handle.rlm_child_id);
				await job.promise;

				expect(job.status, testCase.name).not.toBe("completed");
				const child = lifecycle.listChildren().find(entry => entry.rlm_child_id === handle.rlm_child_id);
				expect(child, testCase.name).toMatchObject({ status: testCase.expectedStatus });
			}
		} finally {
			await fixture.session.dispose();
			fixture.authStorage.close();
		}
	});
	it("normalizes deferred RLM thinking suffixes while rejecting model mismatches", async () => {
		using tempDir = TempDir.createSync("@omp-rlm-model-match-");
		const fixture = await createRlmSession(tempDir);
		try {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [TASK_AGENT],
				projectAgentsDir: null,
			});
			const cases: Array<{
				name: string;
				requestedModel: string;
				resolvedModel: string;
				expectedStatus: "completed" | "failed";
			}> = [
				{
					name: "plain selector adopts high",
					requestedModel: "anthropic/claude-sonnet-4-5",
					resolvedModel: "anthropic/claude-sonnet-4-5:high",
					expectedStatus: "completed",
				},
				{
					name: "plain selector adopts max",
					requestedModel: "anthropic/claude-sonnet-4-5",
					resolvedModel: "anthropic/claude-sonnet-4-5:max",
					expectedStatus: "completed",
				},
				{
					name: "auto selector adopts concrete high",
					requestedModel: "anthropic/claude-sonnet-4-5:auto",
					resolvedModel: "anthropic/claude-sonnet-4-5:high",
					expectedStatus: "completed",
				},
				{
					name: "canonical provider and model case is accepted",
					requestedModel: "ANTHROPIC/CLAUDE-SONNET-4-5",
					resolvedModel: "anthropic/claude-sonnet-4-5:high",
					expectedStatus: "completed",
				},
				{
					name: "explicit low rejects high",
					requestedModel: "anthropic/claude-sonnet-4-5:low",
					resolvedModel: "anthropic/claude-sonnet-4-5:high",
					expectedStatus: "failed",
				},
				{
					name: "different provider rejects",
					requestedModel: "anthropic/claude-sonnet-4-5",
					resolvedModel: "openai/gpt-5.5:high",
					expectedStatus: "failed",
				},
				{
					name: "different model rejects",
					requestedModel: "anthropic/claude-sonnet-4-5",
					resolvedModel: "anthropic/claude-opus-4-5:high",
					expectedStatus: "failed",
				},
				{
					name: "literal max model is not a concrete suffix",
					requestedModel: "nanogpt/nanogpt/coding-router",
					resolvedModel: "nanogpt/nanogpt/coding-router:max",
					expectedStatus: "failed",
				},
			];
			let nextCase = 0;
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				const testCase = cases[nextCase++];
				if (!testCase) throw new Error("Unexpected extra RLM task dispatch");
				return taskResult(options.id, { resolvedModel: testCase.resolvedModel });
			});

			const lifecycle = fixture.session.getRlmLifecycle();
			if (!lifecycle) throw new Error("Expected RLM lifecycle on explicitly enabled root SDK session");
			for (const testCase of cases) {
				const handle = await lifecycle.spawnChild(`model ${testCase.name}`, {
					name: `${testCase.name}-worker`,
					model: testCase.requestedModel,
				});
				const job = requireRlmJob(fixture.session, handle.rlm_child_id);
				await job.promise;

				const child = lifecycle.listChildren().find(entry => entry.rlm_child_id === handle.rlm_child_id);
				expect(child, testCase.name).toMatchObject({ status: testCase.expectedStatus });
				expect(job.status, testCase.name).toBe(testCase.expectedStatus);
				if (testCase.expectedStatus === "failed") {
					expect(job.errorText, testCase.name).toContain("RLM child model mismatch");
				}
			}
		} finally {
			await fixture.session.dispose();
			fixture.authStorage.close();
		}
	});
	it("keeps nested RLM family state in its immediate parent's registry sidecar", async () => {
		using tempDir = TempDir.createSync("@omp-rlm-nested-registry-");
		let rootRegistry: RlmChildRegistry | undefined;
		const openRlmChildRegistry = RlmChildRegistry.open.bind(RlmChildRegistry);
		vi.spyOn(RlmChildRegistry, "open").mockImplementation(async parent => {
			const registry = await openRlmChildRegistry(parent);
			if (parent.parentAgentId === "rlm-root" && !rootRegistry) rootRegistry = registry;
			return registry;
		});
		const fixture = await createRlmSession(tempDir);
		let nestedSession: AgentSession | undefined;
		try {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [TASK_AGENT],
				projectAgentsDir: null,
			});
			const parentArtifactsDir = fixture.session.sessionManager.getArtifactsDir();
			if (!parentArtifactsDir) throw new Error("Expected a persisted parent RLM artifacts directory");
			const parentAgentId = fixture.session.getAgentId();
			if (!parentAgentId) throw new Error("Expected the root SDK session to have an agent id");
			const lifecycle = fixture.session.getRlmLifecycle();
			if (!lifecycle) throw new Error("Expected RLM lifecycle on explicitly enabled root SDK session");

			let nestedExecutorOptions: ExecutorOptions | undefined;
			let nestedSessionOptions: CreateAgentSessionOptions | undefined;
			const siblingAssignment = "complete sibling";
			const nestedAssignment = "inspect parent registry";
			const runRealSubprocess = executorModule.runSubprocess;
			const createRealAgentSession = createAgentSession;
			vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
				if (
					nestedExecutorOptions === undefined ||
					options?.agentId !== nestedExecutorOptions.id ||
					nestedSessionOptions !== undefined
				) {
					throw new Error("Expected the nested executor to create exactly one reserved RLM child session");
				}
				nestedSessionOptions = options;
				const created = await createRealAgentSession(options);
				nestedSession = created.session;
				vi.spyOn(nestedSession, "prompt").mockResolvedValue(true);
				vi.spyOn(nestedSession, "waitForIdle").mockResolvedValue(undefined);
				return created;
			});
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				if (options.assignment === siblingAssignment) return taskResult(options.id);
				if (options.assignment !== nestedAssignment || nestedExecutorOptions !== undefined) {
					throw new Error("Unexpected RLM task dispatch while creating the nested child");
				}
				nestedExecutorOptions = options;
				return await runRealSubprocess(options);
			});

			const sibling = await lifecycle.spawnChild(siblingAssignment, {
				name: "registry-sibling",
				model: "anthropic/claude-sonnet-4-5",
			});
			await requireRlmJob(fixture.session, sibling.rlm_child_id).promise;
			const nested = await lifecycle.spawnChild(nestedAssignment, {
				name: "registry-child",
				model: "anthropic/claude-sonnet-4-5",
			});
			await requireRlmJob(fixture.session, nested.rlm_child_id).promise.catch(() => undefined);

			if (!nestedExecutorOptions) throw new Error("Expected nested RLM executor options");
			if (!nestedSessionOptions) throw new Error("Expected nested RLM SDK session options");
			if (!nestedSession) throw new Error("Expected nested RLM SDK session");
			if (!rootRegistry) throw new Error("Expected the root lifecycle to retain its live RLM registry");
			expect(nestedExecutorOptions.parentRlmArtifactsDir).toBe(parentArtifactsDir);
			expect(nestedExecutorOptions.artifactsDir).not.toBe(parentArtifactsDir);
			expect(nestedSessionOptions.parentRlmArtifactsDir).toBe(parentArtifactsDir);
			expect(nestedSessionOptions.parentRlmArtifactsDir).toBe(nestedExecutorOptions.parentRlmArtifactsDir);
			expect(nestedExecutorOptions.parentRlmRegistry).toBe(rootRegistry);
			expect(nestedExecutorOptions.parentRlmRegistry?.snapshotEntries()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						rlm_child_id: sibling.rlm_child_id,
						session_name: sibling.name,
						status: "completed",
					}),
				]),
			);
			expect(nestedSessionOptions.parentRlmRegistry).toBe(rootRegistry);
			expect(nestedSessionOptions.parentRlmRegistry?.snapshotEntries()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						rlm_child_id: sibling.rlm_child_id,
						session_name: sibling.name,
						status: "completed",
					}),
				]),
			);

			const reopenedParentRegistry = await RlmChildRegistry.open({
				parentAgentId,
				parentSessionFile: fixture.session.sessionFile ?? null,
				artifactsDir: parentArtifactsDir,
			});
			const directChild = await reopenedParentRegistry.resolveDirectChild(nested.rlm_child_id);
			expect(directChild).toMatchObject({
				rlm_child_id: nested.rlm_child_id,
				session_dir: nestedExecutorOptions.artifactsDir,
			});

			const nestedLifecycle = nestedSession.getRlmLifecycle();
			if (!nestedLifecycle?.listAgents || !nestedLifecycle.sendMessage) {
				throw new Error("Expected nested RLM lifecycle family messaging");
			}
			expect(nestedLifecycle.listAgents()).toEqual(
				expect.arrayContaining([
					{ relationship: "parent", name: "parent", id: parentAgentId, status: "running" },
					{
						relationship: "sibling",
						name: sibling.name,
						id: sibling.rlm_child_id,
						status: "completed",
					},
				]),
			);
			const receipt = await nestedLifecycle.sendMessage("nested reply", { receiverRole: "parent" });
			expect(receipt).toEqual({ deliveryStatus: "delivered", receiverId: parentAgentId });
			expect((await reopenedParentRegistry.resolveDirectChild(nested.rlm_child_id)).replied_to_parent).toBe(true);
		} finally {
			await nestedSession?.dispose();
			await fixture.session.dispose();
			fixture.authStorage.close();
		}
	});
	it("cold-revives a parked nested RLM child with separate own and parent sidecars", async () => {
		using tempDir = TempDir.createSync("@omp-rlm-cold-revive-");
		const fixture = await createRlmSession(tempDir);
		let parentSession: AgentSession | undefined;
		let childSession: AgentSession | undefined;
		let revivedSession: AgentSession | undefined;
		let childWasDisposed = false;
		try {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [TASK_AGENT],
				projectAgentsDir: null,
			});
			const rootAgentId = fixture.session.getAgentId();
			if (!rootAgentId) throw new Error("Expected the RLM root session to have an agent id");
			const rootArtifactsDir = fixture.session.sessionManager.getArtifactsDir();
			if (!rootArtifactsDir) throw new Error("Expected the RLM root to expose its artifacts directory");
			const parentAgentId = "cold-revive-parent";
			const parentSidecarDir = RlmChildRegistry.childSessionDirFor(rootArtifactsDir, parentAgentId);
			const parentSessionManager = SessionManager.create(tempDir.path(), parentSidecarDir);
			const rootArtifactManager = fixture.session.sessionManager.getArtifactManager();
			if (!rootArtifactManager) throw new Error("Expected the RLM root to expose its artifact manager");
			parentSessionManager.adoptArtifactManager(rootArtifactManager);
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled Claude model for the nested RLM fixture");
			const createdParent = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.join("agent"),
				agentId: parentAgentId,
				agentDisplayName: "cold-revive-parent",
				parentTaskPrefix: parentAgentId,
				parentAgentId: rootAgentId,
				taskDepth: 1,
				rlmArtifactsDir: parentSidecarDir,
				parentRlmArtifactsDir: rootArtifactsDir,
				sessionManager: parentSessionManager,
				authStorage: fixture.authStorage,
				modelRegistry: new ModelRegistry(fixture.authStorage, tempDir.join("parent-models.yml")),
				model,
				settings: Settings.isolated({
					"async.enabled": true,
					"async.maxJobs": 4,
					"rlm.maxDepth": 3,
					"task.maxRecursionDepth": -1,
				}),
				requireYieldTool: true,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				hasUI: false,
			});
			const liveParentSession = createdParent.session;
			parentSession = liveParentSession;
			const parentLifecycle = liveParentSession.getRlmLifecycle();
			if (!parentLifecycle) throw new Error("Expected the immediate RLM parent lifecycle");

			const childAssignment = "create the cold-revived nested child";
			const runRealSubprocess = executorModule.runSubprocess;
			const createRealAgentSession = createAgentSession;
			let childExecutorOptions: ExecutorOptions | undefined;
			let captureColdReviveOptions = false;
			let coldReviveOptions: CreateAgentSessionOptions | undefined;
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				if (options.assignment !== childAssignment || childExecutorOptions !== undefined) {
					throw new Error("Expected exactly one nested RLM child dispatch from the live immediate parent");
				}
				childExecutorOptions = options;
				return await runRealSubprocess(options);
			});
			vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
				const isChild = childExecutorOptions !== undefined && options?.agentId === childExecutorOptions.id;
				const isColdRevive = captureColdReviveOptions;
				if (!isChild || (isColdRevive ? coldReviveOptions !== undefined : childSession !== undefined)) {
					throw new Error("Expected an SDK session request for exactly the nested RLM child");
				}
				if (isColdRevive) coldReviveOptions = options;
				const created = await createRealAgentSession(options);
				if (!isColdRevive) {
					const createdChildSession = created.session;
					childSession = createdChildSession;
					vi.spyOn(createdChildSession, "prompt").mockImplementation(async () => {
						createdChildSession.agent.emitExternalEvent({
							type: "tool_execution_end",
							toolCallId: "cold-revive-nested-yield",
							toolName: "yield",
							isError: false,
							result: {
								content: [{ type: "text", text: "Nested child fixture yielded." }],
								details: { status: "success", data: { ok: true } },
							},
						});
						return true;
					});
					vi.spyOn(createdChildSession, "waitForIdle").mockResolvedValue(undefined);
				}
				return created;
			});

			const childHandle = await parentLifecycle.spawnChild(childAssignment, {
				name: "cold-revive-child",
				model: "anthropic/claude-sonnet-4-5",
			});
			const childJob = requireRlmJob(liveParentSession, childHandle.rlm_child_id);
			await childJob.promise;
			if (childJob.status !== "completed") {
				throw new Error(childJob.errorText ?? `Nested RLM child job ended ${childJob.status}`);
			}
			if (!childExecutorOptions) throw new Error("Expected executor options for the nested RLM child");
			expect(childHandle.rlm_child_id).toBe(childExecutorOptions.id);
			if (!childSession) throw new Error("Expected the nested RLM child session");
			expect(childSession.getAgentId()).toBe(childHandle.rlm_child_id);
			const parentSessionFile = liveParentSession.sessionFile;
			const childSessionFile = childSession.sessionFile;
			if (!parentSessionFile || !childSessionFile) throw new Error("Expected persisted nested session files");
			const childSidecarDir = path.dirname(childSessionFile);
			const adoptedRootArtifactsDir = rootArtifactsDir;
			expect(path.dirname(parentSessionFile)).toBe(parentSidecarDir);
			expect(liveParentSession.sessionManager.getArtifactsDir()).toBe(adoptedRootArtifactsDir);
			expect(childExecutorOptions.parentRlmArtifactsDir).toBe(parentSidecarDir);
			expect(parentSidecarDir).not.toBe(adoptedRootArtifactsDir);

			await childSession.dispose();
			childWasDisposed = true;

			const parentRegistry = await RlmChildRegistry.open({
				parentAgentId,
				parentSessionFile,
				artifactsDir: parentSidecarDir,
				isJobLive: () => false,
			});
			const sibling = await parentRegistry.admit({
				rlmChildId: "cold-revive-sibling",
				name: "cold-revive-sibling",
				model: "anthropic/claude-sonnet-4-5",
				taskDepth: 2,
				maxDepth: 3,
			});
			await parentRegistry.markSettled(sibling.rlm_child_id, { status: "completed" });

			const childRegistry = await RlmChildRegistry.open({
				parentAgentId: childHandle.rlm_child_id,
				parentSessionFile: childSessionFile,
				artifactsDir: childSidecarDir,
				isJobLive: () => false,
			});
			const nested = await childRegistry.admit({
				rlmChildId: "cold-revive-grandchild",
				name: "cold-revive-grandchild",
				model: "anthropic/claude-sonnet-4-5",
				taskDepth: 3,
				maxDepth: 3,
			});
			await childRegistry.markSettled(nested.rlm_child_id, { status: "completed" });

			AgentLifecycleManager.resetGlobalForTests();
			const registry = AgentRegistry.global();
			const staleChild = registry.get(childHandle.rlm_child_id);
			if (staleChild) registry.unregister(childHandle.rlm_child_id, staleChild);
			const parkedChild = registry.register({
				id: childHandle.rlm_child_id,
				displayName: childHandle.name,
				kind: "sub",
				parentId: parentAgentId,
				status: "parked",
				session: null,
				sessionFile: childSessionFile,
			});
			expect(parkedChild.status).toBe("parked");

			const reviverFactory = createPersistedSubagentReviverFactory({
				session: parentSession,
				authStorage: fixture.authStorage,
				modelRegistry: new ModelRegistry(fixture.authStorage, tempDir.join("revive-models.yml")),
				settings: Settings.isolated({
					"async.enabled": true,
					"async.maxJobs": 4,
					"rlm.maxDepth": 3,
					"task.maxRecursionDepth": -1,
				}),
				enableLsp: false,
			});
			AgentLifecycleManager.global().setPersistedSubagentReviverFactory(reviverFactory, 60_000);
			captureColdReviveOptions = true;
			revivedSession = await AgentLifecycleManager.global().ensureLive(parkedChild.id);

			if (!coldReviveOptions) {
				throw new Error("Expected the persisted reviver to create the parked nested RLM child session");
			}
			expect(coldReviveOptions).toMatchObject({
				agentId: childHandle.rlm_child_id,
				parentAgentId,
				rlmArtifactsDir: childSidecarDir,
				parentRlmArtifactsDir: parentSidecarDir,
			});
			expect(coldReviveOptions.parentRlmArtifactsDir).not.toBe(adoptedRootArtifactsDir);
			const revivedLifecycle = revivedSession.getRlmLifecycle();
			if (!revivedLifecycle?.listAgents || !revivedLifecycle.sendMessage) {
				throw new Error("Expected revived nested RLM family messaging");
			}
			expect(revivedLifecycle.listChildren()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ rlm_child_id: nested.rlm_child_id, status: "completed" }),
				]),
			);
			expect(revivedLifecycle.listAgents()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ relationship: "parent", id: parentAgentId }),
					expect.objectContaining({
						relationship: "sibling",
						id: sibling.rlm_child_id,
						status: "completed",
					}),
				]),
			);
			const receipt = await revivedLifecycle.sendMessage("cold nested reply", { receiverRole: "parent" });
			expect(receipt).toEqual({ deliveryStatus: "delivered", receiverId: parentAgentId });
			expect((await parentRegistry.resolveDirectChild(childHandle.rlm_child_id)).replied_to_parent).toBe(true);
		} finally {
			await revivedSession?.dispose();
			if (!childWasDisposed) await childSession?.dispose();
			await parentSession?.dispose();
			await fixture.session.dispose();
			fixture.authStorage.close();
		}
	});
});
