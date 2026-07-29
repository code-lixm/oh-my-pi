/**
 * AgentRegistry - Process-global registry of agents (the main session plus
 * every subagent), keyed by stable id.
 *
 * Tracks each agent's status and (when live) its AgentSession so peers can be
 * addressed by id (`hub`, `task resume`, `history://`). Sessions are
 * registered explicitly at creation; finished agents stay registered as
 * `idle` (live) or `parked` (session disposed, ref + sessionFile retained for
 * revival) and are only removed on explicit release/teardown.
 */

import type { AgentSession } from "../session/agent-session";
import { oneLineLabel } from "../task/types";
import type { AgentActivityState } from "./agent-activity";

export const MAIN_AGENT_ID = "Main";

/**
 * - `running`: a turn owns a runnable slot and is in flight.
 * - `waiting`: a live turn temporarily released its slot while blocking on
 *   child or peer work; it must never be TTL-parked.
 * - `idle`: live AgentSession in memory, awaiting work. Finished agents are
 *   `idle`, not removed.
 * - `parked`: session disposed; AgentRef + sessionFile retained, revivable.
 * - `aborted`: hard-killed, terminal.
 */
export type AgentStatus = "running" | "waiting" | "idle" | "parked" | "aborted";
/**
 * - `main`/`sub`: the user-facing agent tree (driving agent + task subagents).
 * - `advisor`: a passive review transcript persisted like a subagent for usage
 *   attribution and Agent Hub observability, but never a peer — hidden from
 *   agent-facing rosters (`hub`, `history://`) and not messageable/revivable.
 */
export type AgentKind = "main" | "sub" | "advisor";

export interface AgentRef {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	/** Null exactly when parked/aborted. */
	session: AgentSession | null;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
	/** Human-readable title for a top-level session. Distinct from the agent's display name. */
	sessionTitle?: string;
	/** Durable session id without the registry's `top-level:` addressing prefix. */
	sessionId?: string;
	/** Short gist retained for compatibility with model-facing peer rosters. */
	activity?: string;
	/** Structured current activity shared by local and remote observer surfaces. */
	activityState?: AgentActivityState;
}

export type AgentRefExpectation = AgentRef | AgentSession;

export type RegistryEvent =
	| { type: "registered"; ref: AgentRef }
	| { type: "status_changed"; ref: AgentRef }
	| { type: "removed"; ref: AgentRef }
	| { type: "metadata_changed"; ref: AgentRef };

type RegistryListener = (event: RegistryEvent) => void;

export interface RegisterInput {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	sessionTitle?: string;
	sessionId?: string;
	activityState?: AgentActivityState;
	session: AgentSession | null;
	sessionFile?: string | null;
	status?: AgentStatus;
}

export class AgentRegistry {
	static #global: AgentRegistry | undefined;

	static global(): AgentRegistry {
		if (!AgentRegistry.#global) {
			AgentRegistry.#global = new AgentRegistry();
		}
		return AgentRegistry.#global;
	}

	/** Reset the global registry. Test-only. */
	static resetGlobalForTests(): void {
		AgentRegistry.#global = new AgentRegistry();
	}

	readonly #refs = new Map<string, AgentRef>();
	readonly #listeners = new Set<RegistryListener>();

