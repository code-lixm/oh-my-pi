import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EARCON_SAMPLE_RATE, type EarconKind, renderEarcon } from "../../src/audio/earcons";
import { type EarconOutput, type EarconOutputFactory, SoundService } from "../../src/audio/sounds";

type SoundSwitches = Record<EarconKind, "on" | "off">;
type EndForOutput = (index: number) => Promise<void>;

const SOUND_ON: SoundSwitches = {
	ask: "on",
	completion: "on",
	error: "on",
	queued: "on",
};

class RecordingOutput implements EarconOutput {
	readonly writes: Float32Array[] = [];
	endCalls = 0;
	stopCalls = 0;

	constructor(private readonly finish: () => Promise<void>) {}

	write(samples: Float32Array): void {
		this.writes.push(samples);
	}

	end(): Promise<void> {
		this.endCalls += 1;
		return this.finish();
	}

	stop(): void {
		this.stopCalls += 1;
	}
}

class OutputRecorder {
	readonly sampleRates: number[] = [];
	readonly outputs: RecordingOutput[] = [];
	readonly factory: EarconOutputFactory;

	constructor(private readonly endForOutput: EndForOutput = () => Promise.resolve()) {
		this.factory = sampleRate => {
			const index = this.outputs.length;
			const output = new RecordingOutput(() => this.endForOutput(index));
			this.sampleRates.push(sampleRate);
			this.outputs.push(output);
			return output;
		};
	}

	get writes(): Float32Array[] {
		return this.outputs.flatMap(output => output.writes);
	}

	get endCalls(): number {
		return this.outputs.reduce((total, output) => total + output.endCalls, 0);
	}
}

let activeService: SoundService | undefined;

function createSoundHarness(endForOutput?: EndForOutput): { recorder: OutputRecorder; service: SoundService } {
	const recorder = new OutputRecorder(endForOutput);
	const service = new SoundService(recorder.factory);
	activeService = service;
	return { recorder, service };
}

function configureSounds(enabled: boolean, kinds: SoundSwitches): void {
	settings.override("sound.enabled", enabled);
	settings.override("sound.ask", kinds.ask);
	settings.override("sound.completion", kinds.completion);
	settings.override("sound.error", kinds.error);
	settings.override("sound.queued", kinds.queued);
}

async function flushPlayback(): Promise<void> {
	// 播放链从微任务开始；连续让出以等待串行的 end() 完成。
	for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	activeService?.stopAll();
	activeService = undefined;
	vi.restoreAllMocks();
	vi.useRealTimers();
	setSystemTime();
	resetSettingsForTest();
});

describe("SoundService.play", () => {
	it("does not open an output while sound.enabled is false", async () => {
		configureSounds(false, SOUND_ON);
		const { recorder, service } = createSoundHarness();

		service.play("completion");
		await flushPlayback();

		expect(recorder.sampleRates).toHaveLength(0);
		expect(recorder.writes).toHaveLength(0);
		expect(recorder.endCalls).toBe(0);
	});

	it("does not write a kind explicitly switched off", async () => {
		configureSounds(true, { ...SOUND_ON, completion: "off" });
		const { recorder, service } = createSoundHarness();

		service.play("completion");
		await flushPlayback();

		expect(recorder.sampleRates).toHaveLength(0);
		expect(recorder.writes).toHaveLength(0);
		expect(recorder.endCalls).toBe(0);
	});

	it("writes the completion PCM at the earcon sample rate and ends the output", async () => {
		configureSounds(true, SOUND_ON);
		const { recorder, service } = createSoundHarness();

		service.play("completion");
		await flushPlayback();

		expect(recorder.sampleRates).toEqual([EARCON_SAMPLE_RATE]);
		expect(recorder.writes).toHaveLength(1);
		expect(recorder.writes[0]).toBe(renderEarcon("completion"));
		expect(recorder.writes[0]?.length).toBeGreaterThan(0);
		expect(recorder.endCalls).toBe(1);
	});

	it("serializes playback until the preceding output ends", async () => {
		configureSounds(true, SOUND_ON);
		const firstEnd = Promise.withResolvers<void>();
		const { recorder, service } = createSoundHarness(index => (index === 0 ? firstEnd.promise : Promise.resolve()));

		try {
			service.play("ask");
			service.play("completion");
			await flushPlayback();

			expect(recorder.writes).toHaveLength(1);
			expect(recorder.writes[0]).toBe(renderEarcon("ask"));

			firstEnd.resolve();
			await flushPlayback();

			expect(recorder.writes).toHaveLength(2);
			expect(recorder.writes[1]).toBe(renderEarcon("completion"));
		} finally {
			firstEnd.resolve();
			await flushPlayback();
		}
	});

	it("drops a queued chime inside its one-second cooldown and allows a later one", async () => {
		vi.useFakeTimers();
		setSystemTime(10_000);
		configureSounds(true, SOUND_ON);
		const { recorder, service } = createSoundHarness();

		service.play("queued");
		service.play("queued");
		await flushPlayback();
		expect(recorder.writes).toHaveLength(1);

		setSystemTime(11_001);
		service.play("queued");
		await flushPlayback();

		expect(recorder.writes).toHaveLength(2);
		expect(recorder.writes.every(samples => samples === renderEarcon("queued"))).toBe(true);
	});
});

