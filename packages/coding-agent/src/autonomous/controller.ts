import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import continuationPrompt from "../prompts/autonomous/continuation-prompt.md" with { type: "text" };
import continuationPromptZh from "../prompts/autonomous/continuation-prompt.zh-CN.md" with { type: "text" };
import gateFailureContinuationPrompt from "../prompts/autonomous/gate-failure-continuation.md" with { type: "text" };
import gateFailureContinuationPromptZh from "../prompts/autonomous/gate-failure-continuation.zh-CN.md" with {
	type: "text",
};
import { selectPrompt } from "../prompts/prompt-locale";
import { captureWorktreeSnapshot, runGateCommand, truncateGateOutput, worktreeSnapshotsEqual } from "./gate-runner";
import {
	type AutonomousConfig,
	type AutonomousDecision,
	type AutonomousGateFailure,
	type AutonomousGateResult,
	type AutonomousLimitReason,
	type AutonomousRuntimeState,
	type AutonomousStatus,
	DEFAULT_GATES,
	DEFAULT_LIMITS,
	MAX_CHILD_PROCESS_OUTPUT_CHARS,
	MAX_GATE_OUTPUT_CHARS,
} from "./types";

/** Mirrors AgentSession's hard session_stop continuation guard. */
export const AUTONOMOUS_SESSION_STOP_CONTINUATION_CAP = 8;

export type AutonomousLimitState = Pick<
	AutonomousStatus,
	"continuationsUsed" | "turnsUsed" | "tokensUsed" | "startedAt" | "limits"
>;

export interface AutonomousOperationOptions {
	cwd?: string;
	signal?: AbortSignal;
	/** Ephemeral host hint; the controller's persistent state remains authoritative. */
	goalActive?: boolean;
}
export type AutonomousUsage = Pick<AssistantMessage["usage"], "input" | "output" | "cacheWrite">;

export function createAutonomousRuntimeState(config?: AutonomousConfig): AutonomousRuntimeState {
	const enabled = config?.enabled === true;
	return {
		enabled,
		goalActive: false,
		continuationsUsed: 0,
		turnsUsed: 0,
		tokensUsed: 0,
		startedAt: enabled ? Date.now() : undefined,
		limits: {
			maxContinuations: normalizeLimit(config?.maxContinuations, DEFAULT_LIMITS.maxContinuations),
			maxTurns: normalizeLimit(config?.maxTurns, DEFAULT_LIMITS.maxTurns),
			maxTokens: normalizeLimit(config?.maxTokens, DEFAULT_LIMITS.maxTokens),
			timeoutMs: normalizeLimit(config?.timeoutMs, DEFAULT_LIMITS.timeoutMs),
		},
		continuationPrompt: config?.continuationPrompt?.trim() || defaultContinuationPrompt(),
		gates: {
			commands: [...(config?.gates?.commands ?? DEFAULT_GATES.commands)],
			maxRetries: normalizeLimit(config?.gates?.maxRetries, DEFAULT_GATES.maxRetries),
			timeoutMs: normalizeLimit(config?.gates?.timeoutMs, DEFAULT_GATES.timeoutMs),
		},
		gateAttempts: {},
		lastGateFailure: undefined,
		lastGateFailureSnapshot: undefined,
	};
}

export function setAutonomousEnabled(state: AutonomousRuntimeState, enabled: boolean): void {
	state.enabled = enabled;
	if (enabled) {
		state.continuationsUsed = 0;
		state.turnsUsed = 0;
		state.tokensUsed = 0;
		state.startedAt = Date.now();
		state.gateAttempts = {};
		state.lastGateFailure = undefined;
		state.lastGateFailureSnapshot = undefined;
		return;
	}
	state.startedAt = undefined;
	state.gateAttempts = {};
	state.lastGateFailure = undefined;
	state.lastGateFailureSnapshot = undefined;
}

export function autonomousStatus(state: AutonomousRuntimeState): AutonomousStatus {
	return {
		enabled: state.enabled,
		goalActive: state.goalActive === true,
		continuationsUsed: state.continuationsUsed,
		turnsUsed: state.turnsUsed,
		tokensUsed: state.tokensUsed,
		startedAt: state.startedAt,
		limits: { ...state.limits },
		gates: { ...state.gates, commands: [...state.gates.commands] },
		gateAttempts: { ...state.gateAttempts },
		lastGateFailure: state.lastGateFailure ? { ...state.lastGateFailure } : undefined,
	};
}

