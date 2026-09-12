import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { countTokens } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";

/**
 * Locally-counted token total for an in-flight assistant message.
 *
 * The activity row needs a token count *while* the turn is running, but
 * `usage.output` only lands in the provider's final chunk — Ollama reports
 * `eval_count` on `done`, Anthropic on `message_delta`. Counting the message's
 * own content gives a monotonic reading from the first delta, which is what the
 * rate tracker needs. Provider-reported usage wins whenever it is present so the
 * reading snaps to the exact billed figure the moment it arrives.
 *
 * Counts every block the provider bills for: visible text, thinking traces, and
 * tool-call arguments. Reasoning text is usually streamed *before* any visible
 * output, so omitting it would leave the row at zero through the whole thinking
 * phase — the case the live rate exists to cover.
 */
export function countStreamingAssistantTokens(message: AssistantMessage | undefined): number {
	if (!message) return 0;
	const reported = message.usage?.output;
	if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) return reported;

	const fragments: string[] = [];
	for (const block of message.content) {
		switch (block.type) {
			case "text":
				fragments.push(block.text);
				break;
			case "thinking":
				fragments.push(block.thinking);
				break;
			case "toolCall":
				fragments.push(block.name);
				if (block.arguments !== undefined) fragments.push(JSON.stringify(block.arguments));
				break;
			default:
				break;
		}
	}
	if (fragments.length === 0) return 0;
	return countTokens(fragments);
}

/**
 * In-flight assistant message of `messages`-bearing agent state, or undefined
 * when the session is idle. Kept here rather than at each call site so the
 * streaming surfaces agree on what "currently generating" means.
 */
export function streamingAssistantMessage(state: { streamMessage: AgentMessage | null }): AssistantMessage | undefined {
	const message = state.streamMessage;
	return message?.role === "assistant" ? message : undefined;
}