describe("SoundService repeats", () => {
	it("plays immediately, repeats at the requested interval, and stops after the returned callback", async () => {
		vi.useFakeTimers();
		setSystemTime(10_000);
		configureSounds(true, SOUND_ON);
		const { recorder, service } = createSoundHarness();

		const stop = service.startRepeat("ask", 50);
		await flushPlayback();
		expect(recorder.writes).toHaveLength(1);

		vi.advanceTimersByTime(50);
		await flushPlayback();
		expect(recorder.writes).toHaveLength(2);

		vi.advanceTimersByTime(50);
		await flushPlayback();
		expect(recorder.writes).toHaveLength(3);

		stop();
		vi.advanceTimersByTime(200);
		await flushPlayback();
		expect(recorder.writes).toHaveLength(3);
	});

	it("replaces an existing same-kind repeat instead of leaving the old interval alive", async () => {
		vi.useFakeTimers();
		setSystemTime(10_000);
		configureSounds(true, SOUND_ON);
		const { recorder, service } = createSoundHarness();

		service.startRepeat("ask", 100);
		await flushPlayback();
		service.startRepeat("ask", 20);
		await flushPlayback();

		for (let tick = 0; tick < 5; tick += 1) {
			vi.advanceTimersByTime(20);
			await flushPlayback();
		}

		// 两次立即播放加上新循环的五个 tick；旧循环若仍存活会在 100ms 多播一次。
		expect(recorder.writes).toHaveLength(7);
	});

	it("stopRepeat stops only the requested kind", async () => {
		vi.useFakeTimers();
		setSystemTime(10_000);
		configureSounds(true, SOUND_ON);
		const { recorder, service } = createSoundHarness();

		service.startRepeat("ask", 40);
		service.startRepeat("completion", 40);
		await flushPlayback();
		service.stopRepeat("ask");

		vi.advanceTimersByTime(40);
		await flushPlayback();

		expect(recorder.writes).toHaveLength(3);
		expect(recorder.writes[2]).toBe(renderEarcon("completion"));
	});

	it("stopAll stops repeats for every earcon kind", async () => {
		vi.useFakeTimers();
		setSystemTime(10_000);
		configureSounds(true, SOUND_ON);
		const { recorder, service } = createSoundHarness();

		for (const kind of ["ask", "completion", "error", "queued"] as const) {
			service.startRepeat(kind, 1_500);
		}
		await flushPlayback();
		expect(recorder.writes).toHaveLength(4);

		service.stopAll();
		vi.advanceTimersByTime(3_000);
		await flushPlayback();
		expect(recorder.writes).toHaveLength(4);
	});

	it("stops a disabled repeat on its next tick instead of resuming after sound is re-enabled", async () => {
		vi.useFakeTimers();
		setSystemTime(10_000);
		configureSounds(true, SOUND_ON);
		const { recorder, service } = createSoundHarness();

		service.startRepeat("ask", 50);
		await flushPlayback();
		expect(recorder.writes).toHaveLength(1);

		settings.override("sound.enabled", false);
		vi.advanceTimersByTime(50);
		await flushPlayback();
		expect(recorder.writes).toHaveLength(1);

		settings.override("sound.enabled", true);
		vi.advanceTimersByTime(200);
		await flushPlayback();
		expect(recorder.writes).toHaveLength(1);
	});
});
