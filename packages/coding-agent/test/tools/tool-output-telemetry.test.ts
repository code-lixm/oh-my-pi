import { afterEach, describe, expect, it, vi } from "bun:test";
import * as logger from "@oh-my-pi/pi-utils/logger";

import {
	finishToolOutputTelemetry,
	recordLiveToolPreview,
	recordToolUpdateCoalesced,
	recordToolUpdateDispatched,
	recordToolUpdateEnqueued,
	recordToolUpdateRendered,
	resetToolOutputTelemetryForTests,
} from "../../src/tools/tool-output-telemetry";

afterEach(() => {
	resetToolOutputTelemetryForTests();
	vi.restoreAllMocks();
});

describe("tool output backpressure telemetry", () => {
	it("attributes threshold-triggered partial backpressure across rendered update windows", () => {
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const toolCallId = "call-42";

		recordLiveToolPreview(toolCallId, "read", 8_000, 1_000, 100, true);
		recordLiveToolPreview(toolCallId, "read", 12_000, 2_000, 105, true);

		recordToolUpdateEnqueued(toolCallId, 120);
		recordToolUpdateCoalesced(toolCallId);
		recordToolUpdateDispatched(toolCallId, 145);
		recordToolUpdateRendered(toolCallId, 160);

		recordToolUpdateEnqueued(toolCallId, 200);
		recordToolUpdateCoalesced(toolCallId);
		recordToolUpdateDispatched(toolCallId, 215);
		recordToolUpdateRendered(toolCallId, 250);

		finishToolOutputTelemetry(toolCallId, 280);

		expect(debugSpy).toHaveBeenCalledTimes(1);
		expect(debugSpy).toHaveBeenLastCalledWith("tool.partial.backpressure", {
			toolCallId,
			tool: "read",
			durationMs: 180,
			wasLimited: true,
			maxOriginalBytes: 12_000,
			maxTrimmedBytes: 2_000,
			receivedCount: 2,
			coalescedCount: 2,
			dispatchedCount: 2,
			maxEnqueueToDispatchMs: 25,
			renderedCount: 2,
			maxEnqueueToRenderMs: 50,
		});

		finishToolOutputTelemetry(toolCallId, 300);
		expect(debugSpy).toHaveBeenCalledTimes(1);
	});

	it("reports unbounded live previews after high-frequency coalescing", () => {
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const toolCallId = "high-frequency-unbounded-call";

		recordLiveToolPreview(toolCallId, "read", 100, 50, 0, false);
		recordLiveToolPreview(toolCallId, "read", 200, 100, 10, false);
		recordLiveToolPreview(toolCallId, "read", 300, 150, 20, false);
		recordLiveToolPreview(toolCallId, "read", 400, 200, 30, false);

		recordToolUpdateCoalesced(toolCallId);
		recordToolUpdateCoalesced(toolCallId);
		recordToolUpdateCoalesced(toolCallId);
		finishToolOutputTelemetry(toolCallId, 40);

		expect(debugSpy).toHaveBeenCalledTimes(1);
		expect(debugSpy).toHaveBeenLastCalledWith("tool.partial.backpressure", {
			toolCallId,
			tool: "read",
			durationMs: 40,
			wasLimited: false,
			maxOriginalBytes: 400,
			maxTrimmedBytes: 200,
			receivedCount: 4,
			coalescedCount: 3,
			dispatchedCount: 0,
			renderedCount: 0,
			maxEnqueueToDispatchMs: 0,
			maxEnqueueToRenderMs: 0,
		});
	});

	it("does not log low-frequency unbounded live preview streams", () => {
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const toolCallId = "unbounded-call";

		recordLiveToolPreview(toolCallId, "read", 100, 80, 100, false);
		recordToolUpdateEnqueued(toolCallId, 100);
		recordToolUpdateCoalesced(toolCallId);
		recordToolUpdateDispatched(toolCallId, 120);
		recordToolUpdateRendered(toolCallId, 140);
		finishToolOutputTelemetry(toolCallId, 160);

		expect(debugSpy).not.toHaveBeenCalled();
	});
});
