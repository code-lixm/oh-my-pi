import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, ToolCall, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolExecutionHandle } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { TUI } from "@oh-my-pi/pi-tui";

const TOOL_CALL_A_ID = "toolu_mixed_text_order_a";
const TOOL_CALL_B_ID = "toolu_mixed_text_order_b";
const INTRO_MARKER = "INTRO TEXT BEFORE FIRST TOOL";
const TOOL_RESULT_A_MARKER = "TOOL RESULT FROM FIRST TOOL";
const MIDDLE_MARKER = "MIDDLE TEXT BETWEEN TOOL CALLS";
const TOOL_RESULT_B_MARKER = "TOOL RESULT FROM SECOND TOOL";
const FINAL_MARKER = "FINAL ANSWER AFTER SECOND TOOL";
const THINKING_TOOL_ID = "toolu_thinking_visibility";
const THINKING_TOOL_NAME = "thinking_visibility_probe";
const TOOL_BOUNDARY_RESULT = "TOOL BOUNDARY RESULT";
const FIRST_THINKING_CODE = "```ts\nconst beforeToolReasoning = true;\n```";
const FIRST_THINKING_MARKER = "const beforeToolReasoning = true;";
const SECOND_THINKING_CODE = "```ts\nconst afterToolReasoning = true;\n```";
const SECOND_THINKING_MARKER = "const afterToolReasoning = true;";
const HIDDEN_BASH_COMMAND_MARKER = "HIDDEN BASH COMMAND MARKER";
const HIDDEN_BASH_FAILURE_MARKER = "HIDDEN BASH FAILURE MARKER";
const HIDDEN_READ_PATH_MARKER = "hidden-tool-activity.ts";

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "cursor",
		provider: "cursor",
		model: "cursor-model",
		stopReason: "stop",
		usage: zeroUsage(),
		timestamp: 1,
	};
}

function lineContaining(lines: string[], marker: string): number {
	const index = lines.findIndex(line => line.includes(marker));
	if (index === -1) {
		throw new Error(`Rendered transcript did not contain ${marker}:\n${lines.join("\n")}`);
	}
	return index;
}

function createFixture(hideToolActivity = false) {
	const chatContainer = new TranscriptContainer();
	chatContainer.setToolActivityVisible(!hideToolActivity);
	const pendingTools = new Map<string, ToolExecutionHandle>();
	const requestRender = vi.fn();
	const requestComponentRender = vi.fn();
	const ui = {
		requestRender,
		requestComponentRender,
		imageBudget: undefined,
	} as unknown as TUI;
	const viewSession = {
		getToolByName: () => undefined,
		hasBuiltInTool: () => true,
		extensionRunner: undefined,
		isTtsrAbortPending: false,
		retryAttempt: 0,
	};
	let hasDisplayableThinkingContent = false;
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui,
		settings,
		chatContainer,
		transcriptMessageComponents: new WeakMap(),
		pendingTools,
		toolOutputExpanded: false,
		hideToolActivity,
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: true,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		noteDisplayableThinkingContent: vi.fn((message: AssistantMessage) => {
			const hasThinking = message.content.some(
				content => content.type === "thinking" && content.thinking.trim() !== "",
			);
			if (!hasThinking || hasDisplayableThinkingContent) return false;
			hasDisplayableThinkingContent = true;
			return true;
		}),
		session: viewSession,
		viewSession,
		sessionManager: { getCwd: () => process.cwd() },
		showWarning: vi.fn(),
		showPinnedError: vi.fn(),
		clearTransientSessionUi: vi.fn(),
		lastAssistantUsage: zeroUsage(),
	};

	return {
		controller: new EventController(ctx as unknown as InteractiveModeContext),
		chatContainer,
		ctx,
		requestRender,
		requestComponentRender,
	};
}

