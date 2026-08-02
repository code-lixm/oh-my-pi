import { beforeAll, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AutocompleteItem, AutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";

// ---------------------------------------------------------------------------
// Tab / Shift+Tab model cycling (app.model.cycleForward / cycleBackward)
//
// New default keybindings:
//   • Tab            → app.model.cycleForward  (falls through only on completion miss)
//   • Shift+Tab     → app.model.cycleBackward (blocked when autocomplete visible)
//   • Ctrl+P        → app.thinking.cycle     (no longer cycles models)
//   • Shift+Ctrl+P → user-configurable       (no longer a default action)
//
// Contracts:
//   • Tab → model.cycleForward only when autocomplete popup is absent AND
//     Tab has no completion candidates (completion miss).
//   • Tab with a visible autocomplete popup → accepts the selection, no cycling.
//   • Tab when completion candidates exist → opens / inserts autocomplete, no cycling.
//   • Shift+Tab without autocomplete popup → model.cycleBackward.
//   • Shift+Tab with autocomplete popup open → no cycling.
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

	it("does not exit on ctrl+d with the default keybindings", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onExit = vi.fn();

		editor.onExit = onExit;
		editor.handleInput("\x04");

		expect(onExit).not.toHaveBeenCalled();
	});

	it("routes ctrl+d to onExit only when app.exit is explicitly configured", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onExit = vi.fn();

		editor.setActionKeys("app.exit", ["ctrl+d"]);
		editor.onExit = onExit;
		editor.handleInput("\x04");

		expect(onExit).toHaveBeenCalledTimes(1);
	});
});

