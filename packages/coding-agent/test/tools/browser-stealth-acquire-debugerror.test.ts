/**
 * Regression test for issue #5296: the stealth `puppeteer-core` patch
 * (`patches/puppeteer-core@25.3.0.patch`) re-implements world acquisition
 * without `Runtime.enable`. Its new catch handlers in `FrameManager` called the
 * bare `debugError` logger, which puppeteer leaves `undefined` when the
 * `puppeteer:error` debug channel is disabled (the default). A transient CDP
 * failure during world re-acquire then threw `TypeError: debugError is not a
 * function` from `#doAcquireWorlds`, escaped as an `unhandledRejection`, and the
 * postmortem handler killed the whole OMP process (parent session + every
 * subagent).
 *
 * The test drives the real patched `FrameManager` with controllable CDP
 * promises. Keeping the first acquire pending lets both worlds share it and
 * queue the fire-and-forget retry; rejecting those promises manually exercises
 * the bug path without wall-clock sleeps. It then asserts the acquire path
 * emits no unhandled `TypeError` while preserving the original rejection for
 * callers.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CdpFrame } from "puppeteer-core/lib/puppeteer/cdp/Frame.js";
import { FrameManager } from "puppeteer-core/lib/puppeteer/cdp/FrameManager.js";
import { MAIN_WORLD, PUPPETEER_WORLD } from "puppeteer-core/lib/puppeteer/cdp/IsolatedWorlds.js";
import { EventEmitter } from "puppeteer-core/lib/puppeteer/common/EventEmitter.js";
import { TimeoutSettings } from "puppeteer-core/lib/puppeteer/common/TimeoutSettings.js";

type PendingSend = {
	method: string;
	reject: (reason: Error) => void;
};

// A CDP session double whose `send` calls stay pending until the test rejects
// them, modelling navigation tearing the target's execution contexts down at a
// precise point in the acquire/retry sequence.
class ControlledRejectingSession extends EventEmitter<Record<string, unknown>> {
	readonly sends: PendingSend[] = [];

	constructor(readonly sessionId: string) {
		super();
	}
	id(): string {
		return this.sessionId;
	}
	send(method: string): Promise<never> {
		const { promise, reject } = Promise.withResolvers<never>();
		this.sends.push({ method, reject });
		return promise;
	}
	target(): unknown {
		return { _targetId: "T", type: () => "page" };
	}
}

function makeFrameManager(session: ControlledRejectingSession): FrameManager {
	const browser = { isNetworkEnabled: () => false, isIssuesEnabled: () => false, connected: true };
	const page = { browser: () => browser, isClosed: () => false, emit() {}, once() {}, off() {} };
	const timeoutSettings = new TimeoutSettings();
	// The patched FrameManager only touches the members exercised here; the
	// puppeteer-internal `CdpCDPSession` / `CdpPage` types are far wider than the
	// acquire path needs, so the doubles cross the boundary with a cast.
	return new FrameManager(session as never, page as never, timeoutSettings);
}

describe("stealth FrameManager world acquire — issue #5296", () => {
	const rejections: unknown[] = [];
	const onUnhandled = (reason: unknown) => rejections.push(reason);

	beforeEach(() => {
		rejections.length = 0;
		process.on("unhandledRejection", onUnhandled);
	});

	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
	});

	it("preserves CDP acquire failures without emitting debugError TypeErrors", async () => {
		const session = new ControlledRejectingSession("S1");
		const frameManager = makeFrameManager(session);
		const frame = new CdpFrame(frameManager, "F1", undefined, session as never);
		frameManager._frameTree.addFrame(frame);

		// Navigation installs the lazy context providers and invalidates the old
		// contexts; wait one event-loop turn so the async listener completes after
		// the already-present frame resolves from the frame tree.
		session.emit("Page.frameNavigated", {
			frame: { id: "F1", parentId: undefined, url: "about:blank" },
			type: "Navigation",
		});
		const navigationHandled = Promise.withResolvers<void>();
		setImmediate(navigationHandled.resolve);
		await navigationHandled.promise;

		// Concurrent pulls on both worlds share the first pending CDP acquire and
		// queue the retry (`void this.#acquireWorlds` in `finally`), which is the
		// path where the old patch called the bare `debugError(error)`.
		const main = frame.worlds[MAIN_WORLD];
		const util = frame.worlds[PUPPETEER_WORLD];
		const mainEvaluate = main.evaluate(() => 1);
		const utilEvaluate = util.evaluate(() => 1);

		expect(session.sends.map(send => send.method)).toEqual(["Page.createIsolatedWorld"]);
		const acquireError = new Error("mid-flight CDP failure");
		session.sends[0]?.reject(acquireError);

		const results = await Promise.allSettled([mainEvaluate, utilEvaluate]);

		// The queued fire-and-forget retry must have started; reject it and give the
		// runtime one event-loop turn to report any unhandled rejection.
		expect(session.sends.map(send => send.method)).toEqual(["Page.createIsolatedWorld", "Page.createIsolatedWorld"]);
		session.sends[1]?.reject(new Error("retry CDP failure"));
		const unhandledRejectionsFlushed = Promise.withResolvers<void>();
		setImmediate(unhandledRejectionsFlushed.resolve);
		await unhandledRejectionsFlushed.promise;

		expect(rejections).toHaveLength(0);

		// The original CDP failure is still observable as the evaluate rejection;
		// the fix must not turn it into a debugError TypeError, a timeout, or a
		// silent successful acquire.
		const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
		expect(rejected).toHaveLength(2);
		expect(rejected.map(r => r.reason)).toEqual([acquireError, acquireError]);
	});
});
