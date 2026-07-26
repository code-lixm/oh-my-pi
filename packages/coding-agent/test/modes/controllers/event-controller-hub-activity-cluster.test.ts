/**
 * Contracts:
 * 1. Live Hub `wait(from)` / `inbox` feedback goes to `showSubagentFeedback`
 *    instead of rendering IRC transcript rows, and pure message waits never show
 *    a visible pending card.
 * 2. Useful Hub transcript rows still render: awaited `send`, job-id `wait`, and
 *    Hub errors remain visible.
 * 3. Transcript rebuild skips historical IRC custom messages while preserving the
 *    useful Hub rows from the same turn.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-coding-agent/modes/components/chat-transcript-builder";
import { HubActivityGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/hub-activity-group";
import type { ToolExecutionHandle } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { Component, TUI } from "@oh-my-pi/pi-tui";

const HUB_SEND_ID = "hub-send";
const HUB_WAIT_ID = "hub-wait";

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

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason,
		usage: emptyUsage(),
		timestamp: 1,
	};
}

function makeIrcMessage(body: string, from = "Worker", timestamp = 1_700_000_000_500) {
	return {
		role: "custom" as const,
		customType: "irc:incoming" as const,
		content: body,
		display: true,
		details: { from, message: body },
		timestamp,
	};
}

function createLiveFixture() {
	const chatContainer = new TranscriptContainer();
	const pendingTools = new Map<string, ToolExecutionHandle>();
	const requestRender = vi.fn(() => {});
	const requestComponentRender = vi.fn(() => {});
	const addMessageToChat = vi.fn();
	const showSubagentFeedback = vi.fn();
	const sessionStub = {
		getToolByName: () => undefined,
		extensionRunner: undefined,
		isTtsrAbortPending: false,
		retryAttempt: 0,
	};
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender, requestComponentRender, imageBudget: undefined },
		settings,
		chatContainer,
		transcriptMessageComponents: new WeakMap(),
		pendingTools,
		toolOutputExpanded: false,
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: true,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		noteDisplayableThinkingContent: vi.fn(() => false),
		session: sessionStub,
		viewSession: sessionStub,
		sessionManager: { getCwd: () => process.cwd() },
		showWarning: vi.fn(),
		showPinnedError: vi.fn(),
		clearTransientSessionUi: vi.fn(),
		addMessageToChat,
		showSubagentFeedback,
		lastAssistantUsage: emptyUsage(),
	} as unknown as InteractiveModeContext;
	return { controller: new EventController(ctx), chatContainer, pendingTools, showSubagentFeedback };
}

function hubGroups(container: TranscriptContainer): HubActivityGroupComponent[] {
	return container.children.filter(
		(child): child is HubActivityGroupComponent => child instanceof HubActivityGroupComponent,
	);
}

function visibleAssistantComponents(container: TranscriptContainer): AssistantMessageComponent[] {
	return container.children.filter(
		(child): child is AssistantMessageComponent =>
			child instanceof AssistantMessageComponent && child.render(120).length > 0,
	);
}
function renderText(renderable: Component): string {
	return Bun.stripANSI(renderable.render(120).join("\n"));
}

function createRebuildFixture() {
	const requestRender = vi.fn(() => {});
	const mockTui = {
		requestRender,
		requestComponentRender: vi.fn(() => {}),
		resetDisplay: vi.fn(() => {}),
		imageBudget: undefined,
	} as unknown as TUI;
	const builder = new ChatTranscriptBuilder({
		ui: mockTui,
		getTool: () => undefined,
		getMessageRenderer: () => undefined,
		cwd: process.cwd(),
		hideThinkingBlock: () => false,
		proseOnlyThinking: () => true,
		requestRender,
	});
	return { builder };
}

function makeMessageEntry(id: string, timestamp: number, message: SessionMessageEntry["message"]): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message,
	};
}

describe("EventController hub activity cluster", () => {
	it("routes wait(from) replies to showSubagentFeedback and never renders a pending card", async () => {
		const { controller, chatContainer, showSubagentFeedback } = createLiveFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: HUB_WAIT_ID,
			toolName: "hub",
			args: { op: "wait", from: "AuthLoader" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);

		const pendingGroup = hubGroups(chatContainer)[0]!;
		expect(pendingGroup.render(120)).toEqual([]);
		expect(renderText(chatContainer)).not.toContain("pending");

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: HUB_WAIT_ID,
			toolName: "hub",
			result: {
				content: [{ type: "text", text: "Reply received" }],
				details: {
					op: "wait",
					waited: {
						id: "irc-wait-1",
						from: "AuthLoader",
						to: "Main",
						body: "ready now",
						ts: 1_700_000_000_100,
					},
				},
			},
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(showSubagentFeedback).toHaveBeenCalledWith({
			agentId: "AuthLoader",
			text: "ready now",
			timestamp: 1_700_000_000_100,
		});
		expect(hubGroups(chatContainer)).toHaveLength(0);
		expect(renderText(chatContainer)).not.toContain("ready now");
	});

	it("dedupes inbox feedback and keeps the transcript free of IRC body rows", async () => {
		const { controller, chatContainer, showSubagentFeedback } = createLiveFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "hub-inbox",
			toolName: "hub",
			args: { op: "inbox" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "hub-inbox",
			toolName: "hub",
			result: {
				content: [{ type: "text", text: "2 messages" }],
				details: {
					op: "inbox",
					inbox: [
						{ from: "Worker", body: "ping", ts: 1 },
						{ from: "Worker", body: "ping", ts: 1 },
						{ from: "AuthLoader", body: "ready", ts: 2 },
					],
				},
			},
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(showSubagentFeedback).toHaveBeenCalledTimes(2);
		expect(showSubagentFeedback).toHaveBeenNthCalledWith(1, { agentId: "Worker", text: "ping", timestamp: 1 });
		expect(showSubagentFeedback).toHaveBeenNthCalledWith(2, {
			agentId: "AuthLoader",
			text: "ready",
			timestamp: 2,
		});
		expect(hubGroups(chatContainer)).toHaveLength(0);
		expect(renderText(chatContainer)).not.toContain("ping");
		expect(renderText(chatContainer)).not.toContain("ready");
	});

	it("keeps awaited send receipts and outbound body visible without no-reply text", async () => {
		const { controller, chatContainer } = createLiveFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: HUB_SEND_ID,
			toolName: "hub",
			args: { op: "send", to: "Worker", message: "ping", await: true },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: HUB_SEND_ID,
			toolName: "hub",
			result: {
				content: [{ type: "text", text: "" }],
				details: {
					op: "send",
					to: "Worker",
					receipts: [{ to: "Worker", outcome: "woken" }],
					waited: null,
				},
			},
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		const rendered = renderText(hubGroups(chatContainer)[0]!);
		expect(rendered).toContain("Worker");
		expect(rendered).toContain("woken");
		expect(rendered).toContain("ping");
		expect(rendered).not.toContain("no reply");
		expect(rendered).not.toContain("No reply yet");
	});

	it("keeps job-id waits visible from pending through running output", async () => {
		const { controller, chatContainer } = createLiveFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "hub-jobs-running",
			toolName: "hub",
			args: { op: "wait", ids: ["job-1"] },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);

		const pendingRendered = renderText(hubGroups(chatContainer)[0]!);
		expect(pendingRendered).toContain("job-1");
		expect(pendingRendered).toContain("pending");

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "hub-jobs-running",
			toolName: "hub",
			result: {
				content: [{ type: "text", text: "still running" }],
				details: {
					op: "wait",
					jobs: [{ id: "job-1", type: "task", status: "running", label: "Build job", durationMs: 12 }],
				},
			},
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		const rendered = renderText(hubGroups(chatContainer)[0]!);
		expect(rendered).toContain("Build job");
		expect(rendered).toContain("running");
	});

	it("keeps Hub errors visible in the activity group", async () => {
		const { controller, chatContainer } = createLiveFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "hub-inbox-error",
			toolName: "hub",
			args: { op: "inbox" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "hub-inbox-error",
			toolName: "hub",
			result: {
				content: [{ type: "text", text: "hub broker unavailable" }],
				details: { op: "inbox" },
			},
			isError: true,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(renderText(hubGroups(chatContainer)[0]!)).toContain("hub broker unavailable");
	});
});

describe("ChatTranscriptBuilder hub activity cluster", () => {
	it("rebuild skips historical IRC custom rows while keeping same-turn send and job wait rows", () => {
		const { builder } = createRebuildFixture();

		try {
			builder.rebuild([
				makeMessageEntry(
					"entry-1",
					1_700_000_000_000,
					makeAssistantMessage([
						{
							type: "toolCall",
							id: HUB_SEND_ID,
							name: "hub",
							arguments: { op: "send", to: "Worker", message: "ping", await: true },
						},
						{ type: "toolCall", id: "hub-job-wait", name: "hub", arguments: { op: "wait", ids: ["job-1"] } },
					]),
				),
				makeMessageEntry("entry-2", 1_700_000_000_050, {
					role: "toolResult",
					toolCallId: HUB_SEND_ID,
					toolName: "hub",
					content: [{ type: "text", text: "" }],
					details: {
						op: "send",
						to: "Worker",
						receipts: [{ to: "Worker", outcome: "woken" }],
						waited: null,
					},
					isError: false,
					timestamp: 1_700_000_000_050,
				}),
				makeMessageEntry("entry-3", 1_700_000_000_100, {
					role: "toolResult",
					toolCallId: "hub-job-wait",
					toolName: "hub",
					content: [{ type: "text", text: "still running" }],
					details: {
						op: "wait",
						jobs: [{ id: "job-1", type: "task", status: "running", label: "Build job", durationMs: 12 }],
					},
					isError: false,
					timestamp: 1_700_000_000_100,
				}),
				makeMessageEntry("entry-4", 1_700_000_000_500, makeIrcMessage("viewer cluster hello")),
			]);

			const groups = hubGroups(builder.container);
			expect(groups).toHaveLength(1);
			expect(visibleAssistantComponents(builder.container)).toHaveLength(0);
			const rendered = renderText(groups[0]!);
			expect(rendered).toContain("Worker");
			expect(rendered).toContain("ping");
			expect(rendered).toContain("Build job");
			expect(rendered).not.toContain("viewer cluster hello");
		} finally {
			builder.dispose();
		}
	});

	it("rebuild omits a pure message wait(from) timeout once its final result is an empty no-reply", () => {
		const { builder } = createRebuildFixture();

		try {
			builder.rebuild([
				makeMessageEntry(
					"entry-1",
					1_700_000_000_000,
					makeAssistantMessage([
						{ type: "toolCall", id: HUB_WAIT_ID, name: "hub", arguments: { op: "wait", from: "AuthLoader" } },
					]),
				),
				makeMessageEntry("entry-2", 1_700_000_000_100, {
					role: "toolResult",
					toolCallId: HUB_WAIT_ID,
					toolName: "hub",
					content: [{ type: "text", text: "No message from AuthLoader within 10s." }],
					details: { op: "wait", waited: null },
					isError: false,
					useless: true,
					timestamp: 1_700_000_000_100,
				}),
			]);

			expect(hubGroups(builder.container)).toHaveLength(0);
			expect(renderText(builder.container)).not.toContain("no reply");
			expect(renderText(builder.container)).not.toContain("AuthLoader");
		} finally {
			builder.dispose();
		}
	});

	it("rebuild keeps Hub errors visible", () => {
		const { builder } = createRebuildFixture();

		try {
			builder.rebuild([
				makeMessageEntry(
					"entry-1",
					1_700_000_001_000,
					makeAssistantMessage([
						{ type: "toolCall", id: "hub-inbox-error", name: "hub", arguments: { op: "inbox" } },
					]),
				),
				makeMessageEntry("entry-2", 1_700_000_001_100, {
					role: "toolResult",
					toolCallId: "hub-inbox-error",
					toolName: "hub",
					content: [{ type: "text", text: "hub broker unavailable" }],
					details: { op: "inbox" },
					isError: true,
					timestamp: 1_700_000_001_100,
				}),
			]);

			expect(renderText(hubGroups(builder.container)[0]!)).toContain("hub broker unavailable");
		} finally {
			builder.dispose();
		}
	});
});
