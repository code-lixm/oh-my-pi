import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession pending user queue persistence", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-pending-user-queue-");
		vi.useFakeTimers();
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		for (const session of sessions.reverse()) await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function createSession(sessionManager: SessionManager): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [] } });
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({}),
			modelRegistry: new ModelRegistry(authStorage),
		});
		sessions.push(session);
		return session;
	}

	async function reopenSessionManager(sessionFile: string): Promise<SessionManager> {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		await manager.setSessionFile(sessionFile);
		return manager;
	}

	it("restores queued user steers and follow-ups after reopening the session", async () => {
		const originalManager = SessionManager.create(tempDir.path(), tempDir.path());
		const original = createSession(originalManager);
		vi.spyOn(original.agent, "continue").mockImplementation(async () => {});

		await original.steer("interrupt with this");
		await original.followUp("then do this");
		const sessionFile = originalManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		const restored = createSession(await reopenSessionManager(sessionFile));
		vi.spyOn(restored.agent, "continue").mockImplementation(async () => {});
		await restored.restorePendingUserQueue();

		expect(restored.getQueuedMessages()).toEqual({
			steering: ["interrupt with this"],
			followUp: ["then do this"],
		});
	});

	it("does not restore a sidecar message already committed to the transcript", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const message: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "already delivered" }],
			attribution: "user",
			steering: true,
			timestamp: Date.now(),
		};
		await manager.savePendingUserMessages([{ id: Bun.randomUUIDv7(), mode: "steer", message }]);
		manager.appendMessage(message);
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		const reopened = await reopenSessionManager(sessionFile);
		const restored = createSession(reopened);
		await restored.restorePendingUserQueue();

		expect(restored.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		expect(await reopened.loadPendingUserMessages()).toEqual([]);
	});
});
