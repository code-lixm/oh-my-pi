import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { parseRetryFallbackSelector } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import {
	type RecoveryCompactionResult,
	TurnRecovery,
	type TurnRecoveryHost,
} from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
const fallback = getBundledModel("openai", "gpt-4o-mini");
if (!primary || !fallback) throw new Error("Expected bundled primary and fallback test models");

const primarySelector = `${primary.provider}/${primary.id}`;
const fallbackSelector = `${fallback.provider}/${fallback.id}`;

type Probe = TurnRecoveryHost["probeModelConnectivity"];
type StreamingAgentStub = {
	state: Pick<TurnRecoveryHost["agent"]["state"], "isStreaming">;
};

let modelRegistry: ModelRegistry;

interface FallbackProbeHarness {
	recovery: TurnRecovery;
	probe: Mock<Probe>;
	events: AgentSessionEvent[];
	currentSelector(): string;
	currentModel(): Model;
	currentThinkingLevel(): ReturnType<TurnRecoveryHost["configuredThinkingLevel"]>;
	setStreaming(value: boolean): void;
}

interface FallbackProbeHarnessOptions {
	configuredThinkingLevel?: ReturnType<TurnRecoveryHost["configuredThinkingLevel"]>;
	beforeSetModel?: (model: Model) => Promise<void>;
}

function makeSuccessfulAssistantMessage(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "completed" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...USAGE },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function flushMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

function createHarness(probe: Probe, options: FallbackProbeHarnessOptions = {}): FallbackProbeHarness {
	let currentModel: Model = primary;
	const agent: StreamingAgentStub = { state: { isStreaming: false } };
	let configuredThinkingLevel = options.configuredThinkingLevel;
	const events: AgentSessionEvent[] = [];
	const probeModelConnectivity = vi.fn(probe);
	const host: TurnRecoveryHost = {
		agent: agent as TurnRecoveryHost["agent"],
		sessionManager: {
			getSessionId: () => "test-session",
			appendModelChange: () => {},
		} as unknown as TurnRecoveryHost["sessionManager"],
		persistedAssistantEntryId: () => undefined,
		settings: Settings.isolated(),
		modelRegistry,
		configWarnings: [],
		model: () => currentModel,
		textOutputCommitted: () => false,
		thinkingLevel: () => undefined,
		configuredThinkingLevel: () => configuredThinkingLevel,
		setTransientThinkingLevel: level => {
			configuredThinkingLevel = level;
		},
		thinkingLevelCeiling: () => undefined,
		isDisposed: () => false,
		isStreaming: () => agent.state.isStreaming,
		isCompacting: () => false,
		abortInProgress: () => false,
		streamingEditAbortTriggered: () => false,
		promptGeneration: () => 0,
		sessionId: () => "test-session",
		setActivity: () => {},
		emitSessionEvent: async event => {
			events.push(event);
		},
		scheduleAgentContinue: () => {},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		sessionMessageAlreadyPersisted: () => false,
		setModelWithProviderSessionReset: async model => {
			await options.beforeSetModel?.(model);
			currentModel = model;
		},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemCodexReset: async () => false,
		probeModelConnectivity,
		runAutoCompaction: async () =>
			({ deferredHandoff: false, continuationScheduled: false }) as RecoveryCompactionResult,
		withBashBranchTransition: <T>(operation: () => T): T => operation(),
	};

	return {
		recovery: new TurnRecovery(host),
		probe: probeModelConnectivity,
		events,
		currentSelector: () => `${currentModel.provider}/${currentModel.id}`,
		currentModel: () => currentModel,
		currentThinkingLevel: () => configuredThinkingLevel,
		setStreaming: (value: boolean) => {
			agent.state.isStreaming = value;
		},
	};
}

async function activateFallback(harness: FallbackProbeHarness, selectorValue = fallbackSelector): Promise<void> {
	const selector = parseRetryFallbackSelector(selectorValue, modelRegistry);
	if (!selector) throw new Error("Expected fallback selector to parse");
	await harness.recovery.applyRetryFallbackCandidate("test-role", selector, primarySelector, { apiKey: "test-key" });
}

