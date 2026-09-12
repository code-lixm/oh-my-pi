import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { RpcClient } from "../../../src/modes/rpc/rpc-client";
import type { RpcSessionState } from "../../../src/modes/rpc/rpc-types";
import { RpcInteractiveSessionPort } from "../../../src/modes/session-port/rpc-session-port";
import type { AgentSessionEvent } from "../../../src/session/agent-session-events";

const testModel = {
	provider: "anthropic",
	id: "model-a",
	name: "Model A",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
} as Model;

function sessionState(followUp: readonly string[], modelId: string): RpcSessionState {
	return {
		model: { ...testModel, id: modelId, name: modelId },
		thinkingLevel: undefined,
		configuredThinkingLevel: undefined,
		isStreaming: true,
		isCompacting: false,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		interruptMode: "immediate",
		sessionId: "session-1",
		autoCompactionEnabled: true,
		fastModeEnabled: false,
		fastModeActive: false,
		tokensPerSecond: null,
		messageCount: 0,
		queuedMessageCount: followUp.length,
		queuedMessages: { steering: [], followUp },
		todoPhases: [],
	};
}

/**
 * Minimal client double: the first `getState` (connect) answers immediately, and
 * every later call parks on a deferred the test controls. That is exactly the
 * production window the projection ledger protects — snapshot RPC payloads read
 * before the frame is emitted, while reliable events keep flowing.
 */
class SlowSnapshotClient {
	readonly #sessionEventListeners = new Set<(event: AgentSessionEvent) => void>();
	#stateCalls = 0;
	#signalRequested!: () => void;
	readonly stateRequested = new Promise<void>(resolve => {
		this.#signalRequested = resolve;
	});

	constructor(
		private readonly initial: RpcSessionState,
		private readonly next: () => Promise<RpcSessionState>,
	) {}

	async getState(): Promise<RpcSessionState> {
		this.#stateCalls++;
		if (this.#stateCalls === 1) return this.initial;
		this.#signalRequested();
		return await this.next();
	}

	async getMessages(): Promise<never[]> {
		return [];
	}

	async getAvailableCommands(): Promise<never[]> {
		return [];
	}

	async getSubagents(): Promise<never[]> {
		return [];
	}

	onSessionEvent(listener: (event: AgentSessionEvent) => void): () => void {
		this.#sessionEventListeners.add(listener);
		return () => this.#sessionEventListeners.delete(listener);
	}

	onAvailableCommandsUpdate(): () => void {
		return () => {};
	}

	onSubagentLifecycle(): () => void {
		return () => {};
	}

	async stop(): Promise<void> {}

	emitSessionEvent(event: AgentSessionEvent): void {
		for (const listener of this.#sessionEventListeners) listener(event);
	}
}

async function connectPort(client: SlowSnapshotClient): Promise<RpcInteractiveSessionPort> {
	return await RpcInteractiveSessionPort.connect({
		client: client as unknown as RpcClient,
		cwd: "/tmp",
	});
}

describe("RpcInteractiveSessionPort stale snapshot guard", () => {
	test("a snapshot in flight never reverts a field a reliable event updated", async () => {
		const deferred = Promise.withResolvers<RpcSessionState>();
		const client = new SlowSnapshotClient(sessionState([], "model-a"), () => deferred.promise);
		const port = await connectPort(client);

		const refresh = port.requestSnapshot();
		await client.stateRequested;
		// The user's follow-up lands while the snapshot payloads are in flight.
		client.emitSessionEvent({ type: "queue_changed", queue: { steering: [], followUp: ["QUEUED"] } });
		expect(port.projection.queue.followUp).toEqual(["QUEUED"]);

		deferred.resolve(sessionState([], "model-b"));
		await refresh;

		// The queue keeps the newer event value...
		expect(port.projection.queue.followUp).toEqual(["QUEUED"]);
		// ...while fields the snapshot alone owns still refresh.
		expect(port.projection.model?.id).toBe("model-b");
		await port.dispose();
	});

	test("an uncontested snapshot still applies its queue", async () => {
		const deferred = Promise.withResolvers<RpcSessionState>();
		const client = new SlowSnapshotClient(sessionState([], "model-a"), () => deferred.promise);
		const port = await connectPort(client);

		const refresh = port.requestSnapshot();
		await client.stateRequested;
		deferred.resolve(sessionState(["FROM-SNAPSHOT"], "model-b"));
		await refresh;

		expect(port.projection.queue.followUp).toEqual(["FROM-SNAPSHOT"]);
		await port.dispose();
	});

	test("a later snapshot still applies after an event bump", async () => {
		const first = Promise.withResolvers<RpcSessionState>();
		const second = Promise.withResolvers<RpcSessionState>();
		let pending = first;
		const client = new SlowSnapshotClient(sessionState([], "model-a"), () => pending.promise);
		const port = await connectPort(client);

		const refresh = port.requestSnapshot();
		await client.stateRequested;
		client.emitSessionEvent({ type: "queue_changed", queue: { steering: [], followUp: ["QUEUED"] } });
		first.resolve(sessionState([], "model-b"));
		await refresh;
		expect(port.projection.queue.followUp).toEqual(["QUEUED"]);

		// A snapshot requested after that event is authoritative again.
		pending = second;
		const nextRefresh = port.requestSnapshot();
		await Bun.sleep(0);
		second.resolve(sessionState(["AFTER-EVENT"], "model-c"));
		await nextRefresh;
		expect(port.projection.queue.followUp).toEqual(["AFTER-EVENT"]);
		await port.dispose();
	});
});
