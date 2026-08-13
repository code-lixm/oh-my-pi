/**
 * Regression coverage for automatic memory lifecycle events in the interactive TUI.
 *
 * These events are UI-only: an automatic recall/retain must look like a normal
 * memory tool card while it runs, settle the same card with the memory renderer,
 * and never become an agent/session transcript message.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ToolExecutionComponent,
	type ToolExecutionHandle,
} from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const MEMORY_OPERATIONS = ["retain", "recall", "reflect"] as const;
type MemoryOperation = (typeof MEMORY_OPERATIONS)[number];
type MemoryTrigger = "auto-recall" | "auto-retain" | "compaction" | "maintenance";

type MemoryResult = {
	content: Array<{ type: "text"; text?: string }>;
	details?: unknown;
};

type MemoryTool = {
	name: MemoryOperation;
	label: string;
	approval: "read";
};

type Fixture = {
	controller: EventController;
	chatContainer: TranscriptContainer;
	pendingTools: Map<string, ToolExecutionHandle>;
	session: {
		messages: unknown[];
		agent: { appendMessage: Mock<(...args: unknown[]) => unknown> };
	};
	sessionManager: {
		appendMessage: Mock<(...args: unknown[]) => unknown>;
		appendCustomMessageEntry: Mock<(...args: unknown[]) => unknown>;
	};
};

const fixtures: Fixture[] = [];

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
});

afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		for (const child of fixture.chatContainer.children) {
			if (child instanceof ToolExecutionComponent) child.seal();
		}
		fixture.controller.dispose();
	}
	vi.restoreAllMocks();
	resetSettingsForTest();
});

function createFixture(): Fixture {
	const chatContainer = new TranscriptContainer();
	const pendingTools = new Map<string, ToolExecutionHandle>();
	const history = [{ role: "user", content: "existing conversation" }];
	const agent = { appendMessage: vi.fn() };
	const sessionManager = {
		appendMessage: vi.fn(),
		appendCustomMessageEntry: vi.fn(),
		getCwd: () => process.cwd(),
	};
	const tools = new Map<MemoryOperation, MemoryTool>(
		MEMORY_OPERATIONS.map(operation => [
			operation,
			{ name: operation, label: operation[0]!.toUpperCase() + operation.slice(1), approval: "read" },
		]),
	);
	const getToolByName = (name: string) => tools.get(name as MemoryOperation);
	const session = {
		isStreaming: false,
		isAborting: false,
		isRetrying: false,
		isCompacting: false,
		activity: undefined,
		messages: history,
		agent,
		settings,
		sessionManager,
		getAgentId: () => "Main",
		getToolByName,
		hasBuiltInTool: (name: string) => tools.has(name as MemoryOperation),
		extensionRunner: undefined,
	};
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: {
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
			resetDisplay: vi.fn(),
			imageBudget: undefined,
			terminal: { setProgress: vi.fn() },
		},
		settings,
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		chatContainer,
		pendingTools,
		transcriptMessageComponents: new WeakMap(),
		streamingComponent: undefined,
		streamingMessage: undefined,
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		toolOutputExpanded: false,
		hideToolActivity: false,
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: true,
		noteDisplayableThinkingContent: vi.fn(() => false),
		session,
		viewSession: session,
		sessionManager,
		focusedAgentId: undefined,
		setWorkingMessage: vi.fn(),
		ensureLoadingAnimation: vi.fn(),
		clearTransientSessionUi: vi.fn(),
		showWarning: vi.fn(),
		showPinnedError: vi.fn(),
		clearPinnedError: vi.fn(),
		flushPendingCommandOutput: vi.fn(),
		flushPendingModelSwitch: vi.fn(async () => {}),
	} as unknown as InteractiveModeContext;
	const fixture = {
		controller: new EventController(ctx),
		chatContainer,
		pendingTools,
		session,
		sessionManager,
	};
	fixtures.push(fixture);
	return fixture;
}

function memoryStart(
	operationId: string,
	operation: MemoryOperation,
	args: unknown,
	trigger: MemoryTrigger,
): AgentSessionEvent {
	return {
		type: "memory_operation_start",
		operationId,
		operation,
		args,
		trigger,
	} as unknown as AgentSessionEvent;
}

function memoryEnd(
	operationId: string,
	operation: MemoryOperation,
	result: MemoryResult,
	isError = false,
): AgentSessionEvent {
	return {
		type: "memory_operation_end",
		operationId,
		operation,
		result,
		isError,
	} as unknown as AgentSessionEvent;
}

function rendered(card: ToolExecutionHandle): string {
	return Bun.stripANSI(card.render(120).join("\n"));
}

function memoryCards(container: TranscriptContainer): ToolExecutionComponent[] {
	return container.children.filter(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
}

function statusGlyph(status: "pending" | "success" | "error"): string {
	return Bun.stripANSI(theme.status[status]);
}

describe("EventController automatic memory lifecycle", () => {
	it("mounts visible pending cards and settles the matching retain/recall card by operationId", async () => {
		const fixture = createFixture();
		const recallId = "memory-recall-1";
		const retainId = "memory-retain-1";

		await fixture.controller.handleEvent(
			memoryStart(recallId, "recall", { query: "deployment notes" }, "auto-recall"),
		);
		await fixture.controller.handleEvent(
			memoryStart(retainId, "retain", { items: [{ content: "deployment fact" }] }, "auto-retain"),
		);

		const cards = memoryCards(fixture.chatContainer);
		expect(cards).toHaveLength(2);
		const recallCard = fixture.pendingTools.get(recallId);
		const retainCard = fixture.pendingTools.get(retainId);
		expect(recallCard).toBeInstanceOf(ToolExecutionComponent);
		expect(retainCard).toBeInstanceOf(ToolExecutionComponent);
		expect(rendered(recallCard!)).toContain("Memory: recall");
		expect(rendered(recallCard!)).toContain("deployment notes");
		expect(rendered(recallCard!)).toContain(statusGlyph("pending"));
		expect(rendered(retainCard!)).toContain("Memory: retain");
		expect(rendered(retainCard!)).toContain(statusGlyph("pending"));

		// End in reverse order: operationId, rather than arrival order or operation
		// name alone, must select the card that receives each result.
		await fixture.controller.handleEvent(
			memoryEnd(retainId, "retain", {
				content: [{ type: "text", text: "1 memory stored." }],
				details: { count: 1 },
			}),
		);
		expect(fixture.pendingTools.has(retainId)).toBe(false);
		expect(fixture.pendingTools.get(recallId)).toBe(recallCard);
		expect(fixture.chatContainer.children).toContain(retainCard!);
		expect(rendered(retainCard!)).toContain("Memory: retain");
		expect(rendered(retainCard!)).toContain("1 memory stored");
		expect(rendered(retainCard!)).toContain(Bun.stripANSI(theme.styledSymbol("tool.memory", "accent")));
		expect(rendered(recallCard!)).toContain(statusGlyph("pending"));

		await fixture.controller.handleEvent(
			memoryEnd(recallId, "recall", {
				content: [{ type: "text", text: "Found 1 relevant memory:\n\n- deployment fact" }],
			}),
		);
		expect(fixture.pendingTools.has(recallId)).toBe(false);
		expect(fixture.chatContainer.children).toContain(recallCard!);
		expect(rendered(recallCard!)).toContain("Memory: recall");
		expect(rendered(recallCard!)).toContain("1 found");
		expect(rendered(recallCard!)).toContain(Bun.stripANSI(theme.styledSymbol("tool.memory", "accent")));
	});

	it("settles an errored automatic memory operation as a visible failed card", async () => {
		const fixture = createFixture();
		const operationId = "memory-recall-error";

		await fixture.controller.handleEvent(
			memoryStart(operationId, "recall", { query: "unavailable index" }, "maintenance"),
		);
		const card = fixture.pendingTools.get(operationId);
		expect(card).toBeInstanceOf(ToolExecutionComponent);

		await fixture.controller.handleEvent(
			memoryEnd(operationId, "recall", { content: [{ type: "text", text: "memory backend unavailable" }] }, true),
		);

		expect(fixture.pendingTools.has(operationId)).toBe(false);
		expect(fixture.chatContainer.children).toContain(card!);
		const output = rendered(card!);
		expect(output).toContain("Memory: recall");
		expect(output).toContain("memory backend unavailable");
		expect(output).toContain(statusGlyph("error"));
	});

	it("ignores an end event whose operationId has no pending start", async () => {
		const fixture = createFixture();

		await fixture.controller.handleEvent(
			memoryEnd("memory-orphan", "recall", {
				content: [{ type: "text", text: "orphan result must not render" }],
			}),
		);

		expect(fixture.pendingTools).toHaveLength(0);
		expect(memoryCards(fixture.chatContainer)).toHaveLength(0);
		expect(fixture.chatContainer.children).toHaveLength(0);
	});

	it("keeps automatic memory lifecycle events out of agent/session message history", async () => {
		const fixture = createFixture();
		const historyBefore = [...fixture.session.messages];

		await fixture.controller.handleEvent(
			memoryStart("memory-retain-history", "retain", { items: [{ content: "private fact" }] }, "auto-retain"),
		);
		await fixture.controller.handleEvent(
			memoryEnd("memory-retain-history", "retain", {
				content: [{ type: "text", text: "1 memory stored." }],
			}),
		);

		expect(fixture.session.messages).toEqual(historyBefore);
		expect(fixture.session.agent.appendMessage).not.toHaveBeenCalled();
		expect(fixture.sessionManager.appendMessage).not.toHaveBeenCalled();
		expect(fixture.sessionManager.appendCustomMessageEntry).not.toHaveBeenCalled();
	});
});
