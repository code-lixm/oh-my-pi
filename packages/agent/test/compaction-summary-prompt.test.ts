import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { generateSummary } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Message, Model, Usage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const MODEL: Model = buildModel({
	id: "mock-model",
	name: "mock-model",
	api: "mock",
	provider: "mock",
	baseUrl: "mock://",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_768,
});

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const REQUIRED_SECTIONS = [
	"## Objective",
	"## Important Details",
	"## Work State",
	"## Next Move",
	"## Relevant Files",
] as const;

const P3_CONTINUITY_REQUIREMENTS = [
	"same execution chain",
	"user constraints/preferences",
	"settled decisions with rationale/evidence",
	"verified facts/assumptions",
	"### Completed",
	"completed work or delivered updates",
	"verified facts/commands with outcomes",
	"### Active",
	"current work, partial changes, pending decisions, or investigation state",
	"### Blocked",
	"blockers, failing commands with outcomes, essential missing state, or unknowns",
	"immediate concrete action",
	"recoverable file, artifact/history URI, or summary reference",
	"Preserve exact file paths, symbols, commands, command outcomes, error strings, URLs, identifiers, and recoverable URIs when known.",
	"Essential state missing? State the exact gap in Blocked; make recovery the first Next Move.",
] as const;

const PREVIOUS_SUMMARY = `## Objective
- Keep the prior objective current.

## Important Details
- Preserve earlier verified facts.

## Work State
### Completed
- Captured the previous run state.

### Active
- Waiting on the next focused change.

### Blocked
- (none)

## Next Move
1. Run the focused tests.
2. Report the result.

## Relevant Files
- packages/agent/test/compaction-summary-prompt.test.ts: prompt contract coverage`;

function makeAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeConversation(): AgentMessage[] {
	return [
		{ role: "user", content: "Protect the OpenCode compaction contract.", timestamp: 1 },
		makeAssistantMessage("The new summary must stay in the later model context verbatim."),
	];
}

function extractPromptText(message: Message | undefined): string {
	if (!message) throw new Error("Expected a compaction summary request message");
	if (message.role !== "user") throw new Error("Expected the compaction summary request to be a user message");
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

function promptInstructions(promptText: string, boundary: string): string {
	const boundaryIndex = promptText.indexOf(boundary);
	expect(boundaryIndex).toBeGreaterThanOrEqual(0);
	return promptText.slice(boundaryIndex + boundary.length);
}

function expectAnchoredOpenCodeSchema(promptText: string): void {
	let previousIndex = -1;
	for (const heading of REQUIRED_SECTIONS) {
		const index = promptText.indexOf(heading);
		expect(index).toBeGreaterThan(previousIndex);
		previousIndex = index;
	}
}

function expectP3ContinuityRequirements(instructions: string): void {
	for (const requirement of P3_CONTINUITY_REQUIREMENTS) {
		expect(instructions).toContain(requirement);
	}
	expect(instructions).toContain("Continue from recorded state; NEVER redo Completed work.");
	expect(instructions).toContain("NEVER reopen settled decisions without new contradictory evidence.");
}

describe("generateSummary prompt contract", () => {
	test("initial summaries require the anchored OpenCode schema and P3 execution continuity", async () => {
		let capturedPrompt = "";
		await generateSummary(makeConversation(), MODEL, 4096, "test-api-key", undefined, undefined, undefined, {
			completeImpl: async (_model, ctx) => {
				expect(ctx.messages).toHaveLength(1);
				capturedPrompt = extractPromptText(ctx.messages[0]);
				return makeAssistantMessage(PREVIOUS_SUMMARY);
			},
		});

		expect(capturedPrompt).toContain("<conversation>");
		expect(capturedPrompt).toContain("Protect the OpenCode compaction contract.");
		expect(capturedPrompt).not.toContain("<previous-summary>");
		const instructions = promptInstructions(capturedPrompt, "</conversation>\n\n");
		expectAnchoredOpenCodeSchema(instructions);
		expectP3ContinuityRequirements(instructions);
	});

	test("update summaries retain prior context and require the anchored schema with P3 continuity", async () => {
		let capturedPrompt = "";
		await generateSummary(makeConversation(), MODEL, 4096, "test-api-key", undefined, undefined, PREVIOUS_SUMMARY, {
			completeImpl: async (_model, ctx) => {
				expect(ctx.messages).toHaveLength(1);
				capturedPrompt = extractPromptText(ctx.messages[0]);
				return makeAssistantMessage(PREVIOUS_SUMMARY);
			},
		});

		expect(capturedPrompt).toContain("<previous-summary>");
		expect(capturedPrompt).toContain(PREVIOUS_SUMMARY);
		const instructions = promptInstructions(capturedPrompt, "</previous-summary>\n\n");
		expectAnchoredOpenCodeSchema(instructions);
		expectP3ContinuityRequirements(instructions);
		expect(instructions).toContain("Preserve still-true details, remove stale details, and merge in new facts.");
	});
});
