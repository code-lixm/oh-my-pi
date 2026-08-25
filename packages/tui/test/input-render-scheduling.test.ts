import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	type Component,
	type RenderTimer,
	TUI,
	type TuiFrameResponsivenessSample,
	type TuiResponsivenessReport,
	type TuiResponsivenessTestStage,
} from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "./virtual-terminal";

class InputProbe implements Component {
	constructor(private readonly events: string[]) {}

	revision = 0;

	invalidate(): void {}

	render(_width: number): readonly string[] {
		this.events.push("render");
		return [`probe-${this.revision}`];
	}

	handleInput(data: string): void {
		this.events.push(`input:${data}`);
	}
}

class DeferredRenderScheduler {
	nowMs = 0;
	readonly immediates: Array<() => void> = [];
	readonly timers: Array<{ callback: () => void; canceled: boolean; dueAt: number }> = [];

	now(): number {
		return this.nowMs;
	}

	advance(ms: number): void {
		this.nowMs += ms;
	}

	scheduleImmediate(callback: () => void): void {
		this.immediates.push(callback);
	}

	scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const timer = { callback, canceled: false, dueAt: this.nowMs + delayMs };
		this.timers.push(timer);
		return {
			cancel: () => {
				timer.canceled = true;
			},
		};
	}

	runNext(): boolean {
		const immediate = this.immediates.shift();
		if (immediate) {
			immediate();
			return true;
		}
		const timerIndex = this.timers.findIndex(timer => !timer.canceled);
		if (timerIndex < 0) {
			this.timers.length = 0;
			return false;
		}
		const timer = this.timers.splice(timerIndex, 1)[0]!;
		this.nowMs = Math.max(this.nowMs, timer.dueAt);
		if (!timer.canceled) timer.callback();
		return true;
	}

	drain(limit = 100): void {
		for (let step = 0; step < limit && this.runNext(); step++) {
			// Intentionally drive only queued callbacks; no wall-clock waiting.
		}
	}
}

type FrameMetric = "composeMs" | "prepareMs" | "diffMs" | "outputSubmitMs";

interface ResponsivenessFixture {
	readonly term: VirtualTerminal;
	readonly scheduler: DeferredRenderScheduler;
	readonly probe: InputProbe;
	readonly reports: TuiResponsivenessReport[];
	readonly stages: TuiResponsivenessTestStage[];
	readonly tui: TUI;
}

function createResponsivenessFixture(
	stalls: Partial<Record<TuiResponsivenessTestStage, number>> = {},
): ResponsivenessFixture {
	const term = new VirtualTerminal(20, 4);
	const scheduler = new DeferredRenderScheduler();
	const events: string[] = [];
	const probe = new InputProbe(events);
	const reports: TuiResponsivenessReport[] = [];
	const stages: TuiResponsivenessTestStage[] = [];
	let armed = false;
	const tui = new TUI(term, undefined, {
		renderScheduler: scheduler,
		responsivenessTestHooks: {
			injectStall: stage => {
				if (!armed) return;
				stages.push(stage);
				scheduler.advance(stalls[stage] ?? 0);
			},
			onReport: report => reports.push(report),
		},
	});
	tui.addChild(probe);
	tui.setFocus(probe);
	tui.start();
	scheduler.drain();
	// Keep startup rendering out of the evidence window and make each later
	// threshold breach eligible for immediate report emission.
	reports.length = 0;
	stages.length = 0;
	scheduler.advance(10_000);
	armed = true;
	return { term, scheduler, probe, reports, stages, tui };
}

function runChangedFrame(fixture: ResponsivenessFixture, force = true, queueDelayMs = 0): void {
	fixture.probe.revision++;
	fixture.tui.requestRender(force);
	if (queueDelayMs > 0) fixture.scheduler.advance(queueDelayMs);
	fixture.scheduler.drain();
}

function frameSample(reports: readonly TuiResponsivenessReport[]): TuiFrameResponsivenessSample | undefined {
	for (const report of reports) {
		const sample = report.samples.find(
			(candidate): candidate is TuiFrameResponsivenessSample => candidate.kind === "frame",
		);
		if (sample) return sample;
	}
	return undefined;
}

