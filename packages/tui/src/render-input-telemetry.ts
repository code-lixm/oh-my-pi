import { isBunTestRuntime, logger } from "@oh-my-pi/pi-utils";

const INPUT_QUEUE_THRESHOLD_MS = 100;
const INPUT_HANDLER_THRESHOLD_MS = 50;
const RENDER_QUEUE_THRESHOLD_MS = 100;
const RENDER_STAGE_THRESHOLD_MS = 50;
const FRAME_THRESHOLD_MS = 100;
const REPORT_INTERVAL_MS = 5_000;
const MAX_SAMPLES_PER_REPORT = 4;

/** Synchronous render/input boundaries where tests may advance an injected clock. */
export type TuiResponsivenessTestStage =
	| "input.received"
	| "input.dispatch"
	| "render.schedule"
	| "render.compose"
	| "render.prepare"
	| "render.diff"
	| "render.output"
	| "render.complete";

export interface TuiInputResponsivenessSample {
	readonly kind: "input";
	readonly queueDelayMs: number;
	readonly handlerMs: number;
	readonly inputCodeUnits: number;
}

export interface TuiFrameResponsivenessSample {
	readonly kind: "frame";
	readonly queueDelayMs: number;
	readonly composeMs: number;
	readonly prepareMs: number;
	readonly diffMs: number;
	readonly outputSubmitMs: number;
	readonly outputWrites: number;
	readonly outputCodeUnits: number;
	readonly frameMs: number;
	readonly frameRows: number;
}

export type TuiResponsivenessSample = TuiInputResponsivenessSample | TuiFrameResponsivenessSample;

/** Bounded evidence emitted only after a responsiveness threshold is crossed. */
export interface TuiResponsivenessReport {
	readonly eventCount: number;
	readonly droppedSamples: number;
	readonly samples: readonly TuiResponsivenessSample[];
}

/**
 * Test-only deterministic clock seam. `TUI` rejects these hooks outside the Bun
 * test runtime, and production never invokes a hook or sleeps for telemetry.
 */
export interface TuiResponsivenessTestHooks {
	readonly injectStall?: (stage: TuiResponsivenessTestStage) => void;
	readonly onReport?: (report: TuiResponsivenessReport) => void;
}

function elapsed(startedAt: number | undefined, endedAt: number): number {
	return startedAt === undefined ? 0 : Math.max(0, endedAt - startedAt);
}

function rounded(value: number): number {
	return Math.round(value);
}

function hasInputBreach(queueDelayMs: number, handlerMs: number): boolean {
	return queueDelayMs >= INPUT_QUEUE_THRESHOLD_MS || handlerMs >= INPUT_HANDLER_THRESHOLD_MS;
}

function hasFrameBreach(
	queueDelayMs: number,
	composeMs: number,
	prepareMs: number,
	diffMs: number,
	outputSubmitMs: number,
	frameMs: number,
): boolean {
	return (
		queueDelayMs >= RENDER_QUEUE_THRESHOLD_MS ||
		composeMs >= RENDER_STAGE_THRESHOLD_MS ||
		prepareMs >= RENDER_STAGE_THRESHOLD_MS ||
		diffMs >= RENDER_STAGE_THRESHOLD_MS ||
		outputSubmitMs >= RENDER_STAGE_THRESHOLD_MS ||
		frameMs >= FRAME_THRESHOLD_MS
	);
}

/**
 * Allocation-free timing state for the TUI's synchronous input/render path.
 * A report object is allocated only for a threshold breach. Repeated breaches
 * are coalesced until the next bounded report window without adding a timer.
 */
export class TuiResponsivenessTelemetry {
	#now: () => number;
	#onReport: ((report: TuiResponsivenessReport) => void) | undefined;
	#queuedRenderAt: number | undefined;
	#frameStartedAt: number | undefined;
	#composeStartedAt: number | undefined;
	#prepareStartedAt: number | undefined;
	#diffStartedAt: number | undefined;
	#diffOutputSubmitMsAtStart = 0;
	#frameQueueDelayMs = 0;
	#composeMs = 0;
	#prepareMs = 0;
	#diffMs = 0;
	#outputSubmitMs = 0;
	#outputWrites = 0;
	#outputCodeUnits = 0;
	#inputReceivedAt: number | undefined;
	#inputDispatchedAt: number | undefined;
	#inputCodeUnits = 0;
	#lastReportAt: number | undefined;
	#pendingEventCount = 0;
	#pendingDroppedSamples = 0;
	#pendingSamples: TuiResponsivenessSample[] = [];

	constructor(now: () => number, onReport?: (report: TuiResponsivenessReport) => void) {
		this.#now = now;
		this.#onReport = onReport;
	}

	get frameActive(): boolean {
		return this.#frameStartedAt !== undefined;
	}

