import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool, type AsideMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getPromptLocale, type PromptLocale, setPromptLocale } from "../src/prompts/prompt-locale";

/**
 * Regression coverage for issue #3651 and its redesign: the mid-run todo
 * reconciliation nudge keeps the live HUD honest during long runs, but is a
 * gentle MODEL-ONLY hint — deliberately separate from the user-visible
 * stop-time reminder ladder. The contract this defends:
 *
 *   1. Successful mutations tick the counter; a successful `task` result or
 *      successfully delivered async task completion is an immediate
 *      reconciliation boundary. Read-only exploration and errored results
 *      never nudge.
 *   2. At {@link MID_RUN_NUDGE_MUTATION_THRESHOLD} ordinary mutations without
 *      a `todo` call, the aside provider injects a hidden custom message
 *      (`display: false`) — NO `todo_reminder` event, nothing renders.
 *   3. A `todo` tool result resets the counter.
 *   4. At most {@link MID_RUN_NUDGE_MAX_PER_CYCLE} nudges fire per
 *      prompt cycle.
 *   5. The counter update lands synchronously with the message_end emit.
 *
 * Drives the aside provider directly: the production agent loop polls it
 * between tool-use turns (mid-work boundary in `agent-loop.ts`), so calling it
 * after a batch of synthesized `message_end` events mirrors that injection
 * point without spinning a real model.
 */
