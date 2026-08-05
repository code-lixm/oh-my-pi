import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, type RenderScheduler, TUI } from "@oh-my-pi/pi-tui";
import { LoopWatchdog } from "@oh-my-pi/pi-tui/loop-watchdog";
import { currentLoopPhase, popLoopPhase, pushLoopPhase, takeRecentLoopPhase } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "./virtual-terminal";

class DeferredRenderScheduler implements RenderScheduler {
	#immediates: Array<() => void> = [];
	#renders: Array<{ callback: () => void; canceled: boolean }> = [];

	now(): number {
		return 0;
	}

	scheduleImmediate(callback: () => void): void {
		this.#immediates.push(callback);
	}

	scheduleRender(callback: () => void, _delayMs: number) {
		const render = { callback, canceled: false };
		this.#renders.push(render);
		return {
			cancel: () => {
				render.canceled = true;
			},
		};
	}

	runNextImmediate(): void {
		const callback = this.#immediates.shift();
		if (callback === undefined) throw new Error("expected TUI to schedule an immediate render");
		callback();
	}
}

class LoopPhaseProbe implements Component {
	phaseDuringRender: string | undefined;

	constructor(private readonly throwDuringRender = false) {}

	render(_width: number): readonly string[] {
		this.phaseDuringRender = currentLoopPhase();
		if (this.throwDuringRender) throw new Error("intentional render failure");
		return ["loop-phase-probe"];
	}
}

function clearLoopPhaseState(): void {
	while (currentLoopPhase() !== undefined) popLoopPhase();
	takeRecentLoopPhase();
}

/**
 * Contract: the user-visible loop-blocked diagnostic depends on `TUI.start()`
 * arming the watchdog and `TUI.stop()` disarming it. The unit tests exercise
 * `LoopWatchdog` in isolation, so this guards the wiring itself — dropping
 * either TUI call would leave a live session with no loop-block logging while
 * every `LoopWatchdog` unit test still passed.
 *
 * The synchronous TUI render/paint path is also a watchdog attribution boundary:
 * component render work must run under `ui.render`, and an exception must restore
 * the phase stack that entered the render so later work is not misattributed.
 */
describe("TUI loop-watchdog wiring", () => {
	beforeEach(clearLoopPhaseState);

	afterEach(() => {
		vi.restoreAllMocks();
		clearLoopPhaseState();
	});

	it("arms the watchdog on start() and disarms it on stop()", () => {
		const startSpy = vi.spyOn(LoopWatchdog.prototype, "start");
		const stopSpy = vi.spyOn(LoopWatchdog.prototype, "stop");
		const tui = new TUI(new VirtualTerminal(80, 24));

		try {
			tui.start();
			expect(startSpy).toHaveBeenCalledTimes(1);

			tui.stop();
			expect(stopSpy).toHaveBeenCalledTimes(1);
		} finally {
			tui.stop();
		}
	});

	it("marks a real scheduled TUI render as ui.render", () => {
		const terminal = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const probe = new LoopPhaseProbe();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.addChild(probe);

		try {
			tui.start();
			scheduler.runNextImmediate();

			expect(probe.phaseDuringRender).toBe("ui.render");
		} finally {
			tui.stop();
		}
	});

	it("restores the entered active phase stack when a TUI render throws", () => {
		const terminal = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const probe = new LoopPhaseProbe(true);
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.addChild(probe);

		try {
			tui.start();
			pushLoopPhase("test.enclosing-phase");
			try {
				expect(() => scheduler.runNextImmediate()).toThrow("intentional render failure");

				expect(probe.phaseDuringRender).toBe("ui.render");
				expect(currentLoopPhase()).toBe("test.enclosing-phase");
			} finally {
				popLoopPhase();
			}
		} finally {
			tui.stop();
		}
	});
});
