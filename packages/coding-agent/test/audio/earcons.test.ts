import { describe, expect, it } from "bun:test";
import { EARCON_SAMPLE_RATE, type EarconKind, renderEarcon } from "../../src/audio/earcons";

const EARCON_CASES = [
	{ kind: "ask", durationSeconds: 0.32 },
	{ kind: "completion", durationSeconds: 1 },
	{ kind: "error", durationSeconds: 1 },
	{ kind: "queued", durationSeconds: 0.5 },
] as const satisfies readonly { kind: EarconKind; durationSeconds: number }[];

function peakMagnitude(samples: Float32Array): number {
	let peak = 0;
	for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
	return peak;
}

function differs(left: Float32Array, right: Float32Array): boolean {
	if (left.length !== right.length) return true;
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return true;
	}
	return false;
}

describe("renderEarcon", () => {
	for (const { kind, durationSeconds } of EARCON_CASES) {
		it(`renders a bounded, non-silent ${kind} PCM recipe`, () => {
			const samples = renderEarcon(kind);

			expect(samples.some(sample => sample !== 0)).toBe(true);
			expect(Math.abs(samples.length - durationSeconds * EARCON_SAMPLE_RATE)).toBeLessThanOrEqual(1);
			expect(peakMagnitude(samples)).toBeLessThanOrEqual(1);
		});
	}

	it("keeps every earcon recipe distinguishable", () => {
		for (let leftIndex = 0; leftIndex < EARCON_CASES.length; leftIndex += 1) {
			const left = EARCON_CASES[leftIndex]!;
			for (let rightIndex = leftIndex + 1; rightIndex < EARCON_CASES.length; rightIndex += 1) {
				const right = EARCON_CASES[rightIndex]!;
				expect(differs(renderEarcon(left.kind), renderEarcon(right.kind))).toBe(true);
			}
		}
	});
});
