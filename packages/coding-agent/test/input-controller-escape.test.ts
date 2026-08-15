import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext, SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { vocalizer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import { setKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { tSettingsUi } from "../src/i18n/settings-locale";

type Spy = Mock<(...args: unknown[]) => unknown>;
type StartPendingSubmissionSpy = Mock<InteractiveModeContext["startPendingSubmission"]>;
type FakeEditor = {
	onEscape?: () => void;
	onSubmit?: (text: string) => Promise<void>;
	onClear?: () => void;
	onExit?: () => void;
	onSuspend?: () => void;
	onCycleThinkingLevel?: () => void;
	onCycleModelForward?: () => void;
	onCycleModelBackward?: () => void;
	onSelectModelTemporary?: () => void;
	onSelectModel?: () => void;
	onLeftAtStart?: () => void;
	onHistorySearch?: () => void;
	onPasteImage?: () => void;
	onCopyPrompt?: () => void;
	onExpandTools?: () => void;
	onToggleThinking?: () => void;
	onExternalEditor?: () => void;
	onDequeue?: () => void;
	onChange?: (text: string) => void;
	setText(text: string): void;
	getText(): string;
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
};

function createSubmission(input: {
	text: string;
	images?: ImageContent[];
	imageLinks?: (string | undefined)[];
}): SubmittedUserInput {
	return {
		text: input.text,
		images: input.images,
		imageLinks: input.imageLinks,
		cancelled: false,
		started: false,
	};
}

function createContext(): {
	ctx: InteractiveModeContext;
	editor: FakeEditor;
	spies: {
		abort: Spy;
		abortBash: Spy;
		abortEval: Spy;
		abortMainCompaction: Spy;
		abortMainHandoff: Spy;
		abortMainRetry: Spy;
		abortHandoff: Spy;
		addMessageToChat: Spy;
		cancelAsyncJobs: Spy;
		cancelPendingSubmission: Spy;
		clearEditor: Spy;
		clearQueue: Spy;
		flushSync: Spy;
		getQueuedMessages: Spy;
		ensureLoadingAnimation: Spy;
		handleBtwCommand: Spy;
		handleBtwEscape: Spy;
		handleOmfgEscape: Spy;
		hasActiveBtw: Spy;
		hasActiveOmfg: Spy;
		onInputCallback: Spy;
		prompt: Spy;
		requestRender: Spy;
		resetDisplay: Spy;
		shutdown: Spy;
		showStatus: Spy;
		startPendingSubmission: StartPendingSubmissionSpy;
		updatePendingMessagesDisplay: Spy;
	};
	inputListeners: Array<(data: string) => { consume?: boolean; data?: string } | undefined>;
	sessionListeners: Array<(event: { type: string }) => void>;
} {
	let editorText = "";
	const abort = vi.fn();
	const abortBash = vi.fn();
	const abortEval = vi.fn();
	const abortMainCompaction = vi.fn();
	const abortMainHandoff = vi.fn();
	const abortMainRetry = vi.fn();
	const abortHandoff = vi.fn();
	const addMessageToChat = vi.fn();
	const cancelAsyncJobs = vi.fn();
	const cancelPendingSubmission = vi.fn(() => false);
	const clearQueue = vi.fn(() => ({ steering: [], followUp: [] }));
	const getQueuedMessages = vi.fn(() => ({ steering: [], followUp: [] }));
	const onInputCallback = vi.fn();
	const requestRender = vi.fn();
	const resetDisplay = vi.fn();
	const showStatus = vi.fn();
	const inputListeners: Array<(data: string) => { consume?: boolean; data?: string } | undefined> = [];
	const sessionListeners: Array<(event: { type: string }) => void> = [];
	const handleBtwCommand = vi.fn(async () => {});
	const handleBtwEscape = vi.fn(() => true);
	const hasActiveBtw = vi.fn(() => false);
	const handleOmfgEscape = vi.fn(() => true);
	const hasActiveOmfg = vi.fn(() => false);
	const updatePendingMessagesDisplay = vi.fn();
	const prompt = vi.fn();
	const startPendingSubmission = vi.fn(
		(input: { text: string; images?: ImageContent[]; imageLinks?: (string | undefined)[] }) => {
			ensureLoadingAnimation();
			return createSubmission(input);
		},
	);
	const editor: FakeEditor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
		pendingImages: [],
		pendingImageLinks: [],
	};

	let ctx!: InteractiveModeContext;
	const ensureLoadingAnimation = vi.fn(() => {
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
	});

	ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: {
			requestRender,
			resetDisplay,
			getFocused: () => editor,
			addInputListener: vi.fn(listener => {
				inputListeners.push(listener as (data: string) => { consume?: boolean; data?: string } | undefined);
				return () => {};
			}),
			addStartListener: vi.fn(),
		} as unknown as InteractiveModeContext["ui"],
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		autoCompactionEscapeHandler: undefined,
		retryEscapeHandler: undefined,
		session: {
			isStreaming: false,
			isCompacting: false,
			isGeneratingHandoff: false,
			isRetrying: false,
			isBashRunning: false,
			isEvalRunning: false,
			runningAsyncJobCount: 0,
			queuedMessageCount: 0,
			messages: [],
			extensionRunner: undefined,
			abort,
			abortBash,
			abortEval,
			abortCompaction: abortMainCompaction,
			abortHandoff: abortMainHandoff,
			abortRetry: abortMainRetry,
			cancelAsyncJobs,
			clearQueue,
			getQueuedMessages,
			maybeStartTitleGeneration: vi.fn(),
			prompt,
			subscribe: vi.fn((listener: (event: { type: string }) => void) => {
				sessionListeners.push(listener);
				return () => {
					const index = sessionListeners.indexOf(listener);
					if (index >= 0) sessionListeners.splice(index, 1);
				};
			}),
		} as unknown as InteractiveModeContext["session"],
		viewSession: {
			isCompacting: false,
			isGeneratingHandoff: false,
			isRetrying: false,
			abortCompaction: vi.fn(),
			abortHandoff,
			abortRetry: vi.fn(),
		} as unknown as InteractiveModeContext["viewSession"],
		sessionManager: {
			getSessionName: () => "existing session",
			flushSync: vi.fn(),
		} as unknown as InteractiveModeContext["sessionManager"],
		keybindings: {
			getKeys: () => [],
			matches: () => false,
		} as unknown as InteractiveModeContext["keybindings"],
		compactionQueuedMessages: [],
		isBashMode: false,
		isPythonMode: false,
		optimisticUserMessageSignature: undefined,
		locallySubmittedUserSignatures: new Set<string>(),
		onInputCallback,
		addMessageToChat,
		cancelPendingSubmission,
		ensureLoadingAnimation,
		finishPendingSubmission: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		markPendingSubmissionStarted: vi.fn(() => true),
		startPendingSubmission,
		updatePendingMessagesDisplay,
		updateEditorBorderColor: vi.fn(),
		showDebugSelector: vi.fn(),
		toggleTodoExpansion: vi.fn(),
		showAgentHub: vi.fn(),
		unfocusSession: vi.fn(async () => {}),
		focusParentSession: vi.fn(async () => {}),
		handleSTTToggle: vi.fn(),
		handleBtwEscape,
		handleBtwCommand,
		hasActiveBtw,
		handleOmfgEscape,
		hasActiveOmfg,
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		shutdown: vi.fn(async () => {}),
		clearEditor: vi.fn(),
		showStatus,
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		spies: {
			abort,
			abortBash,
			abortEval,
			abortMainCompaction,
			abortMainHandoff,
			abortMainRetry,
			abortHandoff,
			addMessageToChat,
			cancelAsyncJobs,
			cancelPendingSubmission,
			clearQueue,
			clearEditor: ctx.clearEditor as Spy,
			getQueuedMessages,
			ensureLoadingAnimation,
			flushSync: ctx.sessionManager.flushSync as Spy,
			handleBtwCommand,
			handleBtwEscape,
			hasActiveBtw,
			handleOmfgEscape,
			hasActiveOmfg,
			onInputCallback,
			prompt,
			requestRender,
			resetDisplay,
			showStatus,
			shutdown: ctx.shutdown as Spy,
			startPendingSubmission,
			updatePendingMessagesDisplay,
		},
		inputListeners,
		sessionListeners,
	};
}

