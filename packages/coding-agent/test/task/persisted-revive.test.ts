import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { TaskRequestConcurrency, TaskRunnableConcurrency } from "@oh-my-pi/pi-coding-agent/task/request-concurrency";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
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

type IrcWakeObserver = (records: CustomMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined;

interface RevivedSessionHandle {
	session: AgentSession;
	observer: () => IrcWakeObserver | undefined;
	emit(event: AgentSessionEvent): void;
}

function createRevivedSession(
	activeToolNames: string[][],
	onSubscribe?: (listener: (event: AgentSessionEvent) => void) => void,
): RevivedSessionHandle {
	let observer: IrcWakeObserver | undefined;
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const session = {
		getMountedXdevToolNames: () => [],
		setActiveToolsByName: async (names: string[]) => {
			activeToolNames.push(names);
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			onSubscribe?.(listener);
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		setIrcWakeTurnObserver: (next: IrcWakeObserver | undefined) => {
			observer = next;
		},
		getLastAssistantMessage: () => undefined,
	} as unknown as AgentSession;
	return {
		session,
		observer: () => observer,
		emit: event => {
			for (const listener of listeners) listener(event);
		},
	};
}

async function createPersistedSession(
	cwd: string,
	restrictToolNames?: boolean,
	modelRole?: string,
	resolvedModel?: string,
	advisor?: string,
): Promise<string> {
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	manager.appendSessionInit({
		systemPrompt: "persisted prompt",
		task: "persisted task",
		tools: ["read", "yield"],
		restrictToolNames,
		modelRole,
		resolvedModel: resolvedModel ?? (modelRole ? "anthropic/claude-sonnet-4-5" : undefined),
		advisor,
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

function createFactory(
	cwd: string,
	options: {
		taskRequestConcurrency?: TaskRequestConcurrency;
		taskRunnableConcurrency?: TaskRunnableConcurrency;
		eventBus?: EventBus;
	} = {},
) {
	const parentSession = {
		sessionManager: {
			getCwd: () => cwd,
			getArtifactManager: () => undefined,
		},
		taskRequestConcurrency: options.taskRequestConcurrency,
		taskRunnableConcurrency: options.taskRunnableConcurrency,
		get sessionFile() {
			return path.join(cwd, "parent.jsonl");
		},
	} as unknown as AgentSession;
	return createPersistedSubagentReviverFactory({
		session: parentSession,
		authStorage: {} as never,
		modelRegistry: { authStorage: {} } as ModelRegistry,
		settings: Settings.isolated(),
		enableLsp: true,
		eventBus: options.eventBus,
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
			return { session: createRevivedSession(activeToolNames).session } as CreateAgentSessionResult;
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
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
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
	it("restores the persisted per-agent advisor opt-in on cold revival", async () => {
		const cwd = makeTempDir("@pi-advisor-revive-");
		registerRoot();
		const advisedFile = await createPersistedSession(cwd, undefined, undefined, "moonshot/k3", "moonshot/k3");
		const roleAdvisedFile = await createPersistedSession(cwd, undefined, undefined, "on", "on");
		const unadvisedFile = await createPersistedSession(cwd);
		const captured: Settings[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (options?.settings) captured.push(options.settings);
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const factory = createFactory(cwd);
		for (const [id, sessionFile] of [
			["persisted-advised", advisedFile],
			["persisted-role-advised", roleAdvisedFile],
			["persisted-unadvised", unadvisedFile],
		] as const) {
			const ref = createRef(sessionFile, { id });
			const reviver = await factory(ref);
			if (!reviver) throw new Error(`Expected a persisted reviver for ${id}`);
			await reviver(ref);
		}

		const [advised, roleAdvised, unadvised] = captured;
		expect(advised.get("advisor.enabled")).toBe(true);
		expect(advised.getModelRole("advisor")).toBe("moonshot/k3");
		expect(roleAdvised.get("advisor.enabled")).toBe(true);
		expect(roleAdvised.getModelRole("advisor")).toBeUndefined();
		expect(unadvised.get("advisor.enabled")).toBe(false);
	});

	it("reuses the parent's shared request and runnable limiters when reviving a parked child", async () => {
		const cwd = makeTempDir("@pi-revive-shared-limiters-");
		const sessionFile = await createPersistedSession(cwd);
		registerRoot();
		const sharedRequestLimiter = new TaskRequestConcurrency(() => 1);
		const sharedRunnableScheduler = new TaskRunnableConcurrency(() => 1);
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd, {
			taskRequestConcurrency: sharedRequestLimiter,
			taskRunnableConcurrency: sharedRunnableScheduler,
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.taskRequestConcurrency).toBe(sharedRequestLimiter);
		expect(capturedOptions?.taskRunnableConcurrency).toBe(sharedRunnableScheduler);
	});

	it("restores a persisted custom model role with its explicit effort before reopening the session", async () => {
		const cwd = makeTempDir("@pi-custom-role-revive-");
		const sessionFile = await createPersistedSession(cwd, false, "reviewer", "anthropic/claude-sonnet-4-5:high");
		registerRoot();
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.modelPattern).toEqual(["@reviewer:high", "anthropic/claude-sonnet-4-5:high"]);
		expect(capturedOptions?.modelPatternAuthFallback).toBe("anthropic/claude-sonnet-4-5:high");
	});

	it("pins the persisted concrete model when the default role is revived", async () => {
		const cwd = makeTempDir("@pi-default-role-revive-");
		const sessionFile = await createPersistedSession(cwd, false, "default");
		registerRoot();
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.modelPattern).toBe("anthropic/claude-sonnet-4-5");
		expect(capturedOptions?.modelPatternAuthFallback).toBe("anthropic/claude-sonnet-4-5");
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
				}).session,
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

	it("installs an IRC wake monitor that emits cold-revive lifecycle frames on the shared bus", async () => {
		AgentRegistry.resetGlobalForTests();
		registerRoot();
		AgentLifecycleManager.resetGlobalForTests();
		const cwd = makeTempDir("@pi-revive-frames-");
		const sessionFile = await createPersistedSession(cwd, false, "review-fast");
		MCPManager.setInstance({ getTools: () => [] } as unknown as MCPManager);
		let handle: RevivedSessionHandle | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			handle = createRevivedSession([]);
			return { session: handle.session } as CreateAgentSessionResult;
		});
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const terminal = Promise.withResolvers<void>();
		const rpcRegistry = new RpcSubagentRegistry(eventBus, frame => {
			frames.push(frame);
			if (frame.type === "subagent_lifecycle" && frame.payload.status !== "started") terminal.resolve();
		});
		rpcRegistry.setSubscriptionLevel("progress");
		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd, { eventBus })(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		const observer = handle?.observer();
		expect(observer).toBeDefined();
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: "resume after resume",
			display: true,
			details: { id: "irc-1", from: "Main", message: "resume after resume" },
			attribution: "agent",
			timestamp: Date.now(),
		};
		const finish = observer?.([record]);
		handle?.emit({ type: "agent_start" } as AgentSessionEvent);
		await finish?.();
		await terminal.promise;

		expect(frames[0]).toMatchObject({
			type: "subagent_lifecycle",
			payload: { id: ref.id, status: "started" },
		});
		const progressFrame = frames.find(
			(frame): frame is Extract<RpcSubagentFrame, { type: "subagent_progress" }> =>
				frame.type === "subagent_progress",
		);
		expect(progressFrame?.payload.progress.modelRole).toBe("review-fast");
		expect(progressFrame?.payload.progress.modelOverride).toEqual(["@review-fast", "anthropic/claude-sonnet-4-5"]);
		const last = frames.at(-1);
		expect(last?.type).toBe("subagent_lifecycle");
		if (last?.type !== "subagent_lifecycle") throw new Error("expected terminal lifecycle frame");
		expect(last.payload.id).toBe(ref.id);
		expect(last.payload.status).not.toBe("started");
		rpcRegistry.dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});
});
