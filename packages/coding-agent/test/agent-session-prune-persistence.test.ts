import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { DUPLICATE_NOTICE, SUPERSEDED_NOTICE, USELESS_NOTICE } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression: per-turn pruning must rewrite the live context and durable session
 * atomically enough that resumed/forked sessions preserve the same recoverable
 * placeholders. Archive-dependent candidates must never lose their raw output
 * when artifact persistence fails, while cheap no-archive cleanup still runs.
 */
describe("AgentSession per-turn prune persistence", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;

	const STALE_READ_CALL_ID = "call-stale-read";
	const LATEST_READ_CALL_ID = "call-latest-read";
	const USELESS_CALL_ID = "call-useless-grep";
	const FIRST_DUPLICATE_CALL_ID = "call-first-duplicate";
	const LATEST_DUPLICATE_CALL_ID = "call-latest-duplicate";
	const STALE_READ_OUTPUT = "raw stale read line\n".repeat(128);
	const LATEST_READ_OUTPUT = "fresh read line\n".repeat(128);
	const USELESS_OUTPUT = "no relevant match\n".repeat(128);
	const DUPLICATE_OUTPUT = "same search result\n".repeat(128);
	const usageZero = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	function appendToolCall(
		toolCallId: string,
		name: string,
		arguments_: Record<string, unknown>,
		timestamp: number,
	): void {
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name, arguments: arguments_ }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: usageZero,
			timestamp,
		});
	}

	function appendToolResult(
		toolCallId: string,
		toolName: string,
		text: string,
		timestamp: number,
		options: { useless?: boolean } = {},
	): void {
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			isError: false,
			...options,
			timestamp,
		});
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-prune-persistence-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
		const now = Date.now();
		sessionManager.appendMessage({
			role: "user",
			content: "Inspect the current workspace.",
			timestamp: now - 500,
		});
		appendToolCall(STALE_READ_CALL_ID, "read", { path: "src/persisted.ts" }, now - 490);
		appendToolResult(STALE_READ_CALL_ID, "read", STALE_READ_OUTPUT, now - 480);
		appendToolCall(LATEST_READ_CALL_ID, "read", { path: "src/persisted.ts" }, now - 470);
		appendToolResult(LATEST_READ_CALL_ID, "read", LATEST_READ_OUTPUT, now - 460);
		appendToolCall(USELESS_CALL_ID, "grep", { pattern: "unrelated" }, now - 450);
		appendToolResult(USELESS_CALL_ID, "grep", USELESS_OUTPUT, now - 440, { useless: true });
		appendToolCall(FIRST_DUPLICATE_CALL_ID, "grep", { pattern: "same", path: "src" }, now - 430);
		appendToolResult(FIRST_DUPLICATE_CALL_ID, "grep", DUPLICATE_OUTPUT, now - 420);
		appendToolCall(LATEST_DUPLICATE_CALL_ID, "grep", { path: "src", pattern: "same" }, now - 410);
		appendToolResult(LATEST_DUPLICATE_CALL_ID, "grep", DUPLICATE_OUTPUT, now - 400);

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"compaction.dropUseless": true,
				"compaction.supersedeReads": true,
				"compaction.deduplicateResults": true,
			}),
			modelRegistry,
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
		}
	});

	function resultTextForCall(messages: readonly AgentMessage[], toolCallId: string): string {
		const message = messages.find(
			candidate => candidate.role === "toolResult" && candidate.toolCallId === toolCallId,
		);
		if (message?.role !== "toolResult" || !Array.isArray(message.content)) {
			throw new Error(`Expected tool result ${toolCallId}`);
		}
		const text = message.content.find(block => block.type === "text");
		if (text?.type !== "text") throw new Error(`Expected text content on ${toolCallId}`);
		return text.text;
	}

	function liveResultText(toolCallId: string): string {
		return resultTextForCall(session.agent.state.messages, toolCallId);
	}

	async function finishTurn(): Promise<void> {
		const finalAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Continuing." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: usageZero,
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: finalAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [finalAssistant] });
		await session.waitForIdle();
	}

	it("archives a superseded read and rebuilds the same recoverable placeholder from disk", async () => {
		await finishTurn();

		const livePlaceholder = liveResultText(STALE_READ_CALL_ID);
		const artifactId = livePlaceholder.match(/artifact:\/\/(\d+)/)?.[1];
		if (!artifactId) throw new Error("Expected superseded read placeholder to expose an artifact URI");
		expect(livePlaceholder).toBe(`${SUPERSEDED_NOTICE.slice(0, -1)} — recover: artifact://${artifactId} (region 1)]`);
		expect(liveResultText(LATEST_READ_CALL_ID)).toBe(LATEST_READ_OUTPUT);

		const artifactManager = sessionManager.getArtifactManager();
		if (!artifactManager) throw new Error("Expected a persistent artifact manager");
		expect((await artifactManager.listFiles()).filter(file => file.endsWith(".prune.log"))).toEqual([
			`${artifactId}.prune.log`,
		]);
		const artifactPath = await sessionManager.getArtifactPath(artifactId);
		if (!artifactPath) throw new Error("Expected placeholder artifact to be readable from disk");
		expect(await Bun.file(artifactPath).text()).toContain(STALE_READ_OUTPUT);

		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const reloaded = await SessionManager.open(sessionFile, tempDir.path());
		expect(resultTextForCall(reloaded.buildSessionContext().messages, STALE_READ_CALL_ID)).toBe(livePlaceholder);
	});

	it("keeps archive-dependent reads when artifact storage fails but still applies useless and duplicate cleanup", async () => {
		vi.spyOn(sessionManager, "saveArtifact").mockRejectedValueOnce(new Error("injected archive write failure"));
		await finishTurn();

		expect(liveResultText(STALE_READ_CALL_ID)).toBe(STALE_READ_OUTPUT);
		expect(liveResultText(USELESS_CALL_ID)).toBe(USELESS_NOTICE);
		expect(liveResultText(FIRST_DUPLICATE_CALL_ID)).toBe(DUPLICATE_NOTICE);
		expect(liveResultText(LATEST_DUPLICATE_CALL_ID)).toBe(DUPLICATE_OUTPUT);
	});
});
