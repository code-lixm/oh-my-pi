import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { NoProgressLoopGuard, type NoProgressLoopTurn } from "@oh-my-pi/pi-ai/utils/no-progress-loop-guard";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: zeroUsage,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function toolTurn(id: string, arguments_: Record<string, unknown>, result: string): NoProgressLoopTurn {
	return {
		message: assistant([{ type: "toolCall", id, name: "bash", arguments: arguments_ }]),
		toolResults: [
			{
				role: "toolResult",
				toolCallId: id,
				toolName: "bash",
				content: [{ type: "text", text: result }],
				isError: false,
				timestamp: 1,
			},
		],
	};
}

function visibleTextToolTurn(
	id: string,
	arguments_: Record<string, unknown>,
	result: string,
	text: string,
): NoProgressLoopTurn {
	return {
		message: assistant([
			{ type: "text", text },
			{ type: "toolCall", id, name: "bash", arguments: arguments_ },
		]),
		toolResults: [
			{
				role: "toolResult",
				toolCallId: id,
				toolName: "bash",
				content: [{ type: "text", text: result }],
				isError: false,
				timestamp: 1,
			},
		],
	};
}

function thinkingOnlyTurn(thinking: string): NoProgressLoopTurn {
	return { message: assistant([{ type: "thinking", thinking }]), toolResults: [] };
}

describe("NoProgressLoopGuard", () => {
	test("clears a semantically identical tool-call run when its result changes", () => {
		const guard = new NoProgressLoopGuard({ threshold: 2 });

		expect(
			guard.recordTurn(toolTurn("first", { command: "git status --short", timeout: 30 }, "No files changed.")),
		).toBeNull();
		expect(
			guard.recordTurn(toolTurn("second", { timeout: 30, command: "git status --short" }, "src/index.ts modified")),
		).toBeNull();
		expect(
			guard.recordTurn(toolTurn("third", { command: "git status --short", timeout: 30 }, "src/index.ts modified")),
		).toMatchObject({
			kind: "repeated_no_progress",
			count: 2,
		});
	});

	test("clears a no-progress run when tool-call semantics change", () => {
		const guard = new NoProgressLoopGuard({ threshold: 2 });

		expect(guard.recordTurn(toolTurn("first", { command: "git status --short" }, "No files changed."))).toBeNull();
		expect(guard.recordTurn(toolTurn("second", { command: "git diff --stat" }, "No files changed."))).toBeNull();
		expect(guard.recordTurn(toolTurn("third", { command: "git diff --stat" }, "No files changed."))).toMatchObject({
			kind: "repeated_no_progress",
			count: 2,
		});
	});

	test("detects only the tenth identical completed no-progress tool turn", () => {
		const guard = new NoProgressLoopGuard({ threshold: 10 });
		for (let index = 1; index < 10; index++) {
			expect(
				guard.recordTurn(toolTurn(`call-${index}`, { command: "git status --short" }, "No files changed.")),
			).toBeNull();
		}

		expect(
			guard.recordTurn(toolTurn("call-10", { command: "git status --short" }, "No files changed.")),
		).toMatchObject({
			kind: "repeated_no_progress",
			count: 10,
		});
	});

	test("clears a no-progress run when the assistant emits visible text alongside a tool call", () => {
		const guard = new NoProgressLoopGuard({ threshold: 2 });

		expect(guard.recordTurn(toolTurn("first", { command: "git status --short" }, "No files changed."))).toBeNull();
		expect(
			guard.recordTurn(
				visibleTextToolTurn(
					"second",
					{ command: "git status --short" },
					"No files changed.",
					"I verified the current repository state.",
				),
			),
		).toBeNull();
		expect(guard.recordTurn(toolTurn("third", { command: "git status --short" }, "No files changed."))).toBeNull();
		expect(
			guard.recordTurn(toolTurn("fourth", { command: "git status --short" }, "No files changed.")),
		).toMatchObject({
			kind: "repeated_no_progress",
			count: 2,
		});
	});

	test("detects normalized repeated thinking-only turns", () => {
		const guard = new NoProgressLoopGuard({ threshold: 2 });

		expect(guard.recordTurn(thinkingOnlyTurn("ＰＬＡＮ：　Ｒｅａｄ　ＲＥＡＤＭＥ"))).toBeNull();
		expect(guard.recordTurn(thinkingOnlyTurn("plan:\nread\tREADME"))).toMatchObject({
			kind: "repeated_no_progress",
			count: 2,
		});
	});

	test("detects near-duplicate thinking when most normalized words are shared", () => {
		const guard = new NoProgressLoopGuard({ threshold: 2 });
		const base = "inspect source files compare behavior record evidence explain blocker summarize result";

		expect(guard.recordTurn(thinkingOnlyTurn(base))).toBeNull();
		expect(guard.recordTurn(thinkingOnlyTurn(`${base} carefully`))).toMatchObject({
			kind: "repeated_no_progress",
			count: 2,
		});
	});
});
