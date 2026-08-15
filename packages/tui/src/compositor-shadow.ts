import * as nativeBindings from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";

export interface CompositorRowPlan {
	previousLen: number;
	nextLen: number;
	firstChanged?: number;
	lastChanged?: number;
	changedRows: number;
	same: boolean;
}

export type CompositorRowPlanner = (previous: string[], next: string[]) => CompositorRowPlan;

/** Deterministic TypeScript reference used to verify the native row planner. */
export function planCompositorRows(previous: readonly string[], next: readonly string[]): CompositorRowPlan {
	const common = Math.min(previous.length, next.length);
	let firstChanged: number | undefined;
	let lastChanged: number | undefined;
	let changedRows = 0;
	for (let index = 0; index < common; index++) {
		if (previous[index] === next[index]) continue;
		firstChanged ??= index;
		lastChanged = index;
		changedRows++;
	}
	if (previous.length !== next.length) {
		const start = common;
		const end = Math.max(previous.length, next.length) - 1;
		firstChanged ??= start;
		lastChanged = end;
		changedRows += end - start + 1;
	}
	return {
		previousLen: previous.length,
		nextLen: next.length,
		firstChanged,
		lastChanged,
		changedRows,
		same: firstChanged === undefined,
	};
}

function resolveNativePlanner(): CompositorRowPlanner | undefined {
	const candidate = Reflect.get(nativeBindings, "terminalRowPlan");
	if (typeof candidate !== "function") return undefined;
	return candidate as CompositorRowPlanner;
}

function plansEqual(left: CompositorRowPlan, right: CompositorRowPlan): boolean {
	return (
		left.previousLen === right.previousLen &&
		left.nextLen === right.nextLen &&
		left.firstChanged === right.firstChanged &&
		left.lastChanged === right.lastChanged &&
		left.changedRows === right.changedRows &&
		left.same === right.same
	);
}

/**
 * Opt-in native row-plan shadow. The JavaScript compositor remains authoritative;
 * any mismatch or native exception disables only this instance and leaves the
 * current frame untouched.
 */
export class CompositorShadow {
	#planner: CompositorRowPlanner | undefined;
	#enabled: boolean;
	#failed = false;

	constructor(
		planner: CompositorRowPlanner | undefined = resolveNativePlanner(),
		enabled = Bun.env.PI_TUI_COMPOSITOR_SHADOW === "1" || Bun.env.PI_TUI_COMPOSITOR_SHADOW === "true",
	) {
		this.#planner = planner;
		this.#enabled = enabled && planner !== undefined;
	}

	get active(): boolean {
		return this.#enabled && !this.#failed;
	}

	observe(previous: readonly string[], next: readonly string[]): boolean {
		if (!this.active || !this.#planner) return true;
		const reference = planCompositorRows(previous, next);
		try {
			const native = this.#planner([...previous], [...next]);
			if (plansEqual(reference, native)) return true;
			this.#failed = true;
			logger.warn("native compositor row-plan mismatch; disabling shadow", { reference, native });
			return false;
		} catch (err) {
			this.#failed = true;
			logger.warn("native compositor row-plan failed; disabling shadow", { err });
			return false;
		}
	}
}
