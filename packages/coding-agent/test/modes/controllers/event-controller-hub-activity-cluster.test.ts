/**
 * Contracts:
 * 1. Live EventController path — one assistant turn containing hub send, hub wait(from),
 *    and hub list keeps every hub activity row plus an IRC incoming event inside one
 *    HubActivityGroupComponent.
 * 2. An empty HubActivityGroupComponent renders no rows, and a pure message wait(from)
 *    renders as pending while live, then disappears entirely when its final non-error
 *    result is an empty timeout (`waited: null`) and the group would otherwise be empty.
 * 3. Visible assistant text between grouped hub calls breaks the live cluster; if the later
 *    wait resolves to that empty timeout, only the prose and the earlier hub group remain.
 * 4. Viewer rebuild path (ChatTranscriptBuilder) preserves the same grouping rules, including
 *    suppressing historical empty wait(from) timeouts while keeping adjacent send-await no-reply
 *    rows visible.
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
const HUB_LIST_ID = "hub-list";

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
		lastAssistantUsage: emptyUsage(),
	} as unknown as InteractiveModeContext;
	return { controller: new EventController(ctx), chatContainer, pendingTools };
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
	it("renders an empty HubActivityGroupComponent as no rows", () => {
		const group = new HubActivityGroupComponent();

		expect(group.render(120)).toEqual([]);
		const rendered = renderText(group);
		expect(rendered).not.toContain("IRC");
		expect(rendered).not.toContain("pending");
	});

	it("keeps send, wait(from), list, and irc:incoming inside one HubActivityGroupComponent", async () => {
		const { controller, chatContainer, pendingTools } = createLiveFixture();
		const started = makeAssistantMessage([]);
		const streamed = makeAssistantMessage([
			{ type: "toolCall", id: HUB_SEND_ID, name: "hub", arguments: { op: "send", to: "Worker", message: "ping" } },
			{ type: "toolCall", id: HUB_WAIT_ID, name: "hub", arguments: { op: "wait", from: "AuthLoader" } },
			{ type: "toolCall", id: HUB_LIST_ID, name: "hub", arguments: { op: "list" } },
		]);

		await controller.handleEvent({ type: "message_start", message: started } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({
			type: "message_update",
			message: streamed,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 2,
				toolCall: streamed.content[2]!,
				partial: streamed,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);

		const groupsAfterUpdate = hubGroups(chatContainer);
		expect(groupsAfterUpdate).toHaveLength(1);
		const group = groupsAfterUpdate[0]!;
		expect(pendingTools.get(HUB_SEND_ID)).toBe(group);
		expect(pendingTools.get(HUB_WAIT_ID)).toBe(group);
		expect(pendingTools.get(HUB_LIST_ID)).toBe(group);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: HUB_SEND_ID,
			toolName: "hub",
			args: { op: "send", to: "Worker", message: "ping" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: HUB_SEND_ID,
			toolName: "hub",
			result: {
				content: [{ type: "text", text: "Delivered" }],
				details: { op: "send", to: "Worker", receipts: [{ to: "Worker", outcome: "woken" }] },
			},
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: HUB_WAIT_ID,
			toolName: "hub",
			args: { op: "wait", from: "AuthLoader" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
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

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: HUB_LIST_ID,
			toolName: "hub",
			args: { op: "list" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: HUB_LIST_ID,
			toolName: "hub",
			result: {
				content: [{ type: "text", text: "2 peers" }],
				details: {
					op: "list",
					peers: [
						{
							id: "worker",
							displayName: "Worker",
							kind: "subagent",
							status: "idle",
							unread: 0,
							lastActivity: 1_700_000_000_000,
							activity: "standing by",
						},
						{
							id: "auth",
							displayName: "AuthLoader",
							kind: "subagent",
							status: "running",
							unread: 0,
							lastActivity: 1_700_000_000_050,
							activity: "waiting",
						},
					],
				},
			},
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		await controller.handleEvent({ type: "irc_message", message: makeIrcMessage("cluster hello") });
		await controller.handleEvent({ type: "message_end", message: streamed } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		const groupsAfterEnd = hubGroups(chatContainer);
		expect(groupsAfterEnd).toHaveLength(1);
		expect(groupsAfterEnd[0]).toBe(group);
		const rendered = Bun.stripANSI(group.render(120).join("\n"));
		expect(rendered).toContain("Worker");
		expect(rendered).toContain("AuthLoader");
		expect(rendered).toContain("ready now");
		expect(rendered).toContain("cluster hello");
	});

	it("renders running agents from wait(ids) results even when no jobs are returned", async () => {
		const { controller, chatContainer } = createLiveFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "hub-jobs-agents",
			toolName: "hub",
			args: { op: "wait", ids: ["job-1"] },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "hub-jobs-agents",
			toolName: "hub",
			result: {
				content: [{ type: "text", text: "1 running agent" }],
				details: {
					op: "wait",
					agents: [{ id: "Worker", activity: "compiling", ageMs: 5_000 }],
				},
			},
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		const groups = hubGroups(chatContainer);
		expect(groups).toHaveLength(1);
		const rendered = Bun.stripANSI(groups[0]!.render(120).join("\n"));
		expect(rendered).toContain("Worker");
		expect(rendered).toContain("compiling");
	});

	it("removes an empty message wait(from) group, then renders the next live IRC event", async () => {
		const { controller, chatContainer } = createLiveFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: HUB_WAIT_ID,
			toolName: "hub",
			args: { op: "wait", from: "AuthLoader" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);

		const pendingGroups = hubGroups(chatContainer);
		expect(pendingGroups).toHaveLength(1);
		const pendingGroup = pendingGroups[0]!;
		const pendingRendered = renderText(pendingGroup);
		expect(pendingRendered).toContain("IRC");
		expect(pendingRendered).toContain("AuthLoader");
		expect(pendingRendered).toContain("pending");

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: HUB_WAIT_ID,
			toolName: "hub",
			result: {
				content: [{ type: "text", text: "No reply from AuthLoader within 10s." }],
				details: { op: "wait", waited: null },
				useless: true,
			},
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(hubGroups(chatContainer)).toHaveLength(0);
		let rendered = renderText(chatContainer);
		expect(rendered).not.toContain("no reply");
		expect(rendered).not.toContain("AuthLoader");

		await controller.handleEvent({
			type: "irc_message",
			message: makeIrcMessage("auth loader reported ready", "AuthLoader", 1_700_000_000_600),
		});

		const visibleGroups = hubGroups(chatContainer);
		expect(visibleGroups).toHaveLength(1);
		rendered = renderText(visibleGroups[0]!);
		expect(rendered).toContain("IRC");
		expect(rendered).toContain("AuthLoader");
		expect(rendered).toContain("auth loader reported ready");
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

		const groups = hubGroups(chatContainer);
		expect(groups).toHaveLength(1);
		const rendered = renderText(groups[0]!);
		expect(rendered).toContain("Worker");
		expect(rendered).toContain("woken");
		expect(rendered).toContain("ping");
		expect(rendered).not.toContain("no reply");
		expect(rendered).not.toContain("No reply yet");
	});

	it("displaces a running-only wait(ids) poll when the next grouped hub call arrives", async () => {
		const { controller, chatContainer } = createLiveFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "hub-jobs-running",
			toolName: "hub",
			args: { op: "wait", ids: ["job-1"] },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
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

		const group = hubGroups(chatContainer)[0]!;
		expect(Bun.stripANSI(group.render(120).join("\n"))).toContain("Build job");

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "hub-send-next",
			toolName: "hub",
			args: { op: "send", to: "Worker", message: "ping" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);

		const displaced = Bun.stripANSI(group.render(120).join("\n"));
		expect(displaced).not.toContain("Build job");
		expect(displaced).toContain("Worker");
	});

	it("breaks the cluster when assistant prose appears between hub calls", async () => {
		const { controller, chatContainer, pendingTools } = createLiveFixture();
		const started = makeAssistantMessage([]);
		const streamed = makeAssistantMessage([
			{ type: "toolCall", id: HUB_SEND_ID, name: "hub", arguments: { op: "send", to: "Worker", message: "ping" } },
			{ type: "text", text: "checking peers" },
			{ type: "toolCall", id: HUB_WAIT_ID, name: "hub", arguments: { op: "wait", from: "AuthLoader" } },
		]);

		await controller.handleEvent({ type: "message_start", message: started } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({
			type: "message_update",
			message: streamed,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 2,
				toolCall: streamed.content[2]!,
				partial: streamed,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);

		const groups = hubGroups(chatContainer);
		expect(groups).toHaveLength(2);
		expect(pendingTools.get(HUB_SEND_ID)).toBe(groups[0]);
		expect(pendingTools.get(HUB_WAIT_ID)).toBe(groups[1]);
		expect(groups[0]!.canAppend).toBe(false);
		expect(Bun.stripANSI(groups[1]!.render(120).join("\n"))).toContain("AuthLoader");

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: HUB_SEND_ID,
			toolName: "hub",
			args: { op: "send", to: "Worker", message: "ping" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: HUB_SEND_ID,
			toolName: "hub",
			result: {
				content: [{ type: "text", text: "Delivered" }],
				details: { op: "send", to: "Worker", receipts: [{ to: "Worker", outcome: "woken" }] },
			},
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: HUB_WAIT_ID,
			toolName: "hub",
			args: { op: "wait", from: "AuthLoader" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: HUB_WAIT_ID,
			toolName: "hub",
			result: {
				content: [{ type: "text", text: "No reply yet" }],
				details: { op: "wait", waited: null },
				useless: true,
			},
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(pendingTools.has(HUB_SEND_ID)).toBe(false);
		expect(pendingTools.has(HUB_WAIT_ID)).toBe(false);
		const remainingGroups = hubGroups(chatContainer);
		expect(remainingGroups).toHaveLength(1);
		expect(remainingGroups[0]).toBe(groups[0]);
		expect(renderText(chatContainer)).not.toContain("no reply");
		expect(renderText(chatContainer)).not.toContain("AuthLoader");

		const assistantBlocks = visibleAssistantComponents(chatContainer);
		expect(assistantBlocks).toHaveLength(1);
		expect(renderText(assistantBlocks[0]!)).toContain("checking peers");
	});
});

describe("ChatTranscriptBuilder hub activity cluster", () => {
	it("rebuilds a continuous hub+IRC run as one HubActivityGroupComponent", () => {
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
							arguments: { op: "send", to: "Worker", message: "ping" },
						},
						{ type: "toolCall", id: HUB_WAIT_ID, name: "hub", arguments: { op: "wait", from: "AuthLoader" } },
					]),
				),
				makeMessageEntry("entry-2", 1_700_000_000_500, makeIrcMessage("viewer cluster hello")),
			]);

			const groups = hubGroups(builder.container);
			expect(groups).toHaveLength(1);
			expect(visibleAssistantComponents(builder.container)).toHaveLength(0);
			const rendered = renderText(groups[0]!);
			expect(rendered).toContain("Worker");
			expect(rendered).toContain("AuthLoader");
			expect(rendered).toContain("viewer cluster hello");
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

	it("rebuild keeps awaited send receipts and outbound body visible without no-reply text", () => {
		const { builder } = createRebuildFixture();

		try {
			builder.rebuild([
				makeMessageEntry(
					"entry-1",
					1_700_000_001_000,
					makeAssistantMessage([
						{
							type: "toolCall",
							id: HUB_SEND_ID,
							name: "hub",
							arguments: { op: "send", to: "Worker", message: "ping", await: true },
						},
					]),
				),
				makeMessageEntry("entry-2", 1_700_000_001_100, {
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
					timestamp: 1_700_000_001_100,
				}),
			]);

			const groups = hubGroups(builder.container);
			expect(groups).toHaveLength(1);
			expect(visibleAssistantComponents(builder.container)).toHaveLength(0);
			const rendered = renderText(groups[0]!);
			expect(rendered).toContain("Worker");
			expect(rendered).toContain("woken");
			expect(rendered).toContain("ping");
			expect(rendered).not.toContain("no reply");
			expect(rendered).not.toContain("No reply yet");
		} finally {
			builder.dispose();
		}
	});

	it("rebuilds assistant prose between hub calls as group, prose, group", () => {
		const { builder } = createRebuildFixture();

		try {
			builder.rebuild([
				makeMessageEntry(
					"entry-1",
					1_700_000_001_000,
					makeAssistantMessage([
						{
							type: "toolCall",
							id: HUB_SEND_ID,
							name: "hub",
							arguments: { op: "send", to: "Worker", message: "ping" },
						},
						{ type: "text", text: "checking peers" },
						{ type: "toolCall", id: HUB_WAIT_ID, name: "hub", arguments: { op: "wait", from: "AuthLoader" } },
					]),
				),
			]);

			const visible = builder.container.children.filter(child => {
				if (child instanceof HubActivityGroupComponent) return true;
				return child instanceof AssistantMessageComponent && child.render(120).length > 0;
			});
			expect(visible).toHaveLength(3);
			expect(visible[0]).toBeInstanceOf(HubActivityGroupComponent);
			expect(visible[1]).toBeInstanceOf(AssistantMessageComponent);
			expect(visible[2]).toBeInstanceOf(HubActivityGroupComponent);
			expect((visible[0] as HubActivityGroupComponent).canAppend).toBe(false);
			expect((visible[2] as HubActivityGroupComponent).canAppend).toBe(true);
			expect(renderText(visible[1] as AssistantMessageComponent)).toContain("checking peers");
		} finally {
			builder.dispose();
		}
	});
});
