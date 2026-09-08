import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, type RenderScheduler, visibleWidth } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

class ResizeScheduler implements RenderScheduler {
	#now = 0;
	#pending = new Set<() => void>();

	now(): number {
		return this.#now;
	}

	scheduleImmediate(callback: () => void) {
		callback();
		return { cancel() {} };
	}

	scheduleRender(callback: () => void, _delayMs: number) {
		this.#pending.add(callback);
		return { cancel: () => this.#pending.delete(callback) };
	}

	settle(): void {
		this.#now += 120;
		const pending = [...this.#pending];
		this.#pending.clear();
		for (const callback of pending) callback();
	}
	advance(ms: number): void {
		this.#now += ms;
	}
}

class MutableComposerTail implements Component {
	status = "thinking low";

	invalidate(): void {}

	render(): readonly string[] {
		return ["╭─ EDITOR TOP ─╮", `│ ${this.status} │`, "╰─ EDITOR BOTTOM ─╯"];
	}
}
class WidthTranscriptBlock implements Component {
	constructor(readonly id: number) {}

	renderCount = 0;

	render(width: number): readonly string[] {
		this.renderCount++;
		return [`block-${this.id}@${width}`];
	}
	isTranscriptBlockFinalized(): boolean {
		return true;
	}
}

class TrackingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

function plainBuffer(terminal: VirtualTerminal): string[] {
	return terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
}

function rowOf(rows: readonly string[], needle: string): number {
	return rows.findIndex(row => row.includes(needle));
}

function countRows(rows: readonly string[], needle: string): number {
	return rows.filter(row => row.includes(needle)).length;
}

function expectOneExactEditor(rows: readonly string[], status: string): number {
	const top = rowOf(rows, "EDITOR TOP");
	expect(countRows(rows, "EDITOR TOP")).toBe(1);
	expect(countRows(rows, status)).toBe(1);
	expect(countRows(rows, "EDITOR BOTTOM")).toBe(1);
	expect(rowOf(rows, status)).toBe(top + 1);
	expect(rowOf(rows, "EDITOR BOTTOM")).toBe(top + 2);
	return top;
}

function startRetiredWelcome(modelName: string): { composer: Composer; terminal: TrackingTerminal } {
	const terminal = new TrackingTerminal(80, 12);
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: new ResizeScheduler() },
		preferences: { ...COMPOSER_DEFAULTS, quiet: false, resizeScrollback: "preserve" },
		welcome: { version: "test", modelName, providerName: "test-provider" },
	});
	composer.setRuntimeChildren([new TranscriptContainer(), new MutableComposerTail()]);
	composer.start({ playWelcomeIntro: false });
	return { composer, terminal };
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("composer welcome native-history resize", () => {
	it("keeps one exact editor rectangle and retired welcome through repeated thinking and resize frames", async () => {
		// Select the long auth-broker tip: it retires as three hard rows at
		// width 80 and must not be recomposed into fewer rows after widening.
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const terminal = new TrackingTerminal(80, 12);
		const scheduler = new ResizeScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: false, resizeScrollback: "preserve" },
			welcome: { version: "test", modelName: "test-model", providerName: "test-provider" },
		});
		const offered: number[] = [];
		const acknowledged: number[] = [];
		let resizeFrames = 0;
		const renderFrame = composer.renderFrame.bind(composer);
		const renderResizeFrame = composer.renderResizeFrame.bind(composer);
		const acknowledgeHistory = composer.acknowledgeHistory.bind(composer);
		composer.renderFrame = viewport => {
			const plan = renderFrame(viewport);
			if (plan.history) offered.push(plan.history.id);
			return plan;
		};
		composer.renderResizeFrame = viewport => {
			resizeFrames++;
			return renderResizeFrame(viewport);
		};
		composer.acknowledgeHistory = id => {
			acknowledged.push(id);
			acknowledgeHistory(id);
		};

		const transcript = new TranscriptContainer();
		const tail = new MutableComposerTail();
		composer.setRuntimeChildren([transcript, tail]);
		composer.start({ playWelcomeIntro: false });

		expect(countRows(plainBuffer(terminal), "Welcome back!")).toBe(1);
		expect(offered).toHaveLength(1);
		expect(acknowledged).toEqual(offered);
		const initialAnchor = expectOneExactEditor(
			terminal.getViewport().map(row => Bun.stripANSI(row)),
			tail.status,
		);
		expect(initialAnchor).toBe(9);
		const writesAfterRetirement = terminal.writes.length;

		for (let index = 0; index < 40; index++) {
			tail.status = index % 2 === 0 ? "thinking high" : "thinking low";
			composer.ui.requestRender(true);
			const viewport = terminal.getViewport().map(row => Bun.stripANSI(row));
			expect(expectOneExactEditor(viewport, tail.status)).toBe(initialAnchor);
			expect(countRows(plainBuffer(terminal), "Welcome back!")).toBe(1);
		}
		expect(offered).toHaveLength(1);
		expect(acknowledged).toHaveLength(1);

		let lastTransient: string[] = [];
		for (const [columns, rows] of [
			[96, 28],
			[104, 30],
			[100, 34],
		] as const) {
			terminal.resize(columns, rows);
			lastTransient = terminal.getViewport().map(row => Bun.stripANSI(row));
			expect(countRows(lastTransient, "Welcome back!")).toBe(1);
			expectOneExactEditor(lastTransient, tail.status);
		}
		expect(resizeFrames).toBe(3);
		scheduler.settle();
		// The settled anchor repaint waits on the CPR reply, which VirtualTerminal
		// delivers on a microtask — drain it before reading the normal screen.
		await terminal.flush();

		let settledViewport = terminal.getViewport().map(row => Bun.stripANSI(row));
		expect(countRows(settledViewport, "Welcome back!")).toBe(1);
		expect(rowOf(settledViewport, "Welcome back!")).toBe(rowOf(lastTransient, "Welcome back!"));
		expect(expectOneExactEditor(settledViewport, tail.status)).toBe(expectOneExactEditor(lastTransient, tail.status));
		expect(countRows(plainBuffer(terminal), "EDITOR TOP")).toBe(1);
		scheduler.advance(101);

		for (const [columns, rows] of [
			[92, 30],
			[72, 50],
		] as const) {
			terminal.resize(columns, rows);
			lastTransient = terminal.getViewport().map(row => Bun.stripANSI(row));
			expect(countRows(lastTransient, "Welcome back!")).toBe(1);
			expectOneExactEditor(lastTransient, tail.status);
		}
		expect(resizeFrames).toBe(5);
		scheduler.settle();
		await terminal.flush();

		settledViewport = terminal.getViewport().map(row => Bun.stripANSI(row));
		expect(countRows(settledViewport, "Welcome back!")).toBe(1);
		expect(expectOneExactEditor(settledViewport, tail.status)).toBeGreaterThan(
			rowOf(settledViewport, "Welcome back!"),
		);
		expect(countRows(plainBuffer(terminal), "EDITOR TOP")).toBe(1);
		expect(offered).toHaveLength(1);
		expect(acknowledged).toHaveLength(1);
		expect(terminal.writes.slice(writesAfterRetirement).some(write => write.includes("\x1b[3J"))).toBe(false);
		composer.ui.stop();
	});

	it("preserves a wide glyph that straddles a retired-row resize boundary", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const { composer, terminal } = startRetiredWelcome("model-aaaa界-tail");
		const accepted = plainBuffer(terminal).find(row => row.includes("界"));
		expect(accepted).toBeDefined();
		const glyphIndex = accepted!.indexOf("界");
		const width = visibleWidth(accepted!.slice(0, glyphIndex)) + 1;
		expect(width).toBeLessThan(80);

		const resizeFrame = composer.renderResizeFrame({ columns: width, rows: 200 }).map(row => Bun.stripANSI(row));
		expect(countRows(resizeFrame, "界")).toBe(1);

		terminal.resize(width, 200);

		const transient = terminal.getViewport().map(row => Bun.stripANSI(row));
		expect(countRows(transient, "界")).toBe(1);
		composer.ui.stop();
	});
	it("clips retired hard rows instead of reflowing them inside a multiplexer", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		Bun.env.TMUX = "/tmp/tmux-test/default,1,0";
		const marker = "MUX-SUFFIX";
		const { composer, terminal } = startRetiredWelcome(`model-aaaa${marker}`);
		const accepted = plainBuffer(terminal).find(row => row.includes(marker));
		expect(accepted).toBeDefined();
		expect(visibleWidth(accepted!)).toBeLessThanOrEqual(80);
		const markerIndex = accepted!.indexOf(marker);
		const width = visibleWidth(accepted!.slice(0, markerIndex)) - 1;
		expect(width).toBeGreaterThan(1);

		const resizeFrame = composer.renderResizeFrame({ columns: width, rows: 200 }).map(row => Bun.stripANSI(row));
		expect(countRows(resizeFrame, marker)).toBe(1);

		terminal.resize(width, 200);

		const transient = terminal.getViewport().map(row => Bun.stripANSI(row));
		expect(countRows(transient, marker)).toBe(0);
		composer.ui.stop();
	});
	it("renders only the visible transcript tail during a resize frame", async () => {
		const terminal = new VirtualTerminal(30, 4);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		const blocks = Array.from({ length: 30 }, (_, id) => new WidthTranscriptBlock(id));
		for (const block of blocks) transcript.addChild(block);
		const tail = new MutableComposerTail();
		composer.setRuntimeChildren([transcript, tail]);

		try {
			composer.start({ playWelcomeIntro: false });
			await scheduler.settle(terminal);
			for (const block of blocks) block.renderCount = 0;

			const frame = composer.renderResizeFrame({ columns: 30, rows: 4 });
			const plainFrame = frame.map(row => Bun.stripANSI(row));
			expect(plainFrame).toContain("block-29@30");
			expectOneExactEditor(plainFrame, tail.status);
			expect(blocks.slice(0, 29).every(block => block.renderCount === 0)).toBe(true);
			expect(blocks[29]!.renderCount).toBeGreaterThan(0);
		} finally {
			composer.ui.stop();
		}
	});

	it("replays a completed restored transcript into native scrollback after clearing history", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		transcript.addChild(new WidthTranscriptBlock(99));
		composer.setRuntimeChildren([transcript, new MutableComposerTail()]);

		try {
			composer.start({ playWelcomeIntro: false });
			await scheduler.settle(terminal);

			// renderInitialMessages() clears the visible container, mounts the completed
			// replay, paints its tail, then requests this destructive provider repaint.
			transcript.clear();
			for (let id = 0; id < 10; id++) transcript.addChild(new WidthTranscriptBlock(id));
			composer.ui.paintViewportTail();
			composer.ui.requestRender(true, { clearScrollback: true });
			await scheduler.settle(terminal);

			const restoredPosition = terminal.getBufferPosition();
			expect(restoredPosition.baseY).toBeGreaterThan(0);
			expect(restoredPosition.viewportY).toBe(restoredPosition.baseY);

			terminal.scrollLines(-Number.MAX_SAFE_INTEGER);
			const historyPosition = terminal.getBufferPosition();
			expect(historyPosition.viewportY).toBeLessThan(historyPosition.baseY);
			const historyViewport = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			expect(historyViewport).toContain("block-0@20");

			terminal.scrollLines(Number.MAX_SAFE_INTEGER);
			const bottomPosition = terminal.getBufferPosition();
			expect(bottomPosition.viewportY).toBe(bottomPosition.baseY);
			const bottomViewport = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			expect(bottomViewport).toContain("block-9@20");
		} finally {
			composer.stop();
		}
	});

	it("preserves native history and reader position across resize before appending new rows at bottom", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		for (let id = 0; id < 4; id++) transcript.addChild(new WidthTranscriptBlock(id));
		const tail = new MutableComposerTail();
		composer.setRuntimeChildren([transcript, tail]);

		try {
			composer.start({ playWelcomeIntro: false });
			await scheduler.settle(terminal);

			expect(plainBuffer(terminal)).toContain("block-0@20");
			terminal.scrollLines(-1);
			const beforePosition = terminal.getBufferPosition();
			const beforeViewport = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd().replace(/@\d+$/u, "@"));
			expect(beforePosition.viewportY).toBeLessThan(beforePosition.baseY);

			terminal.resize(30, 4);
			await scheduler.advance(terminal, 160);

			const afterPosition = terminal.getBufferPosition();
			const afterViewport = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd().replace(/@\d+$/u, "@"));
			expect(afterPosition.viewportY).toBe(beforePosition.viewportY);
			expect(afterPosition.viewportY).toBeLessThan(afterPosition.baseY);
			expect(afterViewport).toEqual(beforeViewport);
			const resizedBuffer = plainBuffer(terminal);
			const resizedHistory = resizedBuffer.slice(0, afterPosition.baseY);
			for (let id = 0; id < 3; id++) expect(resizedHistory).toContain(`block-${id}@20`);
			expect(resizedHistory.some(row => /@\d+$/u.test(row) && !row.endsWith("@20"))).toBe(false);
			expect(resizedBuffer).not.toContain("block-0@30");
			expect(resizedBuffer).not.toContain("block-1@30");
			expect(resizedBuffer).not.toContain("block-2@30");
			expect(resizedBuffer).toContain("block-3@30");

			terminal.scrollLines(Number.MAX_SAFE_INTEGER);
			const bottomBeforeAppend = terminal.getBufferPosition();
			expect(bottomBeforeAppend.viewportY).toBe(bottomBeforeAppend.baseY);
			const latest = new WidthTranscriptBlock(4);
			transcript.addChild(latest);
			composer.ui.requestRender(true);
			await scheduler.settle(terminal);

			const finalPosition = terminal.getBufferPosition();
			expect(finalPosition.viewportY).toBe(finalPosition.baseY);
			const finalViewport = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			const finalBuffer = plainBuffer(terminal);
			expect(finalViewport.some(row => row.includes("block-4@30"))).toBe(true);
			expect(finalBuffer.some(row => row.includes("block-4@30"))).toBe(true);
		} finally {
			composer.ui.stop();
		}
	});
});
