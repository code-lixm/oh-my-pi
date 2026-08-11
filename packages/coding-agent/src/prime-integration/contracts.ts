import type { AutonomousRuntimeState } from "../autonomous/types";
import type { RlmChildRegistryEntry, RlmSpawnHandle } from "../eval/rlm-types";
import type { AgentMessageReceipt, AgentMessageSendOptions, AgentMessageTarget } from "../irc/rlm-message-adapter";
import type { HarnessScope, HarnessState } from "../refinement/types";
import type { ScheduleJob } from "../scheduling/types";

/**
 * Scheduled prompt delivery adapter.
 * Implemented by 01 (scheduling/runtime.ts), injected into AgentSession by integration owner.
 */
export interface ScheduledPromptDelivery {
	deliverScheduledPrompt(job: ScheduleJob): Promise<void>;
}

/**
 * Autonomous continuation provider.
 * Implemented by 02 (autonomous/continuation-hook.ts), injected into AgentSession.
 * Called through the guarded #emitSessionStopEvent path (not bypassing the cap).
 */
export interface AutonomousContinuationProvider {
	readonly state: AutonomousRuntimeState | undefined;
	checkContinuation(
		lastMessage: unknown,
		options: { cwd: string; signal?: AbortSignal },
	): Promise<{ shouldContinue: boolean; continuationPrompt?: string }>;
}

/** Options shared by direct and host-scheduled refinement requests. */
export interface RefinementOptions {
	instructions?: string;
	scope?: HarnessScope;
}

export interface RefinementController {
	onTurnEnd(session: unknown): Promise<void>;
	/** Trajectory reset point: compaction rewrote history, so the turn gate restarts and the gate check runs immediately. */
	onCompaction(): Promise<void>;
	refine(session: unknown, options?: RefinementOptions): Promise<void>;
	rollback(session: unknown, resultId: string, scope?: HarnessScope): Promise<void>;
	scheduleRefinement(options?: RefinementOptions): { requestId: string };
	scheduleRollback(resultId: string, scope?: HarnessScope): { requestId: string };
	drainScheduled(): Promise<void>;
	clearScheduled(): void;
	getState(): Promise<HarnessState>;
}

/**
 * RLM child lifecycle manager.
 * Implemented by 04 (eval/rlm-bridge.ts), injected into AgentSession.
 */
export interface RlmChildLifecycle {
	spawnChild(prompt: string, options: { name?: string; model?: string }): Promise<RlmSpawnHandle>;
	listChildren(): RlmChildRegistryEntry[];
	deleteChild(target: string): Promise<void>;
	listAgents?(): AgentMessageTarget[];
	refreshAgents?(): Promise<void>;
	sendMessage?(message: string, options: AgentMessageSendOptions): Promise<AgentMessageReceipt>;
	broadcastMessage?(message: string): Promise<AgentMessageReceipt[]>;
}

/**
 * Prompt contribution descriptor.
 * Each slice exports a render function; the integration owner wires it into system-prompt.ts.
 * No global registry — passed explicitly during integration wiring.
 */
export interface PromptContribution {
	id: string;
	render(context: { harnessState?: HarnessState; pythonSkillMetadata?: unknown }): string | undefined;
}

/**
 * Provider bundle injected into each AgentSession during integration wiring.
 * Each field is optional — a session may have none, some, or all providers.
 * This struct is created per-session (no global state, no cross-session leakage).
 */
export interface PrimeIntegrationProviders {
	scheduling?: ScheduledPromptDelivery;
	autonomous?: AutonomousContinuationProvider;
	refinement?: RefinementController;
	rlm?: RlmChildLifecycle;
}
