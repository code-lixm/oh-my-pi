import { AgentRegistry, resolveTopLevelAgent } from "../registry/agent-registry";
import { getPersistedAgentSnapshot } from "../registry/persisted-agent-snapshot";
import type { AgentProgress, SubagentLifecyclePayload, SubagentProgressPayload } from "../task";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../task";
import type { EventBus } from "../utils/event-bus";

export interface ObservableSession {
	id: string;
	kind: "main" | "subagent";
	label: string;
	agent?: string;
	description?: string;
	status: "active" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	parentToolCallId?: string;
	/**
	 * Spawn runs as a detached background job (parent turn not blocked on it).
	 * The anchored subagent HUD only lists detached spawns: sync task spawns
	 * and eval `agent()` spawns are already rendered live by their own inline
	 * tool block / eval cell.
	 */
	detached?: boolean;
	index?: number;
	lastUpdate: number;
	/** Stable task start time carried across lifecycle-only observer updates. */
	startedAtMs?: number;
	/** Stable terminal time; absent while the task remains active. */
	completedAtMs?: number;
	/** Latest progress snapshot from the subagent executor */
	progress?: AgentProgress;
	/** Last resolved selector restored from a durable task result, when available. */
	resolvedModel?: string;
	resolvedModelIsFallback?: boolean;
	/** Durable retry state/result; omitted rather than synthesized for old JSONL. */
	retryState?: AgentProgress["retryState"];
	retryFailure?: AgentProgress["retryFailure"];
}

/** Coarse source of an observer change; callers use it to separate lifecycle work from high-frequency progress. */
export type SessionObserverChangeKind = "main" | "reset" | "lifecycle" | "progress";

const STATUS_MAP: Record<string, ObservableSession["status"]> = {
	pending: "active",
	running: "active",
	started: "active",
	completed: "completed",
	failed: "failed",
	aborted: "aborted",
};