	#matchesExpected(ref: AgentRef, expected?: AgentRefExpectation): boolean {
		return expected === undefined || ref === expected || ref.session === expected;
	}

	register(input: RegisterInput): AgentRef {
		const now = Date.now();
		const ref: AgentRef = {
			id: input.id,
			displayName: input.displayName,
			kind: input.kind,
			parentId: input.parentId,
			status: input.status ?? "running",
			session: input.session,
			sessionFile: input.sessionFile ?? null,
			createdAt: now,
			lastActivity: input.activityState?.lastActivityAtMs ?? now,
			sessionTitle: input.sessionTitle,
			sessionId: input.sessionId,
			activityState: input.activityState,
		};
		this.#refs.set(ref.id, ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	/**
	 * Register a new id only when it is absent, or reuse the exact ref a parked
	 * revival was authorized to revive. A missing expected ref is a failed CAS:
	 * callers must never claim an id after its prior generation disappeared.
	 */
	registerIfAvailable(input: RegisterInput, expected: AgentRef | null): AgentRef | undefined {
		const current = this.#refs.get(input.id);
		if (expected === null) return current ? undefined : this.register(input);
		return current === expected ? current : undefined;
	}

	setStatus(id: string, status: AgentStatus, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		if (ref.status === status) return true;
		ref.status = status;
		// A non-running ref must not advertise an active roster gist, but its
		// structured last activity remains useful to parked/restored observers.
		if (status !== "running") ref.activity = undefined;
		ref.lastActivity = status !== "running" && ref.activityState ? ref.activityState.lastActivityAtMs : Date.now();
		this.#emit({ type: "status_changed", ref });
		return true;
	}

	/**
	 * Record a short activity gist for the work-aware roster. Display-only and
	 * read on demand (`irc list`, peer roster), so it emits no event — keeping
	 * the per-tool-call update rate off the registry listener path (same as
	 * `attachSession`, which also bumps `lastActivity` without emitting). Only a
	 * `running` agent has current work: a heartbeat for any other status is
	 * dropped, so a late progress flush can't resurrect activity on a ref that
	 * `setStatus` just cleared. Every running heartbeat refreshes `lastActivity`
	 * — even when the gist text is unchanged — so the roster's "active … ago" and
	 * recency sort track real work, not just the last status change.
	 * The gist is normalized to one bounded line (`oneLineLabel`) so model-derived
	 * intent text can neither break the roster nor smuggle terminal escapes —
	 * every caller is safe without sanitizing at its own call site.
	 */
	setActivity(id: string, activity: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		if (ref.status !== "running") return;
		const gist = oneLineLabel(activity);
		ref.lastActivity = Date.now();
		if (ref.activity === gist) return;
		ref.activity = gist;
	}

	updateMetadata(
		id: string,
		metadata: Partial<Pick<AgentRef, "displayName" | "sessionTitle" | "sessionId" | "sessionFile" | "activityState">>,
		expected?: AgentRefExpectation,
	): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		let changed = false;
		for (const key of ["displayName", "sessionTitle", "sessionId", "sessionFile", "activityState"] as const) {
			if (!(key in metadata) || ref[key] === metadata[key]) continue;
			Object.assign(ref, { [key]: metadata[key] });
			changed = true;
		}
		if (!changed) return true;
		ref.lastActivity = Date.now();
		this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	setActivityState(id: string, activityState: AgentActivityState, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected) || ref.status !== "running") return false;
		ref.activityState = activityState;
		ref.lastActivity = activityState.lastActivityAtMs;
		this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	attachSession(
		id: string,
		session: AgentSession,
		sessionFile?: string | null,
		expected?: AgentRefExpectation,
	): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		ref.session = session;
		if (sessionFile !== undefined) ref.sessionFile = sessionFile;
		ref.lastActivity = Date.now();
		return true;
	}

	detachSession(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		ref.session = null;
		return true;
	}

	unregister(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		this.#refs.delete(id);
		this.#emit({ type: "removed", ref });
		return true;
	}

	get(id: string): AgentRef | undefined {
		return this.#refs.get(id);
	}

	list(): AgentRef[] {
		return [...this.#refs.values()];
	}

	/**
	 * Returns every live agent (running | waiting | idle) except the caller.
	 * Advisor refs are observability-only transcripts, never peers, so they are
	 * excluded. Flat namespace: every other agent is visible.
	 */
	listVisibleTo(id: string): AgentRef[] {
		return this.list().filter(
			ref =>
				ref.id !== id &&
				ref.kind !== "advisor" &&
				(ref.status === "running" || ref.status === "waiting" || ref.status === "idle"),
		);
	}

	onChange(listener: RegistryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: RegistryEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// listeners must not break the dispatch loop
			}
		}
	}
}

export function isTopLevelAgent(ref: AgentRef | undefined): ref is AgentRef & { kind: "main" } {
	return ref?.kind === "main";
}

/** Resolve an agent to its owning top-level session without assuming that the root id is `Main`. */
export function resolveTopLevelAgent(registry: AgentRegistry, agentId: string): AgentRef | undefined {
	const seen = new Set<string>();
	let current = registry.get(agentId);
	while (current && !seen.has(current.id)) {
		if (isTopLevelAgent(current)) return current;
		seen.add(current.id);
		current = current.parentId ? registry.get(current.parentId) : undefined;
	}
	return undefined;
}

export function agentDisplayLabel(ref: AgentRef): string {
	return ref.kind === "main" ? ref.sessionTitle?.trim() || ref.displayName : ref.displayName;
}
