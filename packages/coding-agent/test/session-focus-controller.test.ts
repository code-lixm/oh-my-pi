import { describe, expect, it } from "bun:test";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface SessionStub {
	session: AgentSession;
	/** Emit an event through the listener captured by the last subscribe(). */
	emit: (event: unknown) => Promise<void>;
	unsubscribeCalls: () => number;
	setStreaming: (streaming: boolean) => void;
}

function makeSessionStub(opts: { isStreaming?: boolean } = {}): SessionStub {
	let listener: ((event: AgentSessionEvent) => Promise<void> | void) | undefined;
	let unsubscribeCalls = 0;
	const stub = {
		isStreaming: opts.isStreaming ?? false,
		subscribe(fn: (event: AgentSessionEvent) => Promise<void> | void) {
			listener = fn;
			return () => {
				unsubscribeCalls++;
			};
		},
	};
	return {
		session: stub as unknown as AgentSession,
		emit: async event => {
			if (!listener) throw new Error("no listener captured: subscribe() was never called");
			await listener(event as AgentSessionEvent);
		},
		unsubscribeCalls: () => unsubscribeCalls,
		setStreaming: streaming => {
			stub.isStreaming = streaming;
		},
	};
}

interface Harness {
	ctx: InteractiveModeContext;
	controller: SessionFocusController;
	registry: AgentRegistry;
	main: SessionStub;
	handledEvents: unknown[];
	setSessionCalls: Array<[AgentSession, string | undefined, string | undefined]>;
	counts: {
		clearTransientSessionUi: () => number;
		resetTranscriptAnchors: () => number;
		renderInitialMessages: () => number;
		mainUnsubscribe: () => number;
	};
}

function makeHarness(): Harness {
	const main = makeSessionStub();
	const handledEvents: unknown[] = [];
	const setSessionCalls: Array<[AgentSession, string | undefined, string | undefined]> = [];
	let clearTransientSessionUi = 0;
	let resetTranscriptAnchors = 0;
	let renderInitialMessages = 0;
	let mainUnsubscribe = 0;

	const ctx = {
		session: main.session,
		unsubscribe: () => {
			mainUnsubscribe++;
		},
		eventController: {
			handleEvent: async (event: unknown) => {
				handledEvents.push(event);
			},
			resetTranscriptAnchors: () => {
				resetTranscriptAnchors++;
			},
		},
		statusLine: {
			setSession: (session: AgentSession, focusedAgentId?: string, focusedAgentDisplayName?: string) => {
				setSessionCalls.push([session, focusedAgentId, focusedAgentDisplayName]);
			},
			invalidate() {},
		},
		clearTransientSessionUi: () => {
			clearTransientSessionUi++;
		},
		renderInitialMessages: () => {
			renderInitialMessages++;
		},
		updateEditorBorderColor() {},
		ui: { requestRender() {} },
		showStatus() {},
		collabGuest: undefined,
	} as unknown as InteractiveModeContext;

	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const controller = new SessionFocusController(ctx, registry, () => lifecycle);

	return {
		ctx,
		controller,
		registry,
		main,
		handledEvents,
		setSessionCalls,
		counts: {
			clearTransientSessionUi: () => clearTransientSessionUi,
			resetTranscriptAnchors: () => resetTranscriptAnchors,
			renderInitialMessages: () => renderInitialMessages,
			mainUnsubscribe: () => mainUnsubscribe,
		},
	};
}

function registerSub(registry: AgentRegistry, id: string, session: AgentSession, parentId?: string, displayName = id) {
	return registry.register({ id, displayName, kind: "sub", parentId, session, status: "running" });
}

