/**
 * Reply obligations are a bus-level contract: only the addressed peer may
 * resolve an awaited message, and an explicit dismissal or recipient teardown
 * must leave no stale "needs reply" HUD state behind.
 */
import { describe, expect, it } from "bun:test";
import { IrcBus, type IrcMessage, type IrcPendingReplyEvent } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, type AgentStatus } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function fakeSession(): { session: AgentSession; delivered: IrcMessage[] } {
	const delivered: IrcMessage[] = [];
	return {
		session: {
			deliverIrcMessage: async (message: IrcMessage) => {
				delivered.push(message);
				return "injected" as const;
			},
			emitIrcRelayObservation: () => {},
		} as unknown as AgentSession,
		delivered,
	};
}

type ReplyEndpoint = "sender" | "recipient";
type ActiveReplyStatus = Extract<AgentStatus, "running" | "waiting">;

interface OutstandingReplyFixture {
	registry: AgentRegistry;
	lifecycle: AgentLifecycleManager;
	bus: IrcBus;
	events: IrcPendingReplyEvent[];
	message: IrcMessage;
	ids: Record<ReplyEndpoint, string>;
}

async function openOutstandingReply(
	senderStatus: ActiveReplyStatus,
	recipientStatus: ActiveReplyStatus,
): Promise<OutstandingReplyFixture> {
	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const bus = new IrcBus(registry, lifecycle);
	const sender = fakeSession();
	const recipient = fakeSession();
	const ids = { sender: "Sender", recipient: "Recipient" } as const;
	registry.register({
		id: ids.sender,
		displayName: ids.sender,
		kind: "main",
		session: sender.session,
		status: senderStatus,
	});
	registry.register({
		id: ids.recipient,
		displayName: ids.recipient,
		kind: "sub",
		parentId: ids.sender,
		session: recipient.session,
		status: recipientStatus,
	});
	const events: IrcPendingReplyEvent[] = [];
	bus.onPendingReplyChange(event => events.push(event));

	const receipt = await bus.send(
		{ from: ids.sender, to: ids.recipient, body: "Need a decision" },
		{ expectsReply: true },
	);
	if (receipt.outcome !== "injected") {
		await lifecycle.dispose();
		throw new Error(`Expected reply request to be injected, got ${receipt.outcome}`);
	}
	const message = recipient.delivered[0];
	if (!message) {
		await lifecycle.dispose();
		throw new Error("Expected reply request to reach Recipient");
	}
	return { registry, lifecycle, bus, events, message, ids };
}

const terminalReplyTransitions = (["sender", "recipient"] as const).flatMap(endpoint =>
	(["running", "waiting"] as const).flatMap(fromStatus =>
		(["idle", "parked", "aborted"] as const).map(toStatus => ({ endpoint, fromStatus, toStatus })),
	),
);

describe("IRC expected-reply lifecycle", () => {
	it("opens obligations, resolves only the reciprocal reply, and clears them on dismissal or recipient end", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const bus = new IrcBus(registry, lifecycle);
		const main = fakeSession();
		const worker = fakeSession();
		const other = fakeSession();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: main.session });
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			session: worker.session,
		});
		registry.register({ id: "Other", displayName: "Other", kind: "sub", parentId: "Main", session: other.session });
		const events: IrcPendingReplyEvent[] = [];
		bus.onPendingReplyChange(event => events.push(event));

		try {
			const firstReceipt = await bus.send(
				{ from: "Main", to: "Worker", body: "Need a decision" },
				{ expectsReply: true },
			);
			expect(firstReceipt).toEqual({ to: "Worker", outcome: "injected" });
			const first = worker.delivered[0];
			if (!first) throw new Error("Expected the reply request to reach Worker");
			expect(bus.getPendingReplySnapshot("Worker").messages).toEqual([
				expect.objectContaining({ id: first.id, from: "Main", to: "Worker", expectsReply: true }),
			]);

			await bus.send({ from: "Other", to: "Main", body: "unrelated", replyTo: first.id });
			expect(bus.getPendingReplySnapshot("Worker").messages).toHaveLength(1);

			await bus.send({ from: "Worker", to: "Main", body: "Approved", replyTo: first.id });
			expect(bus.getPendingReplySnapshot().messages).toEqual([]);

			await bus.send({ from: "Main", to: "Worker", body: "Need a second decision" }, { expectsReply: true });
			const dismissed = worker.delivered[1];
			if (!dismissed) throw new Error("Expected the second reply request to reach Worker");
			expect(bus.dismissPendingReply(dismissed.id)).toBe(true);
			expect(bus.dismissPendingReply(dismissed.id)).toBe(false);
			expect(bus.getPendingReplySnapshot().messages).toEqual([]);

			await bus.send({ from: "Main", to: "Worker", body: "Need a final decision" }, { expectsReply: true });
			expect(bus.getPendingReplySnapshot("Worker").messages).toHaveLength(1);
			registry.unregister("Worker");
			expect(bus.getPendingReplySnapshot().messages).toEqual([]);

			expect(events.map(event => event.type)).toEqual([
				"opened",
				"resolved",
				"opened",
				"dismissed",
				"opened",
				"dismissed",
			]);
			expect(events[0]?.snapshot.messages.map(message => message.id)).toEqual([first.id]);
			expect(events[1]?.snapshot.messages).toEqual([]);
			expect(events[3]?.snapshot.messages).toEqual([]);
			expect(events[5]?.snapshot.messages).toEqual([]);
		} finally {
			await lifecycle.dispose();
		}
	});

	it.each(terminalReplyTransitions)(
		"clears an outstanding reply when the $endpoint moves from $fromStatus to $toStatus",
		async ({ endpoint, fromStatus, toStatus }) => {
			const fixture = await openOutstandingReply(
				endpoint === "sender" ? fromStatus : "running",
				endpoint === "recipient" ? fromStatus : "running",
			);
			try {
				expect(fixture.bus.getPendingReplySnapshot().messages.map(message => message.id)).toEqual([
					fixture.message.id,
				]);
				expect(fixture.events.map(event => event.type)).toEqual(["opened"]);

				expect(fixture.registry.setStatus(fixture.ids[endpoint], toStatus)).toBe(true);

				expect(fixture.bus.getPendingReplySnapshot().messages).toEqual([]);
				expect(fixture.events.map(event => event.type)).toEqual(["opened", "dismissed"]);
				const lastEvent = fixture.events.at(-1);
				expect(lastEvent?.type).toBe("dismissed");
				expect(lastEvent?.message.id).toBe(fixture.message.id);
				expect(lastEvent?.snapshot.messages).toEqual([]);
			} finally {
				await fixture.lifecycle.dispose();
			}
		},
	);

	it.each([{ endpoint: "sender" }, { endpoint: "recipient" }] as const)(
		"keeps an outstanding reply while the $endpoint moves from running to waiting",
		async ({ endpoint }) => {
			const fixture = await openOutstandingReply("running", "running");
			try {
				expect(fixture.registry.setStatus(fixture.ids[endpoint], "waiting")).toBe(true);

				expect(fixture.bus.getPendingReplySnapshot().messages.map(message => message.id)).toEqual([
					fixture.message.id,
				]);
				expect(fixture.events.map(event => event.type)).toEqual(["opened"]);
				expect(fixture.events.at(-1)?.snapshot.messages.map(message => message.id)).toEqual([fixture.message.id]);
			} finally {
				await fixture.lifecycle.dispose();
			}
		},
	);
});
