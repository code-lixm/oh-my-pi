/**
 * Token-throughput calculator shared by the status line (main session tok/s
 * badge) and the vibe worker aggregation ({@link aggregateVibeWorkerTokensPerSecond}).
 * Lives in `utils/` so neither the render layer nor the vibe runtime has to
 * depend on the other for a pure arithmetic helper.
 */
const MIN_DURATION_MS = 100;

type AssistantUsage = {
	output: number;
};

type AssistantLikeMessage = {
	role: "assistant";
	timestamp: number;
	duration?: number;
	usage: AssistantUsage;
};

type MaybeAssistantMessage = {
	role?: string;
	timestamp?: number;
	duration?: number;
	ttft?: number;
	usage?: {
		output?: number;
	};
};

function isAssistantMessage(message: MaybeAssistantMessage | undefined): message is AssistantLikeMessage {
	return (
		message?.role === "assistant" &&
		typeof message.timestamp === "number" &&
		message.usage !== undefined &&
		typeof message.usage.output === "number"
	);
}

function getLastAssistantMessage(messages: ReadonlyArray<MaybeAssistantMessage>): AssistantLikeMessage | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isAssistantMessage(message)) {
			return message;
		}
	}
	return null;
}

export function calculateTokensPerSecond(
	messages: ReadonlyArray<MaybeAssistantMessage>,
	isStreaming: boolean,
	nowMs: number = Date.now(),
): number | null {
	const assistant = getLastAssistantMessage(messages);
	if (!assistant) return null;

	const outputTokens = assistant.usage.output;
	if (!Number.isFinite(outputTokens) || outputTokens <= 0) return null;

	const resolvedDurationMs =
		typeof assistant.duration === "number" && Number.isFinite(assistant.duration) && assistant.duration > 0
			? assistant.duration
			: isStreaming
				? nowMs - assistant.timestamp
				: null;

	if (resolvedDurationMs === null || resolvedDurationMs < MIN_DURATION_MS) return null;

	const tokensPerSecond = (outputTokens * 1000) / resolvedDurationMs;
	if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return null;

	return tokensPerSecond;
}

/**
 * Time-to-first-token of the most recent assistant message, in ms. Trailing
 * non-assistant entries are skipped so a just-submitted user turn does not
 * blank the reading; absent or non-positive values report null (no measurement).
 */
export function getLastAssistantTtftMs(messages: ReadonlyArray<MaybeAssistantMessage>): number | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const ttft = message.ttft;
		return typeof ttft === "number" && Number.isFinite(ttft) && ttft > 0 ? ttft : null;
	}
	return null;
}

/** Rolling window (ms) over which live throughput observations are averaged. */
const RATE_WINDOW_MS = 3_000;

/**
 * Streaming throughput sampler for the activity row.
 *
 * {@link calculateTokensPerSecond} only sees *settled* assistant messages, so
 * while a turn is running it can only repeat the previous turn's rate: the
 * in-flight message lives in `agent.state.streamMessage`, and most transports
 * (Ollama's `eval_count`, Anthropic's `message_delta`) report `usage.output`
 * only in the final chunk. This tracker is fed locally-counted tokens from that
 * in-flight message instead, so a live rate, a whole-generation average, and a
 * first-token latency all exist from the first delta.
 *
 * Callers own the counting — this class is pure arithmetic so both the render
 * layer and tests can drive it directly. One window covers one assistant
 * generation: {@link begin} on the first reading, {@link sample} per heartbeat
 * tick, {@link end} when the stream stops. The average survives {@link end} so
 * the idle row can keep reporting it.
 */
export class StreamingRateTracker {
	#samples: Array<{ time: number; tokens: number }> = [];
	#startedAt: number | undefined;
	#endedAt: number | undefined;
	#startTokens = 0;
	#latestTokens = 0;
	#open = false;

	/** Open a window for a generation that has already produced `tokens`. */
	begin(tokens: number, now = Date.now()): void {
		this.#startedAt = now;
		this.#endedAt = undefined;
		this.#startTokens = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
		this.#latestTokens = this.#startTokens;
		this.#samples = [{ time: now, tokens: this.#startTokens }];
		this.#open = true;
	}

	/**
	 * Append a cumulative reading. Opens a window implicitly when no window was
	 * ever begun, so a sampler that missed the stream's first delta still
	 * measures from its first observation. A closed window stays closed — the
	 * frozen average is what the idle row reports, and later readings belong to
	 * a generation the caller must {@link begin} explicitly.
	 */
	sample(tokens: number, now = Date.now()): void {
		if (this.#startedAt === undefined) {
			this.begin(tokens, now);
			return;
		}
		if (!this.#open) return;
		if (!Number.isFinite(tokens) || tokens < 0) return;
		this.#latestTokens = tokens;
		this.#samples.push({ time: now, tokens });
		// Trim to the window. Readings at or after the threshold define the
		// current rate; a single reading before it is retained only as the
		// baseline for a delta, so a stall-then-burst cannot hold the rate down
		// with tokens generated long ago.
		const threshold = now - RATE_WINDOW_MS;
		let start = this.#samples.findIndex(sample => sample.time >= threshold);
		if (start < 0) start = this.#samples.length - 1;
		if (start > 0 && this.#samples.length - start < 2) start -= 1;
		if (start > 0) this.#samples.splice(0, start);
	}

	/**
	 * Close the window. The generation's end time is pinned so the average
	 * stays fixed while the row idles, instead of decaying as wall time grows.
	 */
	end(now = Date.now()): void {
		if (!this.#open) return;
		this.#endedAt = now;
		this.#open = false;
	}

	/** Whether a generation is currently being sampled. */
	get active(): boolean {
		return this.#open;
	}

	/**
	 * Windowed instantaneous tok/s. Null until two readings span a measurable
	 * interval, so a just-started row stays blank instead of inventing a rate.
	 */
	getLiveRate(): number | null {
		const first = this.#samples[0];
		const last = this.#samples[this.#samples.length - 1];
		if (!first || !last) return null;
		const elapsedMs = last.time - first.time;
		if (elapsedMs < MIN_DURATION_MS) return null;
		const tokens = last.tokens - first.tokens;
		if (tokens <= 0) return null;
		return (tokens * 1000) / elapsedMs;
	}

	/**
	 * Whole-generation average tok/s since {@link begin}. Smoother than the
	 * windowed rate and, unlike it, still reported after the stream ends.
	 */
	getAverageRate(now = Date.now()): number | null {
		if (this.#startedAt === undefined) return null;
		const elapsedMs = (this.#endedAt ?? now) - this.#startedAt;
		if (elapsedMs < MIN_DURATION_MS) return null;
		const tokens = this.#latestTokens - this.#startTokens;
		if (tokens <= 0) return null;
		return (tokens * 1000) / elapsedMs;
	}
}
