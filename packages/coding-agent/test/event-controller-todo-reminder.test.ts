import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	resetSettingsForTest();
	vi.restoreAllMocks();
});

function createContext() {
	const present = vi.fn();
	const showWarning = vi.fn();
	const chatContainer = new TranscriptContainer();
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn(), imageBudget: undefined },
		pendingTools: new Map(),
		chatContainer,
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		clearPinnedError: vi.fn(),
		ensureLoadingAnimation: vi.fn(),
		session: { getToolByName: () => undefined },
		// `viewSession.isStreaming` is read by `#ensureWorkingLoaderWhileStreaming`,
		// which runs at the top of `tool_execution_end` (and other streaming-event
		// handlers). Leaving it false matches the implicit assumption in this
		// fixture: the todo HUD lifecycle is independent of the working loader.
		viewSession: { isStreaming: false, getToolByName: () => undefined },
		sessionManager: { getCwd: () => process.cwd() },
		setTodos: vi.fn(),
		showWarning,
		present,
	} as unknown as InteractiveModeContext;
	return { ctx, present, showWarning, chatContainer };
}

function todoComponents(chatContainer: TranscriptContainer): ToolExecutionComponent[] {
	return chatContainer.children.filter(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
}

function reminder(attempt: number, content = "pending task"): Extract<AgentSessionEvent, { type: "todo_reminder" }> {
	return {
		type: "todo_reminder",
		todos: [{ content, status: "pending" }],
		attempt,
		maxAttempts: 3,
	};
}

function makeEmptyContext(): SessionContext {
	return {
		messages: [],
		thinkingLevel: "off",
		serviceTier: undefined,
		models: {},
		injectedTtsrRules: [],
		mode: "none",
	};
}

function transcriptWith(messages: AgentMessage[]): SessionContext {
	return { ...makeEmptyContext(), messages };
}

function createRebuildContext(transcript: SessionContext) {
	const chatContainer = new TranscriptContainer();
	let helpers!: UiHelpers;
	const ctx = {
		chatContainer,
		pendingMessagesContainer: new TranscriptContainer(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		pendingTools: new Map(),
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn(), imageBudget: undefined },
		settings: { get: () => false },
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		focusedAgentId: undefined,
		editor: { addToHistory: vi.fn() },
		viewSession: {
			buildTranscriptSessionContext: () => transcript,
			getToolByName: () => undefined,
			extensionRunner: undefined,
			sessionManager: { getEntries: vi.fn(() => []), getCwd: vi.fn(() => process.cwd()) },
		},
		sessionManager: {
			getEntries: vi.fn(() => []),
			getCwd: vi.fn(() => process.cwd()),
			putBlobSync: vi.fn(),
		},
		resetTranscript: () => chatContainer.clear(),
		addMessageToChat: (message: AgentMessage, options?: { populateHistory?: boolean }) =>
			helpers.addMessageToChat(message, options),
		renderSessionContext: (
			context: SessionContext,
			options?: { updateFooter?: boolean; populateHistory?: boolean },
		) => helpers.renderSessionContext(context, options),
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;
	helpers = new UiHelpers(ctx);
	return { helpers, chatContainer };
}

describe("EventController todo reminder", () => {
	it("commits each reminder into durable chat history", async () => {
		const { ctx, present } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(reminder(1, "old task"));
		expect(present).toHaveBeenCalledTimes(1);

		// A second reminder is a distinct escalation, committed as its own block —
		// not merged into or replacing the first.
		await controller.handleEvent(reminder(2, "new task"));
		expect(present).toHaveBeenCalledTimes(2);
		expect(present.mock.calls[0]![0]).not.toBe(present.mock.calls[1]![0]);
	});

	it("routes successful live todo results to the HUD without appending a transcript tool block", async () => {
		const { ctx, present, showWarning, chatContainer } = createContext();
		const controller = new EventController(ctx);
		const phases = [
			{
				name: "Implementation",
				tasks: [
					{ content: "done task", status: "completed" as const },
					{ content: "active task", status: "in_progress" as const },
					{ content: "next task", status: "pending" as const },
				],
			},
		];

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "todo-live",
			toolName: "todo",
			args: { op: "view" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		expect(todoComponents(chatContainer)).toHaveLength(0);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "todo-live",
			toolName: "todo",
			isError: false,
			result: { content: [{ type: "text", text: "updated" }], details: { phases } },
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(ctx.setTodos).toHaveBeenCalledWith(phases);
		expect(todoComponents(chatContainer)).toHaveLength(0);
		expect(Bun.stripANSI(chatContainer.render(120).join("\n"))).not.toContain("active task");
		expect(present).not.toHaveBeenCalled();
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("leaves committed reminders untouched when a todo tool succeeds", async () => {
		const { ctx, present } = createContext();
		const controller = new EventController(ctx);
		const phases = [{ name: "Implementation", tasks: [{ content: "done task", status: "completed" as const }] }];

		await controller.handleEvent(reminder(1));
		expect(present).toHaveBeenCalledTimes(1);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "todo-1",
			toolName: "todo",
			isError: false,
			result: { content: [{ type: "text", text: "" }], details: { phases } },
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		// The reminder stays in history (no retroactive removal); only the sticky
		// HUD updates via setTodos.
		expect(present).toHaveBeenCalledTimes(1);
		expect(ctx.setTodos).toHaveBeenCalledWith(phases);
	});

	it("keeps todo tool failures on the warning path", async () => {
		const { ctx, showWarning, chatContainer } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "todo-error",
			toolName: "todo",
			args: { op: "view" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "todo-error",
			toolName: "todo",
			isError: true,
			result: { content: [{ type: "text", text: "Phase missing" }], details: undefined, isError: true },
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(showWarning).toHaveBeenCalledTimes(1);
		expect(showWarning.mock.calls[0]?.[0]).toContain("Phase missing");
		expect(ctx.setTodos).not.toHaveBeenCalled();
		expect(todoComponents(chatContainer)).toHaveLength(0);
	});
});

describe("todo transcript rebuild", () => {
	it("keeps historical todo tool results as transcript cards", async () => {
		await Settings.init({ inMemory: true });
		const transcript = transcriptWith([
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "todo-rebuild", name: "todo", arguments: { op: "view" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "toolUse",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "todo-rebuild",
				toolName: "todo",
				content: [{ type: "text", text: "updated" }],
				details: {
					phases: [
						{
							name: "Implementation",
							tasks: [
								{ content: "Restore plan", status: "completed" as const },
								{ content: "Ship fix", status: "in_progress" as const },
								{ content: "Verify", status: "pending" as const },
							],
						},
					],
				},
				isError: false,
				timestamp: 2,
			},
		]);
		const { helpers, chatContainer } = createRebuildContext(transcript);

		helpers.renderSessionContext(transcript, { populateHistory: true });

		const todoCards = todoComponents(chatContainer);
		expect(todoCards).toHaveLength(1);
		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(rendered).toContain("Restore plan");
		expect(rendered).toContain("Ship fix");
		expect(rendered).toContain("Verify");
	});
});
