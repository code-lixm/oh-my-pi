import type { AgentEvent, AgentToolResult, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Effort } from "@oh-my-pi/pi-ai";
import type { Rule } from "../capability/rule";
import type { RetryErrorUpdate } from "../extensibility/shared-events";
import type { Goal, GoalModeState } from "../goals/state";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { TodoItem } from "../tools/todo";
import type { CustomMessage } from "./messages";

export type MemoryOperation = "retain" | "recall" | "reflect";
export type MemoryOperationTrigger = "auto-recall" | "auto-retain" | "compaction" | "maintenance" | "shutdown";

export type MemoryOperationResult = Pick<AgentToolResult, "content" | "details">;

/** Optional event surface used by memory backends and lightweight test hosts. */
export interface MemoryOperationEmitter {
	beginMemoryOperation?: (operation: MemoryOperation, args: unknown, trigger: MemoryOperationTrigger) => string;
	endMemoryOperation?: (
		operationId: string,
		operation: MemoryOperation,
		result: MemoryOperationResult,
		isError?: boolean,
	) => void;
}

export function emitMemoryOperationStart(
	session: MemoryOperationEmitter,
	operation: MemoryOperation,
	args: unknown,
	trigger: MemoryOperationTrigger,
): string | undefined {
	return session.beginMemoryOperation?.(operation, args, trigger);
}

export function emitMemoryOperationEnd(
	session: MemoryOperationEmitter,
	operationId: string | undefined,
	operation: MemoryOperation,
	result: MemoryOperationResult,
	isError = false,
): void {
	if (operationId === undefined) return;
	session.endMemoryOperation?.(operationId, operation, result, isError);
}

export interface MemoryOperationStartEvent {
	type: "memory_operation_start";
	operationId: string;
	operation: MemoryOperation;
	args: unknown;
	trigger: MemoryOperationTrigger;
}

export interface MemoryOperationEndEvent {
	type: "memory_operation_end";
	operationId: string;
	operation: MemoryOperation;
	result: MemoryOperationResult;
	isError?: boolean;
}

/** Session-specific events that extend the core AgentEvent. */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| (Extract<AgentEvent, { type: "agent_end" }> & {
			/** False when an async delivery will resume the session before its true final settle. */
			isTerminal?: boolean;
	  })
	| MemoryOperationStartEvent
	| MemoryOperationEndEvent
	| {
			type: "auto_compaction_start";
			reason: "threshold" | "overflow" | "idle" | "incomplete";
			action: "context-full" | "handoff" | "shake" | "snapcompact";
	  }
	| {
			type: "auto_compaction_end";
			action: "context-full" | "handoff" | "shake" | "snapcompact";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			/** True when compaction was skipped for a benign reason. */
			skipped?: boolean;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			errorId?: number;
			model?: string;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
			retryErrors?: RetryErrorUpdate[];
	  }
	| { type: "retry_fallback_applied"; from: string; to: string; role: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	| { type: "retry_fallback_restored"; from: string; to: string; role: string }
	| { type: "model_changed" }
	| { type: "ttsr_triggered"; rules: Rule[] }
	| { type: "todo_reminder"; todos: TodoItem[]; attempt: number; maxAttempts: number }
	| { type: "todo_auto_clear" }
	| { type: "queue_changed" }
	| { type: "irc_message"; message: CustomMessage }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| {
			type: "thinking_level_changed";
			thinkingLevel: ThinkingLevel | undefined;
			/** The user-configured selector when it differs from the effective level. */
			configured?: ConfiguredThinkingLevel;
			/** The level `auto` resolved to this turn, once classified. */
			resolved?: Effort;
	  }
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState };

/** Listener function for agent session events. */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
