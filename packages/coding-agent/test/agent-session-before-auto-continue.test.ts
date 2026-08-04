import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("AgentSession before auto continue", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-before-auto-continue-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		await session?.dispose();
		vi.restoreAllMocks();
		authStorage.close();
		tempDir.removeSync();
	});

	function testModel() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		return model;
	}

	async function createSession(agent: Agent): Promise<AgentSession> {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
		});
		return session;
	}

	it("awaits reconciliation before a TurnRecovery continuation and stops invoking it after clear", async () => {
		const responses: MockResponse[] = [
			{ content: [], stopReason: "stop" },
			{ content: ["recovered before clear"], stopReason: "stop" },
			{ content: [], stopReason: "stop" },
			{ content: ["recovered after clear"], stopReason: "stop" },
		];
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: testModel(), systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const activeSession = await createSession(agent);
		const reconciliationEntered = Promise.withResolvers<void>();
		const reconciliationReleased = Promise.withResolvers<void>();
		const continuationStarted = Promise.withResolvers<void>();
		const order: string[] = [];
		let reconciliations = 0;

		activeSession.setBeforeAutoContinue(async () => {
			reconciliations++;
			order.push("reconciler:entered");
			reconciliationEntered.resolve();
			await reconciliationReleased.promise;
			order.push("reconciler:resolved");
		});
		const continueAgent = agent.continue.bind(agent);
		const continueSpy = vi.spyOn(agent, "continue").mockImplementation(async () => {
			order.push("continue");
			continuationStarted.resolve();
			return continueAgent();
		});

		const firstPrompt = activeSession.prompt("Trigger empty-stop recovery");
		try {
			const firstScheduledAction = await Promise.race([
				reconciliationEntered.promise.then(() => "reconciler" as const),
				continuationStarted.promise.then(() => "continuation" as const),
			]);
			expect(firstScheduledAction).toBe("reconciler");
			await Promise.resolve();
			expect(continueSpy).not.toHaveBeenCalled();
			expect(order).toEqual(["reconciler:entered"]);

			reconciliationReleased.resolve();
			await firstPrompt;
			await activeSession.waitForIdle();
			expect(order).toEqual(["reconciler:entered", "reconciler:resolved", "continue"]);
			expect(mock.calls).toHaveLength(2);

			activeSession.setBeforeAutoContinue(undefined);
			await activeSession.prompt("Trigger empty-stop recovery after clear");
			await activeSession.waitForIdle();

			expect(reconciliations).toBe(1);
			expect(continueSpy).toHaveBeenCalledTimes(2);
			expect(mock.calls).toHaveLength(4);
		} finally {
			reconciliationReleased.resolve();
			await firstPrompt.catch(() => undefined);
		}
	});

	it("awaits reconciliation before a hidden next-turn prompt", async () => {
		const firstStreamStarted = Promise.withResolvers<AssistantMessageEventStream>();
		const reconciliationEntered = Promise.withResolvers<void>();
		const reconciliationReleased = Promise.withResolvers<void>();
		const automaticPromptStarted = Promise.withResolvers<void>();
		const order: string[] = [];
		let streamCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: testModel(), systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: () => {
				streamCalls++;
				const stream = new AssistantMessageEventStream();
				if (streamCalls === 1) {
					queueMicrotask(() => {
						stream.push({ type: "start", partial: createAssistantMessage("") });
						firstStreamStarted.resolve(stream);
					});
					return stream;
				}

				order.push("hidden-next-turn:prompt");
				automaticPromptStarted.resolve();
				queueMicrotask(() => {
					const response = createAssistantMessage("hidden next-turn completed");
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});
		const activeSession = await createSession(agent);
		activeSession.setBeforeAutoContinue(async () => {
			order.push("reconciler:entered");
			reconciliationEntered.resolve();
			await reconciliationReleased.promise;
			order.push("reconciler:resolved");
		});

		const initialPrompt = activeSession.prompt("Start the parent turn");
		const firstStream = await firstStreamStarted.promise;
		await activeSession.sendCustomMessage(
			{
				customType: "hidden-next-turn-test",
				content: "resume with this hidden instruction",
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
		const firstResponse = createAssistantMessage("parent turn completed");
		firstStream.push({ type: "done", reason: "stop", message: firstResponse });

		try {
			const firstScheduledAction = await Promise.race([
				reconciliationEntered.promise.then(() => "reconciler" as const),
				automaticPromptStarted.promise.then(() => "prompt" as const),
			]);
			expect(firstScheduledAction).toBe("reconciler");
			await Promise.resolve();
			expect(streamCalls).toBe(1);
			expect(order).toEqual(["reconciler:entered"]);

			reconciliationReleased.resolve();
			await initialPrompt;
			await activeSession.waitForIdle();
			expect(order).toEqual(["reconciler:entered", "reconciler:resolved", "hidden-next-turn:prompt"]);
			expect(streamCalls).toBe(2);
		} finally {
			reconciliationReleased.resolve();
			await initialPrompt.catch(() => undefined);
		}
	});
});
