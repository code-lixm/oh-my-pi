export interface AutonomousConfig {
	enabled?: boolean;
	maxContinuations?: number;
	maxTurns?: number;
	maxTokens?: number;
	timeoutMs?: number;
	continuationPrompt?: string;
	gates?: AutonomousGateConfig;
}

export interface AutonomousGateConfig {
	commands?: string[];
	maxRetries?: number;
	timeoutMs?: number;
}

export interface AutonomousGateFailure {
	command: string;
	attempt: number;
	exitText: string;
	output: string;
}

export interface AutonomousStatus {
	enabled: boolean;
	/** Host-owned persistent goal mode currently owns continuation decisions. */
	goalActive: boolean;
	continuationsUsed: number;
	turnsUsed: number;
	tokensUsed: number;
	startedAt?: number;
	limits: Required<Omit<AutonomousConfig, "enabled" | "continuationPrompt" | "gates">>;
	gates: Required<AutonomousGateConfig>;
	gateAttempts: Record<string, number>;
	lastGateFailure?: AutonomousGateFailure;
}

export interface AutonomousRuntimeState {
	enabled: boolean;
	/** Host-owned persistent goal mode currently owns continuation decisions. */
	goalActive: boolean;
	continuationsUsed: number;
	turnsUsed: number;
	tokensUsed: number;
	startedAt?: number;
	limits: Required<Omit<AutonomousConfig, "enabled" | "continuationPrompt" | "gates">>;
	continuationPrompt: string;
	gates: Required<AutonomousGateConfig>;
	gateAttempts: Record<string, number>;
	lastGateFailure?: AutonomousGateFailure;
	lastGateFailureSnapshot?: GitWorktreeSnapshot;
}

export interface AutonomousContinuationResult {
	shouldContinue: boolean;
	continuationPrompt?: string;
	/** True when another host-owned loop (currently goal mode) blocks this loop. */
	blocked?: boolean;
	/** True when autonomous mode is disabled rather than blocked by another loop. */
	disabled?: boolean;
	status: "continued" | "blocked" | "disabled" | "stopped";
	reason: AutonomousDecision["reason"];
}

export interface AutonomousDecision {
	shouldContinue: boolean;
	reason: "missing_terminal_evidence" | "gate_failed" | "not_needed" | "limit_reached" | "goal_active";
}

export type AutonomousLimitReason = "maxContinuations" | "maxTurns" | "maxTokens" | "timeoutMs";
export type AutonomousGateResult = "passed" | "failed" | "retry_exhausted";

export interface GitWorktreeSnapshot {
	status: string;
	diff: string;
	untrackedHash: string;
}

export const DEFAULT_LIMITS = {
	maxContinuations: 3,
	maxTurns: 12,
	maxTokens: 80_000,
	timeoutMs: 30 * 60 * 1000,
} as const;

export const DEFAULT_GATES = {
	commands: [] as string[],
	maxRetries: 3,
	timeoutMs: 5 * 60 * 1000,
} as const;

export const MAX_GATE_OUTPUT_CHARS = 6000;
export const MAX_CHILD_PROCESS_OUTPUT_CHARS = 1024 * 1024;

// DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT moved to prompts/autonomous/continuation-prompt.md (locale overlay)
