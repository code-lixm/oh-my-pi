/**
 * Contracts: final async `task` snapshots vs. the tool call's own lifecycle.
 *
 * A `task` call with background jobs streams `tool_execution_update` frames
 * whose `details.async.state` can settle ("completed"/"failed") at any time
 * relative to the call's `tool_execution_end` (mixed blocking+async calls run
 * their jobs while the call is still executing).
 *
 * 1. A final async frame arriving BEFORE the call's end is a partial frame:
 *    the block stays tracked so `tool_execution_end` still delivers the
 *    terminal result (previously the block was dropped from tracking and the
 *    real result never rendered — the "disappearing task call").
 * 2. A final async frame arriving AFTER an end that parked the block as
 *    background ("running") finalizes and untracks it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import type { BashToolDetails } from "@oh-my-pi/pi-coding-agent/tools/bash";

function taskResult(asyncState: "running" | "completed" | "failed" | undefined, text: string) {
	const details: TaskToolDetails = {
		projectAgentsDir: null,
		results: [],
		totalDurationMs: 5,
		...(asyncState ? { async: { state: asyncState, jobId: "Job1", type: "task" as const } } : {}),
	};
	return { content: [{ type: "text" as const, text }], details };
}

function bashResult(text: string) {
	const details: BashToolDetails = {
		async: { state: "running", jobId: "bash-1", type: "bash" },
	};
	return { content: [{ type: "text" as const, text }], details };
}

describe("EventController async update finalization", () => {
	const sealed: ToolExecutionComponent[] = [];

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		for (const component of sealed.splice(0)) component.seal();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function createFixture() {
		const chatContainer = new TranscriptContainer();
		const pendingTools = new Map<string, ToolExecutionComponent>();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const listeners: Array<(event: AgentSessionEvent) => void | Promise<void>> = [];
		const ctx = {
			isInitialized: true,
			init: vi.fn(async () => {}),
			ui: { requestRender, requestComponentRender },
			statusLine: { invalidate: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			toolOutputExpanded: false,
			transcriptMessageComponents: new WeakMap(),
			pendingTools,
			chatContainer,
			session: {
				getToolByName: () => undefined,
				hasBuiltInTool: () => true,
				isStreaming: true,
				subscribe: (listener: (event: AgentSessionEvent) => void | Promise<void>) => {
					listeners.push(listener);
					return () => {};
				},
			},
			showWarning: vi.fn(),
			viewSession: { getToolByName: () => undefined, hasBuiltInTool: () => true },
			sessionManager: { getCwd: () => process.cwd() },
			setTodos: vi.fn(),
		} as unknown as InteractiveModeContext;
		const emit = (event: AgentSessionEvent): void => {
			for (const listener of listeners) void listener(event);
		};
		return { controller: new EventController(ctx), pendingTools, requestRender, requestComponentRender, emit };
	}

	async function flushMicrotasks(): Promise<void> {
		for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
	}

	async function startTask(controller: EventController, pendingTools: Map<string, ToolExecutionComponent>) {
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-task",
			toolName: "task",
			args: { context: "ctx", tasks: [{ agent: "task", task: "work" }] },
		});
		const component = pendingTools.get("tc-task")!;
		sealed.push(component);
		return component;
	}

	it("repaints only the matching tool card for updates and skips missing cards", async () => {
		const { controller, pendingTools, requestRender, requestComponentRender } = createFixture();
		const component = await startTask(controller, pendingTools);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-task",
			toolName: "task",
			result: taskResult("running", "Background task Job1 started."),
			isError: false,
		});
		expect(pendingTools.get("tc-task")).toBe(component);

		requestRender.mockClear();
		requestComponentRender.mockClear();
		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("completed", "Background task Job1 completed."),
		});

		expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("Background task Job1 completed.");
		expect(pendingTools.has("tc-task")).toBe(false);
		expect(requestRender).not.toHaveBeenCalled();
		expect(requestComponentRender.mock.calls).toEqual([[component]]);

		requestRender.mockClear();
		requestComponentRender.mockClear();
		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tc-missing",
			toolName: "task",
			args: {},
			partialResult: taskResult("completed", "This result has no card."),
		});
		expect(requestRender).not.toHaveBeenCalled();
		expect(requestComponentRender).not.toHaveBeenCalled();
	});

	it("keeps the block tracked when a final async frame precedes tool_execution_end", async () => {
		const { controller, pendingTools } = createFixture();
		const component = await startTask(controller, pendingTools);

		// The job settled while the call is still executing (mixed call).
		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("completed", "Background task Job1 complete."),
		});
		expect(pendingTools.get("tc-task")).toBe(component);
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		// The call's own result still lands and finalizes the block.
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-task",
			toolName: "task",
			result: taskResult("completed", "Inline results + spawned listing."),
			isError: false,
		});
		expect(pendingTools.has("tc-task")).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("finalizes a parked background block when its jobs settle after the end", async () => {
		const { controller, pendingTools } = createFixture();
		const component = await startTask(controller, pendingTools);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-task",
			toolName: "task",
			result: taskResult("running", "Spawned agent `Job1` (job `Job1`)."),
			isError: false,
		});
		// Background: kept tracked so later job frames can update it.
		expect(pendingTools.get("tc-task")).toBe(component);
		expect(component.isTranscriptBlockFinalized()).toBe(true);

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("completed", "Background task Job1 complete."),
		});
		expect(pendingTools.has("tc-task")).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("finalizes a backgrounded Bash block without tracking later job updates", async () => {
		const { controller, pendingTools } = createFixture();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-bash",
			toolName: "bash",
			args: { command: "sleep 30" },
		});
		const component = pendingTools.get("tc-bash")!;
		sealed.push(component);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-bash",
			toolName: "bash",
			result: bashResult("Backgrounded as job bash-1; result will be delivered automatically."),
			isError: false,
		});

		expect(pendingTools.has("tc-bash")).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("applies only the newest subscribed tool snapshot per window, then flushes it before the terminal result", async () => {
		vi.useFakeTimers();
		const { controller, pendingTools, emit } = createFixture();
		controller.subscribeToAgent();

		emit({
			type: "tool_execution_start",
			toolCallId: "tc-task",
			toolName: "task",
			args: { context: "ctx", tasks: [{ agent: "task", task: "work" }] },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await flushMicrotasks();
		const component = pendingTools.get("tc-task");
		if (!component) throw new Error("expected a pending task component");
		sealed.push(component);
		const updateResult = vi.spyOn(component, "updateResult");

		emit({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("running", "intermediate 1"),
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);
		emit({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("running", "intermediate 2"),
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);
		emit({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("running", "latest normal snapshot"),
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);
		await flushMicrotasks();
		expect(updateResult).not.toHaveBeenCalled();

		vi.advanceTimersByTime(32);
		await flushMicrotasks();
		expect(updateResult).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		await flushMicrotasks();
		expect(updateResult).toHaveBeenCalledTimes(1);
		expect(updateResult).toHaveBeenLastCalledWith(
			expect.objectContaining({ content: [{ type: "text", text: "latest normal snapshot" }] }),
			true,
			"tc-task",
		);

		updateResult.mockClear();
		emit({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("running", "pending before end 1"),
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);
		emit({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("running", "pending before end 2"),
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);
		emit({
			type: "tool_execution_end",
			toolCallId: "tc-task",
			toolName: "task",
			result: taskResult("completed", "terminal result is visible now"),
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await flushMicrotasks();

		expect(updateResult).toHaveBeenCalledTimes(2);
		expect(updateResult).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ content: [{ type: "text", text: "pending before end 2" }] }),
			true,
			"tc-task",
		);
		expect(updateResult).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ content: [{ type: "text", text: "terminal result is visible now" }] }),
			false,
			"tc-task",
		);
		expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("terminal result is visible now");
	});

	it("flushes interleaved tool and message snapshots in arrival order before a subscribed tool end", async () => {
		vi.useFakeTimers();
		const { controller, pendingTools, emit } = createFixture();
		controller.subscribeToAgent();

		emit({
			type: "tool_execution_start",
			toolCallId: "tc-task",
			toolName: "task",
			args: { context: "ctx", tasks: [{ agent: "task", task: "work" }] },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await flushMicrotasks();
		const component = pendingTools.get("tc-task");
		if (!component) throw new Error("expected a pending task component");
		sealed.push(component);
		const updateResult = vi.spyOn(component, "updateResult");
		const handleEvent = vi.spyOn(controller, "handleEvent");
		const messageUpdate = {
			type: "message_update",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "interleaved message snapshot" }],
			},
			assistantMessageEvent: { type: "text_delta", delta: "interleaved message snapshot" },
		} as Extract<AgentSessionEvent, { type: "message_update" }>;

		emit({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("running", "stale tool snapshot"),
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);
		emit(messageUpdate);
		emit({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("running", "latest interleaved tool snapshot"),
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);
		await flushMicrotasks();
		expect(handleEvent).not.toHaveBeenCalled();
		expect(updateResult).not.toHaveBeenCalled();

		emit({
			type: "tool_execution_end",
			toolCallId: "tc-task",
			toolName: "task",
			result: taskResult("completed", "terminal result after interleaved snapshots"),
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await flushMicrotasks();

		expect(handleEvent.mock.calls.map(([event]) => event.type)).toEqual([
			"tool_execution_update",
			"message_update",
			"tool_execution_end",
		]);
		expect(handleEvent.mock.calls[0]?.[0]).toMatchObject({
			type: "tool_execution_update",
			partialResult: { content: [{ type: "text", text: "latest interleaved tool snapshot" }] },
		});
		expect(handleEvent.mock.calls[1]?.[0]).toBe(messageUpdate);
		expect(handleEvent.mock.calls[2]?.[0]).toMatchObject({
			type: "tool_execution_end",
			result: { content: [{ type: "text", text: "terminal result after interleaved snapshots" }] },
		});
		expect(updateResult).toHaveBeenCalledTimes(2);
		expect(updateResult).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ content: [{ type: "text", text: "latest interleaved tool snapshot" }] }),
			true,
			"tc-task",
		);
		expect(updateResult).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ content: [{ type: "text", text: "terminal result after interleaved snapshots" }] }),
			false,
			"tc-task",
		);
	});

	it("flushes pending subscribed updates before an error terminal task snapshot without waiting for the window", async () => {
		vi.useFakeTimers();
		const { controller, pendingTools, emit } = createFixture();
		controller.subscribeToAgent();

		emit({
			type: "tool_execution_start",
			toolCallId: "tc-task",
			toolName: "task",
			args: { context: "ctx", tasks: [{ agent: "task", task: "work" }] },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await flushMicrotasks();
		const component = pendingTools.get("tc-task");
		if (!component) throw new Error("expected a pending task component");
		sealed.push(component);

		// A running task end keeps its card alive for the later terminal async frame.
		emit({
			type: "tool_execution_end",
			toolCallId: "tc-task",
			toolName: "task",
			result: taskResult("running", "background task is running"),
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await flushMicrotasks();
		expect(pendingTools.get("tc-task")).toBe(component);

		const updateResult = vi.spyOn(component, "updateResult");
		emit({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("running", "stale running snapshot"),
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);
		emit({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("running", "latest running snapshot"),
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);
		await flushMicrotasks();
		expect(updateResult).not.toHaveBeenCalled();

		emit({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: { ...taskResult("running", "error update is visible immediately"), isError: true },
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);
		await flushMicrotasks();

		expect(updateResult).toHaveBeenCalledTimes(2);
		expect(updateResult).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ content: [{ type: "text", text: "latest running snapshot" }] }),
			true,
			"tc-task",
		);
		expect(updateResult).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				content: [{ type: "text", text: "error update is visible immediately" }],
				isError: true,
			}),
			true,
			"tc-task",
		);
		expect(pendingTools.get("tc-task")).toBe(component);

		updateResult.mockClear();
		emit({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("running", "latest update before failure"),
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);
		emit({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("failed", "background task failed immediately"),
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);
		await flushMicrotasks();

		expect(updateResult).toHaveBeenCalledTimes(2);
		expect(updateResult).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ content: [{ type: "text", text: "latest update before failure" }] }),
			true,
			"tc-task",
		);
		expect(updateResult).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				content: [{ type: "text", text: "background task failed immediately" }],
				isError: true,
			}),
			false,
			"tc-task",
		);
		expect(pendingTools.has("tc-task")).toBe(false);
		expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("background task failed immediately");
	});
});
