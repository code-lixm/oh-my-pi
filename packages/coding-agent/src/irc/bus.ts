/**
 * IrcBus - Process-global mailbox bus for agent-to-agent messaging.
 *
 * Replaces the old auto-reply model: a `send` never blocks on the recipient
 * generating anything. Delivery resolves the recipient via the global
 * AgentRegistry — parked agents are revived through the
 * AgentLifecycleManager, idle agents are woken with a real turn, and busy
 * agents receive the message as a non-interrupting aside at the next step
 * boundary (see AgentSession.deliverIrcMessage). Replies are real turns by
 * the recipient, observed via `wait` — with one exception: when the sender
 * awaits a reply and the recipient cannot run a real reply turn in time
 * (mid-turn with async execution disabled — possibly blocked in a
 * synchronous task spawn whose batch includes the sender — or idle in plan
 * mode, where autonomous wake turns are suppressed), the recipient session
 * generates an ephemeral side-channel auto-reply.
 */

import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, resolveTopLevelAgent } from "../registry/agent-registry";
import type { CustomMessage } from "../session/messages";

export interface IrcMessage {
	id: string;
	/** Sender agent id. */
	from: string;
	/** Recipient agent id (resolved; "all" is expanded by the tool, not stored). */
	to: string;
	body: string;
	ts: number;
	/** Message id being answered. */
	replyTo?: string;
	/** Sender requested a reply; IrcBus tracks the outstanding lifecycle separately. */
	expectsReply?: boolean;
}

export interface IrcDeliveryReceipt {
	to: string;
	outcome: "injected" | "woken" | "revived" | "failed";
	error?: string;
}

/** Immutable HUD-facing view of outstanding reply obligations. */
export interface IrcPendingReplySnapshot {
	messages: readonly IrcMessage[];
}

type IrcPendingReplyChange =
	| { type: "opened"; message: IrcMessage }
	| { type: "resolved"; message: IrcMessage; reply: IrcMessage }
	| { type: "dismissed"; message: IrcMessage };

/** State transition for a reply obligation; the snapshot is post-transition. */
export type IrcPendingReplyEvent = IrcPendingReplyChange & { snapshot: IrcPendingReplySnapshot };

export type IrcPendingReplyListener = (event: IrcPendingReplyEvent) => void;

interface IrcWaiter {
	from?: string;
	resolve: (msg: IrcMessage) => void;
	cancel: () => void;
}

/** Mailbox cap per agent; oldest messages are dropped beyond it. */
const MAILBOX_CAP = 100;

export class IrcBus {
	static #global: IrcBus | undefined;

	static global(): IrcBus {
		if (!IrcBus.#global) {
			IrcBus.#global = new IrcBus();
		}
		return IrcBus.#global;
	}

