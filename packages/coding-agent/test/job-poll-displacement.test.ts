/**
 * Repeated `hub` waits must not stack "waiting on N jobs" frames in the
 * transcript: a wait whose watched jobs are all still running stays live
 * (displaceable) and the next `hub` call replaces it — one persistent wait.
 *
 * Contracts under test:
 *  - ToolExecutionComponent: a waiting-poll result keeps the block
 *    un-finalized and displaceable; a settled/cancelled/error result
 *    finalizes normally; seal() always freezes.
 *  - EventController: a follow-up `hub` call removes the tracked waiting
 *    poll from the transcript; any other tool seals it in place.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { HubActivityGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/hub-activity-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { Component, TUI } from "@oh-my-pi/pi-tui";

const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

type JobStatus = "running" | "completed" | "failed" | "cancelled";

function pollResult(
	statuses: JobStatus[],
	extra: { cancelled?: boolean; isError?: boolean } = {},
	labelPrefix = "job",
) {
	return {
		content: [{ type: "text" as const, text: extra.isError ? "poll failed" : "" }],
		isError: extra.isError,
		details: {
			op: "wait" as const,
			jobs: statuses.map((status, i) => ({
				id: `j${i}`,
				type: "task" as const,
				status,
				label: `${labelPrefix} ${i}`,
				durationMs: 1_000,
			})),
			...(extra.cancelled ? { cancelled: [{ id: "j0", status: "cancelled" as const }] } : {}),
		},
	};
}

function todoResult(items = ["investigate", "fix"]) {
	return {
		content: [{ type: "text" as const, text: "" }],
		details: {
			phases: [
				{
					name: "Workflow",
					tasks: items.map((content, index) => ({
						content,
						status: index === 0 ? ("in_progress" as const) : ("pending" as const),
					})),
				},
			],
			storage: "memory" as const,
		},
	};
}

type SealableComponent = { seal(): void };

function trackComponent<T extends SealableComponent>(components: SealableComponent[], component: T) {
	components.push(component);
	return component;
}

describe("hub waiting-poll block lifecycle", () => {
	const created: ToolExecutionComponent[] = [];

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		// Seal everything so displaceable blocks' spinner intervals never leak
		// into later test files.
		for (const component of created.splice(0)) component.seal();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function makeJobComponent() {
		return trackComponent(
			created,
			new ToolExecutionComponent("hub", { op: "wait", ids: ["j0", "j1"] }, {}, undefined, uiStub),
		);
	}

	it("keeps an all-running poll live and displaceable until sealed", () => {
		const component = makeJobComponent();
		component.updateResult(pollResult(["running", "running"]), false);

		expect(component.isDisplaceableBlock()).toBe(true);
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		component.seal();
		expect(component.isDisplaceableBlock()).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("finalizes a poll that observed a settled job", () => {
		const component = makeJobComponent();
		component.updateResult(pollResult(["completed", "running"]), false);

		expect(component.isDisplaceableBlock()).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("finalizes a poll that carried cancel outcomes or an error", () => {
		const cancelled = makeJobComponent();
		cancelled.updateResult(pollResult(["running"], { cancelled: true }), false);
		expect(cancelled.isDisplaceableBlock()).toBe(false);

		const errored = makeJobComponent();
		errored.updateResult(pollResult(["running"], { isError: true }), false);
		expect(errored.isDisplaceableBlock()).toBe(false);
		expect(errored.isTranscriptBlockFinalized()).toBe(true);
	});

	it("keeps successful todo snapshots live for replacement", () => {
		const component = trackComponent(
			created,
			new ToolExecutionComponent("todo", { op: "view" }, {}, undefined, uiStub),
		);
		component.updateResult(todoResult(), false);

		expect(component.isDisplaceableBlock()).toBe(true);
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		component.seal();
		expect(component.isDisplaceableBlock()).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("never marks ordinary non-refresh tools displaceable", () => {
		const component = trackComponent(
			created,
			new ToolExecutionComponent("bash", { command: "ls" }, {}, undefined, uiStub),
		);
		component.updateResult(pollResult(["running"]), false);
		expect(component.isDisplaceableBlock()).toBe(false);
	});
});

describe("EventController displaces consecutive waiting polls", () => {
	const created: SealableComponent[] = [];

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		for (const component of created.splice(0)) component.seal();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function createFixture() {
		const chatContainer = new TranscriptContainer();
		const children = chatContainer.children;
		const pendingTools = new Map();
		const sessionStub = {
			retryAttempt: 0,
			getToolByName: () => undefined,
			extensionRunner: undefined,
			isTtsrAbortPending: false,
		};
		const ctx = {
			isInitialized: true,
			init: vi.fn(async () => {}),
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn(), imageBudget: undefined },
			statusLine: { invalidate: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			toolOutputExpanded: false,
			effectiveHideThinkingBlock: false,
			proseOnlyThinking: true,
			pendingTools,
			chatContainer,
			session: sessionStub,
			viewSession: sessionStub,
			sessionManager: { getCwd: () => process.cwd() },
			showWarning: vi.fn(),
			showPinnedError: vi.fn(),
			setTodos: vi.fn(),
			clearTransientSessionUi: vi.fn(),
			lastAssistantUsage: undefined,
		} as unknown as InteractiveModeContext;
		return { controller: new EventController(ctx), children, pendingTools };
	}

	function hubGroups(children: Component[]) {
		return children.filter((child): child is HubActivityGroupComponent => child instanceof HubActivityGroupComponent);
	}

	function latestHubGroup(children: Component[]) {
		const groups = hubGroups(children);
		const group = groups[groups.length - 1];
		if (!group) throw new Error("No HubActivityGroupComponent found in chat transcript");
		if (!created.includes(group)) trackComponent(created, group);
		return group;
	}

	function renderText(component: Component) {
		return Bun.stripANSI(component.render(120).join("\n"));
	}

	async function runPoll(
		controller: EventController,
		children: Component[],
		toolCallId: string,
		statuses: JobStatus[] = ["running"],
	) {
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId,
			toolName: "hub",
			args: { op: "wait", ids: [`${toolCallId}-j0`] },
		});
		const group = latestHubGroup(children);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: "hub",
			result: pollResult(statuses, {}, `${toolCallId} job`),
			isError: false,
		});
		return group;
	}

	it("removes the previous waiting poll when the next hub call starts", async () => {
		const { controller, children } = createFixture();

		const firstGroup = await runPoll(controller, children, "t1");
		expect(children).toContain(firstGroup);
		expect(renderText(firstGroup)).toContain("t1 job 0");

		const secondGroup = await runPoll(controller, children, "t2");

		// The stale row is displaced inside the current grouped hub block; the group
		// stays live so another hub poll can replace this one instead of stacking.
		expect(secondGroup).toBe(firstGroup);
		expect(hubGroups(children)).toHaveLength(1);
		const rendered = renderText(secondGroup);
		expect(rendered).not.toContain("t1 job 0");
		expect(rendered).toContain("t2 job 0");
		expect(secondGroup.canAppend).toBe(true);
		expect(secondGroup.isTranscriptBlockFinalized()).toBe(false);
	});

	it("seals the waiting poll group in place when a different tool runs next", async () => {
		const { controller, children } = createFixture();

		const pollGroup = await runPoll(controller, children, "t1");
		expect(pollGroup.canAppend).toBe(true);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "t2",
			toolName: "bash",
			args: { command: "ls" },
		});
		const bash = children[children.length - 1] as ToolExecutionComponent;
		trackComponent(created, bash);

		// The grouped poll stays — it is final history now, not a live hub cluster.
		expect(children).toContain(pollGroup);
		expect(children).toContain(bash);
		expect(renderText(pollGroup)).toContain("t1 job 0");
		expect(pollGroup.canAppend).toBe(false);
		expect(pollGroup.isTranscriptBlockFinalized()).toBe(true);
	});

	it("does not displace a poll group that observed completions", async () => {
		const { controller, children } = createFixture();

		const settled = await runPoll(controller, children, "t1", ["completed", "running"]);
		const next = await runPoll(controller, children, "t2");

		// A poll that carried real results is kept in the grouped history; only the
		// all-running predecessor-removal path is skipped.
		expect(next).toBe(settled);
		expect(hubGroups(children)).toHaveLength(1);
		const rendered = renderText(settled);
		expect(rendered).toContain("t1 job 0");
		expect(rendered).toContain("t2 job 0");
		expect(settled.canAppend).toBe(true);
	});
});

describe("UiHelpers.renderSessionContext collapses repeated todo snapshots", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function usage() {
		return {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	function createHelpersFixture(options: { streaming?: boolean } = {}) {
		const chatContainer = new TranscriptContainer();
		const eventController = { inheritDisplaceableTodo: vi.fn(), inheritHubActivityGroup: vi.fn() };
		let helpers!: UiHelpers;
		const ctx = {
			chatContainer,
			transcriptMessageComponents: new WeakMap(),
			pendingTools: new Map(),
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn(), imageBudget: undefined },
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			settings: { get: () => false },
			addMessageToChat: (message: AgentMessage) => helpers.addMessageToChat(message),
			session: {
				retryAttempt: 0,
				getToolByName: () => undefined,
				sessionManager: { getCwd: () => process.cwd() },
				isStreaming: options.streaming === true,
			},
			get viewSession() {
				return (this as { session: unknown }).session;
			},
			eventController,
			toolOutputExpanded: false,
			hideThinkingBlock: false,
			effectiveHideThinkingBlock: false,
			proseOnlyThinking: true,
			lastAssistantUsage: undefined,
			clearTransientSessionUi: () => {},
		} as unknown as InteractiveModeContext;
		helpers = new UiHelpers(ctx);
		return { helpers, chatContainer, eventController };
	}

	function assistantWithToolCalls(content: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
		return {
			role: "assistant",
			content: content.map(tool => ({ type: "toolCall", ...tool })),
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: usage(),
			timestamp: Date.now(),
		} as unknown as AgentMessage;
	}

	function todoToolResult(toolCallId: string, items: string[], errorText?: string) {
		return {
			role: "toolResult",
			toolCallId,
			toolName: "todo",
			content: [{ type: "text", text: errorText ?? "" }],
			details: errorText ? undefined : todoResult(items).details,
			isError: errorText !== undefined,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
	}

	function hubToolResult(toolCallId: string, statuses: JobStatus[]) {
		return {
			role: "toolResult",
			toolCallId,
			toolName: "hub",
			content: [{ type: "text", text: "" }],
			details: pollResult(statuses, {}, `${toolCallId} job`).details,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
	}

	function todoComponents(chatContainer: TranscriptContainer) {
		return chatContainer.children.filter(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
	}

	function renderText(component: Component) {
		return Bun.stripANSI(component.render(120).join("\n"));
	}

	it("removes the earlier todo snapshot when a later todo update lands in the same turn", () => {
		const { helpers, chatContainer } = createHelpersFixture();
		const assistant = assistantWithToolCalls([
			{ id: "todo-1", name: "todo", arguments: { op: "view" } },
			{ id: "bash-1", name: "bash", arguments: { command: "true" } },
			{ id: "todo-2", name: "todo", arguments: { op: "view" } },
		]);
		const bashResult = {
			role: "toolResult",
			toolCallId: "bash-1",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			timestamp: Date.now(),
		} as unknown as AgentMessage;

		helpers.renderSessionContext({
			messages: [
				assistant,
				todoToolResult("todo-1", ["plan", "read"]),
				bashResult,
				todoToolResult("todo-2", ["fix", "test"]),
			],
		} as SessionContext);

		const todos = todoComponents(chatContainer).filter(component => /plan|read|fix|test/.test(renderText(component)));
		expect(todos).toHaveLength(1);
		expect(renderText(todos[0]!)).not.toContain("plan");
		expect(renderText(todos[0]!)).toContain("fix");
		expect(todos[0]!.isTranscriptBlockFinalized()).toBe(true);
	});

	it("hands the trailing todo snapshot to the controller during mid-turn rebuild", () => {
		const { helpers, chatContainer, eventController } = createHelpersFixture({ streaming: true });
		const assistant = assistantWithToolCalls([
			{ id: "todo-1", name: "todo", arguments: { op: "view" } },
			{ id: "todo-2", name: "todo", arguments: { op: "view" } },
		]);

		helpers.renderSessionContext({
			messages: [assistant, todoToolResult("todo-1", ["plan", "read"]), todoToolResult("todo-2", ["fix", "test"])],
		} as SessionContext);

		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(todoComponents(chatContainer)).toHaveLength(0);
		expect(rendered).not.toContain("plan");
		expect(rendered).not.toContain("fix");
		expect(eventController.inheritDisplaceableTodo).toHaveBeenCalledTimes(1);
		expect(eventController.inheritDisplaceableTodo).toHaveBeenCalledWith(null);
	});

	it("keeps the prior todo snapshot when a follow-up todo errors", () => {
		const { helpers, chatContainer } = createHelpersFixture();
		const assistant = assistantWithToolCalls([
			{ id: "todo-1", name: "todo", arguments: { op: "view" } },
			{ id: "todo-2", name: "todo", arguments: { op: "view" } },
		]);

		helpers.renderSessionContext({
			messages: [
				assistant,
				todoToolResult("todo-1", ["plan", "read"]),
				todoToolResult("todo-2", [], "Phase missing"),
			],
		} as SessionContext);

		const renderedTodos = todoComponents(chatContainer).map(renderText);
		expect(renderedTodos).toHaveLength(2);
		expect(renderedTodos.some(text => text.includes("plan"))).toBe(true);
		expect(renderedTodos.some(text => text.includes("Phase missing"))).toBe(true);
	});

	it("hands the trailing hub activity group to the controller during mid-turn rebuild", () => {
		const { helpers, chatContainer, eventController } = createHelpersFixture({ streaming: true });
		const assistant = assistantWithToolCalls([{ id: "hub-1", name: "hub", arguments: { op: "wait", ids: ["j0"] } }]);

		helpers.renderSessionContext({ messages: [assistant, hubToolResult("hub-1", ["running"])] } as SessionContext);

		const groups = chatContainer.children.filter(
			(child): child is HubActivityGroupComponent => child instanceof HubActivityGroupComponent,
		);
		expect(groups).toHaveLength(1);
		expect(renderText(groups[0]!)).toContain("hub-1 job 0");
		expect(eventController.inheritHubActivityGroup).toHaveBeenCalledTimes(1);
		expect(eventController.inheritHubActivityGroup).toHaveBeenCalledWith(groups[0]);
		expect(groups[0]!.canAppend).toBe(true);
	});
});
