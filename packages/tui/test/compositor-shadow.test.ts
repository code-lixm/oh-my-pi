import { describe, expect, it } from "bun:test";
import { type CompositorRowPlan, CompositorShadow, planCompositorRows } from "@oh-my-pi/pi-tui/compositor-shadow";

const rowPlanCases: Array<{
	name: string;
	previous: string[];
	next: string[];
	expected: CompositorRowPlan;
}> = [
	{
		name: "an appended terminal row",
		previous: ["prompt", "cursor"],
		next: ["prompt", "cursor", "streamed row"],
		expected: {
			previousLen: 2,
			nextLen: 3,
			firstChanged: 2,
			lastChanged: 2,
			changedRows: 1,
			same: false,
		},
	},
	{
		name: "a changed row inside a stable frame",
		previous: ["header", "old draft", "footer"],
		next: ["header", "new draft", "footer"],
		expected: {
			previousLen: 3,
			nextLen: 3,
			firstChanged: 1,
			lastChanged: 1,
			changedRows: 1,
			same: false,
		},
	},
	{
		name: "an unchanged frame",
		previous: ["header", "draft"],
		next: ["header", "draft"],
		expected: {
			previousLen: 2,
			nextLen: 2,
			firstChanged: undefined,
			lastChanged: undefined,
			changedRows: 0,
			same: true,
		},
	},
];

describe("CompositorShadow", () => {
	for (const { name, previous, next, expected } of rowPlanCases) {
		it(`keeps the JavaScript compositor authoritative while a native shadow agrees on ${name}`, () => {
			const nativePlans: CompositorRowPlan[] = [];
			const shadow = new CompositorShadow((nativePrevious, nativeNext) => {
				const plan = planCompositorRows(nativePrevious, nativeNext);
				nativePlans.push(plan);
				return plan;
			}, true);

			expect(shadow.observe(previous, next)).toBe(true);
			expect(nativePlans).toEqual([expected]);
			expect(shadow.active).toBe(true);
		});
	}

	it("leaves future compositor frames on the JavaScript path when the native row planner throws", () => {
		let attempts = 0;
		const shadow = new CompositorShadow(() => {
			attempts++;
			throw new Error("native planner unavailable");
		}, true);

		expect(shadow.observe(["before"], ["after"])).toBe(false);
		expect(shadow.active).toBe(false);
		expect(shadow.observe(["still rendered"], ["still rendered"])).toBe(true);
		expect(attempts).toBe(1);
	});
});
