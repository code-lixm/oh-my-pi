/**
 * `/tree`'s interactive selector must let the active leaf's `ask` toolResult
 * fall through to the re-answer flow instead of treating it as a plain
 * "already at this point" no-op (Codex review on #5895, posted as a
 * body-only review comment that predates this fix: the `agent-session.ts`
 * `allowAskReopen` gate is unreachable unless the interactive `/tree`
 * handler itself stops short-circuiting on `entryId === realLeafId` for
 * ask toolResults).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

function askResultEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "ask",
			content: [{ type: "text", text: "User selected: staging" }],
			details: {
				question: "Which deploy target?",
				options: ["staging", "production"],
				multi: false,
				selectedOptions: ["staging"],
			},
			isError: false,
			timestamp: Date.now(),
		},
	} as unknown as SessionEntry;
}

function plainUserEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() },
	} as unknown as SessionEntry;
}

interface EditorSlot {
	children: unknown[];
	clear: Mock<() => void>;
	addChild: Mock<(child: unknown) => void>;
}

type MountedTreeSelector = {
	handleInput: (data: string) => void;
	getTreeList: () => { onSelect?: (id: string, options: { summarize: boolean }) => unknown };
};

function createEditorSlot(...initial: unknown[]): EditorSlot {
	const children = [...initial];
	return {
		children,
		clear: vi.fn(() => {
			children.length = 0;
		}),
		addChild: vi.fn((child: unknown) => {
			children.push(child);
		}),
	};
}

function createCtx(
	leafEntry: SessionEntry,
	navigateTreeResult: unknown = { cancelled: false },
	visibleOwner?: unknown,
) {
	const tree: SessionTreeNode[] = [{ entry: leafEntry, children: [] }];
	const navigateTree = vi.fn(async () => navigateTreeResult as never);
	const showStatus = vi.fn();
	const showError = vi.fn();
	const editor = { id: "editor", getText: () => "", setText: vi.fn() };
	const editorContainer = createEditorSlot(visibleOwner ?? editor);
	const focusTargets: unknown[] = [];
	const overlayHide = vi.fn();
	let mountedSelector: MountedTreeSelector | undefined;
	const showOverlay = vi.fn((component: unknown) => {
		mountedSelector = component as MountedTreeSelector;
		return { hide: overlayHide, setHidden: vi.fn(), isHidden: () => false };
	});
	const requestRender = vi.fn();
	// Records the order of UI-rebuild vs agent-resume so a test can prove the
	// re-answer continuation is deferred until after the transcript rebuild
	// (issue #6483).
	const order: string[] = [];
	const renderInitialMessages = vi.fn(() => {
		order.push("render");
	});
	const reloadTodos = vi.fn(async () => {
		order.push("reloadTodos");
	});
	const resumeAfterAskReanswer = vi.fn(() => {
		order.push("resume");
	});
	const ctx = {
		editor,
		editorContainer,
		sessionManager: {
			getTree: () => tree,
			getLeafId: () => leafEntry.id,
			getEntry: (id: string) => (id === leafEntry.id ? leafEntry : undefined),
		},
		session: { navigateTree, resumeAfterAskReanswer },
		ui: {
			showOverlay,
			setFocus: vi.fn((target: unknown) => {
				focusTargets.push(target);
			}),
			requestRender,
			terminal: { rows: 24 },
		},
		renderInitialMessages,
		reloadTodos,
		showStatus,
		showError,
		// No UI context available in this unit test — forces `#reanswerAsk` to
		// bail out immediately via its own "Ask tool UI is not ready" path
		// instead of requiring a full AskTool/dialog harness. The point of
		// this test is proving `navigateTree` gets reached with
		// `allowAskReopen: true` at all, not exercising the re-answer dialog
		// itself (already covered at the session level).
		getToolUIContext: () => undefined,
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		editorContainer,
		navigateTree,
		showStatus,
		showError,
		resumeAfterAskReanswer,
		order,
		focusTargets,
		showOverlay,
		overlayHide,
		requestRender,
		shownSelector: () => mountedSelector,
	};
}

async function pickEntry(selector: MountedTreeSelector | undefined, entryId: string): Promise<void> {
	if (!selector) throw new Error("Expected tree selector overlay");
	await selector.getTreeList().onSelect?.(entryId, { summarize: false });
}

describe("SelectorController.showTreeSelector re-answering the active ask leaf", () => {
	it("opens /tree as a fullscreen overlay without replacing the editor slot", () => {
		const entry = plainUserEntry("leaf-user");
		const { ctx, editorContainer, focusTargets, requestRender, showOverlay, shownSelector } = createCtx(entry);
		const controller = new SelectorController(ctx);

		controller.showTreeSelector();
		const selector = shownSelector();

		expect(selector).toBeDefined();
		expect(showOverlay).toHaveBeenCalledWith(
			selector,
			expect.objectContaining({
				anchor: "top-left",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			}),
		);
		expect(editorContainer.clear).not.toHaveBeenCalled();
		expect(editorContainer.addChild).not.toHaveBeenCalled();
		expect(focusTargets).toEqual([selector]);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("Escape hides the fullscreen selector and restores focus to the visible editor-slot owner", () => {
		const entry = plainUserEntry("leaf-user");
		const approvalPrompt = { id: "approval-prompt" };
		const { ctx, editorContainer, focusTargets, overlayHide, requestRender, shownSelector } = createCtx(
			entry,
			{ cancelled: false },
			approvalPrompt,
		);
		const controller = new SelectorController(ctx);

		controller.showTreeSelector();
		const selector = shownSelector();
		if (!selector) throw new Error("Expected tree selector overlay");
		const rendersBeforeClose = requestRender.mock.calls.length;

		selector.handleInput("\x1b");

		expect(overlayHide).toHaveBeenCalledTimes(1);
		expect(focusTargets.at(-1)).toBe(approvalPrompt);
		expect(requestRender.mock.calls.length).toBeGreaterThan(rendersBeforeClose);
		expect(editorContainer.clear).not.toHaveBeenCalled();
		expect(editorContainer.addChild).not.toHaveBeenCalled();
	});

	it("keeps the plain no-op for a non-ask current leaf", async () => {
		const entry = plainUserEntry("leaf-user");
		const { ctx, navigateTree, showStatus, shownSelector } = createCtx(entry);
		const controller = new SelectorController(ctx);

		controller.showTreeSelector();
		await pickEntry(shownSelector(), "leaf-user");

		expect(showStatus).toHaveBeenCalledWith("Already at this point");
		expect(navigateTree).not.toHaveBeenCalled();
	});

	it("falls through to navigateTree with allowAskReopen when the active leaf is an ask toolResult", async () => {
		const entry = askResultEntry("leaf-ask");
		const reopenQuestions = [
			{
				id: "deploy_target",
				question: "Which deploy target?",
				options: [{ label: "staging" }, { label: "production" }],
			},
		];
		const { ctx, navigateTree, showStatus, showError, shownSelector } = createCtx(entry, {
			reopenAsk: { questions: reopenQuestions },
		});
		const controller = new SelectorController(ctx);

		controller.showTreeSelector();
		await pickEntry(shownSelector(), "leaf-ask");

		// The no-op short-circuit must not fire for the current-leaf ask result:
		// navigateTree gets called with `allowAskReopen: true`, and the result's
		// `reopenAsk` is genuinely handled (routed into `#reanswerAsk`, which
		// reports "Ask tool UI is not ready" via `showError` in this harness,
		// then "Re-answer cancelled" — never the old plain no-op message).
		expect(showStatus).not.toHaveBeenCalledWith("Already at this point");
		expect(navigateTree).toHaveBeenCalledWith("leaf-ask", expect.objectContaining({ allowAskReopen: true }));
		expect(showError).toHaveBeenCalledWith("Ask tool UI is not ready");
		expect(showStatus).toHaveBeenCalledWith("Re-answer cancelled");
	});

	it("resumes the agent only after rebuilding the transcript when navigateTree reports a committed re-answer", async () => {
		const entry = plainUserEntry("leaf-user");
		const { ctx, showStatus, resumeAfterAskReanswer, order, shownSelector } = createCtx(entry, {
			cancelled: false,
			askReanswerCommitted: true,
		});
		const controller = new SelectorController(ctx);

		controller.showTreeSelector();
		// A non-current target skips the no-op short-circuit and lands straight on
		// the success path (navigateTree here returns a committed re-answer).
		await pickEntry(shownSelector(), "some-other-entry");

		expect(showStatus).toHaveBeenCalledWith("Navigated to selected point");
		expect(resumeAfterAskReanswer).toHaveBeenCalledTimes(1);
		// The resume must be deferred until after the transcript rebuild so the
		// resumed turn never renders against the stale pre-rebuild UI (issue #6483).
		expect(order.indexOf("render")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("resume")).toBeGreaterThan(order.indexOf("render"));
	});

	it("does not resume the agent for a plain navigation without a committed re-answer", async () => {
		const entry = plainUserEntry("leaf-user");
		const { ctx, resumeAfterAskReanswer, shownSelector } = createCtx(entry, { cancelled: false });
		const controller = new SelectorController(ctx);

		controller.showTreeSelector();
		await pickEntry(shownSelector(), "some-other-entry");

		expect(resumeAfterAskReanswer).not.toHaveBeenCalled();
	});
});