/** Settle the async unfocus chain (registry event → void unfocus() → #attach). */
async function flushAsync(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("SessionFocusController", () => {
	it("focusAgent retargets subscription, transcript anchors, and status line onto the worker session", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID, "Build agent");

		await h.controller.focusAgent("Worker");

		expect(h.controller.focusedAgentId).toBe("Worker");
		expect(h.controller.target).toBe(worker.session);
		expect(h.counts.mainUnsubscribe()).toBe(1);
		expect(h.counts.clearTransientSessionUi()).toBe(1);
		expect(h.counts.resetTranscriptAnchors()).toBe(1);
		expect(h.counts.renderInitialMessages()).toBe(1);
		expect(h.setSessionCalls).toEqual([[worker.session, "Worker", "Build agent"]]);

		const event = { type: "message_start", message: { role: "user" } };
		await worker.emit(event);
		expect(h.handledEvents).toEqual([event]);
	});

	it("mid-turn attach synthesizes agent_start, and an orphaned assistant message_update gets a synthesized message_start", async () => {
		const h = makeHarness();
		const worker = makeSessionStub({ isStreaming: true });
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");
		expect(h.handledEvents).toEqual([{ type: "agent_start" }]);

		const message = { role: "assistant", content: "partial" };
		await worker.emit({ type: "message_update", message });
		expect(h.handledEvents.slice(1)).toEqual([
			{ type: "message_start", message },
			{ type: "message_update", message },
		]);

		// Guard fires once: subsequent updates pass through unsynthesized.
		await worker.emit({ type: "message_update", message });
		expect(h.handledEvents.slice(3)).toEqual([{ type: "message_update", message }]);
	});

	it("cycles across Main and live subagents in createdAt order while skipping non-switchable refs", async () => {
		const h = makeHarness();
		const ignoredAdvisor = makeSessionStub();
		const ignoredParked = makeSessionStub();
		const ignoredAborted = makeSessionStub();
		const earlier = makeSessionStub();
		const later = makeSessionStub();

		const advisorRef = h.registry.register({
			id: "Advisor",
			displayName: "Advisor transcript",
			kind: "advisor",
			session: ignoredAdvisor.session,
			status: "running",
		});
		const parkedRef = h.registry.register({
			id: "Parked",
			displayName: "Dormant agent",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: ignoredParked.session,
			status: "parked",
		});
		const laterRef = h.registry.register({
			id: "Later",
			displayName: "Run tests",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: later.session,
			status: "running",
		});
		const earlierRef = h.registry.register({
			id: "Earlier",
			displayName: "Build plan",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: earlier.session,
			status: "idle",
		});
		const abortedRef = h.registry.register({
			id: "Aborted",
			displayName: "Aborted agent",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: ignoredAborted.session,
			status: "aborted",
		});

		advisorRef.createdAt = 1;
		parkedRef.createdAt = 2;
		laterRef.createdAt = 30;
		earlierRef.createdAt = 20;
		abortedRef.createdAt = 40;

		await h.controller.cycleAgent("next");
		expect(h.controller.focusedAgentId).toBe("Earlier");

		await h.controller.cycleAgent("next");
		expect(h.controller.focusedAgentId).toBe("Later");

		await h.controller.cycleAgent("next");
		expect(h.controller.focusedAgentId).toBeUndefined();

		await h.controller.cycleAgent("previous");
		expect(h.controller.focusedAgentId).toBe("Later");

		await h.controller.cycleAgent("previous");
		expect(h.controller.focusedAgentId).toBe("Earlier");

		await h.controller.cycleAgent("previous");
		expect(h.controller.focusedAgentId).toBeUndefined();

		expect(h.setSessionCalls).toEqual([
			[earlier.session, "Earlier", "Build plan"],
			[later.session, "Later", "Run tests"],
			[h.main.session, undefined, undefined],
			[later.session, "Later", "Run tests"],
			[earlier.session, "Earlier", "Build plan"],
			[h.main.session, undefined, undefined],
		]);
	});

	it("focusParent walks parentId to a registered non-main agent, then re-attaches the main session", async () => {
		const h = makeHarness();
		const parent = makeSessionStub();
		const worker = makeSessionStub();
		registerSub(h.registry, "Parent", parent.session, MAIN_AGENT_ID, "Review parent");
		registerSub(h.registry, "Worker", worker.session, "Parent", "Patch worker");

		await h.controller.focusAgent("Worker");
		await h.controller.focusParent();
		expect(h.controller.focusedAgentId).toBe("Parent");
		expect(h.setSessionCalls).toEqual([
			[worker.session, "Worker", "Patch worker"],
			[parent.session, "Parent", "Review parent"],
		]);

		// Parent's parent is Main → unfocus back to ctx.session.
		await h.controller.focusParent();
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.controller.target).toBeUndefined();
		expect(h.setSessionCalls).toEqual([
			[worker.session, "Worker", "Patch worker"],
			[parent.session, "Parent", "Review parent"],
			[h.main.session, undefined, undefined],
		]);
	});

	it("parking the focused agent auto-unfocuses back to the main session", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID, "Queued worker");

		await h.controller.focusAgent("Worker");
		expect(h.controller.focusedAgentId).toBe("Worker");

		h.registry.setStatus("Worker", "parked");
		await flushAsync();

		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.setSessionCalls).toEqual([
			[worker.session, "Worker", "Queued worker"],
			[h.main.session, undefined, undefined],
		]);
	});
});
