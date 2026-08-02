import { describe, expect, it, type Mock, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { type KeyId, matchesKey } from "@oh-my-pi/pi-tui";
import manualContinuePrompt from "../src/prompts/system/manual-continue.md" with { type: "text" };

type FakeEditor = {
	onEscape?: () => void;
	onClear?: () => void;
	onExit?: () => void;
	onDisplayReset?: () => void;
	onSuspend?: () => void;
	onCycleThinkingLevel?: () => void;
	onCycleModelForward?: () => void;
	onCycleModelBackward?: () => void;
	onSelectModelTemporary?: () => void;
	onSelectModel?: () => void;
	onHistorySearch?: () => void;
	onPasteImage?: () => Promise<boolean>;
	onCopyPrompt?: () => void;
	onExpandTools?: () => void;
	onToggleThinking?: () => void;
	onExternalEditor?: () => void;
	onRetry?: () => void;
	onChange?: (text: string) => void;
	onSubmit?: (text: string) => Promise<void>;
	setText(text: string): void;
	getText(): string;
	getExpandedText(): string;
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
	pasteText(text: string): void;
	imageLinks?: (string | undefined)[];
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
	clearDraft(historyText?: string): void;
};

type InputListenerResult = { consume: boolean } | undefined;
type InputListener = (data: string) => InputListenerResult;

function dispatchInput(listeners: InputListener[], data: string): InputListenerResult {
	for (const listener of listeners) {
		const result = listener(data);
		if (result) return result;
	}
	return undefined;
}

function registeredInputListeners(addInputListener: Mock<(listener: InputListener) => void>): InputListener[] {
	return addInputListener.mock.calls.map(call => call[0]);
}

type PendingSubmissionInput = {
	text: string;
	images?: ImageContent[];
	imageLinks?: (string | undefined)[];
	streamingBehavior?: "steer" | "followUp";
};

type ImageDraft = {
	text: string;
	images: ImageContent[];
	imageLinks: (string | undefined)[];
};

function createDetachedEditor(initialText = ""): FakeEditor {
	let text = initialText;
	return {
		setText(value: string) {
			text = value;
		},
		getText() {
			return text;
		},
		getExpandedText() {
			return text;
		},
		addToHistory: vi.fn(),
		pasteText(value: string) {
			text += value;
		},
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
		pendingImages: [],
		pendingImageLinks: [],
		clearDraft(historyText?: string) {
			if (historyText !== undefined) this.addToHistory(historyText);
			this.setText("");
			this.imageLinks = undefined;
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
	};
}

async function createSendToNewSessionHarness() {
	const base = await createContext();
	const { ctx, editor } = base;
	const mutableCtx = ctx as unknown as {
		editor: FakeEditor;
		session: unknown;
		viewSession: unknown;
		activeTopLevelId: string;
		sessionManager: { putBlob: (data: Buffer, options?: { extension?: string }) => Promise<unknown> };
		startPendingSubmission: (input: PendingSubmissionInput) => unknown;
		onInputCallback?: (input: unknown) => void;
		startNewTopLevelRuntime: () => Promise<boolean | undefined>;
		switchTopLevel: (id: string) => Promise<void>;
	};
	const oldId = "old-runtime";
	const targetId = "target-runtime";
	const oldSession = mutableCtx.session;
	const oldManager = {
		putBlob: vi.fn(async () => ({ displayPath: "old://draft-image" })),
	};
	const targetEditor = createDetachedEditor();
	const targetPrompt = vi.fn(async () => {});
	const targetSession = { prompt: targetPrompt };
	const targetLinks = ["target://image-one", "target://image-two"];
	let targetLinkIndex = 0;
	const targetManager = {
		putBlob: vi.fn(async () => ({ displayPath: targetLinks[targetLinkIndex++] })),
	};
	const startPendingSubmission = vi.fn((input: PendingSubmissionInput) => ({
		...input,
		cancelled: false,
		started: true,
	}));
	const onInputCallback = vi.fn();
	const startNewTopLevelRuntime = vi.fn(async () => {
		editor.setText("editor replaced during runtime attach");
		editor.pendingImages = [];
		editor.pendingImageLinks = ["discarded://during-attach"];
		editor.imageLinks = ["discarded://during-attach"];
		mutableCtx.editor = targetEditor;
		mutableCtx.session = targetSession;
		mutableCtx.viewSession = targetSession;
		mutableCtx.sessionManager = targetManager;
		mutableCtx.activeTopLevelId = targetId;
		return true;
	});
	const switchTopLevel = vi.fn(async (id: string) => {
		if (id !== oldId) throw new Error(`unexpected top-level runtime: ${id}`);
		mutableCtx.editor = editor;
		mutableCtx.session = oldSession;
		mutableCtx.viewSession = oldSession;
		mutableCtx.sessionManager = oldManager;
		mutableCtx.activeTopLevelId = oldId;
	});

	Object.assign(mutableCtx, {
		activeTopLevelId: oldId,
		sessionManager: oldManager,
		startPendingSubmission,
		onInputCallback,
		startNewTopLevelRuntime,
		switchTopLevel,
	});

	return {
		...base,
		mutableCtx,
		oldId,
		targetId,
		targetEditor,
		targetLinks,
		targetManager,
		targetPrompt,
		startPendingSubmission,
		onInputCallback,
		startNewTopLevelRuntime,
		switchTopLevel,
	};
}

function seedImageDraft(editor: FakeEditor): ImageDraft {
	const images: ImageContent[] = [
		{ type: "image", mimeType: "image/png", data: "aW1hZ2Utb25l" },
		{ type: "image", mimeType: "image/webp", data: "aW1hZ2UtdHdv" },
	];
	const imageLinks = ["old://image-one", undefined];
	editor.setText("review https://example.com/diagram.png");
	editor.pendingImages = [...images];
	editor.pendingImageLinks = [...imageLinks];
	editor.imageLinks = [...imageLinks];
	return { text: editor.getText(), images, imageLinks };
}

function expectImageDraft(editor: FakeEditor, draft: ImageDraft): void {
	expect(editor.getText()).toBe(draft.text);
	expect(editor.pendingImages).toEqual(draft.images);
	expect(editor.pendingImageLinks).toEqual(draft.imageLinks);
	expect(editor.imageLinks).toEqual(draft.imageLinks);
}

async function createContext() {
	let editorText = "";
	const keyMap: Record<string, KeyId[]> = {
		"app.display.reset": ["ctrl+l"],
		"app.model.selectTemporary": ["ctrl+y"],
		"app.model.select": ["alt+m"],
		"app.session.sendToNew": ["alt+n"],
		"app.retry": ["alt+r"],
		"app.clipboard.pasteImage": ["ctrl+v"],
	};
	const customHandlers = new Map<string, () => void>();
	const setActionKeys = vi.fn();
	const setCustomKeyHandler = vi.fn((key: string, handler: () => void) => {
		customHandlers.set(key, handler);
	});
	const clearCustomKeyHandlers = vi.fn(() => {
		customHandlers.clear();
	});
	const resetDisplay = vi.fn();
	const showModelSelector = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();
	let focused: unknown;
	const addInputListener = vi.fn((listener: InputListener) => {
		void listener;
	});
	const addStartListener = vi.fn();
	const terminalWrite = vi.fn();
	const refreshAppearance = vi.fn();
	const resetDisplayAfterAppearanceRefresh = vi.fn(() => {
		refreshAppearance();
		resetDisplay();
	});
	const prompt = vi.fn(async () => {});
	const retry = vi.fn(async () => true);
	const abort = vi.fn(async () => {});
	const session = {
		isStreaming: false,
		isCompacting: false,
		isGeneratingHandoff: false,
		isBashRunning: false,
		isEvalRunning: false,
		extensionRunner: undefined,
		subscribe: vi.fn(() => () => {}),
		prompt,
		queuedMessageCount: 0,
		abort,
		retry,
	};
	const updatePendingMessagesDisplay = vi.fn();
	const handleBtwBranchKey = vi.fn(async () => true);
	const handleBtwCopyKey = vi.fn(async () => true);
	const canBranchBtw = vi.fn(() => false);
	const canCopyBtw = vi.fn(() => false);
	const editor: FakeEditor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		getExpandedText() {
			return editorText;
		},
		addToHistory: vi.fn(),
		pasteText(text: string) {
			editorText += text;
		},
		setActionKeys,
		setCustomKeyHandler,
		clearCustomKeyHandlers,
		pendingImages: [],
		pendingImageLinks: [],
		clearDraft(historyText?: string) {
			if (historyText !== undefined) this.addToHistory(historyText);
			this.setText("");
			this.imageLinks = undefined;
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
	};
	focused = editor;
	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		resetDisplayAfterAppearanceRefresh,
		ui: {
			requestRender,
			resetDisplay,
			addInputListener,
			addStartListener,
			getFocused: vi.fn(() => focused),
			terminal: { write: terminalWrite, refreshAppearance },
		} as unknown as InteractiveModeContext["ui"],
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		autoCompactionEscapeHandler: undefined,
		retryEscapeHandler: undefined,
		session: session as unknown as InteractiveModeContext["session"],
		viewSession: session as unknown as InteractiveModeContext["viewSession"],
		keybindings: {
			getKeys(action: string) {
				return keyMap[action] ? [...keyMap[action]] : [];
			},
			matches(data: string, action: string) {
				return keyMap[action]?.some(key => matchesKey(data, key)) ?? false;
			},
		} as InteractiveModeContext["keybindings"],
		locallySubmittedUserSignatures: new Set<string>(),
		isKnownSlashCommand: () => false,
		recordLocalSubmission(this: InteractiveModeContext, text: string, imageCount = 0) {
			if (this.isKnownSlashCommand(text)) return () => {};
			const sig = `${text}\u0000${imageCount}`;
			this.locallySubmittedUserSignatures.add(sig);
			let disposed = false;
			return () => {
				if (disposed) return;
				disposed = true;
				this.locallySubmittedUserSignatures.delete(sig);
			};
		},
		async withLocalSubmission<T>(
			this: InteractiveModeContext,
			text: string,
			fn: () => Promise<T>,
			options?: { imageCount?: number },
		): Promise<T> {
			const dispose = this.recordLocalSubmission(text, options?.imageCount ?? 0);
			try {
				return await fn();
			} catch (err) {
				dispose();
				throw err;
			}
		},
		updatePendingMessagesDisplay,
		isBashMode: false,
		isPythonMode: false,
		handleHotkeysCommand: vi.fn(),
		handlePlanModeCommand: vi.fn(),
		handleClearCommand: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		handleSTTToggle: vi.fn(),
		showDebugSelector: vi.fn(),
		showHistorySearch: vi.fn(),
		toggleThinkingBlockVisibility: vi.fn(),
		showModelSelector,
		updateEditorBorderColor: vi.fn(),
		hasActiveBtw: vi.fn(() => false),
		handleBtwBranchKey,
		canBranchBtw,
		canCopyBtw,
		handleBtwCopyKey,
		showError,
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;

	return {
		InputController,
		ctx,
		editor,
		keyMap,
		customHandlers,
		setFocused(target: unknown) {
			focused = target;
		},
		spies: {
			setActionKeys,
			showModelSelector,
			prompt,
			updatePendingMessagesDisplay,
			requestRender,
			retry,
			abort,
			resetDisplay,
			refreshAppearance,
			resetDisplayAfterAppearanceRefresh,
			handleBtwBranchKey,
			canBranchBtw,
			handleBtwCopyKey,
			canCopyBtw,
			addInputListener,
			showError,
		},
	};
}

describe("InputController keybinding setup", () => {
	it("registers model selector and display reset actions separately", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		expect(spies.setActionKeys).toHaveBeenCalledWith("app.display.reset", ["ctrl+l"]);
		expect(spies.setActionKeys).toHaveBeenCalledWith("app.model.selectTemporary", ["ctrl+y"]);
		expect(spies.setActionKeys).toHaveBeenCalledWith("app.model.select", ["alt+m"]);
		expect(editor.onDisplayReset).toBeDefined();
		expect(editor.onSelectModelTemporary).toBeDefined();
		expect(editor.onSelectModel).toBeDefined();
		expect(editor.onSelectModelTemporary).not.toBe(editor.onSelectModel);

		editor.onDisplayReset?.();
		editor.onSelectModelTemporary?.();
		editor.onSelectModel?.();

		expect(spies.showModelSelector).toHaveBeenNthCalledWith(1, { temporaryOnly: true });
		expect(spies.showModelSelector).toHaveBeenNthCalledWith(2);
		expect(spies.resetDisplayAfterAppearanceRefresh).toHaveBeenCalledTimes(1);
	});

	it("routes configurable agent-cycle shortcuts to next and previous focus changes", async () => {
		const { InputController, ctx, customHandlers, keyMap } = await createContext();
		const cycleAgentSession = vi.fn(async (_direction: "next" | "previous") => {});
		keyMap["app.agents.next"] = ["ctrl+n"];
		keyMap["app.agents.previous"] = ["ctrl+p", "shift+tab"];
		ctx.cycleAgentSession = cycleAgentSession;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		expect(customHandlers.has("ctrl+n")).toBe(true);
		expect(customHandlers.has("ctrl+p")).toBe(true);
		expect(customHandlers.has("shift+tab")).toBe(true);
		expect(customHandlers.has("alt+j")).toBe(false);
		expect(customHandlers.has("alt+k")).toBe(false);

		customHandlers.get("ctrl+n")?.();
		customHandlers.get("shift+tab")?.();

		expect(cycleAgentSession.mock.calls).toEqual([["next"], ["previous"]]);
	});

	it("does not mark pasted shell prompts as Python mode while editing", async () => {
		const { InputController, ctx, editor } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		editor.onChange?.("$ cd ~/project && sudo ./build-and-push.sh o5.7 2>&1 | tail -4");

		expect(ctx.isPythonMode).toBe(false);
		expect(ctx.updateEditorBorderColor).not.toHaveBeenCalled();

		editor.onChange?.("$ print(1)");

		expect(ctx.isPythonMode).toBe(true);
		expect(ctx.updateEditorBorderColor).toHaveBeenCalledTimes(1);
	});

	it("registers retry as an editor action and retries the failed turn", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		expect(spies.setActionKeys).toHaveBeenCalledWith("app.retry", ["alt+r"]);
		expect(editor.onRetry).toBeDefined();

		editor.setText("draft that should clear after retry");
		editor.onRetry?.();
		await Promise.resolve();

		expect(spies.retry).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});

	it("retries the focused view session instead of the main session", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const focusedRetry = vi.fn(async () => true);
		(ctx as unknown as { focusedAgentId: string; viewSession: { retry: typeof focusedRetry } }).focusedAgentId =
			"worker";
		(ctx as unknown as { viewSession: { retry: typeof focusedRetry } }).viewSession = { retry: focusedRetry };
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onRetry?.();
		await Promise.resolve();

		expect(focusedRetry).toHaveBeenCalledTimes(1);
		expect(spies.retry).not.toHaveBeenCalled();
	});

	it("keeps retry host-only for collab guests", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const showStatus = ctx.showStatus as unknown as Mock<(message: string) => void>;
		(ctx as unknown as { collabGuest: { readOnly: boolean } }).collabGuest = { readOnly: true };
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("guest draft");
		editor.onRetry?.();
		await Promise.resolve();

		expect(spies.retry).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("/retry is host-only during a collab session");
		expect(editor.getText()).toBe("guest draft");
	});

	it("keeps the draft when there is nothing to retry", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		spies.retry.mockResolvedValueOnce(false);
		const showStatus = ctx.showStatus as unknown as Mock<(message: string) => void>;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft that should survive");
		editor.onRetry?.();
		await Promise.resolve();

		expect(showStatus).toHaveBeenCalledWith("Nothing to retry");
		expect(editor.getText()).toBe("draft that should survive");
	});

	it("clears retry draft attachments only after retry starts", async () => {
		const { InputController, ctx, editor } = await createContext();
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "abc" };
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		ctx.editor.pendingImages = [image];
		ctx.editor.pendingImageLinks = ["local://draft.png"];
		editor.imageLinks = ctx.editor.pendingImageLinks;
		editor.setText("draft with image");
		editor.onRetry?.();
		await Promise.resolve();

		expect(ctx.editor.pendingImages).toEqual([]);
		expect(ctx.editor.pendingImageLinks).toEqual([]);
		expect(editor.imageLinks).toBeUndefined();
		expect(editor.getText()).toBe("");
	});

	it("routes b to branch a branchable /btw panel", async () => {
		const { InputController, ctx, spies } = await createContext();
		(ctx.canBranchBtw as unknown as { mockReturnValue(value: boolean): void }).mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "b");

		expect(result).toEqual({ consume: true });
		expect(spies.handleBtwBranchKey).toHaveBeenCalledTimes(1);
	});

	it("lets b fall through while the editor has draft text", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		(ctx.canBranchBtw as unknown as { mockReturnValue(value: boolean): void }).mockReturnValue(true);
		editor.setText("build a branch");
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "b");

		expect(result).toBeUndefined();
		expect(spies.handleBtwBranchKey).not.toHaveBeenCalled();
	});

	it("lets b fall through when /btw is not branchable", async () => {
		const { InputController, ctx, spies } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "b");

		expect(result).toBeUndefined();
		expect(spies.handleBtwBranchKey).not.toHaveBeenCalled();
	});

	it("lets b fall through while another input is focused", async () => {
		const { InputController, ctx, setFocused, spies } = await createContext();
		(ctx.canBranchBtw as unknown as { mockReturnValue(value: boolean): void }).mockReturnValue(true);
		setFocused({ pasteText: vi.fn() });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "b");

		expect(result).toBeUndefined();
		expect(spies.handleBtwBranchKey).not.toHaveBeenCalled();
	});

	it("routes the smart-paste shortcut to a focused login input", async () => {
		const { promise: pasted, resolve: resolvePaste } = Promise.withResolvers<string>();
		const focusedPasteText = vi.fn((text: string) => {
			resolvePaste(text);
		});
		const { InputController, ctx, setFocused, spies } = await createContext();
		setFocused({ pasteText: focusedPasteText });
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "sk-test-key",
		});

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "\x16");

		expect(result).toEqual({ consume: true });
		expect(await pasted).toBe("sk-test-key");
		expect(focusedPasteText).toHaveBeenCalledWith("sk-test-key");
	});

	it("rejects image smart-paste while a login input is focused instead of mutating the hidden editor", async () => {
		const focusedPasteText = vi.fn();
		const { InputController, ctx, editor, setFocused, spies } = await createContext();
		setFocused({ pasteText: focusedPasteText });
		const { promise: rejected, resolve: resolveRejected } = Promise.withResolvers<string>();
		(ctx.showStatus as unknown as Mock<(message: string) => void>).mockImplementation(message => {
			resolveRejected(message);
		});
		const controller = new InputController(ctx, {
			readImage: async () => ({ data: new Uint8Array([0x89, 0x50]), mimeType: "image/png" }),
			readText: async () => "sk-test-key",
		});

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "\x16");

		expect(result).toEqual({ consume: true });
		expect(await rejected).toBe("Image paste is not supported in this prompt");
		expect(focusedPasteText).not.toHaveBeenCalled();
		expect(editor.pendingImages).toHaveLength(0);
		expect(editor.getText()).toBe("");
	});

	it("routes c to copy a copyable /btw panel when the editor is empty", async () => {
		const { InputController, ctx, spies } = await createContext();
		(ctx.canCopyBtw as unknown as { mockReturnValue(value: boolean): void }).mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "c");

		expect(result).toEqual({ consume: true });
		expect(spies.handleBtwCopyKey).toHaveBeenCalledTimes(1);
	});

	it("lets c fall through while the editor has draft text", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		(ctx.canCopyBtw as unknown as { mockReturnValue(value: boolean): void }).mockReturnValue(true);
		editor.setText("continue this draft");
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "c");

		expect(result).toBeUndefined();
		expect(spies.handleBtwCopyKey).not.toHaveBeenCalled();
	});

	it("lets c fall through when /btw is not copyable", async () => {
		const { InputController, ctx, spies } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "c");

		expect(result).toBeUndefined();
		expect(spies.handleBtwCopyKey).not.toHaveBeenCalled();
	});

	it("lets c fall through while another input is focused", async () => {
		const { InputController, ctx, setFocused, spies } = await createContext();
		(ctx.canCopyBtw as unknown as { mockReturnValue(value: boolean): void }).mockReturnValue(true);
		setFocused({ pasteText: vi.fn() });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "c");

		expect(result).toBeUndefined();
		expect(spies.handleBtwCopyKey).not.toHaveBeenCalled();
	});

	it("empty Enter aborts the active stream when queued messages are pending", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const session = ctx.session as unknown as { isStreaming: boolean; queuedMessageCount: number };
		session.isStreaming = true;
		session.queuedMessageCount = 1;
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.("");

		expect(spies.abort).toHaveBeenCalledWith({ reason: "Interrupted by user" });
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(spies.requestRender).toHaveBeenCalledTimes(1);
		expect(spies.prompt).not.toHaveBeenCalled();
	});

	it("marks streaming follow-up submissions as local", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const session = ctx.session as unknown as { isStreaming: boolean };
		session.isStreaming = true;
		editor.setText("follow up after current response");
		const controller = new InputController(ctx);

		await controller.handleFollowUp();

		expect(ctx.locallySubmittedUserSignatures.has("follow up after current response\u00000")).toBe(true);
		expect(spies.prompt).toHaveBeenCalledWith("follow up after current response", {
			streamingBehavior: "followUp",
		});
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});

	it("marks idle follow-up submissions as local", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		// Default fake session is idle.
		editor.setText("plain idle submit");
		const controller = new InputController(ctx);

		await controller.handleFollowUp();

		expect(ctx.locallySubmittedUserSignatures.has("plain idle submit\u00000")).toBe(true);
		// Idle submit calls prompt() with no streamingBehavior (images forwarded, undefined here).
		expect(spies.prompt).toHaveBeenCalledWith("plain idle submit", { images: undefined });
	});

	it("surfaces and recovers from an idle follow-up dispatch failure", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		spies.prompt.mockImplementationOnce(async () => {
			throw new Error("boom");
		});
		editor.setText("doomed submit");
		const controller = new InputController(ctx);

		// Dispatch failures are caught and surfaced (mirroring the main/focused
		// submit paths), not rethrown, so the keybinding's fire-and-forget call
		// never raises an unhandled rejection.
		await controller.handleFollowUp();

		expect(spies.showError).toHaveBeenCalledWith("boom");
		// Draft handed back so the user can retry.
		expect(editor.getText()).toBe("doomed submit");
		// Contract: a failed delivery must not leave a stale signature behind,
		// otherwise the next attempt with the same text would silently suppress
		// the editor-clear protection that was meant for the failed call.
		expect(ctx.locallySubmittedUserSignatures.has("doomed submit\u00000")).toBe(false);
	});

	it("surfaces and recovers from a streaming follow-up dispatch failure", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const session = ctx.session as unknown as { isStreaming: boolean };
		session.isStreaming = true;
		spies.prompt.mockImplementationOnce(async () => {
			throw new Error("queue full");
		});
		editor.setText("queued during stream");
		const controller = new InputController(ctx);

		await controller.handleFollowUp();

		expect(spies.showError).toHaveBeenCalledWith("queue full");
		expect(editor.getText()).toBe("queued during stream");
		expect(ctx.locallySubmittedUserSignatures.has("queued during stream\u00000")).toBe(false);
	});

	it("continue shortcuts submit a hidden synthetic developer directive", async () => {
		for (const shortcut of [".", "c"]) {
			const { InputController, ctx, editor } = await createContext();
			const onInput = vi.fn();
			ctx.onInputCallback = onInput;
			const controller = new InputController(ctx);

			controller.setupEditorSubmitHandler();
			await editor.onSubmit?.(shortcut);

			expect(onInput, `shortcut ${shortcut}`).toHaveBeenCalledWith({
				text: manualContinuePrompt,
				cancelled: false,
				started: true,
				synthetic: true,
				userInitiated: true,
			});
		}
	});
});

