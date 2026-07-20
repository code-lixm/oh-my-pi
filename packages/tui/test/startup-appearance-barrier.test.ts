import { describe, expect, it } from "bun:test";
import { type Component, type RenderScheduler, type RenderTimer, TUI } from "@oh-my-pi/pi-tui";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";

class MutableLineComponent implements Component {
	#line: string;

	constructor(line: string) {
		this.#line = line;
	}

	setLine(line: string): void {
		this.#line = line;
	}

	invalidate(): void {}

	render(): readonly string[] {
		return [this.#line];
	}
}

class ManualRenderScheduler implements RenderScheduler {
	nowMs = 0;
	readonly immediates: Array<() => void> = [];
	readonly timers: Array<{ at: number; callback: () => void; canceled: boolean }> = [];

	now(): number {
		return this.nowMs;
	}

	scheduleImmediate(callback: () => void): void {
		this.immediates.push(callback);
	}

	scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const timer = { at: this.nowMs + Math.max(0, delayMs), callback, canceled: false };
		this.timers.push(timer);
		return {
			cancel: () => {
				timer.canceled = true;
			},
		};
	}

	flushImmediates(): void {
		while (this.immediates.length > 0) {
			const callbacks = this.immediates.splice(0);
			for (const callback of callbacks) callback();
		}
	}