/** Account a completed assistant turn and its non-cache-read token cost. */
export function addAutonomousUsage(state: AutonomousRuntimeState, usage: AutonomousUsage | undefined): void {
	if (!state.enabled) return;
	state.turnsUsed++;
	state.tokensUsed += autonomousTokenDelta(usage);
}

/** Use when host accounting provides turn and token usage separately. */
export function addAutonomousTurn(state: AutonomousRuntimeState): void {
	if (state.enabled) state.turnsUsed++;
}

export function addAutonomousContinuation(state: AutonomousRuntimeState): void {
	if (state.enabled) state.continuationsUsed++;
}

export async function shouldAutonomouslyContinue(
	state: AutonomousRuntimeState,
	message: AssistantMessage,
	options: AutonomousOperationOptions = {},
	now = Date.now(),
): Promise<AutonomousDecision> {
	options.signal?.throwIfAborted();
	if (state.goalActive === true || options.goalActive === true) {
		return { shouldContinue: false, reason: "goal_active" };
	}
	if (!state.enabled || message.stopReason === "error" || message.stopReason === "aborted") {
		return { shouldContinue: false, reason: "not_needed" };
	}

	const gateResult = await refreshQualityGates(state, options);
	options.signal?.throwIfAborted();
	if (gateResult) {
		if (gateResult === "passed") return { shouldContinue: false, reason: "not_needed" };
		if (gateResult === "retry_exhausted" || autonomousLimitReason(state, now)) {
			return { shouldContinue: false, reason: "limit_reached" };
		}
		return { shouldContinue: true, reason: "gate_failed" };
	}
	if (autonomousLimitReason(state, now)) return { shouldContinue: false, reason: "limit_reached" };
	return { shouldContinue: true, reason: "missing_terminal_evidence" };
}

export function autonomousLimitReason(
	state: AutonomousLimitState,
	now = Date.now(),
): AutonomousLimitReason | undefined {
	if (state.continuationsUsed >= state.limits.maxContinuations) return "maxContinuations";
	if (state.turnsUsed >= state.limits.maxTurns) return "maxTurns";
	if (state.tokensUsed >= state.limits.maxTokens) return "maxTokens";
	if (state.startedAt !== undefined && now - state.startedAt >= state.limits.timeoutMs) return "timeoutMs";
	return undefined;
}