/**
 * Minimal provider that returns candidates only when explicitly configured.
 * When `candidates` is null the provider returns nothing, simulating a
 * "completion miss" — Tab must fall through to model.cycleForward.
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
	it("Tab with no autocomplete provider fires model.cycleForward", async () => {
		const editor = new CustomEditor(getEditorTheme());
		// No provider — Tab has nothing to offer, must fall through.
		const onCycleForward = vi.fn();
		editor.onCycleModelForward = onCycleForward;
		editor.setActionKeys("app.model.cycleForward", ["tab"]);

		editor.handleInput("\t");
		// handleInput() calls super.handleInput() which fires a void promise whose
		// .then() chain calls handleTabCompletionMiss → onCycleModelForward.
		// Drain the microtask queue so that callback runs before the assertion.
		await Bun.sleep(0);

		expect(onCycleForward).toHaveBeenCalledTimes(1);
	});

	it("Tab with provider returning no candidates fires model.cycleForward", async () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setAutocompleteProvider(new OptionalProvider(null));
		const onCycleForward = vi.fn();
		editor.onCycleModelForward = onCycleForward;
		editor.setActionKeys("app.model.cycleForward", ["tab"]);

		editor.handleInput("\t");
		await Bun.sleep(0);

		expect(onCycleForward).toHaveBeenCalledTimes(1);
	});

	it("Tab with visible autocomplete popup accepts selection and does not fire model.cycleForward", async () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setAutocompleteProvider(new OptionalProvider([{ value: "alpha", label: "alpha" }]));
		const onCycleForward = vi.fn();
		editor.onCycleModelForward = onCycleForward;
		editor.setActionKeys("app.model.cycleForward", ["tab"]);

		// Open the popup with a leading slash so auto-trigger fires.
		editor.handleInput("/");
		await Bun.sleep(0);

		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.handleInput("\t"); // Accept via Tab.

		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(onCycleForward).not.toHaveBeenCalled();
	});

	it("Tab with provider returning candidates opens autocomplete and does not fire model.cycleForward", async () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setAutocompleteProvider(new OptionalProvider([{ value: "beta", label: "beta" }]));
		const onCycleForward = vi.fn();
		editor.onCycleModelForward = onCycleForward;
		editor.setActionKeys("app.model.cycleForward", ["tab"]);

		editor.handleInput("\t");
		await Bun.sleep(0);

		// Tab should have opened autocomplete (or accepted the first item)
		// but must NOT have triggered model cycling.
		expect(onCycleForward).not.toHaveBeenCalled();
	});

	it("Tab fires model.cycleForward when autocomplete is dismissed (no candidates)", async () => {
		const editor = new CustomEditor(getEditorTheme());
		// Provider that returns no candidates on first call.
		editor.setAutocompleteProvider(new OptionalProvider(null));
		const onCycleForward = vi.fn();
		editor.onCycleModelForward = onCycleForward;
		editor.setActionKeys("app.model.cycleForward", ["tab"]);

		editor.handleInput("\t");
		await Bun.sleep(0);

		// Tab → provider returns null → no autocomplete shown → cycle fires.
		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(onCycleForward).toHaveBeenCalledTimes(1);
	});

	it("handleDraftEdit(Tab) with no candidates does not fire model.cycleForward", async () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setActionKeys("app.model.cycleForward", ["tab"]);
		editor.setAutocompleteProvider(new OptionalProvider(null));
		const onCycleForward = vi.fn();
		editor.onCycleModelForward = onCycleForward;

		editor.handleDraftEdit("\t");
		await Bun.sleep(0);

		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(onCycleForward).not.toHaveBeenCalled();
	});

	it("cancels a pending Tab completion-miss fallback after a later non-editor action", async () => {
		class DelayedNoCandidatesProvider implements AutocompleteProvider {
			readonly pending = Promise.withResolvers<{ items: AutocompleteItem[]; prefix: string } | null>();

			async getSuggestions(
				_lines: string[],
				_cursorLine: number,
				_cursorCol: number,
			): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
				return this.pending.promise;
			}

			applyCompletion(
				lines: string[],
				cursorLine: number,
				cursorCol: number,
				_item: AutocompleteItem,
				_prefix: string,
			): { lines: string[]; cursorLine: number; cursorCol: number } {
				return { lines, cursorLine, cursorCol };
			}
		}

		const provider = new DelayedNoCandidatesProvider();
		const editor = new CustomEditor(getEditorTheme());
		editor.setAutocompleteProvider(provider);
		editor.setActionKeys("app.model.cycleForward", ["tab"]);
		editor.setActionKeys("app.retry", ["alt+r"]);
		const onCycleForward = vi.fn();
		const onRetry = vi.fn();
		editor.onCycleModelForward = onCycleForward;
		editor.onRetry = onRetry;

		editor.handleInput("\t");
		editor.handleInput("\x1br");
		provider.pending.resolve(null);
		await Bun.sleep(0);

		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(onCycleForward).not.toHaveBeenCalled();
	});

	it("cancels a pending Tab completion-miss fallback after focus changes before resolve", async () => {
		class DelayedNoCandidatesProvider implements AutocompleteProvider {
			readonly pending = Promise.withResolvers<{ items: AutocompleteItem[]; prefix: string } | null>();

			async getSuggestions(
				_lines: string[],
				_cursorLine: number,
				_cursorCol: number,
			): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
				return this.pending.promise;
			}

			applyCompletion(
				lines: string[],
				cursorLine: number,
				cursorCol: number,
				_item: AutocompleteItem,
				_prefix: string,
			): { lines: string[]; cursorLine: number; cursorCol: number } {
				return { lines, cursorLine, cursorCol };
			}
		}

		const provider = new DelayedNoCandidatesProvider();
		const editor = new CustomEditor(getEditorTheme());
		editor.focused = true;
		editor.setAutocompleteProvider(provider);
		editor.setActionKeys("app.model.cycleForward", ["tab"]);
		const onCycleForward = vi.fn();
		editor.onCycleModelForward = onCycleForward;

		editor.handleInput("\t");
		editor.focused = false;
		provider.pending.resolve(null);
		await Bun.sleep(0);

		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(onCycleForward).not.toHaveBeenCalled();
	});
});

describe("Shift+Tab model cycling", () => {
	it("Shift+Tab without autocomplete popup fires model.cycleBackward", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onCycleBackward = vi.fn();
		editor.onCycleModelBackward = onCycleBackward;
		editor.setActionKeys("app.model.cycleBackward", ["shift+tab"]);

		editor.handleInput("\x1b[Z"); // Shift+Tab escape sequence.

		expect(onCycleBackward).toHaveBeenCalledTimes(1);
	});

	it("Shift+Tab with autocomplete popup open does not fire model.cycleBackward", async () => {
		class AlwaysHasCandidatesProvider implements AutocompleteProvider {
			async getSuggestions(
				_lines: string[],
				_cursorLine: number,
				_cursorCol: number,
			): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
				return { items: [{ value: "x", label: "x" }], prefix: "" };
			}

			applyCompletion(
				lines: string[],
				cursorLine: number,
				cursorCol: number,
				_item: AutocompleteItem,
				_prefix: string,
			): { lines: string[]; cursorLine: number; cursorCol: number } {
				return { lines, cursorLine, cursorCol };
			}
		}

		const editor = new CustomEditor(getEditorTheme());
		editor.setAutocompleteProvider(new AlwaysHasCandidatesProvider());
		const onCycleBackward = vi.fn();
		editor.onCycleModelBackward = onCycleBackward;
		editor.setActionKeys("app.model.cycleBackward", ["shift+tab"]);

		// Open the popup.
		editor.handleInput("/");
		await Bun.sleep(0);
		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.handleInput("\x1b[Z"); // Shift+Tab.

		// Autocomplete should still be visible; no backward cycle.
		expect(editor.isShowingAutocomplete()).toBe(true);
		expect(onCycleBackward).not.toHaveBeenCalled();
	});

	it("Shift+Tab with autocomplete popup open does not fire a custom Shift+Tab handler", async () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setAutocompleteProvider(new OptionalProvider([{ value: "x", label: "x" }]));
		const onCustomShiftTab = vi.fn();
		editor.setCustomKeyHandler("shift+tab", onCustomShiftTab);

		editor.handleInput("/");
		await Bun.sleep(0);
		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.handleInput("\x1b[Z");

		expect(editor.isShowingAutocomplete()).toBe(true);
		expect(onCustomShiftTab).not.toHaveBeenCalled();
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
