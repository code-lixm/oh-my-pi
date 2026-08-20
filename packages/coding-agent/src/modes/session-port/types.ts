import type { AgentMessage, ThinkingLevel, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { Model, ToolExample } from "@oh-my-pi/pi-ai";
import type { ContextUsage } from "../../extensibility/extensions/types";
import type { SlashCommandInfo } from "../../extensibility/slash-commands";
import type { GoalModeState } from "../../goals/state";
import type { PlanModeState } from "../../plan-mode/state";
import type { AgentActivityState } from "../../registry/agent-activity";
import type { AsyncJobSnapshot } from "../../session/agent-session-types";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type { TodoPhase } from "../../tools/todo";
import type { VibeModeState } from "../../vibe/state";
import type { RpcSubagentSnapshot } from "../rpc/rpc-types";

/** Stable identity for a session projection without exposing its live session object. */
export interface InteractiveSessionIdentity {
	readonly sessionId: string;
	readonly agentId?: string;
	readonly agentKind?: "main" | "sub";
}

/** Busy state consumed by an independently rendered session view. */
export interface InteractiveSessionBusyFlags {
	readonly isStreaming: boolean;
	readonly isBashRunning: boolean;
	readonly isEvalRunning: boolean;
	readonly isCompacting: boolean;
}

/** Mode state that affects interactive input, status, and rendering. */
export interface InteractiveSessionModes {
	readonly steering: "all" | "one-at-a-time";
	readonly followUp: "all" | "one-at-a-time";
	readonly interrupt: "immediate" | "wait";
	readonly autoCompactionEnabled: boolean;
	readonly fastModeEnabled: boolean;
	readonly fastModeActive: boolean;
	readonly plan?: PlanModeState;
	readonly goal?: GoalModeState;
	readonly vibe?: VibeModeState;
}

/** Serializable tool metadata required by an interactive session view. */
export interface InteractiveSessionTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: unknown;
	readonly examples?: readonly ToolExample[];
	readonly enabled?: boolean;
	readonly loadMode?: ToolLoadMode;
}

/**
 * Complete serializable state needed to render an interactive session outside
 * the backend process. It intentionally contains no AgentSession instance or
 * other live runtime capability.
 */
export interface InteractiveSessionProjection {
	readonly identity: InteractiveSessionIdentity;
	readonly cwd: string;
	/** Persisted session file path, when this session has one. */
	readonly path?: string;
	readonly name?: string;
	readonly model?: Model;
	readonly thinkingLevel: ThinkingLevel | undefined;
	readonly configuredThinkingLevel: ConfiguredThinkingLevel | undefined;
	readonly busy: InteractiveSessionBusyFlags;
	readonly activity?: AgentActivityState;
	readonly todo: readonly TodoPhase[];
	readonly queue: { readonly steering: readonly string[]; readonly followUp: readonly string[] };
	readonly modes: InteractiveSessionModes;
	readonly context?: ContextUsage;
	readonly jobs: AsyncJobSnapshot | null;
	readonly subagents: readonly RpcSubagentSnapshot[];
	readonly commands: readonly SlashCommandInfo[];
	readonly tools: readonly InteractiveSessionTool[];
	readonly messages: readonly AgentMessage[];
}

/** A shallow replacement patch for one or more projection fields. */
export type InteractiveSessionProjectionPatch = Partial<InteractiveSessionProjection>;

/** Monotonic reliable-stream position within one session generation. */
export interface InteractiveSessionCursor {
	readonly generation: string;
	readonly sequence: number;
}

/** An atomic projection replacement used to establish or resynchronize state. */
export interface InteractiveSessionSnapshot {
	readonly cursor: InteractiveSessionCursor;
	readonly projection: InteractiveSessionProjection;
}

/**
 * Ordered backend state change. A final view key indicates that the reliable
 * update supersedes pending volatile view work for that key.
 */
export interface InteractiveSessionReliableFrame {
	readonly generation: string;
	readonly sequence: number;
	readonly patch: InteractiveSessionProjectionPatch;
	readonly finalViewKey?: string;
}

/**
 * Coalescible view update. Revisions are monotonic per key and may skip values
 * after coalescing; baseReliableSequence prevents application against a state
 * that predates the frame's reliable dependency.
 */
export interface InteractiveSessionViewFrame {
	readonly generation: string;
	readonly key: string;
	readonly revision: number;
	readonly baseReliableSequence: number;
	readonly patch: InteractiveSessionProjectionPatch;
}
