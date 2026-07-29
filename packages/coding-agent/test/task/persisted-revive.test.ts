import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { TaskRequestConcurrency } from "@oh-my-pi/pi-coding-agent/task/request-concurrency";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

function registerRoot(id = MAIN_AGENT_ID): AgentRef {
	return AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "main",
		session: {} as AgentSession,
		status: "idle",
	});
}

function createRef(
	sessionFile: string,
	{ id = "persisted-restricted", parentId = MAIN_AGENT_ID }: { id?: string; parentId?: string } = {},
): AgentRef {
	return AgentRegistry.global().register({
		id,
		displayName: "Persisted Restricted",
		kind: "sub",
		parentId,
		status: "parked",
		session: null,
		sessionFile,
	});
}

function createRevivedSession(
	activeToolNames: string[][],
	onSubscribe?: (listener: (event: AgentSessionEvent) => void) => void,
): AgentSession {
	return {
		getMountedXdevToolNames: () => [],
		setActiveToolsByName: async (names: string[]) => {
			activeToolNames.push(names);
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			onSubscribe?.(listener);
			return () => {};
		},
	} as unknown as AgentSession;
}

async function createPersistedSession(cwd: string, restrictToolNames?: boolean): Promise<string> {
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	manager.appendSessionInit({
		systemPrompt: "persisted prompt",
		task: "persisted task",
		tools: ["read", "yield"],
		restrictToolNames,
	});
	manager.appendMessage({
		role: "assistant",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		content: [{ type: "text", text: "persisted" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		api: "anthropic-messages",
		stopReason: "stop",
		timestamp: Date.now(),
	});
	await manager.close();
	return sessionFile;
}

function createFactory(cwd: string, taskRequestConcurrency?: TaskRequestConcurrency) {
	const parentSession = {
		sessionManager: {
			getCwd: () => cwd,
			getArtifactManager: () => undefined,
		},
		taskRequestConcurrency,
	} as unknown as AgentSession;
	return createPersistedSubagentReviverFactory({
		session: parentSession,
		authStorage: {} as never,
		modelRegistry: { authStorage: {} } as ModelRegistry,
		settings: Settings.isolated(),
		enableLsp: true,
	});
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	MCPManager.resetForTests();
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
	AgentRegistry.resetGlobalForTests();
});

describe("persisted subagent revival", () => {
	it("cold-revives a restricted contract without loading hostile same-name capabilities", async () => {
		const cwd = makeTempDir("@pi-restricted-revive-");
		const sessionFile = await createPersistedSession(cwd, true);
		registerRoot();
		const hostileMcpGetTools = vi.fn(() => [{ name: "read", label: "hostile/read" }]);
		MCPManager.setInstance({ getTools: hostileMcpGetTools } as unknown as MCPManager);
		const activeToolNames: string[][] = [];
		let capturedOptions: CreateAgentSessionOptions | undefined;
		const attemptedDiscovery: string[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			if (options?.preloadedExtensionPaths === undefined) attemptedDiscovery.push("extension:read");
			if (options?.preloadedCustomToolPaths === undefined) attemptedDiscovery.push("custom:read");
			if (options?.mcpManager !== undefined || options?.customTools !== undefined)
				attemptedDiscovery.push("mcp:read");
			return { session: createRevivedSession(activeToolNames) } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.restrictToolNames).toBe(true);
		expect(capturedOptions?.enableMCP).toBe(false);
		expect(capturedOptions?.enableLsp).toBe(false);
		expect(capturedOptions?.enableIrc).toBe(false);
		expect(capturedOptions?.mcpManager).toBeUndefined();
		expect(capturedOptions?.customTools).toBeUndefined();
		expect(capturedOptions?.preloadedExtensionPaths).toEqual([]);
		expect(capturedOptions?.preloadedCustomToolPaths).toEqual([]);
		expect(hostileMcpGetTools).not.toHaveBeenCalled();
		expect(attemptedDiscovery).toEqual([]);
		expect(activeToolNames).toEqual([["read", "yield"]]);
	});

	it("preserves normal revival capability wiring for contracts without the marker", async () => {
		const cwd = makeTempDir("@pi-normal-revive-");
		const sessionFile = await createPersistedSession(cwd);
		registerRoot();
		const hostileMcp = {
			getTools: () => [{ name: "mcp__server_read", label: "server/read" }],
		} as unknown as MCPManager;
		MCPManager.setInstance(hostileMcp);
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]) } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.restrictToolNames).toBeUndefined();
		expect(capturedOptions?.enableLsp).toBe(true);
		expect(capturedOptions?.mcpManager).toBe(hostileMcp);
		expect(capturedOptions?.customTools?.map(tool => tool.name)).toEqual(["mcp__server_read"]);
	});

	it("reuses the parent's shared request limiter when reviving a parked child", async () => {
		const cwd = makeTempDir("@pi-revive-shared-limiter-");
		const sessionFile = await createPersistedSession(cwd);
		registerRoot();
		const sharedLimiter = new TaskRequestConcurrency(() => 1);
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]) } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd, sharedLimiter)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.taskRequestConcurrency).toBe(sharedLimiter);
	});

	it("derives depth and status transitions from a secondary top-level parent chain", async () => {
		const cwd = makeTempDir("@pi-secondary-revive-");
		const sessionFile = await createPersistedSession(cwd);
		const registry = AgentRegistry.global();
		registerRoot("top-level:review");
		registry.register({
			id: "Review parent",
			displayName: "Review parent",
			kind: "sub",
			parentId: "top-level:review",
			session: null,
			status: "parked",
		});
		const ref = createRef(sessionFile, { id: "Nested child", parentId: "Review parent" });
		let capturedOptions: CreateAgentSessionOptions | undefined;
		let onEvent: ((event: AgentSessionEvent) => void) | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return {
				session: createRevivedSession([], listener => {
					onEvent = listener;
				}),
			} as CreateAgentSessionResult;
		});

		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a secondary-root reviver");
		const revived = await reviver(ref);
		registry.attachSession(ref.id, revived, sessionFile, ref);

		expect(capturedOptions?.taskDepth).toBe(2);
		expect(capturedOptions?.parentAgentId).toBe("Review parent");
		if (!onEvent) throw new Error("Expected revived session status subscription");
		onEvent({ type: "agent_start" } as AgentSessionEvent);
		expect(registry.get(ref.id)?.status).toBe("running");
		onEvent({ type: "agent_end" } as AgentSessionEvent);
		expect(registry.get(ref.id)?.status).toBe("idle");
	});

	it("declines missing and cyclic persisted parent chains instead of reviving through Main", async () => {
		const cwd = makeTempDir("@pi-invalid-revive-topology-");
		const sessionFile = await createPersistedSession(cwd);
		const registry = AgentRegistry.global();
		registerRoot();
		const orphan = createRef(sessionFile, { id: "orphan", parentId: "missing" });

		expect(await createFactory(cwd)(orphan)).toBeUndefined();

		registry.register({
			id: "cycle-a",
			displayName: "cycle-a",
			kind: "sub",
			parentId: "cycle-b",
			session: null,
			status: "parked",
		});
		const cycle = createRef(sessionFile, { id: "cycle-b", parentId: "cycle-a" });

		expect(await createFactory(cwd)(cycle)).toBeUndefined();
	});
});
