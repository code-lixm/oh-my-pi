import { describe, expect, it } from "bun:test";
import { AdaptiveStreamingUpdateWindow } from "@oh-my-pi/pi-coding-agent/modes/streaming-update-coalescing";

describe("AdaptiveStreamingUpdateWindow", () => {
	it("keeps the 33ms scheduling baseline until two consecutive slow compose frames, then steps up gradually", () => {
		const window = new AdaptiveStreamingUpdateWindow();

		expect(window.delayMs).toBe(33);

		window.observeComposeMs(50);
		expect(window.delayMs).toBe(33);

		window.observeComposeMs(50);
		expect(window.delayMs).toBe(58);

		// A non-slow frame breaks the consecutive-slow requirement for consumers.
		window.observeComposeMs(40);
		expect(window.delayMs).toBe(58);
		window.observeComposeMs(50);
		expect(window.delayMs).toBe(58);
		window.observeComposeMs(50);
		expect(window.delayMs).toBe(83);
	});

	it("never schedules a coalescing window above 250ms during a sustained slow-frame run", () => {
		const window = new AdaptiveStreamingUpdateWindow();
		const observedDelays: number[] = [];

		for (let sample = 0; sample < 100; sample++) {
			window.observeComposeMs(50);
			observedDelays.push(window.delayMs);
		}

		expect(observedDelays.every(delay => delay <= 250)).toBe(true);
		expect(window.delayMs).toBe(250);
	});

	it("waits through recovery cooldown and eight qualifying fast frames instead of reacting to one fast frame", () => {
		const window = new AdaptiveStreamingUpdateWindow();
		window.observeComposeMs(50);
		window.observeComposeMs(50);
		expect(window.delayMs).toBe(58);

		window.observeComposeMs(30);
		expect(window.delayMs).toBe(58);
		for (let sample = 0; sample < 7; sample++) window.observeComposeMs(40);
		expect(window.delayMs).toBe(58);

		for (let sample = 0; sample < 7; sample++) window.observeComposeMs(30);
		expect(window.delayMs).toBe(58);
		window.observeComposeMs(30);
		expect(window.delayMs).toBe(48);
	});

	it("holds the 33ms lower scheduling bound after prolonged fast-frame recovery", () => {
		const window = new AdaptiveStreamingUpdateWindow();
		window.observeComposeMs(50);
		window.observeComposeMs(50);
		expect(window.delayMs).toBe(58);

		const observedDelays: number[] = [];
		for (let sample = 0; sample < 100; sample++) {
			window.observeComposeMs(30);
			observedDelays.push(window.delayMs);
		}

		expect(observedDelays.every(delay => delay >= 33)).toBe(true);
		expect(window.delayMs).toBe(33);
	});

	it("ignores NaN, infinities, and negative compose samples without changing an in-progress slow-frame sequence", () => {
		const window = new AdaptiveStreamingUpdateWindow();
		window.observeComposeMs(50);

		for (const invalidSample of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
			window.observeComposeMs(invalidSample);
			expect(window.delayMs).toBe(33);
		}

		window.observeComposeMs(50);
		expect(window.delayMs).toBe(58);
	});
});
