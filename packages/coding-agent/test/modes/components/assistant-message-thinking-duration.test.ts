import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ThinkingContent } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../../src/i18n/settings-locale";

const RENDER_WIDTH = 120;
const THINKING_STARTED_AT = 1_700_000_000_000;
const THINKING_DURATION_MS = 3_723_000;
const THOUGHT = "Inspect the parser boundary before changing the route.";
const initialLocale = getSettingsUiLocale();

function thinkingMessage(thinking = THOUGHT): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function getThinkingBlock(message: AssistantMessage): ThinkingContent {
	const block = message.content.find((content): content is ThinkingContent => content.type === "thinking");
	if (!block) throw new Error("Expected an assistant thinking block");
	return block;
}

function renderLines(message: AssistantMessage, hideThinkingBlock: boolean, proseOnlyThinking: boolean): string[] {
	const component = new AssistantMessageComponent(
		message,
		hideThinkingBlock,
		undefined,
		[],
		undefined,
		proseOnlyThinking,
	);
	try {
		return Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"))
			.split("\n")
			.map(line => line.trimEnd());
	} finally {
		component.dispose();
	}
}

function waitForPersistedAssistant(sessionManager: SessionManager): Promise<AssistantMessage> {
	const persisted = Promise.withResolvers<AssistantMessage>();
	const previous = sessionManager.onEntryAppended;
	sessionManager.onEntryAppended = entry => {
		previous?.(entry);
		if (entry.type === "message" && entry.message.role === "assistant") {
			persisted.resolve(entry.message);
		}
	};
	return persisted.promise;
}

describe("AssistantMessageComponent thinking duration rendering", () => {
	let session: AgentSession | undefined;

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		setSettingsUiLocale("en");
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.useRealTimers();
		setSystemTime();
		setSettingsUiLocale(initialLocale);
		resetSettingsForTest();
	});

	it("renders one frozen duration row after a completed visible thought and none when hidden", async () => {
		vi.useFakeTimers();
		setSystemTime(THINKING_STARTED_AT);

		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent: new Agent({ initialState: { systemPrompt: [], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		const message = thinkingMessage();
		const persisted = waitForPersistedAssistant(sessionManager);

		session.agent.emitExternalEvent({ type: "message_start", message });
		session.agent.emitExternalEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: message },
		});

		setSystemTime(THINKING_STARTED_AT + THINKING_DURATION_MS);
		session.agent.emitExternalEvent({
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "thinking_end",
				contentIndex: 0,
				content: THOUGHT,
				partial: message,
			},
		});
		expect(getThinkingBlock(message).durationMs).toBe(THINKING_DURATION_MS);

		// A much later assistant end must persist the already-completed duration,
		// rather than extending the thought through the rest of the response.
		setSystemTime(THINKING_STARTED_AT + THINKING_DURATION_MS + 4 * 60 * 60 * 1000);
		session.agent.emitExternalEvent({ type: "message_end", message });
		const persistedMessage = await persisted;
		expect(getThinkingBlock(persistedMessage).durationMs).toBe(THINKING_DURATION_MS);

		const visibleLines = renderLines(persistedMessage, false, false);
		const thoughtRow = visibleLines.findIndex(line => line.includes(THOUGHT));
		const durationRows = visibleLines.filter(line => line.trim() === "Thinking time: 01:02:03");
		expect(thoughtRow).toBeGreaterThanOrEqual(0);
		expect(durationRows).toHaveLength(1);
		expect(visibleLines.findIndex(line => line.trim() === "Thinking time: 01:02:03")).toBeGreaterThan(thoughtRow);

		const hiddenLines = renderLines(persistedMessage, true, false);
		expect(hiddenLines.some(line => line.includes(THOUGHT))).toBe(false);
		expect(hiddenLines.some(line => line.includes("Thinking time: 01:02:03"))).toBe(false);
	});

	it("starts a thought at its first delta and freezes an unfinished block at assistant end", async () => {
		vi.useFakeTimers();
		setSystemTime(THINKING_STARTED_AT);

		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent: new Agent({ initialState: { systemPrompt: [], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		const message = thinkingMessage("Recover from a provider that skipped thinking_start.");
		const persisted = waitForPersistedAssistant(sessionManager);

		session.agent.emitExternalEvent({ type: "message_start", message });
		session.agent.emitExternalEvent({
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "Recover from a provider that skipped thinking_start.",
				partial: message,
			},
		});

		setSystemTime(THINKING_STARTED_AT + 5_000);
		session.agent.emitExternalEvent({ type: "message_end", message });
		const persistedMessage = await persisted;
		expect(getThinkingBlock(persistedMessage).durationMs).toBe(5_000);
	});

	it("renders fenced source only under the configured full-thinking policy", () => {
		const code = "const route = resolveBoundary(input);";
		const message = thinkingMessage(`Inspect the route first.\n\n\`\`\`ts\n${code}\n\`\`\``);

		const fullThinking = renderLines(message, false, false).join("\n");
		const proseOnlyThinking = renderLines(message, false, true).join("\n");

		expect(fullThinking).toContain(code);
		expect(proseOnlyThinking).toContain("Inspect the route first...");
		expect(proseOnlyThinking).not.toContain(code);
	});
});
