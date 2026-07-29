/**
 * Focused subagent views are observation-only: editor submits never steer the
 * focused session and leave text plus pending image draft state untouched.
 */
import { describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createContext(opts: { pendingImages: ImageContent[]; pendingImageLinks?: (string | undefined)[] }) {
	let editorText = "";
	const prompt = vi.fn(async () => {});
	const showError = vi.fn();
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();

	const editor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
		imageLinks: undefined as (string | undefined)[] | undefined,
		pendingImages: [...opts.pendingImages],
		pendingImageLinks:
			opts.pendingImageLinks !== undefined ? [...opts.pendingImageLinks] : opts.pendingImages.map(() => undefined),
		clearDraft(historyText?: string) {
			if (historyText !== undefined) this.addToHistory(historyText);
			editorText = "";
			this.imageLinks = undefined;
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
	};

	const ctx = {
		editor,
		ui: { requestRender },
		session: { isStreaming: true, isCompacting: false, extensionRunner: undefined, queuedMessageCount: 0 },
		viewSession: { isStreaming: true, queuedMessageCount: 0, prompt, abort: vi.fn(async () => {}) },
		focusedAgentId: "Worker",
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		showError,
		updatePendingMessagesDisplay,
		withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
	} as unknown as InteractiveModeContext;

	return { ctx, editor, prompt, showError };
}

describe("InputController focused submit observation-only behavior", () => {
	it("leaves text and pending images untouched without prompting the focused session", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const { ctx, editor, prompt, showError } = createContext({
			pendingImages: [image],
			pendingImageLinks: ["local://draft.png"],
		});
		editor.setText("look at this");
		editor.imageLinks = ["local://draft.png"];

		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		await ctx.editor.onSubmit?.("look at this");

		expect(prompt).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("look at this");
		expect(ctx.editor.pendingImages).toEqual([image]);
		expect(ctx.editor.pendingImageLinks).toEqual(["local://draft.png"]);
		expect(ctx.editor.imageLinks).toEqual(["local://draft.png"]);
	});

	it("leaves image-only drafts untouched without prompting the focused session", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const { ctx, editor, prompt, showError } = createContext({ pendingImages: [image] });
		editor.setText("");
		editor.imageLinks = [undefined];

		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		await ctx.editor.onSubmit?.("");

		expect(prompt).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
		expect(ctx.editor.pendingImages).toEqual([image]);
		expect(ctx.editor.pendingImageLinks).toEqual([undefined]);
		expect(ctx.editor.imageLinks).toEqual([undefined]);
	});
});
