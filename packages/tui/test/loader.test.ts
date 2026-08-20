import { afterEach, describe, expect, it, setSystemTime, spyOn, vi } from "bun:test";
import { Container, Text, TUI } from "@oh-my-pi/pi-tui";
import { Loader, type LoaderMessageColorFn } from "@oh-my-pi/pi-tui/components/loader";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

function visible(term: VirtualTerminal): string[] {
	return term
		.getViewport()
		.map(line => Bun.stripANSI(line).trim())
		.filter(Boolean);
}

describe("Loader component", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("clamps rendered lines to terminal width", async () => {
		const term = new VirtualTerminal(1, 4);
		const tui = new TUI(term);
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Checking",
			["⠸"],
		);
		tui.addChild(loader);

		tui.start();
		await Bun.sleep(0);
		await term.flush();

		for (const line of term.getViewport()) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(1);
		}

		loader.stop();
		tui.stop();
	});

	it("shows semantic status text after a failed direct write through its nested status-root fallback", async () => {
		const term = new VirtualTerminal(48, 6, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const statusRoot = new Container();
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Thinking · Active · phase 0ms",
			["0"],
		);
		loader.stop();
		statusRoot.addChild(loader);
		tui.addChild(new Text("transcript remains visible"));
		tui.addChild(statusRoot);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term).join("\n")).toContain("Thinking · Active · phase 0ms");

			const directWrite = spyOn(tui, "tryDirectWrite").mockReturnValue(false);
			const componentRender = spyOn(tui, "requestComponentRender");
			loader.setMessage("Thinking · Active · phase 1.0s");
			expect(directWrite).toHaveBeenCalledWith(loader);
			expect(componentRender).toHaveBeenCalledWith(loader);

			await scheduler.drain(term);
			const finalFrame = visible(term).join("\n");
			expect(finalFrame).toContain("transcript remains visible");
			expect(finalFrame).toContain("Thinking · Active · phase 1.0s");
			expect(finalFrame).not.toContain("Thinking · Active · phase 0ms");
		} finally {
			loader.stop();
			tui.stop();
			await term.flush();
		}
	});

	it("keeps spinner cadence when animated messages repaint at 30fps", () => {
		vi.useFakeTimers();
		const ui = { tryDirectWrite: vi.fn(() => true), requestComponentRender: vi.fn() };
		const colorMessage = ((text: string) => text) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["0", "1", "2", "3"]);

		vi.advanceTimersByTime(170);

		expect(ui.tryDirectWrite).toHaveBeenCalledTimes(3);
		expect(ui.requestComponentRender).not.toHaveBeenCalled();
		expect(loader.render(20).join("\n")).toContain("2 Checking");
		loader.stop();
	});

	it("pauses waiting-state animation paints and resumes them when work restarts", () => {
		vi.useFakeTimers();
		const ui = { synchronizedOutput: true, tryDirectWrite: vi.fn(() => true), requestComponentRender: vi.fn() };
		const colorMessage = ((text: string) => text) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["0", "1"]);

		const initialPaints = ui.tryDirectWrite.mock.calls.length;
		vi.advanceTimersByTime(34);
		expect(ui.tryDirectWrite.mock.calls.length).toBeGreaterThan(initialPaints);

		loader.setAnimationEnabled(false);
		const pausedPaints = ui.tryDirectWrite.mock.calls.length;
		vi.advanceTimersByTime(200);
		expect(ui.tryDirectWrite).toHaveBeenCalledTimes(pausedPaints);

		loader.setAnimationEnabled(true);
		const resumedPaints = ui.tryDirectWrite.mock.calls.length;
		vi.advanceTimersByTime(34);
		expect(ui.tryDirectWrite.mock.calls.length).toBeGreaterThan(resumedPaints);

		loader.stop();
	});

	it("freezes animated ANSI bytes across external renders while paused", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const ui = { synchronizedOutput: true, tryDirectWrite: vi.fn(() => true), requestComponentRender: vi.fn() };
		const colorMessage = ((text: string) =>
			`\x1b[38;5;${Date.now() % 256}m${text}\x1b[0m`) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["0", "1"]);

		const initial = loader.render(40);
		loader.setAnimationEnabled(false);
		const pausedPaints = ui.tryDirectWrite.mock.calls.length;

		vi.advanceTimersByTime(200);
		const firstPausedRender = loader.render(40);
		vi.advanceTimersByTime(200);
		const secondPausedRender = loader.render(40);

		expect(firstPausedRender).toEqual(initial);
		expect(secondPausedRender).toEqual(firstPausedRender);
		expect(ui.tryDirectWrite).toHaveBeenCalledTimes(pausedPaints);

		loader.stop();
	});

	it("falls back for semantic changes but drops unsafe spinner frames", () => {
		vi.useFakeTimers();
		const ui = { tryDirectWrite: vi.fn(() => false), requestComponentRender: vi.fn() };
		const loader = new Loader(
			ui as unknown as TUI,
			text => text,
			text => text,
			"Checking",
			["0", "1"],
		);

		expect(ui.tryDirectWrite).toHaveBeenCalledTimes(1);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);

		loader.setMessage("Still checking");
		expect(ui.tryDirectWrite).toHaveBeenCalledTimes(2);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);

		vi.advanceTimersByTime(80);
		expect(ui.tryDirectWrite).toHaveBeenCalledTimes(3);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);
		expect(loader.render(30).join("\n")).toContain("1 Still checking");

		loader.stop();
	});

	it("drops unsafe cosmetic message updates while preserving text for the next render", () => {
		vi.useFakeTimers();
		const ui = { tryDirectWrite: vi.fn(() => false), requestComponentRender: vi.fn() };
		const loader = new Loader(
			ui as unknown as TUI,
			text => text,
			text => text,
			"Checking",
			["0"],
		);

		ui.tryDirectWrite.mockClear();
		ui.requestComponentRender.mockClear();

		loader.setCosmeticMessage("Still checking");

		expect(ui.tryDirectWrite).toHaveBeenCalledTimes(1);
		expect(ui.requestComponentRender).not.toHaveBeenCalled();
		expect(loader.render(30).join("\n")).toContain("0 Still checking");

		loader.stop();
	});

	it("drops unsafe synchronized shimmer frames without scheduling a component render", () => {
		vi.useFakeTimers();
		const ui = {
			synchronizedOutput: true,
			tryDirectWrite: vi.fn(() => false),
			requestComponentRender: vi.fn(),
		};
		const colorMessage = ((text: string) => text) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["0"]);

		expect(ui.tryDirectWrite).toHaveBeenCalledTimes(1);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(34);
		expect(ui.tryDirectWrite).toHaveBeenCalledTimes(2);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);

		loader.stop();
	});
	it("falls back to component-scoped renders for lightweight TUI stubs", () => {
		vi.useFakeTimers();
		const ui = { requestComponentRender: vi.fn() };
		const loader = new Loader(
			ui as unknown as TUI,
			text => text,
			text => text,
			"Checking",
			["0"],
		);

		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);

		loader.setMessage("Still checking");
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);
		expect(loader.render(30).join("\n")).toContain("0 Still checking");

		loader.stop();
	});

	it("skips animated render requests when composed text is unchanged before the spinner advances", () => {
		vi.useFakeTimers();
		const ui = { requestDirectWrite: vi.fn(), requestComponentRender: vi.fn() };
		const colorMessage = ((text: string) => text) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["0", "1"]);

		expect(ui.requestDirectWrite).toHaveBeenCalledTimes(1);
		expect(ui.requestComponentRender).not.toHaveBeenCalled();

		vi.advanceTimersByTime(34);
		expect(ui.requestDirectWrite).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(67);
		expect(ui.requestDirectWrite).toHaveBeenCalledTimes(2);
		expect(ui.requestComponentRender).not.toHaveBeenCalled();
		expect(loader.render(20).join("\n")).toContain("1 Checking");

		loader.stop();
	});

	it("requests direct writes for message changes but not repeated identical messages", () => {
		vi.useFakeTimers();
		const ui = { requestDirectWrite: vi.fn(), requestComponentRender: vi.fn() };
		const loader = new Loader(
			ui as unknown as TUI,
			text => text,
			text => text,
			"Checking",
			["0"],
		);

		expect(ui.requestDirectWrite).toHaveBeenCalledTimes(1);
		expect(ui.requestComponentRender).not.toHaveBeenCalled();

		loader.setMessage("Still checking");
		expect(ui.requestDirectWrite).toHaveBeenCalledTimes(2);
		expect(loader.render(30).join("\n")).toContain("0 Still checking");

		loader.setMessage("Still checking");
		expect(ui.requestDirectWrite).toHaveBeenCalledTimes(2);
		expect(ui.requestComponentRender).not.toHaveBeenCalled();

		loader.stop();
	});

	it("requests direct writes when animated message bytes change between spinner frames", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const ui = { synchronizedOutput: true, tryDirectWrite: vi.fn(() => true), requestComponentRender: vi.fn() };
		const colorMessage = ((text: string) => `${text}-${Date.now()}`) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["0"]);

		expect(ui.tryDirectWrite).toHaveBeenCalledTimes(1);
		expect(ui.requestComponentRender).not.toHaveBeenCalled();

		vi.advanceTimersByTime(34);
		expect(ui.tryDirectWrite).toHaveBeenCalledTimes(2);
		expect(ui.requestComponentRender).not.toHaveBeenCalled();
		expect(loader.render(40).join("\n")).toContain("0 Checking-");

		loader.stop();
	});

	it("backs off animated paints when direct writes consume the frame budget", () => {
		vi.useFakeTimers();
		let now = 0;
		const ui = {
			synchronizedOutput: true,
			tryDirectWrite: vi.fn(() => {
				now += 40;
				return true;
			}),
			requestComponentRender: vi.fn(),
		};
		const colorMessage = ((text: string) => text) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		spyOn(performance, "now").mockImplementation(() => now);
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["0"]);

		expect(ui.tryDirectWrite).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(34);
		expect(ui.tryDirectWrite).toHaveBeenCalledTimes(2);

		vi.advanceTimersByTime(200);
		expect(ui.tryDirectWrite).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(160);
		expect(ui.tryDirectWrite).toHaveBeenCalledTimes(3);
		expect(ui.requestComponentRender).not.toHaveBeenCalled();

		loader.stop();
	});

	it("reuses text layout when only animated ANSI styling changes", () => {
		vi.useFakeTimers();
		let colorFrame = 0;
		const ui = { synchronizedOutput: true, requestDirectWrite: vi.fn(), requestComponentRender: vi.fn() };
		const colorMessage = ((text: string) => `\x1b[3${colorFrame++ % 3}m${text}\x1b[0m`) as LoaderMessageColorFn & {
			animated: true;
		};
		colorMessage.animated = true;
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["⠸"]);
		const stringWidth = spyOn(Bun, "stringWidth");

		const initial = loader.render(40);
		stringWidth.mockClear();
		vi.advanceTimersByTime(34);
		const animated = loader.render(40);

		expect(ui.requestDirectWrite).toHaveBeenCalledTimes(2);
		expect(stringWidth).not.toHaveBeenCalled();
		expect(initial[1]).not.toBe(animated[1]);
		expect(visibleWidth(initial[1])).toBe(visibleWidth(animated[1]));
		loader.stop();
	});

	it("reuses the wrapped layout across static spinner frames without re-measuring", () => {
		vi.useFakeTimers();
		const ui = { synchronizedOutput: true, requestDirectWrite: vi.fn(), requestComponentRender: vi.fn() };
		const loader = new Loader(
			ui as unknown as TUI,
			s => s,
			m => m,
			"Checking",
			["⠋", "⠙", "⠹"],
		);
		const stringWidth = spyOn(Bun, "stringWidth");

		const initial = loader.render(40);
		stringWidth.mockClear();
		vi.advanceTimersByTime(80);
		const advanced = loader.render(40);

		// Advancing the spinner glyph must not re-run the wrap/width pipeline:
		// only the leading 1-cell glyph changed, so the cached layout stands.
		expect(stringWidth).not.toHaveBeenCalled();
		expect(advanced[1]).not.toBe(initial[1]);
		expect(advanced[1]).toContain("⠙ Checking");
		expect(visibleWidth(initial[1])).toBe(visibleWidth(advanced[1]));
		loader.stop();
	});

	it("rewraps custom spinner frames when their display widths differ", () => {
		vi.useFakeTimers();
		const ui = { synchronizedOutput: true, requestDirectWrite: vi.fn(), requestComponentRender: vi.fn() };
		const loader = new Loader(
			ui as unknown as TUI,
			s => s,
			m => m,
			"Load",
			["*", ">>>>"],
		);

		loader.render(8);
		vi.advanceTimersByTime(80);
		const widerFrame = loader.render(8);

		expect(widerFrame.join("\n")).toContain(">>>>");
		for (const line of widerFrame) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(8);
		}
		loader.stop();
	});

	it("holds animated message-only frames when synchronized output is unavailable", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const ui = { synchronizedOutput: false, requestDirectWrite: vi.fn(), requestComponentRender: vi.fn() };
		const colorMessage = ((text: string) => `${text}-${Date.now()}`) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["0", "1"]);

		expect(ui.requestDirectWrite).toHaveBeenCalledTimes(1);
		expect(ui.requestComponentRender).not.toHaveBeenCalled();

		vi.advanceTimersByTime(34);
		expect(ui.requestDirectWrite).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(67);
		expect(ui.requestDirectWrite).toHaveBeenCalledTimes(2);
		expect(ui.requestComponentRender).not.toHaveBeenCalled();
		expect(loader.render(40).join("\n")).toContain("1 Checking-");

		loader.stop();
	});

	it("dispose() stops the animation so no further renders are scheduled", async () => {
		const term = new VirtualTerminal(20, 4);
		const tui = new TUI(term);
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Checking",
			["a", "b", "c"],
		);
		const spy = spyOn(tui, "requestDirectWrite");
		loader.dispose();
		const after = spy.mock.calls.length;
		await Bun.sleep(40); // longer than the spinner interval
		expect(spy.mock.calls.length).toBe(after);
		expect(() => loader.dispose()).not.toThrow(); // idempotent
		tui.stop();
	});

	it("container disposeChildren stops detached loader repaints", () => {
		vi.useFakeTimers();
		const term = new VirtualTerminal(20, 4);
		const tui = new TUI(term);
		const spy = spyOn(tui, "requestDirectWrite");
		const container = new Container();
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Checking",
			["0", "1"],
		);
		container.addChild(loader);
		const afterMount = spy.mock.calls.length;

		container.disposeChildren();
		vi.advanceTimersByTime(200);

		expect(spy.mock.calls.length).toBe(afterMount);
		expect(container.children).toEqual([]);
		tui.stop();
	});
	it("advances the spinner by exactly one frame after a long event-loop stall with no catch-up across the next few ticks", () => {
		vi.useFakeTimers();
		// Bun's `vi.useFakeTimers()` drives timers but not `performance.now()`.
		let perfNow = 1_000;
		const perfSpy = spyOn(performance, "now").mockImplementation(() => perfNow);
		const colorMessage = ((s: string) => s) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		const ui = { requestDirectWrite: vi.fn(), requestComponentRender: vi.fn() };
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["0", "1", "2", "3"]);

		perfNow = 1_033;
		vi.advanceTimersByTime(33);
		expect(loader.render(20).join("\n")).toContain("0 Checking");

		// A 300ms stall advances one frame, not floor(300 / 80) frames.
		perfNow = 1_333;
		vi.advanceTimersByTime(33);
		expect(loader.render(20).join("\n")).toContain("1 Checking");

		// The missed-time surplus is discarded; normal 33ms ticks resume from now.
		perfNow = 1_366;
		vi.advanceTimersByTime(33);
		expect(loader.render(20).join("\n")).toContain("1 Checking");
		perfNow = 1_399;
		vi.advanceTimersByTime(33);
		expect(loader.render(20).join("\n")).toContain("1 Checking");
		perfNow = 1_432;
		vi.advanceTimersByTime(33);
		expect(loader.render(20).join("\n")).toContain("2 Checking");

		loader.stop();
		perfSpy.mockRestore();
	});
});
