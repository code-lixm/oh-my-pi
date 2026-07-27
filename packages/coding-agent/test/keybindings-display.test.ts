import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDefaultPasteImageKeys, KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { keyText } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { getKeybindings, setKeybindings, type KeybindingsManager as TuiKeybindingsManager } from "@oh-my-pi/pi-tui";

describe("KeybindingsManager.getDisplayString", () => {
	it("formats a single binding as a human-readable key hint", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.message.dequeue": "alt+up",
		});

		expect(keybindings.getDisplayString("app.message.dequeue")).toBe("Alt+Up");
	});

	it("defaults retry to Alt+R", () => {
		const keybindings = KeybindingsManager.inMemory();

		expect(keybindings.getDisplayString("app.retry")).toBe("Alt+R");
	});

	it("formats multiple bindings with the existing separator", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.clipboard.copyPrompt": ["alt+shift+c", "ctrl+shift+c"],
		});

		expect(keybindings.getDisplayString("app.clipboard.copyPrompt")).toBe("Alt+Shift+C/Ctrl+Shift+C");
	});

	it("returns an empty string when the action has no binding", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.clipboard.copyPrompt": [],
		});

		expect(keybindings.getDisplayString("app.clipboard.copyPrompt")).toBe("");
	});
});

describe("KeybindingsManager.getKeys", () => {
	it("does not expose a default app.exit keybinding", () => {
		const keybindings = KeybindingsManager.inMemory();

		expect(keybindings.getKeys("app.exit")).toEqual([]);
	});

	it("preserves an explicit Ctrl+D app.exit keybinding", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.exit": "ctrl+d",
		});

		expect(keybindings.getKeys("app.exit")).toEqual(["ctrl+d"]);
	});

	it("returns the new default thinking and model cycle bindings", () => {
		const keybindings = KeybindingsManager.inMemory();
		const resolved = keybindings.getResolvedBindings();

		expect(keybindings.getKeys("app.thinking.cycle")).toEqual(["ctrl+p"]);
		expect(keybindings.getKeys("app.model.cycleForward")).toEqual(["tab"]);
		expect(keybindings.getKeys("app.model.cycleBackward")).toEqual(["shift+tab"]);
		expect(resolved["app.thinking.cycle"]).toBe("ctrl+p");
		expect(resolved["app.model.cycleForward"]).toBe("tab");
		expect(resolved["app.model.cycleBackward"]).toBe("shift+tab");
	});

	it("lets an explicit Ctrl+P binding claim the implicit thinking-cycle default until thinking-cycle is explicitly configured", () => {
		const claimed = KeybindingsManager.inMemory({ "app.retry": "ctrl+p" });

		expect(claimed.getKeys("app.thinking.cycle")).toEqual([]);
		expect(claimed.getResolvedBindings()["app.thinking.cycle"]).toEqual([]);

		const preserved = KeybindingsManager.inMemory({
			"app.retry": "ctrl+p",
			"app.thinking.cycle": "ctrl+p",
		});

		expect(preserved.getKeys("app.thinking.cycle")).toEqual(["ctrl+p"]);
		expect(preserved.getResolvedBindings()["app.thinking.cycle"]).toBe("ctrl+p");
	});

	it("lets an explicit Tab binding claim the implicit model-forward default until model-forward is explicitly configured", () => {
		const claimed = KeybindingsManager.inMemory({ "app.tools.expand": "tab" });

		expect(claimed.getKeys("app.model.cycleForward")).toEqual([]);
		expect(claimed.getResolvedBindings()["app.model.cycleForward"]).toEqual([]);

		const preserved = KeybindingsManager.inMemory({
			"app.tools.expand": "tab",
			"app.model.cycleForward": "tab",
		});

		expect(preserved.getKeys("app.model.cycleForward")).toEqual(["tab"]);
		expect(preserved.getResolvedBindings()["app.model.cycleForward"]).toBe("tab");
	});

	it("lets an explicit Shift+Tab binding claim the implicit model-backward default until model-backward is explicitly configured", () => {
		const claimed = KeybindingsManager.inMemory({ "app.tools.expand": "shift+tab" });

		expect(claimed.getKeys("app.model.cycleBackward")).toEqual([]);
		expect(claimed.getResolvedBindings()["app.model.cycleBackward"]).toEqual([]);

		const preserved = KeybindingsManager.inMemory({
			"app.tools.expand": "shift+tab",
			"app.model.cycleBackward": "shift+tab",
		});

		expect(preserved.getKeys("app.model.cycleBackward")).toEqual(["shift+tab"]);
		expect(preserved.getResolvedBindings()["app.model.cycleBackward"]).toBe("shift+tab");
	});
});

describe("legacy keyText", () => {
	let previous: TuiKeybindingsManager;

	beforeEach(() => {
		previous = getKeybindings();
	});

	afterEach(() => {
		setKeybindings(previous);
	});

	it("formats the active binding for legacy extensions", () => {
		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "alt+e" }));

		expect(keyText("app.tools.expand")).toBe("Alt+E");
	});
});

describe("getDefaultPasteImageKeys", () => {
	it("keeps Ctrl+V registered for image paste on Windows alongside the terminal-safe fallback", () => {
		expect(getDefaultPasteImageKeys("win32")).toEqual(["ctrl+v", "alt+v"]);
	});

	it("adds the macOS Command key event to Ctrl+V for image paste", () => {
		expect(getDefaultPasteImageKeys("linux")).toEqual(["ctrl+v"]);
		expect(getDefaultPasteImageKeys("darwin")).toEqual(["ctrl+v", "super+v"]);
	});
});
