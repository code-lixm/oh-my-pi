/**
 * Contracts:
 * 1. Live Hub peer coordination routes useful inbound feedback to
 *    `showSubagentFeedback`, never to transcript process cards.
 * 2. Live and rebuilt peer `send`/`wait(from)`/`list`/`inbox` and historical IRC custom rows
 *    remain absent from the transcript.
 * 3. Live bare and job-id `wait`s render in grouped job activity; the user-facing `ask`
 *    tool remains visible after transcript rebuild.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-coding-agent/modes/components/chat-transcript-builder";
import { HubActivityGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/hub-activity-group";
import {
	ToolExecutionComponent,
	type ToolExecutionHandle,
} from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
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

function createLiveFixture(focusedAgentId?: string, hideToolActivity = false) {
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
		focusedAgentId,
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender, requestComponentRender, imageBudget: undefined },
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
	it("hides named hub process cards unless process activity is enabled", async () => {
		const defaultFixture = createLiveFixture();
		await defaultFixture.controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "hub-start-hidden-by-default",
			toolName: "hub",
			args: { op: "start", name: "web", application: "bun", args: ["run", "dev"] },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);

		expect(defaultFixture.chatContainer.children).toHaveLength(0);
		expect(defaultFixture.pendingTools.has("hub-start-hidden-by-default")).toBe(false);

		settings.set("display.showHubProcessActivity", false);
		const disabledFixture = createLiveFixture();
		await disabledFixture.controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "hub-wait-hidden-when-disabled",
			toolName: "hub",
			args: { op: "wait", name: "web" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);

		expect(disabledFixture.chatContainer.children).toHaveLength(0);
		expect(disabledFixture.pendingTools.has("hub-wait-hidden-when-disabled")).toBe(false);

		settings.set("display.showHubProcessActivity", true);
		const visibleFixture = createLiveFixture();
		await visibleFixture.controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "hub-start-visible-when-enabled",
			toolName: "hub",
			args: { op: "start", name: "web", application: "bun", args: ["run", "dev"] },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);

		expect(visibleFixture.chatContainer.children).toHaveLength(1);
		const [visibleCard] = visibleFixture.chatContainer.children;
		if (!(visibleCard instanceof ToolExecutionComponent)) {
			throw new Error("expected a visible named Hub process tool card");
		}
		expect(visibleFixture.pendingTools.get("hub-start-visible-when-enabled")).toBe(visibleCard);
		expect(hubGroups(visibleFixture.chatContainer)).toHaveLength(0);
	});

	it("hides Hub process activity in a focused live transcript while retaining ordinary tools", async () => {
		settings.set("display.showHubProcessActivity", true);
		const { controller, chatContainer, pendingTools } = createLiveFixture("Worker");

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "focused-hub-start",
			toolName: "hub",
			args: { op: "start", name: "FOCUSED_HUB_PROCESS_MARKER", application: "bun", args: ["run", "dev"] },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "focused-hub-start",
			toolName: "hub",
			result: {
				content: [{ type: "text", text: "FOCUSED_HUB_RESULT_MARKER" }],
				details: { op: "start" },
			},
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(chatContainer.children).toHaveLength(0);
		expect(pendingTools.has("focused-hub-start")).toBe(false);
		expect(renderText(chatContainer)).not.toContain("FOCUSED_HUB_PROCESS_MARKER");
		expect(renderText(chatContainer)).not.toContain("FOCUSED_HUB_RESULT_MARKER");

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "focused-write",
			toolName: "write",
			args: { path: "FOCUSED_VISIBLE_PATH", content: "ordinary content" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);

		const [ordinaryCard] = chatContainer.children;
		if (!(ordinaryCard instanceof ToolExecutionComponent)) {
			throw new Error("expected a visible ordinary tool card in the focused transcript");
		}
		expect(pendingTools.get("focused-write")).toBe(ordinaryCard);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "focused-write",
			toolName: "write",
			result: { content: [{ type: "text", text: "FOCUSED_VISIBLE_RESULT_MARKER" }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(chatContainer.children).toEqual([ordinaryCard]);
		const rendered = renderText(chatContainer);
		expect(rendered).toContain("FOCUSED_VISIBLE_PATH");
		expect(rendered).not.toContain("FOCUSED_HUB_PROCESS_MARKER");
	});
	it("routes wait(from) replies to showSubagentFeedback without a card when process activity is enabled", async () => {
		settings.set("display.showHubProcessActivity", true);
		const { controller, chatContainer, pendingTools, showSubagentFeedback } = createLiveFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: HUB_WAIT_ID,
			toolName: "hub",
			args: { op: "wait", from: "AuthLoader" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);

		expect(chatContainer.children).toHaveLength(0);
		expect(pendingTools.has(HUB_WAIT_ID)).toBe(false);
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
		expect(chatContainer.children).toHaveLength(0);
		expect(pendingTools.has(HUB_WAIT_ID)).toBe(false);
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

	it("keeps peer roster snapshots out of the transcript", async () => {
		const { controller, chatContainer } = createLiveFixture();
		const peers = [
			{
				id: "Worker",
				displayName: "Worker",
				kind: "sub",
				status: "running",
				parentId: "Main",
				unread: 0,
				lastActivity: 1_700_000_000_100,
				activity: "checking routes",
			},
		];

		for (const toolCallId of ["hub-list-first", "hub-list-same"]) {
			await controller.handleEvent({
				type: "tool_execution_start",
				toolCallId,
				toolName: "hub",
				args: { op: "list" },
			} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId,
				toolName: "hub",
				result: {
					content: [{ type: "text", text: "1 peer" }],
					details: { op: "list", peers },
				},
				isError: false,
			} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		}

		const rendered = renderText(chatContainer);
		expect(hubGroups(chatContainer)).toHaveLength(0);
		expect(rendered).not.toContain("checking routes");
		expect(rendered).not.toContain("Worker");
	});

	it("drops a successful empty inbox result instead of leaving a transcript card", async () => {
		const { controller, chatContainer } = createLiveFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "hub-empty-inbox",
			toolName: "hub",
			args: { op: "inbox" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "hub-empty-inbox",
			toolName: "hub",
			result: {
				content: [{ type: "text", text: "Inbox empty." }],
				details: { op: "inbox", inbox: [] },
				useless: true,
			},
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(hubGroups(chatContainer)).toHaveLength(0);
		expect(renderText(chatContainer)).not.toContain("Inbox empty.");
	});

	it("keeps awaited peer sends out of the transcript", async () => {
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

		const rendered = renderText(chatContainer);
		expect(hubGroups(chatContainer)).toHaveLength(0);
		expect(rendered).not.toContain("Worker");
		expect(rendered).not.toContain("woken");
		expect(rendered).not.toContain("ping");
		expect(rendered).not.toContain("no reply");
		expect(rendered).not.toContain("No reply yet");
	});

	it("groups job-id waits from pending through running updates", async () => {
		const { controller, chatContainer, pendingTools } = createLiveFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "hub-jobs-running",
			toolName: "hub",
			args: { op: "wait", ids: ["job-1"] },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);

		expect(hubGroups(chatContainer)).toHaveLength(1);
		const [group] = hubGroups(chatContainer);
		if (!group) throw new Error("expected grouped Hub job activity");
		expect(pendingTools.get("hub-jobs-running")).toBe(group);
		const pendingRendered = renderText(group);
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

		const rendered = renderText(group);
		expect(rendered).toContain("Build job");
		expect(rendered).toContain("running");
	});

	it("keeps peer inbox failures out of activity cards", async () => {
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

		expect(hubGroups(chatContainer)).toHaveLength(0);
		expect(renderText(chatContainer)).not.toContain("hub broker unavailable");
	});
	it("hides grouped Hub tool rows while retaining IRC entries when tool activity is hidden", async () => {
		settings.set("display.showHubProcessActivity", true);
		const { controller, chatContainer, pendingTools } = createLiveFixture(undefined, true);
		const toolCallId = "hidden-hub-job";
		const toolMarker = "HIDDEN_HUB_JOB_MARKER";
		const ircMarker = "VISIBLE_IRC_MARKER";

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId,
			toolName: "hub",
			args: { op: "wait", ids: ["hidden-job"] },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);

		const [group] = hubGroups(chatContainer);
		if (!group) throw new Error("expected grouped Hub activity");
		expect(pendingTools.get(toolCallId)).toBe(group);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: "hub",
			result: {
				content: [{ type: "text", text: "job update" }],
				details: {
					op: "wait",
					jobs: [{ id: "hidden-job", type: "task", status: "running", label: toolMarker, durationMs: 12 }],
				},
			},
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(renderText(group)).not.toContain(toolMarker);
		group.appendIrcEvent({ kind: "incoming", from: "Worker", to: "Main", body: ircMarker });
		expect(renderText(group)).toContain(ircMarker);
		expect(renderText(group)).not.toContain(toolMarker);

		group.setToolActivityVisible(true);
		expect(renderText(group)).toContain(toolMarker);
	});
});

describe("ChatTranscriptBuilder hub activity cluster", () => {
	it("rebuild keeps peer hub coordination and IRC rows silent while rendering ask content", () => {
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
							arguments: { op: "send", to: "SEND_PEER_MARKER", message: "SEND_BODY_MARKER", await: true },
						},
						{
							type: "toolCall",
							id: "hub-wait",
							name: "hub",
							arguments: { op: "wait", from: "WAIT_PEER_MARKER" },
						},
						{ type: "toolCall", id: "hub-list", name: "hub", arguments: { op: "list" } },
						{ type: "toolCall", id: "hub-inbox", name: "hub", arguments: { op: "inbox" } },
						{
							type: "toolCall",
							id: "ask-visible",
							name: "ask",
							arguments: {
								questions: [
									{
										id: "question-1",
										question: "ASK_QUESTION_MARKER",
										options: [{ label: "Use option" }],
									},
								],
							},
						},
					]),
				),
				makeMessageEntry("entry-2", 1_700_000_000_050, {
					role: "toolResult",
					toolCallId: HUB_SEND_ID,
					toolName: "hub",
					content: [{ type: "text", text: "SEND_RESULT_MARKER" }],
					details: {
						op: "send",
						to: "SEND_PEER_MARKER",
						receipts: [{ to: "SEND_PEER_MARKER", outcome: "woken" }],
					},
					isError: false,
					timestamp: 1_700_000_000_050,
				}),
				makeMessageEntry("entry-3", 1_700_000_000_100, {
					role: "toolResult",
					toolCallId: "hub-wait",
					toolName: "hub",
					content: [{ type: "text", text: "WAIT_RESULT_MARKER" }],
					details: {
						op: "wait",
						waited: { id: "wait-1", from: "WAIT_PEER_MARKER", to: "Main", body: "WAIT_BODY_MARKER", ts: 1 },
					},
					isError: false,
					timestamp: 1_700_000_000_100,
				}),
				makeMessageEntry("entry-4", 1_700_000_000_150, {
					role: "toolResult",
					toolCallId: "hub-list",
					toolName: "hub",
					content: [{ type: "text", text: "LIST_RESULT_MARKER" }],
					details: {
						op: "list",
						peers: [
							{
								id: "LIST_PEER_MARKER",
								displayName: "LIST_PEER_MARKER",
								kind: "sub",
								status: "running",
								unread: 0,
								lastActivity: 1,
							},
						],
					},
					isError: false,
					timestamp: 1_700_000_000_150,
				}),
				makeMessageEntry("entry-5", 1_700_000_000_200, {
					role: "toolResult",
					toolCallId: "hub-inbox",
					toolName: "hub",
					content: [{ type: "text", text: "INBOX_RESULT_MARKER" }],
					details: {
						op: "inbox",
						inbox: [{ id: "inbox-1", from: "INBOX_PEER_MARKER", to: "Main", body: "INBOX_BODY_MARKER", ts: 1 }],
					},
					isError: false,
					timestamp: 1_700_000_000_200,
				}),
				makeMessageEntry("entry-6", 1_700_000_000_250, {
					role: "toolResult",
					toolCallId: "ask-visible",
					toolName: "ask",
					content: [{ type: "text", text: "ASK_RESULT_MARKER" }],
					details: { question: "ASK_QUESTION_MARKER", answer: "Use option" },
					isError: false,
					timestamp: 1_700_000_000_250,
				}),
				makeMessageEntry("entry-7", 1_700_000_000_500, makeIrcMessage("IRC_BODY_MARKER")),
			]);

			const rendered = renderText(builder.container);
			expect(hubGroups(builder.container)).toHaveLength(0);
			for (const text of [
				"SEND_PEER_MARKER",
				"SEND_BODY_MARKER",
				"SEND_RESULT_MARKER",
				"WAIT_PEER_MARKER",
				"WAIT_BODY_MARKER",
				"WAIT_RESULT_MARKER",
				"LIST_PEER_MARKER",
				"LIST_RESULT_MARKER",
				"INBOX_PEER_MARKER",
				"INBOX_BODY_MARKER",
				"INBOX_RESULT_MARKER",
				"IRC_BODY_MARKER",
			]) {
				expect(rendered).not.toContain(text);
			}
			expect(rendered).toContain("ASK_QUESTION_MARKER");
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

	it("rebuild keeps peer inbox failures out of the transcript", () => {
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
					content: [{ type: "text", text: "HUB_INBOX_ERROR_MARKER" }],
					details: { op: "inbox" },
					isError: true,
					timestamp: 1_700_000_001_100,
				}),
			]);

			expect(hubGroups(builder.container)).toHaveLength(0);
			expect(renderText(builder.container)).not.toContain("HUB_INBOX_ERROR_MARKER");
		} finally {
			builder.dispose();
		}
	});
});
