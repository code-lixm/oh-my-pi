/**
 * Regression: Alt+Q (app.message.followUp) on a session that LOOKS idle at the
 * controller check but turns busy before `session.prompt` dispatches. The idle
 * check and the turn dispatch are not atomic: the prior turn's post-prompt
 * recovery (or a background continuation) can flip `isStreaming` in the gap.
 * A bare `prompt(text, { images })` then threw AgentBusyError at the user even
 * though the UI showed no "Working…", and the message never queued — it only
 * resurfaced after the user submitted the next manual prompt.
 *
 * Contract: the not-streaming branch passes `streamingBehavior: "followUp"` so
 * a race-flipped busy session queues the message for the idle drain instead of
 * erroring, and still reconciles the pending-messages display after dispatch.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

interface PromptOptionsLike {
	streamingBehavior?: "steer" | "followUp";
	images?: ImageContent[];
}

function createContext(opts: { isStreaming: boolean; flipToStreamingBeforePrompt?: boolean }) {
	let editorText = "";
	const editor = {
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
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		imageLinks: undefined as (string | undefined)[] | undefined,
		compactPendingImageReferences: (text: string) => text,
		clearDraft(text?: string) {
			if (text !== undefined) this.addToHistory(text);
			this.setText("");
			this.imageLinks = undefined;
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
	};
	const prompt = vi.fn(async (_text: string, _options?: PromptOptionsLike) => {});
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();
	const retireOptimisticQueuedMessage = vi.fn();
	const settleOptimisticQueuedMessage = vi.fn();
	const reconcileOptimisticQueuedMessages = vi.fn();

	let streaming = opts.isStreaming;
	const ctx = {
		editor,
		ui: { requestRender },
		skillCommands: new Map<string, string>(),
		session: {
			get isStreaming() {
				return streaming;
			},
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			prompt,
		},
		loopModeEnabled: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		updatePendingMessagesDisplay,
		showError,
		retireOptimisticQueuedMessage,
		reconcileOptimisticQueuedMessages,
		settleOptimisticQueuedMessage,
		planModeEnabled: false,
		planModePaused: false,
		vibeModeEnabled: false,
		goalModeEnabled: false,
		goalModePaused: false,
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		prompt,
		showError,
		retireOptimisticQueuedMessage,
		reconcileOptimisticQueuedMessages,
		settleOptimisticQueuedMessage,
		updatePendingMessagesDisplay,
		flipStreaming(value: boolean) {
			streaming = value;
		},
	};
}

describe("InputController.handleFollowUp idle-check race", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("queues instead of erroring when the session flips busy before dispatch", async () => {
		const { ctx, editor, prompt, showError } = createContext({
			isStreaming: false,
		});
		// Simulate the prior turn's recovery flipping the session busy in the gap
		// between the controller's isStreaming check and session.prompt's own check.
		prompt.mockImplementationOnce(async (_text, options) => {
			if (!(options as PromptOptionsLike | undefined)?.streamingBehavior) {
				throw new Error("AgentBusyError would have been thrown");
			}
			return;
		});
		ctx.session.prompt = prompt as never;

		const controller = new InputController(ctx);
		editor.setText("queued after finish");
		await controller.handleFollowUp();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0]?.[1]?.streamingBehavior).toBe("followUp");
		expect(showError).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
	});

	it("refreshes the pending display after an idle dispatch", async () => {
		const { ctx, editor, prompt, reconcileOptimisticQueuedMessages, updatePendingMessagesDisplay } = createContext({
			isStreaming: false,
		});

		const controller = new InputController(ctx);
		editor.setText("plain idle submit");
		await controller.handleFollowUp();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0]?.[1]?.streamingBehavior).toBe("followUp");
		expect(reconcileOptimisticQueuedMessages).toHaveBeenCalled();
		expect(updatePendingMessagesDisplay).toHaveBeenCalled();
	});
});
