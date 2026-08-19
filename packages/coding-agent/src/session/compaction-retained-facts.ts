import type { AgentMessage, AgentToolCall } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionCommandFact,
	type CompactionDetails,
	type CompactionFailureFact,
	type CompactionPreparation,
	type CompactionRetainedFacts,
	getCompactionRetainedFacts,
} from "@oh-my-pi/pi-agent-core/compaction/compaction";
import { toolOperationKey } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { TodoPhase } from "../tools/todo";
import type { SessionEntry, WorkspaceCheckpointEntry } from "./session-entries";

const MAX_TODOS = 50;
const MAX_COMMANDS = 20;
const MAX_FAILURES = 20;
const MAX_RECOVERABLE_URIS = 40;
const MAX_COMMAND_CHARS = 2_000;
const MAX_FAILURE_CHARS = 2_000;
const RECOVERABLE_URI_RE = /(?:artifact|history|local|memory):\/\/[^\s)\]}>`'"]+/g;

function boundedLine(text: string, maxChars: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function collectToolCalls(messages: readonly AgentMessage[]): Map<string, AgentToolCall> {
	const calls = new Map<string, AgentToolCall>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") calls.set(block.id, block);
		}
	}
	return calls;
}

function toolResultText(message: ToolResultMessage): string {
	return message.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

function collectRecoverableUris(message: AgentMessage, target: Set<string>): void {
	if (!("content" in message)) return;
	const content = message.content;
	const texts: string[] = [];
	if (typeof content === "string") {
		texts.push(content);
	} else {
		for (const block of content) {
			if (block.type === "text") texts.push(block.text);
		}
	}
	for (const text of texts) {
		for (const match of text.matchAll(RECOVERABLE_URI_RE)) {
			const uri = match[0];
			if (uri) target.add(uri);
		}
	}
}

function conclusiveToolSuccess(message: ToolResultMessage): boolean {
	if (message.isError) return false;
	const details = message.details;
	if (!isRecord(details) || !isRecord(details.async)) return true;
	return details.async.state !== "running";
}

function resultExitCode(message: ToolResultMessage): number | undefined {
	const details = message.details;
	if (!isRecord(details) || typeof details.exitCode !== "number") return undefined;
	return details.exitCode;
}

function currentWorkspaceCheckpoint(entries: readonly SessionEntry[]): WorkspaceCheckpointEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "workspace_checkpoint") return entry;
	}
	return undefined;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
}

/** Attach deterministic state that must survive independently of the prose summary. */
export function withCompactionRetainedFacts(
	details: unknown,
	preparation: CompactionPreparation,
	branchEntries: readonly SessionEntry[],
	todoPhases: readonly TodoPhase[],
): CompactionDetails {
	let previousFacts: CompactionRetainedFacts | undefined;
	for (let index = branchEntries.length - 1; index >= 0; index--) {
		const entry = branchEntries[index];
		if (entry.type !== "compaction") continue;
		previousFacts = getCompactionRetainedFacts(entry.details);
		break;
	}
	const sourceDetails = isRecord(details) ? details : {};
	const commands = new Map<string, CompactionCommandFact>();
	for (const command of previousFacts?.commands ?? []) commands.set(command.command, command);
	const failures = new Map<string, CompactionFailureFact>();
	for (const failure of previousFacts?.unresolvedFailures ?? []) failures.set(failure.operationKey, failure);
	const recoverableUris = new Set(previousFacts?.recoverableUris ?? []);

	const compactedMessages = new Set<AgentMessage>([
		...preparation.messagesToSummarize,
		...preparation.turnPrefixMessages,
	]);
	const allMessages = [...compactedMessages, ...preparation.recentMessages];
	const toolCalls = collectToolCalls(allMessages);
	for (const message of allMessages) {
		const compacted = compactedMessages.has(message);
		if (compacted) collectRecoverableUris(message, recoverableUris);
		if (message.role !== "toolResult") continue;
		const toolResult = message as ToolResultMessage;
		const toolCall = toolCalls.get(toolResult.toolCallId);
		if (!toolCall) continue;
		const operationKey = toolOperationKey(toolCall.name, toolCall.arguments);
		const canonicalArgs = operationKey.slice(toolCall.name.length + 1);
		const operation = boundedLine(
			toolCall.name === "bash" && typeof toolCall.arguments.command === "string"
				? toolCall.arguments.command
				: canonicalArgs,
			MAX_COMMAND_CHARS,
		);

		if (conclusiveToolSuccess(toolResult)) {
			failures.delete(operationKey);
		} else if (toolResult.isError) {
			if (compacted) {
				failures.set(operationKey, {
					operationKey,
					tool: toolCall.name,
					operation,
					error: boundedLine(toolResultText(toolResult), MAX_FAILURE_CHARS),
				});
			} else {
				failures.delete(operationKey);
			}
		}

		if (toolCall.name !== "bash" || typeof toolCall.arguments.command !== "string") continue;
		const command = boundedLine(toolCall.arguments.command, MAX_COMMAND_CHARS);
		if (!compacted) {
			commands.delete(command);
			continue;
		}
		const exitCode = resultExitCode(toolResult);
		commands.delete(command);
		commands.set(command, {
			command,
			outcome: toolResult.isError || (exitCode !== undefined && exitCode !== 0) ? "failed" : "passed",
			...(exitCode === undefined ? {} : { exitCode }),
		});
	}

	const todos = todoPhases
		.flatMap(phase =>
			phase.tasks.flatMap(task => {
				if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "blocked") return [];
				return [
					{
						phase: phase.name,
						content: task.content,
						status: task.status,
						...(task.blocker === undefined ? {} : { blocker: task.blocker }),
					},
				];
			}),
		)
		.slice(0, MAX_TODOS);
	const checkpoint = currentWorkspaceCheckpoint(branchEntries);
	const retainedFacts: CompactionRetainedFacts = {
		todos,
		commands: [...commands.values()].slice(-MAX_COMMANDS),
		unresolvedFailures: [...failures.values()].slice(-MAX_FAILURES),
		recoverableUris: [...recoverableUris].slice(-MAX_RECOVERABLE_URIS),
		...(checkpoint
			? {
					workspaceCheckpoint: {
						id: checkpoint.checkpointId,
						reason: checkpoint.reason,
						...(checkpoint.label === null ? {} : { label: checkpoint.label }),
					},
				}
			: {}),
	};
	return {
		readFiles: stringArray(sourceDetails.readFiles),
		modifiedFiles: stringArray(sourceDetails.modifiedFiles),
		retainedFacts,
	};
}