export async function refreshQualityGates(
	state: AutonomousRuntimeState,
	options: AutonomousOperationOptions = {},
): Promise<AutonomousGateResult | undefined> {
	options.signal?.throwIfAborted();
	if (!state.enabled || state.gates.commands.length === 0) return undefined;
	if (!options.cwd) return "failed";

	for (const command of state.gates.commands) {
		const currentSnapshot = await captureWorktreeSnapshot(options.cwd, options.signal);
		options.signal?.throwIfAborted();
		if (
			state.lastGateFailure?.command === command &&
			state.lastGateFailureSnapshot &&
			worktreeSnapshotsEqual(currentSnapshot, state.lastGateFailureSnapshot)
		) {
			const attempt = (state.gateAttempts[command] ?? state.lastGateFailure.attempt) + 1;
			state.gateAttempts[command] = attempt;
			state.lastGateFailure = {
				...state.lastGateFailure,
				attempt,
				exitText: "not rerun: workspace unchanged since previous failed gate",
				output:
					"The autonomous gate was not rerun because the workspace has not changed since this failure. Edit source files, tests, or a blocker artifact before attempting to finish again.",
			};
			return attempt > state.gates.maxRetries ? "retry_exhausted" : "failed";
		}

		const result = await runGateCommand(command, options.cwd, {
			timeoutMs: state.gates.timeoutMs,
			maxOutputChars: MAX_CHILD_PROCESS_OUTPUT_CHARS,
			signal: options.signal,
		});
		options.signal?.throwIfAborted();
		const postRunSnapshot = await captureWorktreeSnapshot(options.cwd, options.signal);
		options.signal?.throwIfAborted();
		if (result.status === 0 && !result.error && !result.timedOut) {
			state.gateAttempts[command] = 0;
			if (state.lastGateFailure?.command === command) {
				state.lastGateFailure = undefined;
				state.lastGateFailureSnapshot = undefined;
			}
			continue;
		}

		const attempt = (state.gateAttempts[command] ?? 0) + 1;
		state.gateAttempts[command] = attempt;
		state.lastGateFailure = {
			command,
			attempt,
			exitText: formatProcessExit(result),
			output: truncateGateOutput(
				[result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
				result.outputTruncated,
				MAX_GATE_OUTPUT_CHARS,
			),
		};
		state.lastGateFailureSnapshot = postRunSnapshot;
		return attempt > state.gates.maxRetries ? "retry_exhausted" : "failed";
	}

	state.lastGateFailure = undefined;
	state.lastGateFailureSnapshot = undefined;
	return "passed";
}

export function buildGateFailureContinuation(
	failure: AutonomousGateFailure,
	maxRetries: number,
	timestamp = Date.now(),
): string {
	const template = selectPrompt(gateFailureContinuationPrompt, gateFailureContinuationPromptZh);
	return prompt.render(template, {
		attempt: failure.attempt,
		maxRetries,
		command: failure.command,
		exitText: failure.exitText,
		output: failure.output,
		timestamp: new Date(timestamp).toISOString(),
	});
}

/**
 * Pure, serializable controller. Session ownership and persistence are supplied
 * by the integration layer; this class never retains an AgentSession reference.
 */
export type AutonomousStateListener = (state: AutonomousRuntimeState) => void;

export class AutonomousController {
	#state: AutonomousRuntimeState;
	readonly #onChange: AutonomousStateListener | undefined;

	constructor(initial?: AutonomousConfig | AutonomousRuntimeState, onChange?: AutonomousStateListener) {
		this.#state = isAutonomousRuntimeState(initial)
			? cloneRuntimeState(initial)
			: createAutonomousRuntimeState(initial);
		this.#onChange = onChange;
		if (this.#state.enabled) this.#assertContinuationCap();
	}

	get state(): AutonomousRuntimeState {
		return cloneRuntimeState(this.#state);
	}

	setEnabled(enabled: boolean): void {
		if (enabled) this.#assertContinuationCap();
		setAutonomousEnabled(this.#state, enabled);
		this.#notify();
	}

	configure(config: AutonomousConfig): void {
		const maxContinuations =
			config.maxContinuations === undefined
				? undefined
				: normalizeLimit(config.maxContinuations, DEFAULT_LIMITS.maxContinuations);
		if (maxContinuations !== undefined && maxContinuations > AUTONOMOUS_SESSION_STOP_CONTINUATION_CAP) {
			throw new RangeError(
				`autonomous maxContinuations must not exceed ${AUTONOMOUS_SESSION_STOP_CONTINUATION_CAP} (session_stop continuation cap)`,
			);
		}

		if (config.maxContinuations !== undefined) this.#state.limits.maxContinuations = maxContinuations!;
		if (config.maxTurns !== undefined) {
			this.#state.limits.maxTurns = normalizeLimit(config.maxTurns, DEFAULT_LIMITS.maxTurns);
		}
		if (config.maxTokens !== undefined) {
			this.#state.limits.maxTokens = normalizeLimit(config.maxTokens, DEFAULT_LIMITS.maxTokens);
		}
		if (config.timeoutMs !== undefined) {
			this.#state.limits.timeoutMs = normalizeLimit(config.timeoutMs, DEFAULT_LIMITS.timeoutMs);
		}
		if (config.continuationPrompt !== undefined) {
			this.#state.continuationPrompt = config.continuationPrompt.trim() || defaultContinuationPrompt();
		}
		if (config.gates?.commands !== undefined) this.#state.gates.commands = [...config.gates.commands];
		if (config.gates?.maxRetries !== undefined) {
			this.#state.gates.maxRetries = normalizeLimit(config.gates.maxRetries, DEFAULT_GATES.maxRetries);
		}
		if (config.gates?.timeoutMs !== undefined) {
			this.#state.gates.timeoutMs = normalizeLimit(config.gates.timeoutMs, DEFAULT_GATES.timeoutMs);
		}
		if (config.enabled !== undefined) {
			if (config.enabled) this.#assertContinuationCap();
			setAutonomousEnabled(this.#state, config.enabled);
		}
		this.#notify();
	}

	status(): AutonomousStatus {
		return autonomousStatus(this.#state);
	}

	async checkContinuation(
		lastMessage: unknown,
		options: { cwd: string; signal?: AbortSignal },
	): Promise<{ shouldContinue: boolean; continuationPrompt?: string }> {
		options.signal?.throwIfAborted();
		if (!this.#state.enabled) return { shouldContinue: false };

		try {
			addAutonomousUsage(this.#state, usageFromUnknownMessage(lastMessage));
			const decision = await shouldAutonomouslyContinue(this.#state, asAssistantMessage(lastMessage), options);
			options.signal?.throwIfAborted();
			if (!decision.shouldContinue || !this.#state.enabled) return { shouldContinue: false };

			addAutonomousContinuation(this.#state);
			return {
				shouldContinue: true,
				continuationPrompt:
					decision.reason === "gate_failed"
						? this.#state.lastGateFailure
							? buildGateFailureContinuation(this.#state.lastGateFailure, this.#state.gates.maxRetries)
							: this.#state.continuationPrompt
						: this.#state.continuationPrompt,
			};
		} finally {
			this.#notify();
		}
	}

	/** Replace state from the session persistence layer after restore/switch. */
	replaceState(state: AutonomousRuntimeState): void {
		const next = cloneRuntimeState(state);
		if (next.enabled && next.limits.maxContinuations > AUTONOMOUS_SESSION_STOP_CONTINUATION_CAP) {
			throw new RangeError(
				`autonomous maxContinuations must not exceed ${AUTONOMOUS_SESSION_STOP_CONTINUATION_CAP} (session_stop continuation cap)`,
			);
		}
		this.#state = next;
	}

	#notify(): void {
		this.#onChange?.(this.state);
	}

	#assertContinuationCap(): void {
		if (this.#state.limits.maxContinuations > AUTONOMOUS_SESSION_STOP_CONTINUATION_CAP) {
			throw new RangeError(
				`autonomous maxContinuations must not exceed ${AUTONOMOUS_SESSION_STOP_CONTINUATION_CAP} (session_stop continuation cap)`,
			);
		}
	}
}

function autonomousTokenDelta(usage: AutonomousUsage | undefined): number {
	if (!usage) return 0;
	return usage.input + usage.output + usage.cacheWrite;
}

function formatProcessExit(result: { status: number; timedOut: boolean; error?: string }): string {
	if (result.timedOut) return "timed out";
	if (result.error) return result.error;
	return `exited ${result.status}`;
}

function defaultContinuationPrompt(): string {
	return selectPrompt(continuationPrompt, continuationPromptZh).trim();
}

function normalizeLimit(value: number | undefined, fallback: number): number {
	if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
	return Math.trunc(value);
}

export function isAutonomousRuntimeState(value: unknown): value is AutonomousRuntimeState {
	if (!isRecord(value) || typeof value.enabled !== "boolean") return false;
	if (!isRecord(value.limits) || !isRecord(value.gates) || !isRecord(value.gateAttempts)) return false;
	return (
		typeof value.continuationsUsed === "number" &&
		typeof value.turnsUsed === "number" &&
		typeof value.tokensUsed === "number" &&
		typeof value.continuationPrompt === "string" &&
		Array.isArray(value.gates.commands)
	);
}

function cloneRuntimeState(state: AutonomousRuntimeState): AutonomousRuntimeState {
	return {
		...state,
		limits: { ...state.limits },
		gates: { ...state.gates, commands: [...state.gates.commands] },
		gateAttempts: { ...state.gateAttempts },
		lastGateFailure: state.lastGateFailure ? { ...state.lastGateFailure } : undefined,
		lastGateFailureSnapshot: state.lastGateFailureSnapshot ? { ...state.lastGateFailureSnapshot } : undefined,
	};
}

function asAssistantMessage(message: unknown): AssistantMessage {
	return (isRecord(message) ? message : {}) as unknown as AssistantMessage;
}

function usageFromUnknownMessage(message: unknown): AutonomousUsage | undefined {
	if (!isRecord(message) || !isRecord(message.usage)) return undefined;
	const usage = message.usage;
	if (typeof usage.input !== "number" || typeof usage.output !== "number" || typeof usage.cacheWrite !== "number") {
		return undefined;
	}
	return usage as unknown as AutonomousUsage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
