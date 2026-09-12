import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "../types";

const LEGACY_INTENT_FIELD = "__intent";
const SIGNATURE_SUMMARY_LIMIT = 400;

/** Runtime settings for detecting repeated completed turns with no observable progress. */
export interface NoProgressLoopGuardOptions {
	readonly threshold: number;
}

/** A completed assistant turn plus tool results available at that boundary. */
export interface NoProgressLoopTurn {
	readonly message: AssistantMessage;
	readonly toolResults: readonly ToolResultMessage[];
}

/** Details for a repeated no-progress sequence. */
export interface NoProgressLoopDetection {
	readonly kind: "repeated_no_progress";
	readonly count: number;
	readonly signature: string;
	readonly summary: string;
}

function canonicalizeValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(item => canonicalizeValue(item));
	if (!value || typeof value !== "object") return value;

	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (key === INTENT_FIELD || key === LEGACY_INTENT_FIELD) continue;
		output[key] = canonicalizeValue(input[key]);
	}
	return output;
}

function summarize(signature: string): string {
	return signature.length > SIGNATURE_SUMMARY_LIMIT ? `${signature.slice(0, SIGNATURE_SUMMARY_LIMIT)}…` : signature;
}

function normalizeThinking(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeBashResult(text: string): string {
	return text.replace(/\n+Wall time: \d+(?:\.\d+)? seconds\s*$/, "").trimEnd();
}

function literalEcho(command: string): { value: string; placeholder: boolean } | undefined {
	const match = command.trim().match(/^echo\s+(?:"([^"\\$`\r\n]*)"|'([^'\r\n]*)'|([^\s|;&><()$`\\]+))$/);
	const value = match?.[1] ?? match?.[2] ?? match?.[3];
	if (value === undefined) return undefined;
	return { value, placeholder: /^(?:placeholder|占位|dummy)(?:\s*[-_ ]?\d+)?$/i.test(value) };
}

function toolResultText(result: ToolResultMessage): string {
	return result.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

function toolCallSignature(message: AssistantMessage, toolResults: readonly ToolResultMessage[]): string | undefined {
	const toolCalls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
	if (toolCalls.length === 0 || toolCalls.some(toolCall => toolCall.name === "hub")) return undefined;

	const signatures: string[] = [];
	for (const toolCall of toolCalls) {
		const result = toolResults.find(candidate => candidate.toolCallId === toolCall.id);
		if (!result) return undefined;
		const args = canonicalizeValue(toolCall.arguments);
		const command =
			toolCall.name === "bash" && typeof (args as Record<string, unknown>).command === "string"
				? ((args as Record<string, unknown>).command as string)
				: undefined;
		const echo = command === undefined ? undefined : literalEcho(command);
		if (echo !== undefined && !result.isError && normalizeBashResult(toolResultText(result)) === echo.value) {
			signatures.push(echo.placeholder ? "bash:placeholder-echo" : `bash:literal-echo:${echo.value}`);
			continue;
		}
		const resultValue =
			command === undefined
				? { content: result.content, isError: result.isError }
				: {
						content: [{ type: "text", text: normalizeBashResult(toolResultText(result)) }],
						isError: result.isError,
					};
		signatures.push(
			`tool:${toolCall.name}:${JSON.stringify(args)}:result:${JSON.stringify(canonicalizeValue(resultValue))}`,
		);
	}
	return signatures.join("\n");
}

function equivalentSignature(left: string, right: string): boolean {
	if (left === right) return true;
	if (!left.startsWith("thinking:") || !right.startsWith("thinking:")) return false;
	const leftWords = new Set(left.slice("thinking:".length).split(" ").filter(Boolean));
	const rightWords = new Set(right.slice("thinking:".length).split(" ").filter(Boolean));
	if (leftWords.size < 8 || rightWords.size < 8) return false;
	let intersection = 0;
	for (const word of leftWords) if (rightWords.has(word)) intersection++;
	const union = new Set([...leftWords, ...rightWords]).size;
	return union > 0 && intersection / union >= 0.9;
}

function thinkingSignature(message: AssistantMessage): string | undefined {
	const thinking = message.content
		.filter(content => content.type === "thinking")
		.map(content => normalizeThinking(content.thinking))
		.filter(Boolean)
		.join("\n");
	if (!thinking) return undefined;

	const hasToolCall = message.content.some(content => content.type === "toolCall");
	return hasToolCall ? undefined : `thinking:${thinking}`;
}
/**
 * Detects a run of completed turns that repeat the same no-progress behavior.
 * Repeated assistant narration does not count as progress; changed tool
 * semantics or results still break the run.
 */
export class NoProgressLoopGuard {
	#threshold: number;
	#lastSignature: string | undefined;
	#count = 0;

	constructor(options: NoProgressLoopGuardOptions) {
		this.#threshold = Math.max(1, Math.trunc(options.threshold));
	}

	/** Records a completed turn and returns every threshold-sized no-progress run. */
	recordTurn(turn: NoProgressLoopTurn): NoProgressLoopDetection | null {
		const signature = toolCallSignature(turn.message, turn.toolResults) ?? thinkingSignature(turn.message);
		if (!signature) {
			this.#lastSignature = undefined;
			this.#count = 0;
			return null;
		}

		if (this.#lastSignature !== undefined && equivalentSignature(signature, this.#lastSignature)) {
			this.#count++;
		} else {
			this.#lastSignature = signature;
			this.#count = 1;
		}
		if (this.#count % this.#threshold !== 0) return null;
		return { kind: "repeated_no_progress", count: this.#count, signature, summary: summarize(signature) };
	}
}