type AbortViewSession = {
	isCompacting: boolean;
	isGeneratingHandoff: boolean;
	isRetrying: boolean;
	abortCompaction: Spy;
	abortHandoff: Spy;
	abortRetry: Spy;
};

function abortViewSession(ctx: InteractiveModeContext): AbortViewSession {
	// Test harness installs a mutable fake AgentSession; keep the unchecked cast named
	// so property access is explicit.
	return ctx.viewSession as unknown as AbortViewSession;
}

type MutableSessionState = InteractiveModeContext["session"] & {
	isStreaming: boolean;
	isCompacting: boolean;
	isGeneratingHandoff: boolean;
	isRetrying: boolean;
	isBashRunning: boolean;
	isEvalRunning: boolean;
	runningAsyncJobCount: number;
};

function mutableSessionState(ctx: InteractiveModeContext): MutableSessionState {
	// Test harness installs a mutable fake AgentSession; keep the unchecked cast named
	// so state mutations are explicit.
	return ctx.session as MutableSessionState;
}

function installClock(start = 1_000) {
	let now = start;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	return {
		advance(ms: number) {
			now += ms;
		},
	};
}

function expectEscapeCancelPrompt(showStatus: Spy, times: number): void {
	expect(showStatus).toHaveBeenCalledTimes(times);
	expect(showStatus).toHaveBeenLastCalledWith(tSettingsUi("Press Esc again within 2s to cancel the active task."));
}

