import { logger } from "@oh-my-pi/pi-utils";

interface ToolOutputBackpressureState {
	toolName: string;
	startedAt: number;
	maxOriginalBytes: number;
	maxTrimmedBytes: number;
	receivedCount: number;
	coalescedCount: number;
	dispatchedCount: number;
	renderedCount: number;
	wasLimited: boolean;
	pendingEnqueueAt: number | undefined;
	maxEnqueueToDispatchMs: number;
	maxEnqueueToRenderMs: number;
}

const active = new Map<string, ToolOutputBackpressureState>();
const MAX_ACTIVE_CALLS = 512;

function now(): number {
	return performance.now();
}

/** Record every live preview; terminal logging remains limited to pressure signals. */
export function recordLiveToolPreview(
	toolCallId: string,
	toolName: string,
	originalBytes: number | undefined,
	previewBytes: number | undefined,
	at = now(),
	wasLimited = false,
): void {
	let state = active.get(toolCallId);
	if (state === undefined) {
		if (active.size >= MAX_ACTIVE_CALLS) {
			const oldest = active.keys().next().value;
			if (oldest !== undefined) active.delete(oldest);
		}
		state = {
			toolName,
			startedAt: at,
			maxOriginalBytes: 0,
			maxTrimmedBytes: 0,
			receivedCount: 0,
			coalescedCount: 0,
			dispatchedCount: 0,
			renderedCount: 0,
			wasLimited: false,
			pendingEnqueueAt: undefined,
			maxEnqueueToDispatchMs: 0,
			maxEnqueueToRenderMs: 0,
		};
		active.set(toolCallId, state);
	}
	state.receivedCount++;
	state.wasLimited ||= wasLimited;
	if (originalBytes !== undefined && Number.isFinite(originalBytes)) {
		state.maxOriginalBytes = Math.max(state.maxOriginalBytes, originalBytes);
	}
	if (previewBytes !== undefined && Number.isFinite(previewBytes)) {
		state.maxTrimmedBytes = Math.max(state.maxTrimmedBytes, previewBytes);
	}
}

export function recordToolUpdateEnqueued(toolCallId: string, at = now()): void {
	const state = active.get(toolCallId);
	if (state === undefined) return;
	state.pendingEnqueueAt ??= at;
}

export function recordToolUpdateCoalesced(toolCallId: string): void {
	const state = active.get(toolCallId);
	if (state !== undefined) state.coalescedCount++;
}

export function recordToolUpdateDispatched(toolCallId: string, at = now()): void {
	const state = active.get(toolCallId);
	if (state === undefined) return;
	state.dispatchedCount++;
	if (state.pendingEnqueueAt !== undefined) {
		state.maxEnqueueToDispatchMs = Math.max(state.maxEnqueueToDispatchMs, at - state.pendingEnqueueAt);
	}
}

/** Mark live partials visible after the TUI commits a compose. */
export function recordToolUpdateRendered(toolCallId: string, at = now()): void {
	const state = active.get(toolCallId);
	if (state === undefined || state.pendingEnqueueAt === undefined) return;
	state.renderedCount++;
	state.maxEnqueueToRenderMs = Math.max(state.maxEnqueueToRenderMs, at - state.pendingEnqueueAt);
	state.pendingEnqueueAt = undefined;
}
const HIGH_FREQUENCY_COALESCE_COUNT = 3;
const DELAYED_UPDATE_MS = 100;

function shouldReport(state: ToolOutputBackpressureState): boolean {
	return (
		state.wasLimited ||
		state.coalescedCount >= HIGH_FREQUENCY_COALESCE_COUNT ||
		state.maxEnqueueToDispatchMs >= DELAYED_UPDATE_MS ||
		state.maxEnqueueToRenderMs >= DELAYED_UPDATE_MS
	);
}

/** Emit and retire only streams that crossed a live-output pressure signal. */
export function finishToolOutputTelemetry(toolCallId: string, at = now()): void {
	const state = active.get(toolCallId);
	if (state === undefined) return;
	active.delete(toolCallId);
	if (!shouldReport(state)) return;
	logger.debug("tool.partial.backpressure", {
		toolCallId,
		tool: state.toolName,
		durationMs: Math.round(Math.max(0, at - state.startedAt)),
		wasLimited: state.wasLimited,
		maxOriginalBytes: state.maxOriginalBytes,
		maxTrimmedBytes: state.maxTrimmedBytes,
		receivedCount: state.receivedCount,
		coalescedCount: state.coalescedCount,
		dispatchedCount: state.dispatchedCount,
		renderedCount: state.renderedCount,
		maxEnqueueToDispatchMs: Math.round(state.maxEnqueueToDispatchMs),
		maxEnqueueToRenderMs: Math.round(state.maxEnqueueToRenderMs),
	});
}

export function resetToolOutputTelemetryForTests(): void {
	active.clear();
}