describe("InputController send-to-new-session", () => {
	it("binds the default Alt+N action to handleSendToNewSession instead of /new", async () => {
		const harness = await createSendToNewSessionHarness();
		const controller = new harness.InputController(harness.ctx);
		const sendToNew = vi.spyOn(controller, "handleSendToNewSession").mockResolvedValue();

		controller.setupKeyHandlers();
		expect(harness.customHandlers.get("alt+n")).toBeDefined();

		harness.customHandlers.get("alt+n")?.();
		await Promise.resolve();

		expect(sendToNew).toHaveBeenCalledTimes(1);
		expect(harness.spies.showModelSelector).not.toHaveBeenCalled();
		expect((harness.ctx.handleClearCommand as unknown as Mock<() => Promise<void>>).mock.calls).toHaveLength(0);
	});

	it("snapshots text, image order, and links before attach, starts the target prompt, then returns to the old UI without aborting it", async () => {
		const harness = await createSendToNewSessionHarness();
		const draft = seedImageDraft(harness.editor);
		const promptStarted = Promise.withResolvers<void>();
		const promptFinished = Promise.withResolvers<void>();
		harness.targetPrompt.mockImplementation(() => {
			promptStarted.resolve();
			return promptFinished.promise;
		});
		const controller = new harness.InputController(harness.ctx);
		let transferResolved = false;

		const transfer = controller.handleSendToNewSession();
		void transfer.then(() => {
			transferResolved = true;
		});
		await promptStarted.promise;
		await Promise.resolve();
		await Promise.resolve();

		expect(harness.startPendingSubmission).toHaveBeenCalledWith({
			text: draft.text,
			images: draft.images,
			imageLinks: harness.targetLinks,
			streamingBehavior: "steer",
		});
		expect(harness.targetPrompt).toHaveBeenCalledWith(draft.text, {
			images: draft.images,
			streamingBehavior: "steer",
		});
		expect(harness.targetManager.putBlob).toHaveBeenCalledTimes(2);
		expect(harness.targetPrompt.mock.invocationCallOrder[0]!).toBeLessThan(
			harness.switchTopLevel.mock.invocationCallOrder[0]!,
		);
		expect(transferResolved).toBe(true);
		expect(harness.mutableCtx.editor).toBe(harness.editor);
		expect(harness.mutableCtx.activeTopLevelId).toBe(harness.oldId);
		expect(harness.spies.abort).not.toHaveBeenCalled();
		expect(harness.onInputCallback).not.toHaveBeenCalled();
		expect(harness.editor.getText()).toBe("");
		expect(harness.editor.pendingImages).toEqual([]);
		expect(harness.editor.pendingImageLinks).toEqual([]);

		promptFinished.resolve();
		await transfer;
	});

	it("restores the complete old draft when the target prompt rejects after the transfer returns", async () => {
		const harness = await createSendToNewSessionHarness();
		const draft = seedImageDraft(harness.editor);
		const promptStarted = Promise.withResolvers<void>();
		const promptResult = Promise.withResolvers<void>();
		const failure = new Error("target prompt rejected");
		harness.targetPrompt.mockImplementation(() => {
			promptStarted.resolve();
			return promptResult.promise.then(() => {
				throw failure;
			});
		});
		const controller = new harness.InputController(harness.ctx);
		let transferResolved = false;
		const transfer = controller.handleSendToNewSession();
		void transfer.then(() => {
			transferResolved = true;
		});

		await promptStarted.promise;
		await Promise.resolve();
		await Promise.resolve();
		expect(transferResolved).toBe(true);
		expect(harness.mutableCtx.editor).toBe(harness.editor);
		expect(harness.switchTopLevel).toHaveBeenCalledWith(harness.oldId);

		promptResult.resolve();
		await promptResult.promise;
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expectImageDraft(harness.editor, draft);
		expect(harness.spies.showError).toHaveBeenCalledWith(failure.message);
		expect(harness.spies.abort).not.toHaveBeenCalled();
	});

	it.each([false, undefined] as const)(
		"keeps the draft and does not dispatch or switch when runtime attach returns %s",
		async attachResult => {
			const harness = await createSendToNewSessionHarness();
			const draft = seedImageDraft(harness.editor);
			const startNewTopLevelRuntime = harness.startNewTopLevelRuntime as unknown as Mock<
				() => Promise<boolean | undefined>
			>;
			startNewTopLevelRuntime.mockImplementationOnce(async () => attachResult);
			const controller = new harness.InputController(harness.ctx);

			await controller.handleSendToNewSession();

			expect(startNewTopLevelRuntime).toHaveBeenCalledTimes(1);
			expect(harness.targetPrompt).not.toHaveBeenCalled();
			expect(harness.startPendingSubmission).not.toHaveBeenCalled();
			expect(harness.switchTopLevel).not.toHaveBeenCalled();
			expect(harness.spies.abort).not.toHaveBeenCalled();
			expectImageDraft(harness.editor, draft);
		},
	);

	it("does not create a runtime for an empty draft even when orphaned image links remain", async () => {
		const harness = await createSendToNewSessionHarness();
		harness.editor.setText("");
		harness.editor.pendingImages = [];
		harness.editor.pendingImageLinks = ["old://orphaned-link"];
		harness.editor.imageLinks = ["old://orphaned-link"];
		const controller = new harness.InputController(harness.ctx);

		await controller.handleSendToNewSession();

		expect(harness.startNewTopLevelRuntime).not.toHaveBeenCalled();
		expect(harness.targetPrompt).not.toHaveBeenCalled();
		expect(harness.switchTopLevel).not.toHaveBeenCalled();
		expect(harness.spies.abort).not.toHaveBeenCalled();
		expect(harness.editor.pendingImageLinks).toEqual(["old://orphaned-link"]);
	});
});
