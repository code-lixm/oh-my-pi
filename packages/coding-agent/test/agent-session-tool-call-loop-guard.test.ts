import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type CustomMessage, convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("AgentSession tool-call loop guard", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-tool-call-loop-guard-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("injects a hidden redirect before the next model call", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({ "command?": "string" }),
			execute: async () => ({ content: [{ type: "text" as const, text: "1263 passed, 4 skipped" }] }),
		};
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const toolCallTurn = callCount < 2;
				const toolCallId = `tc-${callCount}`;
				callCount++;
				const message: AssistantMessage = toolCallTurn
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "pytest -q" } }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Stopped repeating." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: toolCallTurn ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 2,
			"model.toolCallLoopGuard.exemptTools": ["hub"],
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool]]),
		});

		await session.prompt("run checks");
		await session.waitForIdle();

		expect(contexts).toHaveLength(3);
		expect(JSON.stringify(contexts[2]!.messages)).toContain("tool_call_loop_detected");
		expect(JSON.stringify(contexts[2]!.messages)).toContain("1263 passed, 4 skipped");
		const redirects = session.agent.state.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === "tool-call-loop-redirect",
		);
		expect(redirects).toHaveLength(1);
		expect(redirects[0]!.display).toBe(false);
	});

	it("soft-restarts once after ten semantically identical bash calls, then stops on a second threshold", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({ command: "string", "timeout?": "number" }),
			execute: async (_toolCallId, params) => ({
				content: [{ type: "text" as const, text: (params as { command: string }).command.replace(/^echo /, "") }],
			}),
		};
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const callIndex = callCount++;
				const toolCallTurn = callIndex < 20;
				const argumentsForCall = { command: `echo placeholder${callIndex + 1}`, timeout: 30 };
				const message: AssistantMessage = toolCallTurn
					? {
							role: "assistant",
							content: [
								{ type: "text", text: "直接调用 inspect_image 检查两张截图" },
								{
									type: "toolCall",
									id: `tc-${callIndex}`,
									name: "bash",
									arguments: argumentsForCall,
								},
							],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Safety stop after an unexpected extra provider call." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: toolCallTurn ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"advisor.enabled": false,
			"model.loopGuard.enabled": true,
			"model.loopGuard.maxNoProgressTurns": 10,
			"model.toolCallLoopGuard.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool]]),
		});

		await session.prompt("Run the same check until it changes.");
		await session.waitForIdle();
		// Ten no-progress turns cause one continuation; the second threshold is terminal.
		expect(contexts).toHaveLength(20);

		// Completed tool turns stay in session history; only the next model turn is redirected.
		const completedBashTurns = session.agent.state.messages.filter(
			(message): message is AssistantMessage =>
				message.role === "assistant" &&
				message.content.some(content => content.type === "toolCall" && content.name === "bash"),
		);
		expect(completedBashTurns).toHaveLength(20);
		const completedBashResults = session.agent.state.messages.filter(
			message => message.role === "toolResult" && message.toolName === "bash",
		);
		expect(completedBashResults).toHaveLength(20);
		const recoveryMessages = session.agent.state.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === "no-progress-loop-redirect",
		);
		expect(recoveryMessages).toHaveLength(1);
		expect(recoveryMessages[0]!.display).toBe(false);
		const haltedMessages = session.agent.state.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === "no-progress-loop-halted",
		);
		expect(haltedMessages).toHaveLength(1);
		expect(haltedMessages[0]!.details).toMatchObject({ count: 20, recovery: "halted" });
	});

	it("injects a corrective steer when Chinese reasoning repeats across turns with varying tool args", async () => {
		// Regression: a real deepseek-v4-flash run emitted the same reasoning
		// paragraph 8-9 times across 69 placeholder bash turns whose arguments
		// differed each turn (self-incrementing counter), so the verbatim
		// tool-call guard never matched. The cross-turn thinking fingerprint
		// (CJK char bigrams) must catch it on the 4th repetition.
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({ command: "string" }),
			execute: async () => ({ content: [{ type: "text" as const, text: "placeholder" }] }),
		};
		const loopThinking = [
			"我陷入了循环，一直在用 bash 写 JSON 文件而不是直接调用 inspect_image 工具。inspect_image 是内置工具，我应该直接调用它。让我直接调用。",
			"我陷入了循环，一直在用 bash 输出占位符而不是直接调用 inspect_image 工具。让我直接调用 inspect_image 工具来检查截图。",
			"我一直在错误地使用 bash 而不是直接调用 inspect_image 工具。让我直接调用 inspect_image 工具来检查截图。",
			"我陷入了循环，一直在用 bash 写占位符。我应该直接调用 inspect_image 工具来检查截图。让我直接调用它。",
			"我陷入了循环，一直在用 bash 输出占位符而不是直接调用 inspect_image 工具。inspect_image 是内置工具，我应该直接调用它。让我直接调用。",
			"我陷入了循环，一直在用 bash 写占位符。我应该直接调用 inspect_image 工具来检查截图。让我直接调用它。",
		];
		let callCount = 0;
		const STEER_LANDS_ON_CALL = 5; // threshold 4 → steer visible on the 5th model call
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const call = callCount;
				callCount++;
				// Steer visible in this call's context → finish the run cleanly.
				const toolCallTurn = call < STEER_LANDS_ON_CALL;
				const turnIndex = Math.min(toolCallTurn ? call : 0, loopThinking.length - 1);
				const toolCallId = `tc-${call}`;
				// Same reasoning every turn; bash args drift per turn (mimics the
				// real counter-variable drift that defeated the verbatim signature).
				const message: AssistantMessage = {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: loopThinking[turnIndex] },
						...(toolCallTurn
							? [
									{ type: "text" as const, text: "直接调用 inspect_image 检查截图：" },
									{
										type: "toolCall" as const,
										id: toolCallId,
										name: "bash",
										arguments: { command: `echo placeholder${call}` },
									},
								]
							: [{ type: "text" as const, text: "Stopped repeating." }]),
					],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: toolCallTurn ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: toolCallTurn ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.loopGuard.enabled": true,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool]]),
		});

		await session.prompt("检查截图");
		await session.waitForIdle();

		// Threshold 4 → the steer is injected at turn-end #4 and lands in the
		// 5th model call's context.
		expect(contexts.length).toBeGreaterThanOrEqual(STEER_LANDS_ON_CALL);
		expect(JSON.stringify(contexts[STEER_LANDS_ON_CALL - 1]!.messages)).toContain(
			"cross_turn_thinking_loop_detected",
		);
		const steers = session.agent.state.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === "cross-turn-thinking-loop-redirect",
		);
		expect(steers).toHaveLength(1);
		expect(steers[0]!.display).toBe(false);
	});
});
