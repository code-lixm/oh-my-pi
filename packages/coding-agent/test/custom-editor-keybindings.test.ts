import { beforeAll, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AutocompleteItem, AutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";

// ---------------------------------------------------------------------------
// App-level actions routed by CustomEditor
//
// Contracts:
//   • Ctrl+D invokes the default app.exit action.
//   • Tab / Shift+Tab invoke their configured model-cycle actions only with an empty prompt.
//   • Non-empty slash-command input keeps Tab available to autocomplete.
// ---------------------------------------------------------------------------

describe("CustomEditor keybindings", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("routes the configured retry chord through handleInput", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();

		editor.setActionKeys("app.retry", ["alt+shift+r"]);
		editor.onRetry = onRetry;
		editor.handleInput("\x1bR");

		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("routes the configured tool activity visibility chord through handleInput", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onToggleToolActivity = vi.fn();

		editor.setActionKeys("app.tools.toggleVisibility", ["alt+h"]);
		editor.onToggleToolActivity = onToggleToolActivity;
		editor.handleInput("\x1bh");

		expect(onToggleToolActivity).toHaveBeenCalledTimes(1);
	});

	it("lets custom handlers keep precedence over the default retry chord", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		const customHandler = vi.fn();

		editor.onRetry = onRetry;
		editor.setCustomKeyHandler("alt+r", customHandler);
		editor.handleInput("\x1br");

		expect(customHandler).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("lets copy-prompt remaps keep precedence over the default retry chord", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		const onCopyPrompt = vi.fn();

		editor.onRetry = onRetry;
		editor.onCopyPrompt = onCopyPrompt;
		editor.setActionKeys("app.clipboard.copyPrompt", ["alt+r"]);
		editor.handleInput("\x1br");

		expect(onCopyPrompt).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("routes ctrl+d to onExit with the default keybindings", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onExit = vi.fn();

		editor.onExit = onExit;
		editor.handleInput("\x04");

		expect(onExit).toHaveBeenCalledTimes(1);
	});

	it("routes a remapped exit chord to onExit", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onExit = vi.fn();

		editor.setActionKeys("app.exit", ["alt+x"]);
		editor.onExit = onExit;
		editor.handleInput("\x1bx");

		expect(onExit).toHaveBeenCalledTimes(1);
	});
});

/**
 * Minimal provider that exposes an autocomplete popup only when candidates
 * are explicitly configured.
 */
class OptionalProvider implements AutocompleteProvider {
	private readonly _candidates: Array<{ value: string; label: string }> | null;

	constructor(candidates: Array<{ value: string; label: string }> | null = null) {
		this._candidates = candidates;
	}

	async getSuggestions(
		_lines: string[],
		_cursorLine: number,
		_cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		if (!this._candidates) return null;
		return { items: this._candidates, prefix: "" };
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		_prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number; onApplied?: () => void } {
		const line = lines[cursorLine] ?? "";
		const inserted = item.value;
		return {
			lines: [...lines.slice(0, cursorLine), line.slice(0, cursorCol) + inserted, ...lines.slice(cursorLine + 1)],
			cursorLine,
			cursorCol: cursorCol + inserted.length,
		};
	}
}

describe("Tab model cycling", () => {
	it("routes a configured Tab chord to model.cycleForward when the prompt is empty", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setActionKeys("app.model.cycleForward", ["tab"]);
		const onCycleForward = vi.fn();
		editor.onCycleModelForward = onCycleForward;

		editor.handleInput("\t");

		expect(onCycleForward).toHaveBeenCalledTimes(1);
	});

	it("leaves Tab to visible slash-command autocomplete instead of cycling models", async () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setActionKeys("app.model.cycleForward", ["tab"]);
		editor.setAutocompleteProvider(new OptionalProvider([{ value: "alpha", label: "alpha" }]));
		const onCycleForward = vi.fn();
		editor.onCycleModelForward = onCycleForward;

		editor.handleInput("/");
		await Promise.resolve();
		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.handleInput("\t");

		expect(onCycleForward).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("/alpha");
		expect(editor.isShowingAutocomplete()).toBe(false);
	});

	it("keeps app-level model cycling out of handleDraftEdit", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setActionKeys("app.model.cycleForward", ["tab"]);
		editor.setAutocompleteProvider(new OptionalProvider(null));
		const onCycleForward = vi.fn();
		editor.onCycleModelForward = onCycleForward;

		editor.handleDraftEdit("\t");

		expect(onCycleForward).not.toHaveBeenCalled();
	});
});

describe("Shift+Tab model cycling", () => {
	it("routes a configured Shift+Tab chord to model.cycleBackward when the prompt is empty", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setActionKeys("app.model.cycleBackward", ["shift+tab"]);
		const onCycleBackward = vi.fn();
		editor.onCycleModelBackward = onCycleBackward;

		editor.handleInput("\x1b[Z");

		expect(onCycleBackward).toHaveBeenCalledTimes(1);
	});

	it("leaves a non-empty slash-command editor out of backward model cycling", async () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setActionKeys("app.model.cycleBackward", ["shift+tab"]);
		editor.setAutocompleteProvider(new OptionalProvider([{ value: "x", label: "x" }]));
		const onCycleBackward = vi.fn();
		editor.onCycleModelBackward = onCycleBackward;

		editor.handleInput("/");
		await Promise.resolve();
		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.handleInput("\x1b[Z");

		expect(onCycleBackward).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("/");
		expect(editor.isShowingAutocomplete()).toBe(true);
	});
});

describe("display reset and live toggle defaults", () => {
	it("routes Ctrl+L to a live-toggle custom handler and Alt+L to display reset by default", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onDisplayReset = vi.fn();
		const onLiveToggle = vi.fn();

		editor.onDisplayReset = onDisplayReset;
		editor.setCustomKeyHandler("ctrl+l", onLiveToggle);

		editor.handleInput("\x0c"); // Ctrl+L
		expect(onLiveToggle).toHaveBeenCalledTimes(1);
		expect(onDisplayReset).not.toHaveBeenCalled();

		editor.handleInput("\x1bl"); // Alt+L
		expect(onDisplayReset).toHaveBeenCalledTimes(1);
		expect(onLiveToggle).toHaveBeenCalledTimes(1);
	});
});

describe("shipped dequeue defaults", () => {
	it("binds both alt+up and shift+up to the steering dequeue", () => {
		const keybindings = KeybindingsManager.inMemory();
		const keys = keybindings.getKeys("app.message.dequeue");
		expect(keys).toContain("alt+up");
		expect(keys).toContain("shift+up");
	});
	it("does not steal shift+up from an explicit user binding", () => {
		const keybindings = KeybindingsManager.inMemory({
			"tui.editor.cursorUp": "shift+up",
		});

		expect(keybindings.getKeys("app.message.dequeue")).toEqual(["alt+up"]);
		expect(keybindings.getKeys("tui.editor.cursorUp")).toEqual(["shift+up"]);
	});
	it("routes the shipped shift+up default through DEFAULT_ACTION_KEYS to the dequeue handler", () => {
		// F12: the registry test above does not cover DEFAULT_ACTION_KEYS, the second
		// defaults table that custom-editor.ts seeds its match set from. Drive a real
		// editor without calling setActionKeys, so the shipped entry is the only thing
		// that can make the shift+up wire form (CSI 1;2A) reach onDequeue.
		const editor = new CustomEditor(getEditorTheme());
		const onDequeue = vi.fn();

		editor.onDequeue = onDequeue;
		editor.handleInput("\x1b[1;2A");

		expect(onDequeue).toHaveBeenCalledTimes(1);
	});
});
