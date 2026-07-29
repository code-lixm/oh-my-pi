export type AgentActivityPhase =
	| "queued"
	| "requesting"
	| "thinking"
	| "streaming"
	| "tool"
	| "delegating"
	| "retrying"
	| "compacting"
	| "waiting-user"
	| "waiting-peer"
	| "finishing"
	| "idle";

export interface DeterminateActivityProgress {
	completed: number;
	total: number;
	unit?: string;
}

/**
 * Structured, transport-safe description of what an agent is doing now.
 *
 * `phaseStartedAtMs` measures time in the current phase. `lastActivityAtMs`
 * advances only when real work is observed (provider data, tool/job progress,
 * or a lifecycle transition), so renderers can describe quiet periods without
 * inventing percentage progress or declaring a slow request dead.
 */
export interface AgentActivityState {
	phase: AgentActivityPhase;
	label: string;
	detail?: string;
	phaseStartedAtMs: number;
	lastActivityAtMs: number;
	progress?: DeterminateActivityProgress;
}

export type AgentActivityHealth = "active" | "quiet" | "suspected-stall" | "blocked";
