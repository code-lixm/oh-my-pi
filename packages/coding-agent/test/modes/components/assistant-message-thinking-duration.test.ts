import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ThinkingContent } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentActivityState } from "@oh-my-pi/pi-coding-agent/registry/agent-activity";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../../src/i18n/settings-locale";

const RENDER_WIDTH = 120;
const THINKING_STARTED_AT = 1_700_000_000_000;
const THINKING_DURATION_MS = 8_000;
const THOUGHT = "Inspect the parser boundary before changing the route.";
let previousLocale = getSettingsUiLocale();

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
		previousLocale = getSettingsUiLocale();
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
		setSettingsUiLocale(previousLocale);
		resetSettingsForTest();
	});

	it("renders one frozen duration suffix beside a completed visible thought and none when hidden", async () => {
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
		const thoughtRows = visibleLines.filter(line => line.includes(THOUGHT));
		expect(thoughtRows).toHaveLength(1);
		expect(thoughtRows[0]?.trim()).toBe(`${THOUGHT} · 8s`);
		expect(visibleLines.some(line => line.trim() === "8s")).toBe(false);
		expect(visibleLines.some(line => line.includes("Thinking time:"))).toBe(false);

		const hiddenLines = renderLines(persistedMessage, true, false);
		expect(hiddenLines.some(line => line.includes(THOUGHT))).toBe(false);
		expect(hiddenLines.some(line => line.includes("8s"))).toBe(false);
	});

	it("suppresses sub-second suffixes and renders one second inline", () => {
		const noDurationLines = renderLines(thinkingMessage(), false, false);

		for (const durationMs of [0, 999]) {
			const message = thinkingMessage();
			getThinkingBlock(message).durationMs = durationMs;
			expect(renderLines(message, false, false)).toEqual(noDurationLines);
		}

		const oneSecondMessage = thinkingMessage();
		getThinkingBlock(oneSecondMessage).durationMs = 1_000;
		const oneSecondLines = renderLines(oneSecondMessage, false, false);
		const oneSecondRows = oneSecondLines.map(line => line.trim());
		expect(oneSecondRows).toContain(`${THOUGHT} · 1s`);
		expect(oneSecondRows).not.toContain("1s");
		expect(oneSecondLines.some(line => line.includes("Thinking time:"))).toBe(false);
	});

	it("keeps request activity until the first thinking delta and freezes an unfinished block at assistant end", async () => {
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
		const activitySnapshots: Array<{
			signal: "assistant envelope" | "thinking delta";
			phase: string;
			label: string;
		}> = [];
		const requestObserved = Promise.withResolvers<void>();
		const thinkingObserved = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			const activity = (event as { activity?: AgentActivityState }).activity;
			if (event.type === "message_start" && event.message === message) {
				if (!activity) throw new Error("Expected assistant envelope activity snapshot");
				activitySnapshots.push({ signal: "assistant envelope", phase: activity.phase, label: activity.label });
				requestObserved.resolve();
			} else if (
				event.type === "message_update" &&
				event.message === message &&
				event.assistantMessageEvent.type === "thinking_delta"
			) {
				if (!activity) throw new Error("Expected thinking-delta activity snapshot");
				activitySnapshots.push({ signal: "thinking delta", phase: activity.phase, label: activity.label });
				thinkingObserved.resolve();
			}
		});

		session.agent.emitExternalEvent({ type: "message_start", message });
		await requestObserved.promise;
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
		await thinkingObserved.promise;

		setSystemTime(THINKING_STARTED_AT + 5_000);
		session.agent.emitExternalEvent({ type: "message_end", message });
		const persistedMessage = await persisted;
		expect(getThinkingBlock(persistedMessage).durationMs).toBe(5_000);
		unsubscribe();
		expect(activitySnapshots).toEqual([
			{ signal: "assistant envelope", phase: "requesting", label: "Requesting model" },
			{ signal: "thinking delta", phase: "thinking", label: "Thinking" },
		]);
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
