import type { InteractiveSessionViewFrame } from "../modes/session-port";

/**
 * Buffers volatile projection frames until the daemon transport can write them.
 *
 * A component's newest frame replaces its pending predecessor without changing
 * its place in the drain order. New components evict the oldest pending key at
 * capacity, so memory and one drain stay bounded by `maxFrames`.
 */
export class DaemonViewFrameCoalescer {
	readonly #frames = new Map<string, InteractiveSessionViewFrame>();
	readonly #maxFrames: number;

	constructor(maxFrames: number) {
		if (!Number.isSafeInteger(maxFrames) || maxFrames < 1) {
			throw new Error("maxFrames must be a positive safe integer");
		}
		this.#maxFrames = maxFrames;
	}

	/** Number of volatile frames waiting to be drained. */
	get size(): number {
		return this.#frames.size;
	}

	/**
	 * Enqueue a view frame when it advances its component's pending revision.
	 *
	 * Frames for the same component and projection generation are monotonic:
	 * duplicate or stale revisions are ignored. A new generation supersedes a
	 * pending frame regardless of its revision because revisions restart with a
	 * projection generation.
	 */
	push(frame: InteractiveSessionViewFrame): boolean {
		const current = this.#frames.get(frame.key);
		if (current?.generation === frame.generation && current.revision >= frame.revision) return false;

		if (current === undefined && this.#frames.size === this.#maxFrames) {
			const oldestKey = this.#frames.keys().next().value;
			if (oldestKey !== undefined) this.#frames.delete(oldestKey);
		}
		// Map#set preserves insertion order for an existing key.
		this.#frames.set(frame.key, frame);
		return true;
	}

	/** Drain pending frames in first-seen component order. */
	drain(): InteractiveSessionViewFrame[] {
		const frames = [...this.#frames.values()];
		this.#frames.clear();
		return frames;
	}

	/** Remove one component's pending volatile frame. */
	clearComponent(key: string): void {
		this.#frames.delete(key);
	}

	/** Discard every pending volatile frame. */
	clear(): void {
		this.#frames.clear();
	}
}