function emitSessionEvent(sessionListeners: Array<(event: { type: string }) => void>, type: string): void {
	for (const listener of sessionListeners) {
		listener({ type });
	}
}
beforeEach(async () => {
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("InputController escape behavior", () => {
	it("requires a confirmed second Esc to cancel a pending optimistic submission and abort the main session", async () => {
		const clock = installClock();
		const { ctx, editor, spies } = createContext();
		const submission = createSubmission({ text: "hello" });
		spies.startPendingSubmission.mockReturnValue(submission);
		spies.cancelPendingSubmission.mockReturnValue(true);
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.("hello");

		expect(spies.startPendingSubmission).toHaveBeenCalledWith({
			text: "hello",
			images: undefined,
			imageLinks: undefined,
			streamingBehavior: "steer",
		});
		expect(spies.onInputCallback).toHaveBeenCalledWith(submission);

		editor.onEscape?.();
		expectEscapeCancelPrompt(spies.showStatus, 1);
		expect(spies.cancelPendingSubmission).not.toHaveBeenCalled();
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();

		clock.advance(500);
		editor.onEscape?.();
		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		expectEscapeCancelPrompt(spies.showStatus, 1);
	});

	it("empty-submit with a queued message aborts the active stream and refreshes pending display", async () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; queuedMessageCount: number }).isStreaming = true;
		(ctx.session as { isStreaming: boolean; queuedMessageCount: number }).queuedMessageCount = 1;
		const order: string[] = [];
		spies.abort.mockImplementation(async () => {
			order.push("abort");
		});
		spies.updatePendingMessagesDisplay.mockImplementation(() => {
			order.push("refresh");
		});
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.("");

		expect(order).toEqual(["abort", "refresh"]);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(spies.requestRender).toHaveBeenCalledTimes(1);
	});
	it("runs /btw as a builtin side request instead of steering the active stream", async () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		editor.setText("/btw why is it doing that?");
		await editor.onSubmit?.("/btw why is it doing that?");

		expect(spies.handleBtwCommand).toHaveBeenCalledWith("why is it doing that?");
		expect(spies.prompt).not.toHaveBeenCalled();
		expect(editor.addToHistory).toHaveBeenCalledWith("/btw why is it doing that?");
		expect(editor.getText()).toBe("");
	});

	it("requires a second Esc to fall back to aborting the active session when no pending optimistic submission exists", () => {
		const clock = installClock();
		const { ctx, editor, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expectEscapeCancelPrompt(spies.showStatus, 1);
		expect(spies.cancelPendingSubmission).not.toHaveBeenCalled();
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();

		clock.advance(500);
		editor.onEscape?.();

		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
		expect(spies.clearQueue).toHaveBeenCalledTimes(1);
		expect(spies.clearQueue).toHaveBeenCalledWith({ forInterrupt: true });
		expect(spies.abort).toHaveBeenCalledTimes(1);
		// The Esc interrupt threads a user-facing reason so the aborted turn and its
		// synthetic tool results read as a deliberate interrupt, not "Request was aborted".
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		expectEscapeCancelPrompt(spies.showStatus, 1);
	});

	it("requires a confirmed second Esc to pause an idle loop, cancel its pending submission, and abort the main session", () => {
		const clock = installClock();
		const { ctx, editor, spies } = createContext();
		const pauseLoop = vi.fn();
		ctx.loopModeEnabled = true;
		ctx.pauseLoop = pauseLoop;
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		spies.cancelPendingSubmission.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expectEscapeCancelPrompt(spies.showStatus, 1);
		expect(pauseLoop).not.toHaveBeenCalled();
		expect(spies.cancelPendingSubmission).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();

		clock.advance(500);
		editor.onEscape?.();

		expect(pauseLoop).toHaveBeenCalledTimes(1);
		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		expectEscapeCancelPrompt(spies.showStatus, 1);
	});

	it("requires a second Esc to abort active handoff generation before default Esc handling", () => {
		const clock = installClock();
		const { ctx, editor, spies } = createContext();
		abortViewSession(ctx).isGeneratingHandoff = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expectEscapeCancelPrompt(spies.showStatus, 1);
		expect(spies.abortHandoff).not.toHaveBeenCalled();
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();

		clock.advance(500);
		editor.onEscape?.();

		expect(spies.abortHandoff).toHaveBeenCalledTimes(1);
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
		expectEscapeCancelPrompt(spies.showStatus, 1);
	});

	it("uses confirmed Esc to stop an async-only session through the global abort", () => {
		const clock = installClock();
		const { ctx, editor, spies } = createContext();
		mutableSessionState(ctx).runningAsyncJobCount = 1;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expectEscapeCancelPrompt(spies.showStatus, 1);
		expect(spies.cancelAsyncJobs).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();

		clock.advance(500);
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
	});

	it("stops an async job and its overlapping main stream through session abort after confirmation", () => {
		const clock = installClock();
		const { ctx, editor, spies } = createContext();
		const session = mutableSessionState(ctx);
		session.runningAsyncJobCount = 1;
		session.isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expectEscapeCancelPrompt(spies.showStatus, 1);
		expect(spies.cancelAsyncJobs).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();

		clock.advance(500);
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
	});

	it("stops bash and its overlapping main stream after confirmed Esc", () => {
		const clock = installClock();
		const { ctx, editor, spies } = createContext();
		const session = mutableSessionState(ctx);
		session.isStreaming = true;
		session.isBashRunning = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expectEscapeCancelPrompt(spies.showStatus, 1);
		expect(spies.abortBash).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();

		clock.advance(500);
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
	});

	it("stops eval and its overlapping main stream after confirmed Esc", () => {
		const clock = installClock();
		const { ctx, editor, spies } = createContext();
		const session = mutableSessionState(ctx);
		session.isStreaming = true;
		session.isEvalRunning = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expectEscapeCancelPrompt(spies.showStatus, 1);
		expect(spies.abortEval).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();

		clock.advance(500);
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
	});
	it("requires a second Esc to pause loop mode and abort its active stream", () => {
		const clock = installClock();
		const { ctx, editor, spies } = createContext();
		const pauseLoop = vi.fn();
		ctx.loopModeEnabled = true;
		ctx.pauseLoop = pauseLoop;
		mutableSessionState(ctx).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expectEscapeCancelPrompt(spies.showStatus, 1);
		expect(pauseLoop).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();

		clock.advance(500);
		editor.onEscape?.();

		expect(pauseLoop).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		expectEscapeCancelPrompt(spies.showStatus, 1);
	});

	it("requires a confirmed second Esc to stop loop mode, compaction, and the main session", () => {
		const clock = installClock();
		const { ctx, editor, spies } = createContext();
		const pauseLoop = vi.fn();
		const viewSession = abortViewSession(ctx);
		ctx.loopModeEnabled = true;
		ctx.pauseLoop = pauseLoop;
		viewSession.isCompacting = true;
		viewSession.abortCompaction = vi.fn();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expectEscapeCancelPrompt(spies.showStatus, 1);
		expect(pauseLoop).not.toHaveBeenCalled();
		expect(viewSession.abortCompaction).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();

		clock.advance(500);
		editor.onEscape?.();

		expect(pauseLoop).toHaveBeenCalledTimes(1);
		expect(viewSession.abortCompaction).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		expectEscapeCancelPrompt(spies.showStatus, 1);
	});

	it("dismisses an active /btw panel before aborting the main stream", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("dismisses an active /btw panel before canceling a pending optimistic submission", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.cancelPendingSubmission).not.toHaveBeenCalled();
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("dismisses an active /btw panel before aborting bash", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isBashRunning: boolean }).isBashRunning = true;
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.abortBash).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("dismisses an active /btw panel before aborting loop mode", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loopModeEnabled = true;
		mutableSessionState(ctx).isStreaming = true;
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
		expect(ctx.loopModeEnabled).toBe(true);
	});

	it("dismisses an active /btw panel before aborting maintenance", () => {
		const { ctx, editor, spies } = createContext();
		abortViewSession(ctx).isGeneratingHandoff = true;
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.abortHandoff).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("requires a second Esc to abort an active streaming turn", () => {
		const clock = installClock();
		const { ctx, editor, spies } = createContext();
		mutableSessionState(ctx).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expectEscapeCancelPrompt(spies.showStatus, 1);
		expect(spies.abort).not.toHaveBeenCalled();

		clock.advance(500);
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		expectEscapeCancelPrompt(spies.showStatus, 1);
	});

	it("does not count a Kitty Esc release as the confirming press", () => {
		const clock = installClock();
		const { ctx, editor, spies, inputListeners } = createContext();
		mutableSessionState(ctx).isStreaming = true;
		const controller = new InputController(ctx);

		setKittyProtocolActive(true);
		try {
			controller.setupKeyHandlers();
			const dispatchInput = (data: string) => {
				for (const listener of inputListeners) {
					const result = listener(data);
					if (result) return result;
				}
				return undefined;
			};

			expect(dispatchInput("\x1b[27u")).toBeUndefined();
			editor.onEscape?.();
			expectEscapeCancelPrompt(spies.showStatus, 1);
			expect(spies.abort).not.toHaveBeenCalled();

			expect(dispatchInput("\x1b[27;1:3u")).toBeUndefined();
			expectEscapeCancelPrompt(spies.showStatus, 1);
			expect(spies.abort).not.toHaveBeenCalled();

			clock.advance(500);
			expect(dispatchInput("\x1b[27u")).toEqual({ consume: true });
			expect(spies.abort).toHaveBeenCalledTimes(1);
			expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		} finally {
			setKittyProtocolActive(false);
		}
	});

	it("carries the same main-task confirmation from optimistic loading into streaming", async () => {
		const clock = installClock();
		const { ctx, editor, spies } = createContext();
		const submission = createSubmission({ text: "fix issue #4921" });
		spies.startPendingSubmission.mockReturnValue(submission);
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.("fix issue #4921");

		editor.onEscape?.();

		expectEscapeCancelPrompt(spies.showStatus, 1);
		expect(spies.cancelPendingSubmission).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();

		mutableSessionState(ctx).isStreaming = true;
		ctx.loadingAnimation = undefined;
		clock.advance(500);
		editor.onEscape?.();

		expect(spies.cancelPendingSubmission).not.toHaveBeenCalled();
		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		expectEscapeCancelPrompt(spies.showStatus, 1);
	});

	it("returns focused subagent view to main on Esc instead of aborting", () => {
		const { ctx, editor, spies } = createContext();
		Object.defineProperty(ctx, "focusedAgentId", { value: "Worker", configurable: true });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(ctx.unfocusSession).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("stops the main stream on the next Esc after leaving a focused subagent overlay", () => {
		const clock = installClock();
		const { ctx, editor, spies } = createContext();
		Object.defineProperty(ctx, "focusedAgentId", { value: "Worker", configurable: true });
		mutableSessionState(ctx).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(ctx.unfocusSession).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();

		Object.defineProperty(ctx, "focusedAgentId", { value: undefined, configurable: true });
		clock.advance(500);
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
	});

	it("returns focused subagent view to main on Esc without aborting its active maintenance (#2819)", () => {
		const { ctx, editor, spies } = createContext();
		Object.defineProperty(ctx, "focusedAgentId", { value: "Worker", configurable: true });
		(ctx.viewSession as { isCompacting: boolean }).isCompacting = true;
		(ctx.viewSession as { isGeneratingHandoff: boolean }).isGeneratingHandoff = true;
		(ctx.viewSession as { isRetrying: boolean }).isRetrying = true;
		(ctx.viewSession as unknown as { abortCompaction: Spy }).abortCompaction = vi.fn();
		(ctx.viewSession as unknown as { abortHandoff: Spy }).abortHandoff = spies.abortHandoff;
		(ctx.viewSession as unknown as { abortRetry: Spy }).abortRetry = vi.fn();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(ctx.unfocusSession).toHaveBeenCalledTimes(1);
		expect(ctx.viewSession.abortCompaction as unknown as Spy).not.toHaveBeenCalled();
		expect(spies.abortHandoff).not.toHaveBeenCalled();
		expect(ctx.viewSession.abortRetry as unknown as Spy).not.toHaveBeenCalled();
	});

	it("requires a second Esc to abort main-view maintenance", () => {
		const clock = installClock();
		const { ctx, editor, spies } = createContext();
		// Not focused:
		expect(ctx.focusedAgentId).toBeUndefined();
		const viewSession = abortViewSession(ctx);
		viewSession.isCompacting = true;
		viewSession.isGeneratingHandoff = true;
		viewSession.isRetrying = true;
		viewSession.abortCompaction = vi.fn();
		viewSession.abortHandoff = spies.abortHandoff;
		viewSession.abortRetry = vi.fn();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expectEscapeCancelPrompt(spies.showStatus, 1);
		expect(ctx.unfocusSession).not.toHaveBeenCalled();
		expect(viewSession.abortCompaction).not.toHaveBeenCalled();
		expect(spies.abortHandoff).not.toHaveBeenCalled();
		expect(viewSession.abortRetry).not.toHaveBeenCalled();

		clock.advance(500);
		editor.onEscape?.();

		expect(ctx.unfocusSession).not.toHaveBeenCalled();
		expect(viewSession.abortCompaction).toHaveBeenCalledTimes(1);
		expect(spies.abortHandoff).toHaveBeenCalledTimes(1);
		expect(viewSession.abortRetry).toHaveBeenCalledTimes(1);
		expectEscapeCancelPrompt(spies.showStatus, 1);
	});

	it.each([
		{ lifecycle: "compaction", state: "isCompacting" },
		{ lifecycle: "handoff", state: "isGeneratingHandoff" },
		{ lifecycle: "retry", state: "isRetrying" },
	] as const)(
		"requires a confirmed second Esc to cancel main-session $lifecycle and abort its turn despite a separate view session",
		({ lifecycle, state }) => {
			const clock = installClock();
			const { ctx, editor, spies } = createContext();
			const session = mutableSessionState(ctx);
			const viewSession = abortViewSession(ctx);
			session[state] = true;
			const mainMaintenanceAborts = {
				compaction: spies.abortMainCompaction,
				handoff: spies.abortMainHandoff,
				retry: spies.abortMainRetry,
			};
			const controller = new InputController(ctx);

			controller.setupKeyHandlers();
			editor.onEscape?.();

			expectEscapeCancelPrompt(spies.showStatus, 1);
			for (const abortMaintenance of Object.values(mainMaintenanceAborts)) {
				expect(abortMaintenance).not.toHaveBeenCalled();
			}
			expect(viewSession.abortCompaction).not.toHaveBeenCalled();
			expect(viewSession.abortHandoff).not.toHaveBeenCalled();
			expect(viewSession.abortRetry).not.toHaveBeenCalled();
			expect(spies.abort).not.toHaveBeenCalled();

			clock.advance(500);
			editor.onEscape?.();

			expect(mainMaintenanceAborts[lifecycle]).toHaveBeenCalledTimes(1);
			for (const [otherLifecycle, abortMaintenance] of Object.entries(mainMaintenanceAborts)) {
				if (otherLifecycle !== lifecycle) expect(abortMaintenance).not.toHaveBeenCalled();
			}
			expect(viewSession.abortCompaction).not.toHaveBeenCalled();
			expect(viewSession.abortHandoff).not.toHaveBeenCalled();
			expect(viewSession.abortRetry).not.toHaveBeenCalled();
			expect(spies.abort).toHaveBeenCalledTimes(1);
			expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
			expectEscapeCancelPrompt(spies.showStatus, 1);
		},
	);

	it("re-prompts instead of canceling when the second Esc arrives after the 2s confirmation window", () => {
		const clock = installClock();
		const { ctx, editor, spies } = createContext();
		mutableSessionState(ctx).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expectEscapeCancelPrompt(spies.showStatus, 1);
		expect(spies.abort).not.toHaveBeenCalled();

		clock.advance(2_001);
		editor.onEscape?.();

		expect(spies.abort).not.toHaveBeenCalled();
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expectEscapeCancelPrompt(spies.showStatus, 2);

		clock.advance(500);
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		expectEscapeCancelPrompt(spies.showStatus, 2);
	});

	it("clears an armed main-task confirmation on agent_end so the next streaming turn needs its own first Esc", () => {
		const clock = installClock();
		const { ctx, editor, spies, sessionListeners } = createContext();
		mutableSessionState(ctx).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expectEscapeCancelPrompt(spies.showStatus, 1);
		expect(spies.abort).not.toHaveBeenCalled();

		mutableSessionState(ctx).isStreaming = false;
		emitSessionEvent(sessionListeners, "agent_end");
		clock.advance(100);
		mutableSessionState(ctx).isStreaming = true;
		editor.onEscape?.();

		expect(spies.abort).not.toHaveBeenCalled();
		expectEscapeCancelPrompt(spies.showStatus, 2);
	});

	it("does not let a settled active-task confirmation trigger a selector action on later Esc presses by default", () => {
		const clock = installClock();
		const { ctx, editor, spies } = createContext();
		mutableSessionState(ctx).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expectEscapeCancelPrompt(spies.showStatus, 1);
		mutableSessionState(ctx).isStreaming = false;
		clock.advance(100);
		editor.onEscape?.();

		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
		expect(spies.resetDisplay).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();

		clock.advance(100);
		editor.onEscape?.();

		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
		expect(spies.resetDisplay).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("keeps global cancellation armed when the active local surface changes", () => {
		const clock = installClock();
		const { ctx, editor, spies } = createContext();
		const session = mutableSessionState(ctx);
		session.isBashRunning = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expectEscapeCancelPrompt(spies.showStatus, 1);
		expect(spies.abort).not.toHaveBeenCalled();

		session.isBashRunning = false;
		session.isEvalRunning = true;
		clock.advance(100);
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
	});

	it("logs abort failures while treating maintenance Esc as handled after confirmation", () => {
		const clock = installClock();
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const { ctx, editor, spies } = createContext();
		const viewSession = abortViewSession(ctx);
		viewSession.isCompacting = true;
		viewSession.isGeneratingHandoff = true;
		viewSession.isRetrying = true;
		viewSession.abortCompaction = vi.fn(() => {
			throw new Error("compaction boom");
		});
		viewSession.abortHandoff = vi.fn(() => {
			throw new Error("handoff boom");
		});
		viewSession.abortRetry = vi.fn(() => {
			throw new Error("retry boom");
		});
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expectEscapeCancelPrompt(spies.showStatus, 1);
		expect(viewSession.abortCompaction).not.toHaveBeenCalled();
		expect(viewSession.abortHandoff).not.toHaveBeenCalled();
		expect(viewSession.abortRetry).not.toHaveBeenCalled();
		expect(debugSpy).not.toHaveBeenCalled();

		clock.advance(500);
		editor.onEscape?.();

		expect(viewSession.abortCompaction).toHaveBeenCalledTimes(1);
		expect(viewSession.abortHandoff).toHaveBeenCalledTimes(1);
		expect(viewSession.abortRetry).toHaveBeenCalledTimes(1);
		expect(debugSpy).toHaveBeenCalledWith("Failed to abort compaction", { error: "compaction boom" });
		expect(debugSpy).toHaveBeenCalledWith("Failed to abort handoff", { error: "handoff boom" });
		expect(debugSpy).toHaveBeenCalledWith("Failed to abort retry", { error: "retry boom" });
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("returns a focused subagent view to Main before opening the Agent Hub on double-←", async () => {
		const now = vi.spyOn(Date, "now");
		const { ctx, inputListeners } = createContext();
		Object.defineProperty(ctx, "focusedAgentId", { value: "Worker", configurable: true });
		ctx.lastLeftTapTime = 0;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		now.mockReturnValue(2_000);
		const first = inputListeners[0]("\x1b[D");
		now.mockReturnValue(2_200); // 200ms later — a deliberate second tap
		const second = inputListeners[0]("\x1b[D");
		await Promise.resolve();

		// Both taps are consumed; the completed gesture returns to Main before showing the hub.
		expect(first).toEqual({ consume: true });
		expect(second).toEqual({ consume: true });
		expect(ctx.unfocusSession).toHaveBeenCalledTimes(1);
		expect(ctx.showAgentHub).toHaveBeenCalledWith({ armCloseTap: true });
		expect(ctx.focusParentSession).not.toHaveBeenCalled();
	});
	it("does not open tree or branch or clear the display on default double-Esc", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();
		editor.onEscape?.();

		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
		expect(spies.resetDisplay).not.toHaveBeenCalled();
	});

	it("opens the tree selector and clears the display when double-Esc is configured for tree", () => {
		Settings.instance.override("doubleEscapeAction", "tree");
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();
		editor.onEscape?.();

		expect(ctx.showTreeSelector).toHaveBeenCalledTimes(1);
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
		expect(spies.resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("opens the message selector and clears the display when double-Esc is configured for branch", () => {
		Settings.instance.override("doubleEscapeAction", "branch");
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();
		editor.onEscape?.();

		expect(ctx.showUserMessageSelector).toHaveBeenCalledTimes(1);
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(spies.resetDisplay).toHaveBeenCalledTimes(1);
	});
	it("preserves typed editor text on Esc without opening selectors or aborting", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft message");
		editor.onEscape?.();

		expect(editor.getText()).toBe("draft message");
		expect(spies.requestRender).not.toHaveBeenCalled();
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
		expect(spies.resetDisplay).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("does not treat the Esc after a text-preserving Esc as a double-Esc", () => {
		const { ctx, editor } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.(); // empty editor: arms double-Esc timer
		editor.setText("draft");
		editor.onEscape?.(); // preserves text, must also reset the timer
		editor.setText("");
		editor.onEscape?.(); // empty again: should only re-arm, not trigger

		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
	});

	it("silences TTS on the first Esc without aborting an overlapping agent turn (#6118)", () => {
		const clear = vi.spyOn(vocalizer, "clear").mockImplementation(() => {});
		vi.spyOn(vocalizer, "isSpeaking").mockReturnValue(true);
		const { ctx, editor, spies } = createContext();
		const pauseLoop = vi.fn();
		ctx.loopModeEnabled = true;
		ctx.pauseLoop = pauseLoop;
		mutableSessionState(ctx).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(clear).toHaveBeenCalledTimes(1);
		expect(pauseLoop).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("stops the overlapping main stream on the next Esc after silencing TTS", () => {
		const clock = installClock();
		const clear = vi.spyOn(vocalizer, "clear").mockImplementation(() => {});
		const isSpeaking = vi.spyOn(vocalizer, "isSpeaking").mockReturnValue(true);
		const { ctx, editor, spies } = createContext();
		mutableSessionState(ctx).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(clear).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();

		isSpeaking.mockReturnValue(false);
		clock.advance(500);
		editor.onEscape?.();

		expect(clear).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
	});

	it("silences a still-audible vocalizer on Esc instead of opening the tree selector (#4521)", () => {
		const clear = vi.spyOn(vocalizer, "clear").mockImplementation(() => {});
		const isSpeaking = vi.spyOn(vocalizer, "isSpeaking").mockReturnValue(true);
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(clear).toHaveBeenCalledTimes(1);
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
		expect(spies.resetDisplay).not.toHaveBeenCalled();

		// A second Esc after silence must NOT immediately fire the double-Esc
		// gesture — the first press consumed the arm.
		isSpeaking.mockReturnValue(false);
		editor.onEscape?.();
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
	});
});

describe("InputController Ctrl+C behavior", () => {
	it("sync-flushes the session JSONL on first Ctrl+C (editor clear)", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onClear?.(); // first Ctrl+C: clears editor

		expect(spies.clearEditor).toHaveBeenCalledTimes(1);
		expect(spies.flushSync).toHaveBeenCalledTimes(1);
		expect(spies.shutdown).not.toHaveBeenCalled();
	});

	it("sync-flushes the session JSONL on second Ctrl+C (shutdown)", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onClear?.(); // first Ctrl+C
		editor.onClear?.(); // second Ctrl+C within 500ms → shutdown

		expect(spies.shutdown).toHaveBeenCalledTimes(1);
		// flushSync fires on both presses; the first-press flush is the
		// guarantee that the JSONL is on disk even if the user closes the
		// terminal before the second press.
		expect(spies.flushSync).toHaveBeenCalledTimes(2);
	});

	it("does not flush when Ctrl+C is not pressed", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.(); // Esc is a different handler

		expect(spies.flushSync).not.toHaveBeenCalled();
	});
});

describe("InputController double-tap ← gesture", () => {
	function setup(focusedAgentId?: string) {
		const { ctx, editor } = createContext();
		(ctx as { lastLeftTapTime: number }).lastLeftTapTime = 0;
		(ctx as { focusedAgentId?: string }).focusedAgentId = focusedAgentId;
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		return {
			ctx,
			showAgentHub: ctx.showAgentHub as Spy,
			unfocusSession: ctx.unfocusSession as Spy,
			tap: () => editor.onLeftAtStart?.(),
		};
	}

	it("opens the Agent Hub on a deliberate double-tap", () => {
		const now = vi.spyOn(Date, "now");
		const { showAgentHub, tap } = setup();
		now.mockReturnValue(1_000);
		tap();
		now.mockReturnValue(1_200); // 200ms later — a human double-tap
		tap();
		expect(showAgentHub).toHaveBeenCalledWith({ armCloseTap: true });
	});

	it("ignores a terminal-synthesized burst of ← arrows arriving together", () => {
		const now = vi.spyOn(Date, "now");
		const { showAgentHub, tap } = setup();
		// A "click to move cursor" burst delivers every arrow in one stdin read,
		// so all taps share the same millisecond timestamp.
		now.mockReturnValue(1_000);
		for (let i = 0; i < 6; i++) tap();
		expect(showAgentHub).not.toHaveBeenCalled();
	});

	it("ignores a second tap closer than the human-plausible minimum gap", () => {
		const now = vi.spyOn(Date, "now");
		const { showAgentHub, tap } = setup();
		now.mockReturnValue(1_000);
		tap();
		now.mockReturnValue(1_010); // 10ms later — too fast to be deliberate
		tap();
		expect(showAgentHub).not.toHaveBeenCalled();
	});

	it("opens the Agent Hub after returning a focused subagent view to Main", async () => {
		const now = vi.spyOn(Date, "now");
		const { showAgentHub, unfocusSession, tap } = setup("Agent1");
		now.mockReturnValue(1_000);
		tap();
		now.mockReturnValue(1_200);
		tap();
		await Promise.resolve();
		expect(unfocusSession).toHaveBeenCalledTimes(1);
		expect(showAgentHub).toHaveBeenCalledWith({ armCloseTap: true });
	});
});
