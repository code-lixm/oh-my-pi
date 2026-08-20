import type {
	InteractiveSessionCursor,
	InteractiveSessionProjectionPatch,
	InteractiveSessionReliableFrame,
	InteractiveSessionSnapshot,
	InteractiveSessionViewFrame,
} from "./types";

export interface InteractiveSessionAppliedFrame {
	readonly kind: "applied";
	readonly snapshot: InteractiveSessionSnapshot;
	/** A reliable final update superseded this volatile view key. */
	readonly clearedViewKey?: string;
}

export interface InteractiveSessionStaleGeneration {
	readonly kind: "stale-generation";
	readonly currentGeneration: string | undefined;
	readonly receivedGeneration: string;
}

export interface InteractiveSessionReliableGap {
	readonly kind: "gap";
	readonly cursor: InteractiveSessionCursor;
	readonly expectedSequence: number;
	readonly receivedSequence: number;
}

export interface InteractiveSessionViewAheadOfReliable {
	readonly kind: "ahead-of-reliable";
	readonly cursor: InteractiveSessionCursor;
	readonly key: string;
	readonly baseReliableSequence: number;
}

export interface InteractiveSessionStaleViewRevision {
	readonly kind: "stale-view-revision";
	readonly key: string;
	readonly latestRevision: number;
	readonly receivedRevision: number;
}

export interface InteractiveSessionFinalizedView {
	readonly kind: "finalized-view";
	readonly key: string;
	readonly finalReliableSequence: number;
	readonly baseReliableSequence: number;
}

export type InteractiveSessionReliableApplyResult =
	| InteractiveSessionAppliedFrame
	| InteractiveSessionReliableGap
	| InteractiveSessionStaleGeneration;

export type InteractiveSessionViewApplyResult =
	| InteractiveSessionAppliedFrame
	| InteractiveSessionStaleGeneration
	| InteractiveSessionViewAheadOfReliable
	| InteractiveSessionStaleViewRevision
	| InteractiveSessionFinalizedView;

interface FinalizedViewCursor {
	readonly generation: string;
	readonly sequence: number;
}

/**
 * Applies snapshot, reliable, and volatile view frames for one session.
 * Projection objects remain plain serializable data; the maps only hold
 * transport-local ordering metadata.
 */
export class InteractiveSessionProjectionReducer {
	#snapshot: InteractiveSessionSnapshot | undefined;
	readonly #viewRevisions = new Map<string, number>();
	readonly #finalizedViews = new Map<string, FinalizedViewCursor>();

	constructor(snapshot?: InteractiveSessionSnapshot) {
		if (snapshot) this.applySnapshot(snapshot);
	}

	get snapshot(): InteractiveSessionSnapshot | undefined {
		return this.#snapshot;
	}

	get cursor(): InteractiveSessionCursor | undefined {
		return this.#snapshot?.cursor;
	}

	/** Replaces the complete projection and cursor as one state transition. */
	applySnapshot(snapshot: InteractiveSessionSnapshot): InteractiveSessionSnapshot {
		const previousGeneration = this.#snapshot?.cursor.generation;
		this.#snapshot = snapshot;
		if (previousGeneration !== snapshot.cursor.generation) {
			this.#viewRevisions.clear();
			this.#finalizedViews.clear();
		}
		return snapshot;
	}

