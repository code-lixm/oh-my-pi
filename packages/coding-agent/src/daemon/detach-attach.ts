import type { AgentSessionEvent } from "../session/agent-session-events";
import type { OmpDaemonEventCursor, OmpSessionSnapshot } from "./protocol";

const DEFAULT_EVENT_HISTORY_LIMIT = 10_000;

/**
 * The small public surface DetachAttachManager needs from an AgentSession.
 * Keeping this structural lets workers own the concrete session while tests and
 * alternate runtimes can supply an equivalent session host.
 */
export interface DetachAttachSession {
	readonly messages: readonly unknown[];
	readonly model?: { provider: string; id: string };
	readonly thinkingLevel?: unknown;
	configuredThinkingLevel?(): unknown;
	getActiveToolNames?(): string[];
	getGoalModeState?(): unknown;
	getTodoPhases?(): unknown[];
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
}

/** Optional worker-owned state which is not directly exposed by AgentSession. */
export interface DetachAttachSessionOptions {
	/** Preserve a generation while replacing a runtime for the same logical session. */
	generation?: string;
	/** The callback MUST be synchronous so snapshot and replay have one ordering boundary. */
	snapshot?: (session: DetachAttachSession) => OmpSessionSnapshot;
	getAutonomousState?: () => unknown;
	getCronJobs?: () => readonly unknown[];
	getRlmChildren?: () => readonly unknown[];
}

interface SequencedSessionEvent {
	cursor: OmpDaemonEventCursor;
	event: AgentSessionEvent;
}

interface ManagedSession {
	session: DetachAttachSession;
	options: DetachAttachSessionOptions;
	generation: string;
	sequence: number;
	events: SequencedSessionEvent[];
	resident: boolean;
	unsubscribe: () => void;
}

/**
 * Keeps a worker-owned session resident while clients come and go. It snapshots
 * current state at attach time and retains a bounded, generation-scoped event
 * stream for cursor replay.
 */
export class DetachAttachManager {
	readonly #sessions = new Map<string, ManagedSession>();
	readonly #leases = new Map<string, string>();
	readonly #eventHistoryLimit: number;