	/** Reset the global bus. Test-only. */
	static resetGlobalForTests(): void {
		IrcBus.#global = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #lifecycle: () => AgentLifecycleManager;
	readonly #mailboxes = new Map<string, IrcMessage[]>();
	readonly #waiters = new Map<string, IrcWaiter[]>();
	readonly #pendingReplies = new Map<string, IrcMessage>();
	readonly #pendingReplyListeners = new Set<IrcPendingReplyListener>();

	constructor(registry: AgentRegistry = AgentRegistry.global(), lifecycle?: AgentLifecycleManager) {
		this.#registry = registry;
		// Lazy: the lifecycle global self-constructs against the global registry,
		// so only touch it when a parked recipient actually needs reviving.
		this.#lifecycle = () => lifecycle ?? AgentLifecycleManager.global();
		this.#registry.onChange(event => {
			if (
				event.type === "removed" ||
				(event.type === "status_changed" &&
					(event.ref.status === "idle" || event.ref.status === "parked" || event.ref.status === "aborted"))
			) {
				this.dismissPendingRepliesFor(event.ref.id);
			}
		});
	}

	/** Snapshot reply obligations addressed to one agent, or every agent when omitted. */
	getPendingReplySnapshot(agentId?: string): IrcPendingReplySnapshot {
		return this.#pendingReplySnapshot(agentId);
	}

	/** Subscribe to reply-obligation transitions for HUDs and other observers. */
	onPendingReplyChange(listener: IrcPendingReplyListener): () => void {
		this.#pendingReplyListeners.add(listener);
		return () => this.#pendingReplyListeners.delete(listener);
	}

	/** Dismiss one outstanding obligation when its recipient ends or the UI dismisses it. */
	dismissPendingReply(messageId: string): boolean {
		const message = this.#pendingReplies.get(messageId);
		if (!message) return false;
		this.#pendingReplies.delete(messageId);
		this.#emitPendingReplyChange({ type: "dismissed", message });
		return true;
	}

	/** Dismiss every obligation touching an ended agent. */
	dismissPendingRepliesFor(agentId: string): number {
		const messageIds = [...this.#pendingReplies.values()]
			.filter(message => message.from === agentId || message.to === agentId)
			.map(message => message.id);
		for (const messageId of messageIds) this.dismissPendingReply(messageId);
		return messageIds.length;
	}

	/**
	 * Fire-and-forget delivery. Never blocks on the recipient generating
	 * anything: the receipt reports how the message reached the recipient
	 * (waiter/aside = "injected", idle wake = "woken", park revival =
	 * "revived"), not what they did with it.
	 *
	 * Mailbox semantics: a successfully delivered message never lingers in
	 * the recipient's mailbox — injection/wake puts the full body into their
	 * context, so buffering it too would double-deliver via a later
	 * `wait`/`inbox` and inflate unread counts. Only a failed live hand-off
	 * is buffered for the recipient to drain later.
	 *
	 * `opts.expectsReply` marks sends whose caller is blocked on an answer
	 * (`send await:true`). It is forwarded to the recipient session so a
	 * mid-turn recipient that cannot reach a step boundary (async execution
	 * disabled — e.g. blocked in a synchronous task spawn awaiting the
	 * sender's own batch) can generate an ephemeral side-channel auto-reply
	 * instead of stranding the sender until timeout.
	 *
	 * `opts.suppressRelay` skips the display-only owning-root relay for this leg.
	 * Set by broadcast fan-out when the same broadcast also targets that root
	 * directly: the root agent then already sees the body as its own incoming card,
	 * so relaying the sibling legs would duplicate it.
	 */
	async send(
		msg: Omit<IrcMessage, "id" | "ts">,
		opts?: { expectsReply?: boolean; suppressRelay?: boolean },
	): Promise<IrcDeliveryReceipt> {
		const { expectsReply: requestedReply, ...input } = msg;
		const expectsReply = opts?.expectsReply ?? requestedReply;
		const message: IrcMessage = {
			...input,
			id: Snowflake.next(),
			ts: Date.now(),
			...(expectsReply ? { expectsReply: true } : {}),
		};
		const ref = this.#registry.get(message.to);
		if (!ref) {
			return {
				to: message.to,
				outcome: "failed",
				error: `Unknown agent "${message.to}" — check \`irc list\` for live peers.`,
			};
		}
		if (ref.status === "aborted") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" was hard-aborted and cannot be messaged or revived. Its transcript remains readable at history://${message.to}.`,
			};
		}
		// Advisor refs are observability-only transcripts, never messageable peers.
		if (ref.kind === "advisor") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" is a read-only advisor transcript and cannot be messaged.`,
			};
		}

		// A `parked` recipient always needs the lifecycle to revive it — this is
		// read from *this* bus's registry, so it holds for any registry. The
		// mid-park / adopted checks below query the lifecycle's own state, which
		// only describes the registry it manages: consult them only when the
		// lifecycle owns this bus's registry, otherwise a custom-registry bus
		// (fallen back to the global manager) would gate a live recipient on
		// unrelated global park state. Main/non-adopted live peers skip the gate,
		// and pending waiters still win without a session.
		const lifecycle = this.#lifecycle();
		const lifecycleOwnsRegistry = lifecycle.manages(this.#registry);
		const needsLifecycleGate =
			ref.status === "parked" ||
			(lifecycleOwnsRegistry && (lifecycle.isParking(message.to) || lifecycle.has(message.to)));

		const priorSession = ref.session;
		let revived = false;
		if (needsLifecycleGate) {
			try {
				const liveSession = await lifecycle.ensureLive(message.to);
				// Revival = we did not keep the same live instance (parked start, or
				// park completed and a fresh session was rebuilt).
				revived = !priorSession || liveSession !== priorSession;
			} catch (error) {
				// Not revivable / released / revive failed. Do not buffer: a permanent
				// failure must not inflate unread counts or pretend delivery is pending.
				return {
					to: message.to,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}

		// A pending `wait` from the recipient consumes the message directly —
		// it is returned from their irc tool call and never hits the inbox or
		// the session injection path.
		const waiter = this.#takeMatchingWaiter(message.to, message.from);
		if (waiter) {
			if (message.expectsReply) this.#beginPendingReply(message);
			waiter.resolve(message);
			this.#resolvePendingReply(message);
			if (!opts?.suppressRelay) this.#relayToRootUi(message);
			return { to: message.to, outcome: revived ? "revived" : "injected" };
		}

		const session = this.#registry.get(message.to)?.session;
		if (!session) {
			return { to: message.to, outcome: "failed", error: `Agent "${message.to}" has no live session.` };
		}

		if (message.expectsReply) this.#beginPendingReply(message);
		try {
			const delivery = await session.deliverIrcMessage(message, { expectsReply: message.expectsReply });
			this.#resolvePendingReply(message);
			if (!opts?.suppressRelay) this.#relayToRootUi(message);
			return { to: message.to, outcome: revived ? "revived" : delivery };
		} catch (error) {
			// Live hand-off failed (e.g. recipient disposed mid-shutdown): buffer
			// the message so a later `wait`/`inbox` from the recipient can still
			// pick it up. The receipt stays "failed" — the recipient has not
			// seen it, but a queued reply request remains outstanding.
			this.#enqueue(message);
			this.#resolvePendingReply(message);
			return {
				to: message.to,
				outcome: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Block until a message for `agentId` (optionally from `filter.from`)
	 * arrives; consume + return it. Null on timeout (`timeoutMs <= 0` waits
	 * forever). Rejects when `signal` aborts. By default, already-buffered
	 * mail satisfies the wait before parking a future waiter; callers that
	 * need a strictly future reply can disable that drain.
	 */
	async wait(
		agentId: string,
		filter: { from?: string },
		timeoutMs: number,
		signal?: AbortSignal,
		options?: { drainPending?: boolean; liveness?: { registry: AgentRegistry; senderId: string } },
	): Promise<IrcMessage | null> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted");
		}

		if (options?.drainPending !== false) {
			// Already-pending mail satisfies the wait without parking a waiter.
			const pending = this.#takeFromMailbox(agentId, filter.from);
			if (pending) return pending;
		}

		const { promise, resolve, reject } = Promise.withResolvers<IrcMessage | null>();
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		let unsubscribeLiveness: (() => void) | undefined;

		const liveness = options?.liveness;
		const livenessReason = filter.from
			? `IRC wait aborted: agent "${filter.from}" is not running`
			: "IRC wait aborted: no running peers remain";

		const settle = (
			outcome: { kind: "message"; msg: IrcMessage } | { kind: "timeout" } | { kind: "abort"; error: Error },
		): void => {
			cleanup();
			if (outcome.kind === "message") {
				resolve(outcome.msg);
			} else if (outcome.kind === "timeout") {
				resolve(null);
			} else {
				reject(outcome.error);
			}
		};

		const cleanup = (): void => {
			this.#removeWaiter(agentId, waiter);
			clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			unsubscribeLiveness?.();
		};

		const waiter: IrcWaiter = {
			from: filter.from,
			resolve: msg => settle({ kind: "message", msg }),
			cancel: () => cleanup(),
		};

		if (signal) {
			onAbort = () =>
				settle({
					kind: "abort",
					error: signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"),
				});
			signal.addEventListener("abort", onAbort, { once: true });
		}
		if (timeoutMs > 0) {
			timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
			timer.unref?.();
		}

		let waiters = this.#waiters.get(agentId);
		if (!waiters) {
			waiters = [];
			this.#waiters.set(agentId, waiters);
		}
		waiters.push(waiter);

		if (liveness) {
			const { registry, senderId } = liveness;
			const hasRunningSender = (from?: string): boolean =>
				registry
					.listVisibleTo(senderId)
					.some(ref => (ref.status === "running" || ref.status === "waiting") && (!from || ref.id === from));
			const check = filter.from ? () => hasRunningSender(filter.from) : () => hasRunningSender();
			unsubscribeLiveness = registry.onChange(() => {
				if (!check()) {
					settle({ kind: "abort", error: new Error(livenessReason) });
				}
			});
			if (!check()) {
				settle({ kind: "abort", error: new Error(livenessReason) });
			}
		}

		return promise;
	}

	/** Drain (or peek) pending messages for `agentId`. */
	inbox(agentId: string, opts?: { peek?: boolean }): IrcMessage[] {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox || mailbox.length === 0) return [];
		if (opts?.peek) return [...mailbox];
		this.#mailboxes.delete(agentId);
		return mailbox;
	}

	unreadCount(agentId: string): number {
		return this.#mailboxes.get(agentId)?.length ?? 0;
	}

	#pendingReplySnapshot(agentId?: string): IrcPendingReplySnapshot {
		return {
			messages: [...this.#pendingReplies.values()]
				.filter(message => agentId === undefined || message.to === agentId)
				.map(message => ({ ...message })),
		};
	}

	#beginPendingReply(message: IrcMessage): void {
		this.#pendingReplies.set(message.id, message);
		this.#emitPendingReplyChange({ type: "opened", message });
	}

	#resolvePendingReply(reply: IrcMessage): void {
		if (!reply.replyTo) return;
		const message = this.#pendingReplies.get(reply.replyTo);
		if (!message || message.to !== reply.from || message.from !== reply.to) return;
		this.#pendingReplies.delete(message.id);
		this.#emitPendingReplyChange({ type: "resolved", message, reply });
	}

	#emitPendingReplyChange(event: IrcPendingReplyChange): void {
		if (this.#pendingReplyListeners.size === 0) return;
		const snapshot = this.#pendingReplySnapshot();
		const change: IrcPendingReplyEvent = { ...event, snapshot } as IrcPendingReplyEvent;
		for (const listener of this.#pendingReplyListeners) {
			try {
				listener(change);
			} catch (error) {
				logger.debug("IrcBus: pending reply listener failed", { error: String(error) });
			}
		}
	}

	#enqueue(message: IrcMessage): void {
		let mailbox = this.#mailboxes.get(message.to);
		if (!mailbox) {
			mailbox = [];
			this.#mailboxes.set(message.to, mailbox);
		}
		mailbox.push(message);
		if (mailbox.length > MAILBOX_CAP) {
			const dropped = mailbox.shift();
			logger.debug("IrcBus: mailbox full, dropped oldest message", {
				agentId: message.to,
				droppedId: dropped?.id,
				droppedFrom: dropped?.from,
			});
		}
	}

	/** Resolve the OLDEST waiter for `agentId` whose from-filter accepts `from`. */
	#takeMatchingWaiter(agentId: string, from: string): IrcWaiter | undefined {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return undefined;
		const index = waiters.findIndex(waiter => !waiter.from || waiter.from === from);
		if (index === -1) return undefined;
		const [waiter] = waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
		return waiter;
	}

	#removeWaiter(agentId: string, waiter: IrcWaiter): void {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return;
		const index = waiters.indexOf(waiter);
		if (index !== -1) waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
	}

	#takeFromMailbox(agentId: string, from?: string): IrcMessage | undefined {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox) return undefined;
		const index = from ? mailbox.findIndex(msg => msg.from === from) : 0;
		if (index === -1 || mailbox.length === 0) return undefined;
		const [message] = mailbox.splice(index, 1);
		if (mailbox.length === 0) this.#mailboxes.delete(agentId);
		return message;
	}

	/**
	 * Surface sibling traffic as a display-only card on its owning top-level
	 * session UI. A root endpoint already renders its own incoming or outgoing
	 * message, so only non-root endpoints need a relay. Cross-root and malformed
	 * parent chains have no unambiguous owner and are intentionally not relayed.
	 */
	#relayToRootUi(message: IrcMessage): void {
		const senderRoot = resolveTopLevelAgent(this.#registry, message.from);
		const recipientRoot = resolveTopLevelAgent(this.#registry, message.to);
		if (!senderRoot || !recipientRoot || senderRoot.id !== recipientRoot.id) return;
		if (message.to === senderRoot.id || message.from === senderRoot.id) return;
		const rootSession = senderRoot.session;
		if (!rootSession) return;
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:relay",
			content: `[IRC \`${message.from}\` → \`${message.to}\`]\n\n${message.body}`,
			display: true,
			details: { from: message.from, to: message.to, body: message.body },
			attribution: "agent",
			timestamp: message.ts,
		};
		try {
			rootSession.emitIrcRelayObservation(record);
		} catch (error) {
			// Display-only forwarding must never affect delivery semantics.
			logger.debug("IrcBus: root UI relay failed", { to: message.to, error: String(error) });
		}
	}
}