	advanceBy(ms: number): void {
		this.flushImmediates();
		this.nowMs += ms;
		while (true) {
			const due = this.timers.filter(timer => !timer.canceled && timer.at <= this.nowMs).sort((a, b) => a.at - b.at);
			if (due.length === 0) break;
			for (const timer of due) {
				timer.canceled = true;
				timer.callback();
				this.flushImmediates();
			}
		}
		this.flushImmediates();
	}
}
async function withEnvPatch<T>(patch: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const key in patch) {
		saved[key] = Bun.env[key];
		const value = patch[key];
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
	try {
		return await run();
	} finally {
		for (const key in saved) {
			const value = saved[key];
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
	}
}

const STARTUP_SYNC_WAIT_ENV: Record<string, string | undefined> = {
	TMUX: "1",
	STY: undefined,
	ZELLIJ: undefined,
	TERM_FEATURES: undefined,
	WT_SESSION: undefined,
	PI_NO_SYNC_OUTPUT: undefined,
	PI_FORCE_SYNC_OUTPUT: undefined,
	PI_TUI_SYNC_OUTPUT: undefined,
};

const SYNC_OUTPUT_BEGIN = "\x1b[?2026h";
const SYNC_OUTPUT_END = "\x1b[?2026l";

class AppearanceTerminal implements Terminal {
	columns = 40;
	rows = 6;
	kittyProtocolActive = false;
	kittyEnableSequence: string | null = null;
	keyboardEnhancementEnterSequence: string | null = null;
	keyboardEnhancementExitSequence: string | null = null;
	writes: string[] = [];
	#appearance: TerminalAppearance | undefined;
	#appearanceCallbacks: Array<(appearance: TerminalAppearance) => void> = [];
	#privateModeCallbacks: Array<(mode: number, supported: boolean, confirmed?: boolean) => void> = [];

	constructor(appearance?: TerminalAppearance) {
		this.#appearance = appearance;
	}

	get appearance(): TerminalAppearance | undefined {
		return this.#appearance;
	}

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}

	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void {
		this.#appearanceCallbacks.push(callback);
		if (this.#appearance) callback(this.#appearance);
	}

	onPrivateModeReport(callback: (mode: number, supported: boolean, confirmed?: boolean) => void): void {
		this.#privateModeCallbacks.push(callback);
	}

	setAppearance(appearance: TerminalAppearance): void {
		if (appearance === this.#appearance) return;
		this.#appearance = appearance;
		for (const callback of this.#appearanceCallbacks) callback(appearance);
	}

	reportPrivateMode(mode: number, supported: boolean, confirmed: boolean): void {
		for (const callback of this.#privateModeCallbacks) callback(mode, supported, confirmed);
	}
}

describe("TUI startup barriers", () => {
	it("holds the first paint until appearance resolves, then flushes only the latest queued frame", () => {
		const term = new AppearanceTerminal();
		const scheduler = new ManualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const content = new MutableLineComponent("frame-0");
		tui.addChild(content);

		try {
			tui.start({ clearScrollback: true, waitForAppearanceMs: 100 });
			scheduler.flushImmediates();
			expect(term.writes.filter(write => write.includes("frame-"))).toEqual([]);

			content.setLine("frame-1");
			tui.requestRender();
			scheduler.flushImmediates();
			expect(term.writes.filter(write => write.includes("frame-"))).toEqual([]);

			content.setLine("frame-2");
			tui.requestRender();
			scheduler.flushImmediates();
			expect(term.writes.filter(write => write.includes("frame-"))).toEqual([]);

			term.setAppearance("dark");
			scheduler.flushImmediates();

			const paintWrites = term.writes.filter(write => write.includes("frame-"));
			expect(paintWrites).toHaveLength(1);
			const firstPaint = paintWrites[0]!;
			expect(firstPaint).toContain("frame-2");
			expect(term.writes.some(write => write.includes("frame-0"))).toBe(false);
			expect(term.writes.some(write => write.includes("frame-1"))).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("falls back to a timeout-first paint when appearance never resolves", () => {
		const term = new AppearanceTerminal();
		const scheduler = new ManualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const content = new MutableLineComponent("timeout-0");
		tui.addChild(content);

		try {
			tui.start({ clearScrollback: true, waitForAppearanceMs: 100 });
			scheduler.flushImmediates();
			expect(term.writes.filter(write => write.includes("timeout-"))).toEqual([]);

			content.setLine("timeout-1");
			tui.requestRender();
			scheduler.flushImmediates();
			expect(term.writes.filter(write => write.includes("timeout-"))).toEqual([]);

			scheduler.advanceBy(99);
			expect(term.writes.filter(write => write.includes("timeout-"))).toEqual([]);

			scheduler.advanceBy(1);
			const paintWrites = term.writes.filter(write => write.includes("timeout-"));
			expect(paintWrites).toHaveLength(1);
			const firstPaint = paintWrites[0]!;
			expect(firstPaint).toContain("timeout-1");
			expect(term.writes.some(write => write.includes("timeout-0"))).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("keeps scheduling the initial paint immediately when no appearance wait is requested", () => {
		const term = new AppearanceTerminal();
		const scheduler = new ManualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const content = new MutableLineComponent("instant-frame");
		tui.addChild(content);

		try {
			tui.start({ clearScrollback: true });
			expect(term.writes.filter(write => write.includes("instant-frame"))).toEqual([]);

			scheduler.flushImmediates();
			const paintWrites = term.writes.filter(write => write.includes("instant-frame"));
			expect(paintWrites).toHaveLength(1);
			const firstPaint = paintWrites[0]!;
			expect(firstPaint).toContain("instant-frame");
		} finally {
			tui.stop();
		}
	});
	it("holds the first paint until a confirmed DEC 2026 report, then flushes only the latest queued frame inside a sync wrapper", async () => {
		await withEnvPatch(STARTUP_SYNC_WAIT_ENV, async () => {
			const term = new AppearanceTerminal();
			const scheduler = new ManualRenderScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			expect(tui.synchronizedOutput).toBe(false);
			const content = new MutableLineComponent("sync-frame-0");
			tui.addChild(content);

			try {
				tui.start({ clearScrollback: true, waitForSynchronizedOutputMs: 100 });
				scheduler.flushImmediates();
				expect(term.writes.filter(write => write.includes("sync-frame-"))).toEqual([]);

				content.setLine("sync-frame-1");
				tui.requestRender();
				scheduler.flushImmediates();
				expect(term.writes.filter(write => write.includes("sync-frame-"))).toEqual([]);

				content.setLine("sync-frame-2");
				tui.requestRender();
				scheduler.flushImmediates();
				expect(term.writes.filter(write => write.includes("sync-frame-"))).toEqual([]);

				term.reportPrivateMode(2026, true, true);
				scheduler.flushImmediates();

				const paintWrites = term.writes.filter(write => write.includes("sync-frame-"));
				expect(paintWrites).toHaveLength(1);
				const firstPaint = paintWrites[0]!;
				expect(firstPaint).toContain("sync-frame-2");
				expect(firstPaint).toContain(SYNC_OUTPUT_BEGIN);
				expect(firstPaint).toContain(SYNC_OUTPUT_END);
				expect(term.writes.some(write => write.includes("sync-frame-0"))).toBe(false);
				expect(term.writes.some(write => write.includes("sync-frame-1"))).toBe(false);
				expect(tui.synchronizedOutput).toBe(true);
			} finally {
				tui.stop();
			}
		});
	});

	it("falls back to a timeout-first paint when DEC 2026 confirmation never arrives", async () => {
		await withEnvPatch(STARTUP_SYNC_WAIT_ENV, async () => {
			const term = new AppearanceTerminal();
			const scheduler = new ManualRenderScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			expect(tui.synchronizedOutput).toBe(false);
			const content = new MutableLineComponent("sync-timeout-0");
			tui.addChild(content);

			try {
				tui.start({ clearScrollback: true, waitForSynchronizedOutputMs: 100 });
				scheduler.flushImmediates();
				expect(term.writes.filter(write => write.includes("sync-timeout-"))).toEqual([]);

				content.setLine("sync-timeout-1");
				tui.requestRender();
				scheduler.flushImmediates();
				expect(term.writes.filter(write => write.includes("sync-timeout-"))).toEqual([]);

				scheduler.advanceBy(99);
				expect(term.writes.filter(write => write.includes("sync-timeout-"))).toEqual([]);

				scheduler.advanceBy(1);
				const paintWrites = term.writes.filter(write => write.includes("sync-timeout-"));
				expect(paintWrites).toHaveLength(1);
				const firstPaint = paintWrites[0]!;
				expect(firstPaint).toContain("sync-timeout-1");
				expect(term.writes.some(write => write.includes("sync-timeout-0"))).toBe(false);
			} finally {
				tui.stop();
			}
		});
	});

	it("does not paint when appearance resolves before the synchronized-output barrier releases", async () => {
		await withEnvPatch(STARTUP_SYNC_WAIT_ENV, async () => {
			const term = new AppearanceTerminal();
			const scheduler = new ManualRenderScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			expect(tui.synchronizedOutput).toBe(false);
			const content = new MutableLineComponent("appearance-first-0");
			tui.addChild(content);

			try {
				tui.start({ clearScrollback: true, waitForAppearanceMs: 100, waitForSynchronizedOutputMs: 100 });
				scheduler.flushImmediates();
				expect(term.writes.filter(write => write.includes("appearance-first-"))).toEqual([]);

				content.setLine("appearance-first-1");
				tui.requestRender();
				scheduler.flushImmediates();
				term.setAppearance("dark");
				scheduler.flushImmediates();
				expect(term.writes.filter(write => write.includes("appearance-first-"))).toEqual([]);

				content.setLine("appearance-first-2");
				tui.requestRender();
				scheduler.flushImmediates();
				expect(term.writes.filter(write => write.includes("appearance-first-"))).toEqual([]);

				term.reportPrivateMode(2026, true, true);
				scheduler.flushImmediates();

				const paintWrites = term.writes.filter(write => write.includes("appearance-first-"));
				expect(paintWrites).toHaveLength(1);
				const firstPaint = paintWrites[0]!;
				expect(firstPaint).toContain("appearance-first-2");
				expect(firstPaint).toContain(SYNC_OUTPUT_BEGIN);
				expect(firstPaint).toContain(SYNC_OUTPUT_END);
			} finally {
				tui.stop();
			}
		});
	});

	it("does not paint when DEC 2026 confirms before the appearance barrier releases", async () => {
		await withEnvPatch(STARTUP_SYNC_WAIT_ENV, async () => {
			const term = new AppearanceTerminal();
			const scheduler = new ManualRenderScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			expect(tui.synchronizedOutput).toBe(false);
			const content = new MutableLineComponent("sync-first-0");
			tui.addChild(content);

			try {
				tui.start({ clearScrollback: true, waitForAppearanceMs: 100, waitForSynchronizedOutputMs: 100 });
				scheduler.flushImmediates();
				expect(term.writes.filter(write => write.includes("sync-first-"))).toEqual([]);

				content.setLine("sync-first-1");
				tui.requestRender();
				scheduler.flushImmediates();
				term.reportPrivateMode(2026, true, true);
				scheduler.flushImmediates();
				expect(term.writes.filter(write => write.includes("sync-first-"))).toEqual([]);
				expect(tui.synchronizedOutput).toBe(true);

				content.setLine("sync-first-2");
				tui.requestRender();
				scheduler.flushImmediates();
				expect(term.writes.filter(write => write.includes("sync-first-"))).toEqual([]);

				term.setAppearance("dark");
				scheduler.flushImmediates();

				const paintWrites = term.writes.filter(write => write.includes("sync-first-"));
				expect(paintWrites).toHaveLength(1);
				const firstPaint = paintWrites[0]!;
				expect(firstPaint).toContain("sync-first-2");
				expect(firstPaint).toContain(SYNC_OUTPUT_BEGIN);
				expect(firstPaint).toContain(SYNC_OUTPUT_END);
			} finally {
				tui.stop();
			}
		});
	});
});