describe("TurnRecovery fallback primary probe", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-turn-recovery-fallback-probe-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("waits the full probe interval before checking the original primary", async () => {
		const harness = createHarness(async () => false);
		await activateFallback(harness);

		vi.advanceTimersByTime(59_999);
		await flushMicrotasks();
		expect(harness.probe).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		await flushMicrotasks();
		expect(harness.probe).toHaveBeenCalledTimes(1);
		expect(harness.probe.mock.calls[0]?.[0]).toMatchObject({ provider: primary.provider, id: primary.id });
	});

	it("gives an unhealthy primary a fresh full-minute probe window", async () => {
		const harness = createHarness(async () => false);
		await activateFallback(harness);

		vi.advanceTimersByTime(60_000);
		await flushMicrotasks();
		expect(harness.probe).toHaveBeenCalledTimes(1);
		expect(harness.currentSelector()).toBe(fallbackSelector);

		vi.advanceTimersByTime(59_999);
		await flushMicrotasks();
		expect(harness.probe).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(1);
		await flushMicrotasks();
		expect(harness.probe).toHaveBeenCalledTimes(2);
	});

	it("restores a healthy primary and announces the fallback transition", async () => {
		const harness = createHarness(async () => true);
		await activateFallback(harness);

		vi.advanceTimersByTime(60_000);
		await flushMicrotasks();

		expect(harness.currentSelector()).toBe(primarySelector);
		expect(harness.events.filter(event => event.type === "retry_fallback_restored")).toEqual([
			{
				type: "retry_fallback_restored",
				from: fallbackSelector,
				to: primarySelector,
				role: "test-role",
			},
		]);
	});

	it("restores a healthy primary only at an explicit safe boundary after a streaming turn", async () => {
		const harness = createHarness(async () => true);
		harness.setStreaming(true);
		await activateFallback(harness);

		vi.advanceTimersByTime(60_000);
		await flushMicrotasks();
		expect(harness.probe).toHaveBeenCalledTimes(1);
		expect(harness.currentSelector()).toBe(fallbackSelector);
		expect(harness.events.filter(event => event.type === "retry_fallback_restored")).toEqual([]);

		harness.setStreaming(false);
		await harness.recovery.onAssistantSettledSuccessfully(makeSuccessfulAssistantMessage(harness.currentModel()));

		expect(harness.currentSelector()).toBe(fallbackSelector);
		expect(harness.events.filter(event => event.type === "retry_fallback_restored")).toEqual([]);

		await harness.recovery.restoreReadyFallbackAtSafeBoundary();

		expect(harness.currentSelector()).toBe(primarySelector);
		expect(harness.events.filter(event => event.type === "retry_fallback_restored")).toEqual([
			{
				type: "retry_fallback_restored",
				from: fallbackSelector,
				to: primarySelector,
				role: "test-role",
			},
		]);
	});

	it("does not restore thinking or announce recovery after fallback ownership clears during an in-flight primary reset", async () => {
		const primaryResetStarted = Promise.withResolvers<void>();
		const releasePrimaryReset = Promise.withResolvers<void>();
		const harness = createHarness(async () => true, {
			configuredThinkingLevel: ThinkingLevel.High,
			beforeSetModel: async model => {
				if (model.provider !== primary.provider || model.id !== primary.id) return;
				primaryResetStarted.resolve();
				await releasePrimaryReset.promise;
			},
		});
		await activateFallback(harness, `${fallbackSelector}:${ThinkingLevel.Off}`);

		vi.advanceTimersByTime(60_000);
		await primaryResetStarted.promise;

		harness.recovery.clearActiveRetryFallback();
		releasePrimaryReset.resolve();
		await flushMicrotasks();

		expect(harness.currentThinkingLevel()).toBe(ThinkingLevel.Off);
		expect(harness.events.filter(event => event.type === "retry_fallback_restored")).toEqual([]);
	});

	it("cancels the scheduled probe when retry fallback ownership is cleared", async () => {
		const harness = createHarness(async () => false);
		await activateFallback(harness);
		expect(vi.getTimerCount()).toBe(1);

		harness.recovery.clearActiveRetryFallback();
		expect(vi.getTimerCount()).toBe(0);

		vi.advanceTimersByTime(60_000);
		await flushMicrotasks();
		expect(harness.probe).not.toHaveBeenCalled();
	});
});