	markRenderQueued(at = this.#now()): boolean {
		if (this.#queuedRenderAt !== undefined) return false;
		this.#queuedRenderAt = at;
		return true;
	}

	beginFrame(at = this.#now()): void {
		this.#frameStartedAt = at;
		this.#frameQueueDelayMs = elapsed(this.#queuedRenderAt, at);
		this.#queuedRenderAt = undefined;
		this.#composeStartedAt = undefined;
		this.#prepareStartedAt = undefined;
		this.#diffStartedAt = undefined;
		this.#diffOutputSubmitMsAtStart = 0;
		this.#composeMs = 0;
		this.#prepareMs = 0;
		this.#diffMs = 0;
		this.#outputSubmitMs = 0;
		this.#outputWrites = 0;
		this.#outputCodeUnits = 0;
	}

	beginCompose(at = this.#now()): void {
		if (!this.frameActive) return;
		this.#composeStartedAt = at;
	}

	endCompose(at = this.#now()): void {
		if (!this.frameActive) return;
		this.#composeMs += elapsed(this.#composeStartedAt, at);
		this.#composeStartedAt = undefined;
	}

	beginPrepare(at = this.#now()): void {
		if (!this.frameActive) return;
		this.#prepareStartedAt = at;
	}

	endPrepare(at = this.#now()): void {
		if (!this.frameActive) return;
		this.#prepareMs += elapsed(this.#prepareStartedAt, at);
		this.#prepareStartedAt = undefined;
	}

	beginDiff(at = this.#now()): void {
		if (!this.frameActive) return;
		this.#diffStartedAt = at;
		this.#diffOutputSubmitMsAtStart = this.#outputSubmitMs;
	}

	endDiff(at = this.#now()): void {
		if (!this.frameActive) return;
		const elapsedMs = elapsed(this.#diffStartedAt, at);
		const outputSubmitMs = Math.max(0, this.#outputSubmitMs - this.#diffOutputSubmitMsAtStart);
		this.#diffMs += Math.max(0, elapsedMs - outputSubmitMs);
		this.#diffStartedAt = undefined;
		this.#diffOutputSubmitMsAtStart = 0;
	}

	recordOutputSubmission(startedAt: number, endedAt = this.#now(), codeUnits: number): void {
		if (!this.frameActive) return;
		this.#outputSubmitMs += Math.max(0, endedAt - startedAt);
		this.#outputWrites++;
		this.#outputCodeUnits += codeUnits;
	}

	finishFrame(frameRows: number, at = this.#now()): void {
		const startedAt = this.#frameStartedAt;
		if (startedAt === undefined) return;
		this.endCompose(at);
		this.endPrepare(at);
		this.endDiff(at);
		const frameMs = Math.max(0, at - startedAt);
		const queueDelayMs = this.#frameQueueDelayMs;
		const composeMs = this.#composeMs;
		const prepareMs = this.#prepareMs;
		const diffMs = this.#diffMs;
		const outputSubmitMs = this.#outputSubmitMs;
		if (hasFrameBreach(queueDelayMs, composeMs, prepareMs, diffMs, outputSubmitMs, frameMs)) {
			this.#record(at, {
				kind: "frame",
				queueDelayMs: rounded(queueDelayMs),
				composeMs: rounded(composeMs),
				prepareMs: rounded(prepareMs),
				diffMs: rounded(diffMs),
				outputSubmitMs: rounded(outputSubmitMs),
				outputWrites: this.#outputWrites,
				outputCodeUnits: this.#outputCodeUnits,
				frameMs: rounded(frameMs),
				frameRows,
			});
		}
		this.#frameStartedAt = undefined;
		this.#composeStartedAt = undefined;
		this.#prepareStartedAt = undefined;
		this.#diffStartedAt = undefined;
	}

	beginInput(receivedAt: number, dispatchedAt = this.#now(), inputCodeUnits = 0): void {
		this.#inputReceivedAt = receivedAt;
		this.#inputDispatchedAt = dispatchedAt;
		this.#inputCodeUnits = inputCodeUnits;
	}

	finishInput(at = this.#now()): void {
		const dispatchedAt = this.#inputDispatchedAt;
		if (dispatchedAt === undefined) return;
		const queueDelayMs = elapsed(this.#inputReceivedAt, dispatchedAt);
		const handlerMs = Math.max(0, at - dispatchedAt);
		if (hasInputBreach(queueDelayMs, handlerMs)) {
			this.#record(at, {
				kind: "input",
				queueDelayMs: rounded(queueDelayMs),
				handlerMs: rounded(handlerMs),
				inputCodeUnits: this.#inputCodeUnits,
			});
		}
		this.#inputReceivedAt = undefined;
		this.#inputDispatchedAt = undefined;
		this.#inputCodeUnits = 0;
	}

	#record(at: number, sample: TuiResponsivenessSample): void {
		if (this.#lastReportAt === undefined || at - this.#lastReportAt >= REPORT_INTERVAL_MS) {
			this.#appendPendingSample(sample);
			this.#emitPending(at);
			return;
		}
		this.#appendPendingSample(sample);
	}

	#appendPendingSample(sample: TuiResponsivenessSample): void {
		this.#pendingEventCount++;
		if (this.#pendingSamples.length < MAX_SAMPLES_PER_REPORT) {
			this.#pendingSamples.push(sample);
		} else {
			this.#pendingDroppedSamples++;
		}
	}

	#emitPending(at: number): void {
		const report: TuiResponsivenessReport = {
			eventCount: this.#pendingEventCount,
			droppedSamples: this.#pendingDroppedSamples,
			samples: this.#pendingSamples,
		};
		this.#lastReportAt = at;
		this.#pendingEventCount = 0;
		this.#pendingDroppedSamples = 0;
		this.#pendingSamples = [];
		if (this.#onReport) {
			this.#onReport(report);
			return;
		}
		if (!isBunTestRuntime()) {
			logger.warn("ui.responsiveness", {
				eventCount: report.eventCount,
				droppedSamples: report.droppedSamples,
				samples: report.samples,
			});
		}
	}
}
