/**
 * Reply obligations are a bus-level contract: only the addressed peer may
 * resolve an awaited message, and an explicit dismissal or recipient teardown
 * must leave no stale "needs reply" HUD state behind.
 */
import { describe, expect, it } from "bun:test";
import { IrcBus, type IrcMessage, type IrcPendingReplyEvent } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
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
});