function isFiniteEpoch(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function withSessionTiming(progress: AgentProgress, session?: ObservableSession): AgentProgress {
	const snapshot = { ...progress };
	const startedAtMs = isFiniteEpoch(progress.startedAtMs) ? progress.startedAtMs : session?.startedAtMs;
	if (isFiniteEpoch(startedAtMs)) snapshot.startedAtMs = startedAtMs;
	if (snapshot.status !== "completed" && snapshot.status !== "failed" && snapshot.status !== "aborted") {
		delete snapshot.completedAtMs;
		return snapshot;
	}
	const completedAtMs = isFiniteEpoch(progress.completedAtMs) ? progress.completedAtMs : session?.completedAtMs;
	if (isFiniteEpoch(completedAtMs)) {
		snapshot.completedAtMs = completedAtMs;
		if (isFiniteEpoch(snapshot.startedAtMs)) {
			snapshot.durationMs = Math.max(0, completedAtMs - snapshot.startedAtMs);
		}
	}
	return snapshot;
}

export class SessionObserverRegistry {
	#sessions = new Map<string, ObservableSession>();
	#listeners = new Set<(kind: SessionObserverChangeKind) => void>();
	#eventBusUnsubscribers: Array<() => void> = [];
	#sortOrderById = new Map<string, number>();
	#parentSortOrderById = new Map<string, number>();
	#nextSortOrder = 0;

	/** Add a change listener. Returns unsubscribe function. */
	onChange(cb: (kind: SessionObserverChangeKind) => void): () => void {
		this.#listeners.add(cb);
		return () => this.#listeners.delete(cb);
	}

	#notifyListeners(kind: SessionObserverChangeKind): void {
		for (const cb of this.#listeners) cb(kind);
	}

	#ensureSortOrder(id: string): number {
		const existing = this.#sortOrderById.get(id);
		if (existing !== undefined) return existing;
		const order = this.#nextSortOrder++;
		this.#sortOrderById.set(id, order);
		return order;
	}

	#ensureParentSortOrder(parentToolCallId: string | undefined, order: number): void {
		if (!parentToolCallId) return;
		if (this.#parentSortOrderById.has(parentToolCallId)) return;
		this.#parentSortOrderById.set(parentToolCallId, order);
	}

	#getStableOrder(session: ObservableSession): number {
		return this.#sortOrderById.get(session.id) ?? Number.MAX_SAFE_INTEGER;
	}

	#getGroupOrder(session: ObservableSession): number {
		const parentOrder = session.parentToolCallId
			? this.#parentSortOrderById.get(session.parentToolCallId)
			: undefined;
		return parentOrder ?? this.#getStableOrder(session);
	}

	setMainSession(sessionFile?: string): void {
		const existing = this.#sessions.get("main");
		this.#ensureSortOrder("main");
		this.#sessions.set("main", {
			id: "main",
			kind: "main",
			label: "Main Session",
			status: "active",
			sessionFile: sessionFile ?? existing?.sessionFile,
			lastUpdate: Date.now(),
		});
		this.#notifyListeners("main");
	}

	getSessions(): ObservableSession[] {
		const sessions = [...this.#sessions.values()];
		const mainSessionFile = this.#sessions.get("main")?.sessionFile;
		if (mainSessionFile) {
			const registry = AgentRegistry.global();
			for (const ref of registry.list()) {
				if (ref.kind !== "sub" || ref.status !== "parked" || this.#sessions.has(ref.id)) continue;
				if (resolveTopLevelAgent(registry, ref.id)?.sessionFile !== mainSessionFile) continue;
				const observation = getPersistedAgentSnapshot(ref)?.observations.get(ref.id);
				if (!observation?.status) continue;
				const status =
					observation.status === "completed" || observation.status === "failed" || observation.status === "aborted"
						? observation.status
						: observation.status === "pending" || observation.status === "running"
							? "active"
							: undefined;
				const lastUpdate = observation.lastUpdate ?? observation.activityState?.lastActivityAtMs;
				if (!status || lastUpdate === undefined) continue;
				const sortOrder = this.#ensureSortOrder(ref.id);
				this.#ensureParentSortOrder(observation.parentToolCallId, sortOrder);
				sessions.push({
					id: ref.id,
					kind: "subagent",
					label: observation.description ?? ref.displayName,
					agent: observation.agent,
					description: observation.description,
					status,
					sessionFile: ref.sessionFile ?? undefined,
					parentToolCallId: observation.parentToolCallId,
					index: observation.index,
					lastUpdate,
					startedAtMs: observation.progress?.startedAtMs,
					completedAtMs: observation.progress?.completedAtMs,
					progress: observation.progress,
					resolvedModel: observation.resolvedModel,
					resolvedModelIsFallback: observation.resolvedModelIsFallback,
					retryState: observation.retryState,
					retryFailure: observation.retryFailure,
				});
			}
		}
		sessions.sort((a, b) => {
			if (a.kind === "main" && b.kind !== "main") return -1;
			if (b.kind === "main" && a.kind !== "main") return 1;
			if (a.kind === "main" || b.kind === "main") return 0;

			const groupDiff = this.#getGroupOrder(a) - this.#getGroupOrder(b);
			if (groupDiff !== 0) return groupDiff;

			const aIndex = a.index ?? Number.MAX_SAFE_INTEGER;
			const bIndex = b.index ?? Number.MAX_SAFE_INTEGER;
			if (aIndex !== bIndex) return aIndex - bIndex;

			return this.#getStableOrder(a) - this.#getStableOrder(b);
		});
		return sessions;
	}

	getActiveSubagentCount(): number {
		let count = 0;
		for (const session of this.getSessions()) {
			if (session.kind === "subagent" && session.status === "active") count++;
		}
		return count;
	}

	/** Clear all tracked sessions (e.g. on session switch). Keeps EventBus subscriptions and listeners. */
	resetSessions(): void {
		this.#sessions.clear();
		this.#sortOrderById.clear();
		this.#parentSortOrderById.clear();
		this.#nextSortOrder = 0;
		this.#notifyListeners("reset");
	}

	dispose(): void {
		for (const unsub of this.#eventBusUnsubscribers) unsub();
		this.#eventBusUnsubscribers = [];
		this.#sessions.clear();
		this.#sortOrderById.clear();
		this.#parentSortOrderById.clear();
		this.#nextSortOrder = 0;
		this.#listeners.clear();
	}

	subscribeToEventBus(eventBus: EventBus): void {
		// Dispose previous EventBus subscriptions if called again
		for (const unsub of this.#eventBusUnsubscribers) unsub();
		this.#eventBusUnsubscribers = [];

		this.#eventBusUnsubscribers.push(
			eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
				const payload = data as SubagentLifecyclePayload;
				const status = STATUS_MAP[payload.status];
				if (!status) return;

				const sortOrder = this.#ensureSortOrder(payload.id);
				this.#ensureParentSortOrder(payload.parentToolCallId, sortOrder);
				const existing = this.#sessions.get(payload.id);
				const now = Date.now();
				const startedAtMs = isFiniteEpoch(payload.startedAtMs)
					? payload.startedAtMs
					: (existing?.startedAtMs ?? existing?.progress?.startedAtMs);
				const completedAtMs =
					status === "active"
						? undefined
						: isFiniteEpoch(payload.completedAtMs)
							? payload.completedAtMs
							: (existing?.completedAtMs ?? existing?.progress?.completedAtMs ?? now);
				if (existing) {
					if (startedAtMs !== undefined) existing.startedAtMs = startedAtMs;
					if (status === "active") {
						delete existing.completedAtMs;
					} else if (completedAtMs !== undefined) {
						existing.completedAtMs = completedAtMs;
					}
					if (existing.progress) {
						const nextStatus: AgentProgress["status"] = status === "active" ? "running" : status;
						const nextProgress = { ...existing.progress, status: nextStatus };
						existing.progress = withSessionTiming(nextProgress, existing);
					}
					existing.status = status;
					existing.lastUpdate = now;
					existing.index = payload.index;
					existing.parentToolCallId = payload.parentToolCallId ?? existing.parentToolCallId;
					existing.detached = payload.detached ?? existing.detached;
					if (payload.description) existing.description = payload.description;
					if (payload.sessionFile) existing.sessionFile = payload.sessionFile;
				} else {
					this.#sessions.set(payload.id, {
						id: payload.id,
						kind: "subagent",
						label: payload.description ?? `Subagent #${payload.index}`,
						agent: payload.agent,
						description: payload.description,
						status,
						sessionFile: payload.sessionFile,
						parentToolCallId: payload.parentToolCallId,
						detached: payload.detached,
						index: payload.index,
						lastUpdate: now,
						startedAtMs,
						...(completedAtMs === undefined ? {} : { completedAtMs }),
					});
				}
				this.#notifyListeners("lifecycle");
			}),
		);

		this.#eventBusUnsubscribers.push(
			eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
				const payload = data as SubagentProgressPayload;
				const progress = payload.progress;
				const id = progress.id;
				const existing = this.#sessions.get(id);
				const snapshot = withSessionTiming(progress, existing);
				const status = STATUS_MAP[snapshot.status];
				if (!status) return;
				// Progress can be coalesced independently from lifecycle events. Once a
				// lifecycle generation is terminal, only a new `started` lifecycle event
				// may reopen it; a late progress snapshot must never resurrect or rewrite it.
				if (existing && existing.status !== "active" && status !== existing.status) return;

				const sortOrder = this.#ensureSortOrder(id);
				this.#ensureParentSortOrder(payload.parentToolCallId, sortOrder);
				if (existing) {
					if (snapshot.startedAtMs !== undefined) existing.startedAtMs = snapshot.startedAtMs;
					if (snapshot.completedAtMs === undefined) delete existing.completedAtMs;
					else existing.completedAtMs = snapshot.completedAtMs;
					existing.lastUpdate = Date.now();
					existing.index = payload.index;
					existing.parentToolCallId = payload.parentToolCallId ?? existing.parentToolCallId;
					existing.detached = payload.detached ?? existing.detached;
					existing.status = status;
					existing.progress = snapshot;
					if (snapshot.description) existing.description = snapshot.description;
					if (payload.sessionFile) existing.sessionFile = payload.sessionFile;
				} else {
					this.#sessions.set(id, {
						id,
						kind: "subagent",
						label: progress.description ?? `Subagent #${payload.index}`,
						agent: payload.agent,
						description: progress.description,
						status,
						sessionFile: payload.sessionFile,
						parentToolCallId: payload.parentToolCallId,
						detached: payload.detached,
						index: payload.index,
						lastUpdate: Date.now(),
						startedAtMs: snapshot.startedAtMs,
						completedAtMs: snapshot.completedAtMs,
						progress: snapshot,
					});
				}
				this.#notifyListeners("progress");
			}),
		);
	}
}