	constructor(options: { eventHistoryLimit?: number } = {}) {
		const requestedLimit = options.eventHistoryLimit ?? DEFAULT_EVENT_HISTORY_LIMIT;
		if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
			throw new Error("eventHistoryLimit must be a positive safe integer");
		}
		this.#eventHistoryLimit = requestedLimit;
	}

	/**
	 * Begin tracking a worker-owned session. Re-registering an active session ID
	 * atomically replaces its prior runtime and event generation.
	 */
	registerSession(
		activeSessionId: string,
		session: DetachAttachSession,
		options: DetachAttachSessionOptions = {},
	): () => void {
		if (!activeSessionId.trim()) throw new Error("activeSessionId is required");
		this.unregisterSession(activeSessionId);

		const state: ManagedSession = {
			session,
			options,
			generation: options.generation ?? crypto.randomUUID(),
			sequence: 0,
			events: [],
			resident: false,
			unsubscribe: () => {},
		};
		state.unsubscribe = session.subscribe(event => this.#recordEventFor(state, activeSessionId, event));
		this.#sessions.set(activeSessionId, state);

		return () => {
			if (this.#sessions.get(activeSessionId) === state) this.unregisterSession(activeSessionId);
		};
	}

	/** Stop retaining one worker session and release any client lease for it. */
	unregisterSession(activeSessionId: string): void {
		const state = this.#sessions.get(activeSessionId);
		if (!state) return;
		this.#sessions.delete(activeSessionId);
		this.#leases.delete(activeSessionId);
		state.unsubscribe();
	}

	/** Record an event delivered outside the normal AgentSession subscription path. */
	recordEvent(activeSessionId: string, event: AgentSessionEvent): void {
		const state = this.#sessions.get(activeSessionId);
		if (state) this.#recordEventFor(state, activeSessionId, event);
	}

	/** Mark the session resident after its attached client disconnects. */
	async onClientDetach(activeSessionId: string): Promise<void> {
		const state = this.#requireSession(activeSessionId);
		state.resident = true;
		// Detach is the ownership boundary. A future client may acquire input
		// ownership without being blocked by the disconnected client.
		this.#leases.delete(activeSessionId);
	}

	/**
	 * Produce an attach-time state snapshot plus events newer than a compatible
	 * cursor. A stale/foreign generation receives the authoritative snapshot and
	 * no speculative replay.
	 */
	async onClientAttach(
		activeSessionId: string,
		cursor: OmpDaemonEventCursor | undefined,
	): Promise<{ snapshot: OmpSessionSnapshot; replayEvents: AgentSessionEvent[] }> {
		const state = this.#requireSession(activeSessionId);
		const snapshot = this.#createSnapshot(state);
		state.resident = false;

		const replayEvents =
			cursor?.generation === state.generation
				? state.events
						.filter(candidate => candidate.cursor.sequence > cursor.sequence)
						.map(candidate => cloneValue(candidate.event))
				: [];
		return { snapshot, replayEvents };
	}

	/** Grant the session input lease when unowned or already owned by this client. */
	async acquireLease(activeSessionId: string, clientId: string): Promise<boolean> {
		if (!clientId.trim() || !this.#sessions.has(activeSessionId)) return false;
		const owner = this.#leases.get(activeSessionId);
		if (owner !== undefined && owner !== clientId) return false;
		this.#leases.set(activeSessionId, clientId);
		return true;
	}

	/** Release only a lease held by the calling client. */
	async releaseLease(activeSessionId: string, clientId: string): Promise<void> {
		if (this.#leases.get(activeSessionId) === clientId) this.#leases.delete(activeSessionId);
	}

	/** Current event-stream cursor, useful for supervisor worker replies. */
	getCursor(activeSessionId: string): OmpDaemonEventCursor | undefined {
		const state = this.#sessions.get(activeSessionId);
		return state ? { generation: state.generation, sequence: state.sequence } : undefined;
	}

	isResident(activeSessionId: string): boolean {
		return this.#sessions.get(activeSessionId)?.resident === true;
	}

	getLeaseOwner(activeSessionId: string): string | undefined {
		return this.#leases.get(activeSessionId);
	}

	#createSnapshot(state: ManagedSession): OmpSessionSnapshot {
		const { session, options } = state;
		const model = session.model ? `${session.model.provider}/${session.model.id}` : undefined;
		const thinkingLevel = session.configuredThinkingLevel?.() ?? session.thinkingLevel;
		const activeTools = session.getActiveToolNames?.();
		const goalState = session.getGoalModeState?.();
		const todoState = session.getTodoPhases?.();
		const autonomousState = options.getAutonomousState?.();
		const cronJobs = options.getCronJobs?.();
		const rlmChildren = options.getRlmChildren?.();

		const base: OmpSessionSnapshot = {
			messages: cloneValue([...session.messages]),
			...(model === undefined ? {} : { model }),
			...(thinkingLevel === undefined ? {} : { thinkingLevel: String(thinkingLevel) }),
			...(activeTools === undefined ? {} : { activeTools: cloneValue(activeTools) }),
			...(goalState === undefined ? {} : { goalState: cloneValue(goalState) }),
			...(todoState === undefined ? {} : { todoState: cloneValue(todoState) }),
			...(autonomousState === undefined ? {} : { autonomousState: cloneValue(autonomousState) }),
			...(cronJobs === undefined ? {} : { cronJobs: cloneValue(cronJobs) }),
			...(rlmChildren === undefined ? {} : { rlmChildren: cloneValue(rlmChildren) }),
		};
		return cloneValue({ ...base, ...options.snapshot?.(session) });
	}

	#recordEventFor(state: ManagedSession, activeSessionId: string, event: AgentSessionEvent): void {
		if (this.#sessions.get(activeSessionId) !== state) return;
		state.sequence++;
		state.events.push({
			cursor: { generation: state.generation, sequence: state.sequence },
			event: cloneValue(event),
		});
		if (state.events.length > this.#eventHistoryLimit)
			state.events.splice(0, state.events.length - this.#eventHistoryLimit);
	}

	#requireSession(activeSessionId: string): ManagedSession {
		const state = this.#sessions.get(activeSessionId);
		if (!state) throw new Error(`Unknown daemon session: ${activeSessionId}`);
		return state;
	}
}

function cloneValue<T>(value: T): T {
	try {
		return structuredClone(value);
	} catch {
		// Agent events and snapshots are expected to be structured-cloneable. Keep
		// delivery alive if an extension placed an opaque value in its metadata.
		return value;
	}
}