describe("EventController mixed assistant text/tool rendering", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("scopes cumulative assistant stream updates to the transcript while start and end stay full boundaries", async () => {
		const { controller, chatContainer, requestRender, requestComponentRender } = createFixture();
		const streamedRead: ToolCall = {
			type: "toolCall",
			id: "toolu_scoped_stream_read",
			name: "read",
			arguments: { path: "streamed-scoped-render.ts" },
		};
		const started = assistantMessage([]);
		const cumulative = assistantMessage([{ type: "text", text: "STREAMED SCOPED TRANSCRIPT CONTENT" }, streamedRead]);

		await controller.handleEvent({ type: "message_start", message: started } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		expect(requestRender).toHaveBeenCalled();

		requestRender.mockClear();
		requestComponentRender.mockClear();
		await controller.handleEvent({
			type: "message_update",
			message: cumulative,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: streamedRead,
				partial: cumulative,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);

		expect(Bun.stripANSI(chatContainer.render(120).join("\n"))).toContain("STREAMED SCOPED TRANSCRIPT CONTENT");
		expect(requestRender).not.toHaveBeenCalled();
		expect(requestComponentRender.mock.calls).toEqual([[chatContainer]]);

		requestRender.mockClear();
		requestComponentRender.mockClear();
		await controller.handleEvent({ type: "message_end", message: cumulative } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		expect(requestRender).toHaveBeenCalled();
	});

	it("renders assistant text segments in order around two tool results from one mixed message", async () => {
		const { controller, chatContainer } = createFixture();
		const toolCallA: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_A_ID,
			name: "contract_probe_a",
			arguments: { value: "a" },
		};
		const toolCallB: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_B_ID,
			name: "contract_probe_b",
			arguments: { value: "b" },
		};
		const started = assistantMessage([]);
		const withFirstToolCall = assistantMessage([{ type: "text", text: INTRO_MARKER }, toolCallA]);
		const withSecondToolCall = assistantMessage([
			{ type: "text", text: INTRO_MARKER },
			toolCallA,
			{ type: "text", text: MIDDLE_MARKER },
			toolCallB,
		]);
		const completed = assistantMessage([
			{ type: "text", text: INTRO_MARKER },
			toolCallA,
			{ type: "text", text: MIDDLE_MARKER },
			toolCallB,
			{ type: "text", text: FINAL_MARKER },
		]);

		await controller.handleEvent({ type: "message_start", message: started } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({
			type: "message_update",
			message: withFirstToolCall,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: toolCallA,
				partial: withFirstToolCall,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await controller.handleEvent({
			type: "message_update",
			message: withSecondToolCall,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 3,
				toolCall: toolCallB,
				partial: withSecondToolCall,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		const liveLines = chatContainer.render(120).map(line => Bun.stripANSI(line));
		expect(lineContaining(liveLines, INTRO_MARKER)).toBeLessThan(lineContaining(liveLines, MIDDLE_MARKER));
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_A_ID,
			toolName: "contract_probe_a",
			args: { value: "a" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_A_ID,
			toolName: "contract_probe_a",
			result: { content: [{ type: "text", text: TOOL_RESULT_A_MARKER }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_B_ID,
			toolName: "contract_probe_b",
			args: { value: "b" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_B_ID,
			toolName: "contract_probe_b",
			result: { content: [{ type: "text", text: TOOL_RESULT_B_MARKER }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({ type: "message_end", message: completed } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		const lines = chatContainer.render(120).map(line => Bun.stripANSI(line));
		const introLine = lineContaining(lines, INTRO_MARKER);
		const toolResultALine = lineContaining(lines, TOOL_RESULT_A_MARKER);
		const middleLine = lineContaining(lines, MIDDLE_MARKER);
		const toolResultBLine = lineContaining(lines, TOOL_RESULT_B_MARKER);
		const finalLine = lineContaining(lines, FINAL_MARKER);

		expect(introLine).toBeLessThan(toolResultALine);
		expect(toolResultALine).toBeLessThan(middleLine);
		expect(lines.filter(line => line.includes(MIDDLE_MARKER))).toHaveLength(1);
		expect(middleLine).toBeLessThan(toolResultBLine);
		expect(toolResultBLine).toBeLessThan(finalLine);
	});

	for (const display of [
		{ name: "full", hidden: false, proseOnly: false },
		{ name: "prose", hidden: false, proseOnly: true },
		{ name: "hidden", hidden: true, proseOnly: false },
	] as const) {
		it(`renders ${display.name} thinking deltas before a tool boundary without waiting for message_end`, async () => {
			const { controller, chatContainer, ctx } = createFixture();
			ctx.effectiveHideThinkingBlock = display.hidden;
			ctx.proseOnlyThinking = display.proseOnly;
			const toolCall: ToolCall = {
				type: "toolCall",
				id: THINKING_TOOL_ID,
				name: THINKING_TOOL_NAME,
				arguments: { target: "thinking visibility" },
			};
			const started = assistantMessage([]);
			const beforeTool = assistantMessage([{ type: "thinking", thinking: FIRST_THINKING_CODE }]);
			const atToolBoundary = assistantMessage([{ type: "thinking", thinking: FIRST_THINKING_CODE }, toolCall]);
			const afterTool = assistantMessage([
				{ type: "thinking", thinking: FIRST_THINKING_CODE },
				toolCall,
				{ type: "thinking", thinking: SECOND_THINKING_CODE },
			]);
			const renderLines = () => chatContainer.render(120).map(line => Bun.stripANSI(line));
			const assertFirstThinking = (lines: string[]) => {
				if (display.name === "full") {
					expect(lines.join("\n")).toContain(FIRST_THINKING_MARKER);
					return;
				}
				if (display.name === "prose") {
					expect(lines.some(line => line.trim() === "...")).toBe(true);
					expect(lines.join("\n")).not.toContain(FIRST_THINKING_MARKER);
					return;
				}
				expect(lines.join("\n")).not.toContain(FIRST_THINKING_MARKER);
				expect(lines.some(line => line.trim() === "...")).toBe(false);
			};

			await controller.handleEvent({ type: "message_start", message: started } as Extract<
				AgentSessionEvent,
				{ type: "message_start" }
			>);
			await controller.handleEvent({
				type: "message_update",
				message: beforeTool,
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: FIRST_THINKING_CODE,
					partial: beforeTool,
				},
			} as Extract<AgentSessionEvent, { type: "message_update" }>);

			// No message_end has occurred: this is the live transcript before any tool card exists.
			assertFirstThinking(renderLines());

			await controller.handleEvent({
				type: "message_update",
				message: atToolBoundary,
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 1,
					toolCall,
					partial: atToolBoundary,
				},
			} as Extract<AgentSessionEvent, { type: "message_update" }>);
			assertFirstThinking(renderLines());

			await controller.handleEvent({
				type: "tool_execution_start",
				toolCallId: THINKING_TOOL_ID,
				toolName: THINKING_TOOL_NAME,
				args: toolCall.arguments,
			} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: THINKING_TOOL_ID,
				toolName: THINKING_TOOL_NAME,
				result: { content: [{ type: "text", text: TOOL_BOUNDARY_RESULT }] },
				isError: false,
			} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
			await controller.handleEvent({
				type: "message_update",
				message: afterTool,
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 2,
					delta: SECOND_THINKING_CODE,
					partial: afterTool,
				},
			} as Extract<AgentSessionEvent, { type: "message_update" }>);

			const lines = renderLines();
			const toolResultLine = lineContaining(lines, TOOL_BOUNDARY_RESULT);
			if (display.name === "full") {
				const firstLine = lineContaining(lines, FIRST_THINKING_MARKER);
				const secondLine = lineContaining(lines, SECOND_THINKING_MARKER);
				expect(lines.filter(line => line.includes(FIRST_THINKING_MARKER))).toHaveLength(1);
				expect(lines.filter(line => line.includes(SECOND_THINKING_MARKER))).toHaveLength(1);
				expect(firstLine).toBeLessThan(toolResultLine);
				expect(toolResultLine).toBeLessThan(secondLine);
			} else if (display.name === "prose") {
				const ellipsisLines = lines.flatMap((line, index) => (line.trim() === "..." ? [index] : []));
				expect(ellipsisLines).toHaveLength(2);
				expect(lines.join("\n")).not.toContain(FIRST_THINKING_MARKER);
				expect(lines.join("\n")).not.toContain(SECOND_THINKING_MARKER);
				expect(ellipsisLines[0]).toBeLessThan(toolResultLine);
				expect(toolResultLine).toBeLessThan(ellipsisLines[1]!);
			} else {
				expect(lines.join("\n")).not.toContain(FIRST_THINKING_MARKER);
				expect(lines.join("\n")).not.toContain(SECOND_THINKING_MARKER);
				expect(lines.some(line => line.trim() === "...")).toBe(false);
			}
		});
	}
	it("keeps assistant text streaming while hiding bash failures and grouped read activity", async () => {
		const { controller, chatContainer } = createFixture(true);
		const bashCall: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_A_ID,
			name: "bash",
			arguments: { command: `printf '${HIDDEN_BASH_COMMAND_MARKER}'` },
		};
		const readCall: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_B_ID,
			name: "read",
			arguments: { path: HIDDEN_READ_PATH_MARKER },
		};
		const started = assistantMessage([]);
		const streaming = assistantMessage([
			{ type: "text", text: INTRO_MARKER },
			bashCall,
			{ type: "text", text: MIDDLE_MARKER },
			readCall,
			{ type: "text", text: FINAL_MARKER },
		]);

		await controller.handleEvent({ type: "message_start", message: started } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({
			type: "message_update",
			message: streaming,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 3,
				toolCall: readCall,
				partial: streaming,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_A_ID,
			toolName: "bash",
			args: bashCall.arguments,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_A_ID,
			toolName: "bash",
			result: { content: [{ type: "text", text: HIDDEN_BASH_FAILURE_MARKER }] },
			isError: true,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_B_ID,
			toolName: "read",
			args: readCall.arguments,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_B_ID,
			toolName: "read",
			result: { content: [{ type: "text", text: "read result must stay hidden" }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({ type: "message_end", message: streaming } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(rendered).toContain(INTRO_MARKER);
		expect(rendered).toContain(MIDDLE_MARKER);
		expect(rendered).toContain(FINAL_MARKER);
		expect(rendered).not.toContain(HIDDEN_BASH_COMMAND_MARKER);
		expect(rendered).not.toContain(HIDDEN_BASH_FAILURE_MARKER);
		expect(rendered).not.toContain(HIDDEN_READ_PATH_MARKER);
	});
});