	/**
	 * Applies exactly the next reliable frame. Any sequence mismatch is a gap;
	 * callers must resynchronize with an atomic snapshot before continuing.
	 */
	applyReliable(frame: InteractiveSessionReliableFrame): InteractiveSessionReliableApplyResult {
		const snapshot = this.#snapshot;
		if (!snapshot || snapshot.cursor.generation !== frame.generation) {
			return {
				kind: "stale-generation",
				currentGeneration: snapshot?.cursor.generation,
				receivedGeneration: frame.generation,
			};
		}

		const expectedSequence = snapshot.cursor.sequence + 1;
		if (frame.sequence !== expectedSequence) {
			return {
				kind: "gap",
				cursor: snapshot.cursor,
				expectedSequence,
				receivedSequence: frame.sequence,
			};
		}

		const nextSnapshot = this.#applyPatch(frame.patch, {
			generation: frame.generation,
			sequence: frame.sequence,
		});
		if (frame.finalViewKey === undefined) return { kind: "applied", snapshot: nextSnapshot };

		this.#viewRevisions.delete(frame.finalViewKey);
		this.#finalizedViews.set(frame.finalViewKey, {
			generation: frame.generation,
			sequence: frame.sequence,
		});
		return {
			kind: "applied",
			snapshot: nextSnapshot,
			clearedViewKey: frame.finalViewKey,
		};
	}

	/**
	 * Applies a coalescible view patch only when its reliable base is already
	 * present and its key-local revision advances.
	 */
	applyView(frame: InteractiveSessionViewFrame): InteractiveSessionViewApplyResult {
		const snapshot = this.#snapshot;
		if (!snapshot || snapshot.cursor.generation !== frame.generation) {
			return {
				kind: "stale-generation",
				currentGeneration: snapshot?.cursor.generation,
				receivedGeneration: frame.generation,
			};
		}

		if (frame.baseReliableSequence > snapshot.cursor.sequence) {
			return {
				kind: "ahead-of-reliable",
				cursor: snapshot.cursor,
				key: frame.key,
				baseReliableSequence: frame.baseReliableSequence,
			};
		}

		const finalized = this.#finalizedViews.get(frame.key);
		if (finalized && finalized.generation === frame.generation) {
			if (frame.baseReliableSequence < finalized.sequence) {
				return {
					kind: "finalized-view",
					key: frame.key,
					finalReliableSequence: finalized.sequence,
					baseReliableSequence: frame.baseReliableSequence,
				};
			}
			this.#finalizedViews.delete(frame.key);
		}

		const latestRevision = this.#viewRevisions.get(frame.key);
		if (latestRevision !== undefined && frame.revision <= latestRevision) {
			return {
				kind: "stale-view-revision",
				key: frame.key,
				latestRevision,
				receivedRevision: frame.revision,
			};
		}

		this.#viewRevisions.set(frame.key, frame.revision);
		return { kind: "applied", snapshot: this.#applyPatch(frame.patch, snapshot.cursor) };
	}

	#applyPatch(patch: InteractiveSessionProjectionPatch, cursor: InteractiveSessionCursor): InteractiveSessionSnapshot {
		const snapshot = this.#snapshot;
		if (!snapshot) throw new Error("Cannot apply a frame before a session snapshot");
		const nextSnapshot: InteractiveSessionSnapshot = {
			cursor,
			projection: { ...snapshot.projection, ...patch },
		};
		this.#snapshot = nextSnapshot;
		return nextSnapshot;
	}
}

/**
 * Bounded latest-wins queue for volatile view frames. Replacements retain a
 * key's first insertion position, so every drain has deterministic ordering.
 */
export class LatestViewFrameCoalescer {
	readonly #maximumEntries: number;
	readonly #frames = new Map<string, InteractiveSessionViewFrame>();
	#generation: string | undefined;

	constructor(maximumEntries = 128) {
		if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
			throw new RangeError("maximumEntries must be a positive safe integer");
		}
		this.#maximumEntries = maximumEntries;
	}

	get size(): number {
		return this.#frames.size;
	}

	/**
	 * Keeps the newest frame for a key. If capacity is exhausted by a new key,
	 * returns the oldest pending frame for immediate delivery instead of losing it.
	 */
	enqueue(frame: InteractiveSessionViewFrame): InteractiveSessionViewFrame | undefined {
		if (this.#generation !== undefined && frame.generation !== this.#generation) this.#frames.clear();
		this.#generation = frame.generation;

		const existing = this.#frames.get(frame.key);
		if (existing) {
			if (this.#isNewer(frame, existing)) this.#frames.set(frame.key, frame);
			return undefined;
		}

		let overflow: InteractiveSessionViewFrame | undefined;
		if (this.#frames.size === this.#maximumEntries) {
			const oldestKey = this.#frames.keys().next().value;
			if (oldestKey !== undefined) {
				overflow = this.#frames.get(oldestKey);
				this.#frames.delete(oldestKey);
			}
		}
		this.#frames.set(frame.key, frame);
		return overflow;
	}

	/** Removes and returns all pending frames in deterministic insertion order. */
	drain(): InteractiveSessionViewFrame[] {
		const frames = [...this.#frames.values()];
		this.#frames.clear();
		return frames;
	}

	/** Drops a single pending volatile key. */
	clear(key: string): boolean {
		return this.#frames.delete(key);
	}

	/**
	 * Advances the coalescer's generation fence and clears the view frame that a
	 * reliable final update has made authoritative.
	 */
	observeReliable(frame: InteractiveSessionReliableFrame): boolean {
		if (this.#generation !== undefined && frame.generation !== this.#generation) this.#frames.clear();
		this.#generation = frame.generation;
		if (frame.finalViewKey === undefined) return false;

		const pending = this.#frames.get(frame.finalViewKey);
		if (!pending || pending.generation !== frame.generation) return false;
		this.#frames.delete(frame.finalViewKey);
		return true;
	}

	#isNewer(candidate: InteractiveSessionViewFrame, existing: InteractiveSessionViewFrame): boolean {
		if (candidate.generation !== existing.generation) return true;
		return candidate.revision > existing.revision;
	}
}
