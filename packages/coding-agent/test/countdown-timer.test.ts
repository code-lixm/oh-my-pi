import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { CountdownTimer } from "@oh-my-pi/pi-coding-agent/modes/components/countdown-timer";

describe("CountdownTimer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("waits to start until first presentation and then expires at its precise deadline", () => {
		const onTick = vi.fn();
		const onExpire = vi.fn();
		const timer = new CountdownTimer(250, undefined, onTick, onExpire, { start: false });

		vi.advanceTimersByTime(1_000);
		expect(onExpire).not.toHaveBeenCalled();

		timer.start();
		expect(onTick).toHaveBeenCalledWith(1);
		vi.advanceTimersByTime(249);
		expect(onExpire).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(onExpire).toHaveBeenCalledTimes(1);
	});

	it("honors an inherited absolute deadline instead of opening a fresh timeout window", () => {
		const onTick = vi.fn();
		const onExpire = vi.fn();
		const timer = new CountdownTimer(10_000, undefined, onTick, onExpire, { start: false });
		const deadline = Date.now() + 1_000;

		vi.advanceTimersByTime(400);
		timer.start(deadline);
		expect(onTick).toHaveBeenCalledWith(1);

		vi.advanceTimersByTime(599);
		expect(onExpire).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onExpire).toHaveBeenCalledTimes(1);
	});
});