describe("AgentSession mid-run todo reconciliation nudge", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let reminderEvents: Array<Extract<AgentSessionEvent, { type: "todo_reminder" }>>;
	let asideProvider: (() => AsideMessage[] | Promise<AsideMessage[]>) | undefined;
	let previousPromptLocale: PromptLocale;
	let asyncJobManager: AsyncJobManager;

	const THRESHOLD = 4; // mirrors MID_RUN_NUDGE_MUTATION_THRESHOLD
	const MAX_PER_CYCLE = 2; // mirrors MID_RUN_NUDGE_MAX_PER_CYCLE
	const NUDGE_TYPE = "mid-run-todo-nudge"; // mirrors MID_RUN_NUDGE_MESSAGE_TYPE

	function toolUseAssistant(toolName: string): AssistantMessage {
		const id = `call_${toolName}_${Date.now()}_${Math.random()}`;
		const toolCall: ToolCall = { type: "toolCall", id, name: toolName, arguments: {} };
		return {
			role: "assistant",
			content: [toolCall],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 50,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 60,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	function textOnlyAssistant(): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "paused for instruction" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 50,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 60,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	async function emitTextOnlyStop(): Promise<void> {
		const msg = textOnlyAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		await settle();
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	/** Production-shaped tool round trip: assistant toolCall turn + toolResult. */
	function emitToolResult(toolName: string, opts?: { isError?: boolean }): void {
		const toolCallId = `call_${toolName}_${Date.now()}_${Math.random()}`;
		session.agent.emitExternalEvent({ type: "message_end", message: toolUseAssistant(toolName) });
		const content: TextContent[] = [{ type: "text", text: "ok" }];
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content,
				isError: opts?.isError ?? false,
				timestamp: Date.now(),
			},
		});
	}

	/**
	 * #processAgentEvent fires off message_end handlers as async microtasks that
	 * chain on `#messageEndPersistenceTail`. After a batch of synchronous emits
	 * the counter only catches up once every queued persist task drains, so
	 * tests yield a full event-loop tick before draining asides.
	 *
	 * Real-timer exception (ts-no-test-timers): `Bun.sleep(0)` is a single
	 * event-loop tick, not a tuned duration — the private persistence tail
	 * exposes no drain promise to await, and fake timers cannot flush it.
	 */
	async function settle(): Promise<void> {
		await Bun.sleep(0);
	}

	function collectNudges(entries: AsideMessage[]): CustomMessage[] {
		const out: CustomMessage[] = [];
		for (const entry of entries) {
			const message = typeof entry === "function" ? entry() : entry;
			if (message?.role !== "custom" || message.customType !== NUDGE_TYPE) continue;
			out.push(message);
		}
		return out;
	}

	function drainNudgesSynchronously(): CustomMessage[] {
		if (!asideProvider) throw new Error("aside provider was never captured");
		const entries = asideProvider();
		if (entries instanceof Promise) throw new Error("aside provider unexpectedly returned a Promise");
		return collectNudges(entries);
	}

	async function drainNudges(): Promise<CustomMessage[]> {
		if (!asideProvider) throw new Error("aside provider was never captured");
		return collectNudges(await asideProvider());
	}

	function registerGatedAsyncJob(type: "bash" | "task", id: string): PromiseWithResolvers<string> {
		const gate = Promise.withResolvers<string>();
		asyncJobManager.register(type, `async ${type} ${id}`, async () => await gate.promise, {
			id,
			ownerId: "Main",
		});
		return gate;
	}

	async function drainOwnedAsyncDeliveries(): Promise<void> {
		await asyncJobManager.waitForOwnerJobs("Main");
		await asyncJobManager.drainDeliveries({ filter: { ownerId: "Main" } });
	}

	beforeEach(async () => {
		previousPromptLocale = getPromptLocale();
		setPromptLocale("en");
		tempDir = TempDir.createSync("@pi-todo-mid-run-nudge-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		asyncJobManager = new AsyncJobManager({});

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": true,
			"todo.reminders": true,
			"todo.remindersMax": 3,
		});
		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings,
		};
		const todoTool = new TodoTool(toolSession);

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [todoTool as unknown as AgentTool],
				messages: [],
			},
		});

		// Capture the aside provider AgentSession installs in its constructor.
		// Wrap the instance method (not the prototype) so concurrent test files
		// constructing their own Agents are never observed through this seam.
		asideProvider = undefined;
		const originalSet = agent.setAsideMessageProvider.bind(agent);
		agent.setAsideMessageProvider = (fn): void => {
			if (fn !== undefined && asideProvider === undefined) asideProvider = fn;
			originalSet(fn);
		};

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			agentId: "Main",
			asyncJobManager,
		});

		reminderEvents = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "todo_reminder") reminderEvents.push(event);
		});

		session.setTodoPhases([
			{
				name: "Refactor pass",
				tasks: [
					{ content: "Sweep call sites", status: "in_progress" },
					{ content: "Update tests", status: "pending" },
					{ content: "Polish docs", status: "pending" },
				],
			},
		]);
	});

	afterEach(async () => {
		await session.dispose();
		asyncJobManager.cancelAll();
		await asyncJobManager.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
		setPromptLocale(previousPromptLocale);
	});

	it("read-only exploration never ticks the counter, no matter how long", async () => {
		for (let i = 0; i < THRESHOLD * 3; i++) emitToolResult(i % 2 === 0 ? "grep" : "read");

		await settle();
		expect(await drainNudges()).toEqual([]);
		expect(reminderEvents).toEqual([]);
	});

	it("stays silent below the mutation threshold", async () => {
		for (let i = 0; i < THRESHOLD - 1; i++) emitToolResult("edit");

		await settle();
		expect(await drainNudges()).toEqual([]);
		expect(reminderEvents).toEqual([]);
	});

	it("immediately reconciles after one successful task result without bulk-closing todos", () => {
		emitToolResult("task");

		const nudges = drainNudgesSynchronously();

		expect(nudges).toHaveLength(1);
		const nudge = nudges[0];
		// Hidden from the TUI/transcript, visible to the model only.
		expect(nudge?.display).toBe(false);
		const text = typeof nudge?.content === "string" ? nudge.content : "";
		expect(text).toContain("<system-reminder>");
		expect(text).toContain("3 todo items");
		// Gentle hint, not the stop-time escalation ladder: no per-task
		// enumeration, no attempt counter.
		expect(text).not.toContain("Sweep call sites");
		expect(text).not.toMatch(/reminder \d\/\d/i);
		// A task result is a subagent-progress boundary. The model must reconcile
		// its ledger one item at a time instead of treating implementation work as
		// permission to close a whole phase or unverified verification work.
		expect(text).toMatch(/\b(?:subagent|task progress)\b/i);
		expect(text).toMatch(/\b(?:reconcile|update)\b/i);
		expect(text).toMatch(/\b(?:completed|done)\b/i);
		expect(text).toMatch(/\b(?:one[- ]by[- ]one|individually)\b/i);
		expect(text).toMatch(/\b(?:do not|never)\b[^.]*\b(?:bulk|batch)\b[^.]*\b(?:close|complete)\b/i);
		expect(text).toMatch(/\b(?:implementation|implemented)\b/i);
		expect(text).toMatch(/\b(?:unverified|verification)\b/i);

		// SEPARATE concept from the stop-time reminder: no todo_reminder event,
		// so nothing renders a TodoReminderComponent or reaches extensions.
		expect(reminderEvents).toEqual([]);

		// Taking the nudge resets its mutation budget, so an immediate next aside
		// poll cannot re-inject without another task or mutation runway.
		const followUpNudges = drainNudgesSynchronously();
		expect(followUpNudges).toEqual([]);
	});

	it("re-arms reconciliation when a real async task result is enqueued after its initial task result was reconciled", async () => {
		// This mirrors an async TaskTool call's immediate result: the ledger nudge
		// is consumed now, before the background subagent can finish.
		emitToolResult("task");
		expect(drainNudgesSynchronously()).toHaveLength(1);
		expect(drainNudgesSynchronously()).toEqual([]);

		const completion = registerGatedAsyncJob("task", "completed-task-result");
		completion.resolve("subagent completed its assigned change");
		await drainOwnedAsyncDeliveries();

		// Delivery passed through AgentSession's real async-result queue rather
		// than another synthetic tool result, so it must independently re-arm the
		// next aside reconciliation boundary.
		expect(session.hasPendingAsyncWork()).toBe(true);
		expect(drainNudgesSynchronously()).toHaveLength(1);
		expect(drainNudgesSynchronously()).toEqual([]);
	});

	it("does not arm reconciliation for completed bash or failed/cancelled task deliveries", async () => {
		const bashCompletion = registerGatedAsyncJob("bash", "completed-bash-result");
		bashCompletion.resolve("bash completed");
		await drainOwnedAsyncDeliveries();
		// Bash still produces a real async-result follow-up, but it is not
		// subagent progress and must not re-open the todo ledger.
		expect(session.hasPendingAsyncWork()).toBe(true);
		expect(drainNudgesSynchronously()).toEqual([]);

		asyncJobManager.register(
			"task",
			"failed async task",
			async () => {
				throw new Error("expected async task failure");
			},
			{ id: "failed-task-result", ownerId: "Main" },
		);
		await drainOwnedAsyncDeliveries();
		// A failed task reaches the same async-result sink but is not completion
		// evidence, so its delivery must leave todos untouched.
		expect(session.hasPendingAsyncWork()).toBe(true);
		expect(drainNudgesSynchronously()).toEqual([]);

		const cancelled = registerGatedAsyncJob("task", "cancelled-task-result");
		asyncJobManager.cancelAll({ ownerId: "Main" });
		cancelled.resolve("cancelled task output");
		await drainOwnedAsyncDeliveries();
		expect(session.hasPendingAsyncWork()).toBe(false);
		expect(drainNudgesSynchronously()).toEqual([]);
	});

	it("does not arm reconciliation for suppressed or disposed async task deliveries", async () => {
		const suppressed = registerGatedAsyncJob("task", "suppressed-task-result");
		// Foreground wait acknowledgement suppresses the manager delivery before
		// the job settles, so no async-result may become a progress boundary.
		asyncJobManager.acknowledgeDeliveries(["suppressed-task-result"]);
		suppressed.resolve("suppressed task output");
		await drainOwnedAsyncDeliveries();
		expect(session.hasPendingAsyncWork()).toBe(false);
		expect(drainNudgesSynchronously()).toEqual([]);

		// Full disposal unregisters the owner sink. A task that settles after this
		// point is dead-lettered and cannot mutate the disposed session's tracker.
		await session.dispose();
		asyncJobManager.register("task", "disposed async task", async () => "late task output", {
			id: "disposed-task-result",
			ownerId: "Main",
		});
		await drainOwnedAsyncDeliveries();
		expect(session.hasPendingAsyncWork()).toBe(false);
		expect(drainNudgesSynchronously()).toEqual([]);
	});
	it("renders the selected Chinese reconciliation nudge after one task result", async () => {
		setPromptLocale("zh-CN");
		emitToolResult("task");

		await settle();
		const nudges = await drainNudges();
		expect(nudges).toHaveLength(1);
		const text = typeof nudges[0]?.content === "string" ? nudges[0].content : "";
		expect(text).toContain("收到子代理结果或任务进度后");
		expect(text).toContain("只逐项标记已有完成证据的任务");
		expect(text).toContain("NEVER 批量关闭整个阶段");
		expect(text).toContain("实现完成不等于验证完成");
		expect(text).toContain("验证命令成功前必须保持验证任务开放");
		expect(text).not.toContain("A subagent result");
	});
	it("errored Bash results do not tick the counter", async () => {
		for (let i = 0; i < THRESHOLD * 3; i++) emitToolResult("bash", { isError: true });

		await settle();
		expect(await drainNudges()).toEqual([]);
		expect(reminderEvents).toEqual([]);
	});

	it("does not nudge when a `todo` call has reset the counter mid-window", async () => {
		for (let i = 0; i < THRESHOLD - 1; i++) emitToolResult("write");
		emitToolResult("todo");
		for (let i = 0; i < THRESHOLD - 1; i++) emitToolResult("write");

		await settle();
		expect(await drainNudges()).toEqual([]);
		expect(reminderEvents).toEqual([]);
	});

	it("caps nudges per prompt cycle", async () => {
		let fired = 0;
		for (let cycle = 0; cycle < MAX_PER_CYCLE + 2; cycle++) {
			for (let i = 0; i < THRESHOLD; i++) emitToolResult("edit");
			await settle();
			fired += (await drainNudges()).length;
		}
		expect(fired).toBe(MAX_PER_CYCLE);
		expect(reminderEvents).toEqual([]);
	});

	it("counter update lands synchronously with the message_end emit (no microtask drain required)", () => {
		// Regression for the review on PR #3652: pre-fix the counter update sat
		// after `await messageEndPersistence.persist(...)`, so the live counter
		// only caught up once microtasks drained. A poll between the emit burst
		// and the persistence chain settling would observe stale state. With the
		// hoisted (synchronous) update, the production-shaped contract holds even
		// when the aside poll runs in the same JS task as the emit.
		for (let i = 0; i < THRESHOLD; i++) emitToolResult("edit");

		if (!asideProvider) throw new Error("aside provider was never captured");
		const result = asideProvider();
		if (result instanceof Promise) throw new Error("aside provider unexpectedly returned a Promise");
		const nudges = result
			.map(entry => (typeof entry === "function" ? entry() : entry))
			.filter((m): m is NonNullable<typeof m> => Boolean(m))
			.filter(m => m.role === "custom" && (m as CustomMessage).customType === NUDGE_TYPE);
		expect(nudges.length).toBe(1);
	});

	it("stays silent when `todo` is not in the active-tool list, even if `todo.enabled` is still on", async () => {
		// An explicit active-tool list (or discovery-mode filtering) can drop
		// `todo` from the slate while the setting flag stays true. Asking the
		// model to call a tool that is not in its schema would produce
		// fabricated/unknown tool calls. Mirror {@link #createEagerTodoPrelude}.
		await session.setActiveToolsByName([]);
		expect(session.getActiveToolNames()).not.toContain("todo");

		for (let i = 0; i < THRESHOLD; i++) emitToolResult("edit");
		await settle();
		expect(await drainNudges()).toEqual([]);
		expect(reminderEvents).toEqual([]);
	});

	it("stays silent when Todo reminders are disabled", async () => {
		session.settings.override("todo.reminders", false);
		for (let i = 0; i < THRESHOLD; i++) emitToolResult("edit");

		await settle();
		expect(await drainNudges()).toEqual([]);
		expect(reminderEvents).toEqual([]);
	});

	it("stays silent in plan mode", async () => {
		session.setPlanModeState({ enabled: true, planFilePath: "plan.md" });
		for (let i = 0; i < THRESHOLD; i++) emitToolResult("edit");

		await settle();
		expect(await drainNudges()).toEqual([]);
		expect(reminderEvents).toEqual([]);
	});

	it("does not spend the pre-stop mutation count immediately after a stop-time reminder", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		for (let i = 0; i < THRESHOLD - 1; i++) emitToolResult("edit");

		await settle();
		await emitTextOnlyStop();
		await session.waitForIdle();
		// The stop-time path is the user-visible ladder: it emits the event.
		expect(reminderEvents.length).toBe(1);
		expect(reminderEvents[0]?.attempt).toBe(1);

		// The stop-time reminder reset the mutation counter, so one more landed
		// mutation (crossing the stale pre-reminder threshold) must stay silent.
		emitToolResult("edit");
		await settle();
		expect(await drainNudges()).toEqual([]);
		expect(reminderEvents.length).toBe(1);
	});
});