describe("TUI input/render scheduling", () => {
	it("can process terminal input before a deferred ordinary repaint", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const events: string[] = [];
		const probe = new InputProbe(events);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(probe);
		tui.setFocus(probe);

		try {
			tui.start();
			scheduler.immediates.shift()?.();
			const initialTimer = scheduler.timers.shift();
			if (initialTimer && !initialTimer.canceled) initialTimer.callback();
			events.length = 0;
			scheduler.nowMs = 100;

			tui.requestRender();
			term.sendInput("x");
			scheduler.immediates.shift()?.();
			const repaintTimer = scheduler.timers.shift();
			if (repaintTimer && !repaintTimer.canceled) repaintTimer.callback();

			expect(events[0]).toBe("input:x");
			expect(events).toContain("render");
		} finally {
			tui.stop();
		}
	});

	it("drains every terminal input already queued before an ordinary repaint", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const events: string[] = [];
		const probe = new InputProbe(events);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(probe);
		tui.setFocus(probe);

		try {
			tui.start();
			scheduler.immediates.shift()?.();
			const initialTimer = scheduler.timers.shift();
			if (initialTimer && !initialTimer.canceled) initialTimer.callback();
			events.length = 0;
			scheduler.nowMs = 100;

			tui.requestRender();
			term.sendInput("a");
			term.sendInput("b");
			term.sendInput("c");
			scheduler.immediates.shift()?.();
			const repaintTimer = scheduler.timers.shift();
			if (repaintTimer && !repaintTimer.canceled) repaintTimer.callback();

			expect(events).toEqual(["input:a", "input:b", "input:c", "render"]);
		} finally {
			tui.stop();
		}
	});

	it("attributes slow compose, prepare, diff, and output stages independently", () => {
		const stalls: Partial<Record<TuiResponsivenessTestStage, number>> = {
			"render.compose": 60,
			"render.prepare": 70,
			"render.diff": 80,
			"render.output": 90,
		};
		const fixture = createResponsivenessFixture(stalls);
		try {
			runChangedFrame(fixture, false, 120);
			const sample = frameSample(fixture.reports);
			expect(sample).toBeDefined();
			for (const [stage, metric, minimum] of [
				["render.compose", "composeMs", 60],
				["render.prepare", "prepareMs", 70],
				["render.diff", "diffMs", 80],
				["render.output", "outputSubmitMs", 90],
			] as const satisfies readonly [TuiResponsivenessTestStage, FrameMetric, number][]) {
				expect(fixture.stages).toContain(stage);
				expect(sample?.[metric]).toBeGreaterThanOrEqual(minimum);
			}
			expect(sample?.queueDelayMs).toBeGreaterThanOrEqual(100);
			expect(sample?.frameMs).toBeGreaterThanOrEqual(300);
			expect(sample?.outputWrites).toBeGreaterThan(0);
			expect(sample?.outputCodeUnits).toBeGreaterThan(0);
		} finally {
			fixture.tui.stop();
		}
	});

	it("notifies the compose observer once after a completed ordinary frame", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const probe = new InputProbe([]);
		const samples: number[] = [];
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(probe);

		try {
			tui.start();
			scheduler.drain();
			tui.setComposeSampleObserver(composeMs => samples.push(composeMs));
			probe.revision++;
			tui.requestRender();
			scheduler.drain();

			expect(samples).toHaveLength(1);
			const composeMs = samples[0]!;
			expect(Number.isFinite(composeMs)).toBe(true);
			expect(composeMs).toBeGreaterThanOrEqual(0);
		} finally {
			tui.stop();
		}
	});

	it("does not notify the compose observer when compose fails", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const probe = new InputProbe([]);
		const samples: number[] = [];
		let failCompose = false;
		const tui = new TUI(term, undefined, {
			renderScheduler: scheduler,
			responsivenessTestHooks: {
				injectStall: stage => {
					if (failCompose && stage === "render.compose") throw new Error("compose failed");
				},
			},
		});
		tui.addChild(probe);

		try {
			tui.start();
			scheduler.drain();
			tui.setComposeSampleObserver(composeMs => samples.push(composeMs));
			failCompose = true;
			probe.revision++;
			tui.requestRender();

			expect(() => scheduler.drain()).toThrow("compose failed");
			expect(samples).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("keeps repeated slow-frame evidence bounded while preserving event counts", () => {
		const fixture = createResponsivenessFixture({
			"render.compose": 60,
			"render.prepare": 60,
			"render.diff": 60,
			"render.output": 60,
		});
		try {
			runChangedFrame(fixture);
			for (let index = 0; index < 5; index++) runChangedFrame(fixture);
			expect(fixture.reports).toHaveLength(1);

			fixture.scheduler.advance(5_000);
			runChangedFrame(fixture);

			expect(fixture.reports).toHaveLength(2);
			expect(fixture.reports[1]).toMatchObject({ eventCount: 6, droppedSamples: 2 });
			expect(fixture.reports[1]?.samples).toHaveLength(4);
		} finally {
			fixture.tui.stop();
		}
	});

	it("separately reports delayed input dispatch and handler time", () => {
		const cases: readonly {
			name: string;
			stage: TuiResponsivenessTestStage;
			metric: "queueDelayMs" | "handlerMs";
			minimum: number;
		}[] = [
			{ name: "queued before dispatch", stage: "input.received", metric: "queueDelayMs", minimum: 100 },
			{ name: "slow input handler", stage: "input.dispatch", metric: "handlerMs", minimum: 50 },
		];

		for (const testCase of cases) {
			const fixture = createResponsivenessFixture({ [testCase.stage]: testCase.minimum + 10 });
			try {
				fixture.term.sendInput("q");
				const sample = fixture.reports
					.flatMap(report => report.samples)
					.find(candidate => candidate.kind === "input");
				expect(sample, testCase.name).toBeDefined();
				expect(fixture.stages).toContain(testCase.stage);
				expect(sample?.[testCase.metric]).toBeGreaterThanOrEqual(testCase.minimum);
				expect(sample?.inputCodeUnits).toBe(1);
			} finally {
				fixture.tui.stop();
			}
		}
	});

	it("rejects responsiveness hooks in a production-runtime child", async () => {
		const tuiSource = pathToFileURL(path.resolve(import.meta.dir, "../src/tui.ts")).href;
		const script = `
import { TUI } from ${JSON.stringify(tuiSource)};
try {
  new TUI({}, undefined, { responsivenessTestHooks: {} });
  process.stdout.write(JSON.stringify({ accepted: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    accepted: false,
    message: error instanceof Error ? error.message : String(error),
  }));
}
`;
		const tempDir = TempDir.createSync("@pi-tui-responsiveness-child-");
		try {
			const scriptPath = tempDir.join("production-runtime-child.ts");
			const stdoutPath = tempDir.join("stdout.json");
			const stderrPath = tempDir.join("stderr.log");
			await Promise.all([Bun.write(scriptPath, script), Bun.write(stdoutPath, ""), Bun.write(stderrPath, "")]);
			const child = Bun.spawn(["bun", scriptPath], {
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: {
					PATH: process.env.PATH ?? "",
					HOME: process.env.HOME ?? "",
					TMPDIR: process.env.TMPDIR ?? "",
					BUN_INSTALL: process.env.BUN_INSTALL ?? "",
					BUN_ENV: "development",
					NODE_ENV: "development",
					PI_TEST_RUNTIME: "0",
				},
				stdout: Bun.file(stdoutPath),
				stderr: Bun.file(stderrPath),
			});
			const exitCode = await child.exited;
			const [stdout, stderr] = await Promise.all([Bun.file(stdoutPath).text(), Bun.file(stderrPath).text()]);
			expect(exitCode, stderr).toBe(0);
			expect(JSON.parse(stdout)).toEqual({
				accepted: false,
				message: "TUI responsiveness test hooks are only available under Bun test",
			});
		} finally {
			await tempDir.remove();
		}
	});

	it("preempts adaptive repaint delay for input without bypassing cadence or interrupt grace", () => {
		const frameIntervalMs = 1000 / 30;
		const slowFrameMs = 20;
		for (const testCase of [
			{
				name: "ordinary repaint waits for the adaptive deadline",
				data: undefined,
				expectedDueAfterSlowFrameStart: slowFrameMs * 2,
				adaptiveRelation: "at",
			},
			{
				name: "ordinary input keeps the 30 fps cadence",
				data: "x",
				expectedDueAfterSlowFrameStart: frameIntervalMs,
				adaptiveRelation: "before",
			},
			{
				name: "Escape keeps the double-interrupt grace window",
				data: "\x1b",
				expectedDueAfterSlowFrameStart: slowFrameMs + frameIntervalMs,
				adaptiveRelation: "after",
			},
		] as const) {
			const term = new VirtualTerminal(20, 4);
			const scheduler = new DeferredRenderScheduler();
			const events: string[] = [];
			const probe = new InputProbe(events);
			let slowFrameArmed = false;
			const tui = new TUI(term, undefined, {
				renderScheduler: scheduler,
				responsivenessTestHooks: {
					injectStall: stage => {
						if (slowFrameArmed && stage === "render.compose") {
							slowFrameArmed = false;
							scheduler.advance(slowFrameMs);
						}
					},
				},
			});
			tui.addChild(probe);
			tui.setFocus(probe);

			try {
				tui.start();
				scheduler.drain();
				events.length = 0;

				const slowFrameStartedAt = scheduler.now();
				slowFrameArmed = true;
				tui.requestRender(true);
				expect(scheduler.runNext(), testCase.name).toBe(true);
				events.length = 0;

				tui.requestRender();
				expect(scheduler.runNext(), testCase.name).toBe(true);
				expect(events, testCase.name).toEqual([]);

				if (testCase.data !== undefined) {
					term.sendInput(testCase.data);
					expect(events, testCase.name).toEqual([`input:${testCase.data}`]);

					expect(scheduler.runNext(), testCase.name).toBe(true);
					expect(events, testCase.name).toEqual([`input:${testCase.data}`]);
				}

				expect(scheduler.runNext(), testCase.name).toBe(true);
				expect(scheduler.now(), testCase.name).toBeCloseTo(
					slowFrameStartedAt + testCase.expectedDueAfterSlowFrameStart,
					5,
				);
				const adaptiveDueAt = slowFrameStartedAt + slowFrameMs * 2;
				if (testCase.adaptiveRelation === "before") {
					expect(scheduler.now(), testCase.name).toBeLessThan(adaptiveDueAt);
				} else if (testCase.adaptiveRelation === "after") {
					expect(scheduler.now(), testCase.name).toBeGreaterThan(adaptiveDueAt);
				} else {
					expect(scheduler.now(), testCase.name).toBeCloseTo(adaptiveDueAt, 5);
				}
				expect(events, testCase.name).toEqual(
					testCase.data === undefined ? ["render"] : [`input:${testCase.data}`, "render"],
				);
			} finally {
				tui.stop();
			}
		}
	});
});
