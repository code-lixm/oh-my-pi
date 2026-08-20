import type { TUI } from "../tui";
import { getPaddingX, sliceByColumn, visibleWidth } from "../utils";
import { Text } from "./text";

const RENDER_INTERVAL_MS = 1000 / 30;
const SPINNER_ADVANCE_MS = 80;
const RENDER_BACKPRESSURE_MULTIPLIER = 9;

type ColorFn = (str: string) => string;

/**
 * Styles Loader message fragments without changing their visible text or width.
 * Set `animated` for colorizers whose ANSI output changes over time.
 */
export type LoaderMessageColorFn = ColorFn & {
	readonly animated?: true;
};

/** Animates a spinner and colorized message while asynchronous work is pending. */
export class Loader extends Text {
	#frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	#currentFrame = 0;
	#intervalId?: NodeJS.Timeout;
	#animationEnabled = true;
	#ui: TUI | null = null;
	#lastSpinnerTick = 0;
	#layoutSource?: readonly string[];
	#layout?: readonly { leading: string; content: string; trailing: string }[];
	#layoutFrames: readonly string[];
	#frozenMessageColors = new Map<string, string>();
	#layoutFrame: string;

	constructor(
		ui: TUI,
		private spinnerColorFn: ColorFn,
		private messageColorFn: LoaderMessageColorFn,
		private message: string = "Loading...",
		spinnerFrames?: string[],
	) {
		super("", 1, 0);
		this.#ui = ui;
		if (spinnerFrames && spinnerFrames.length > 0) {
			this.#frames = spinnerFrames;
		}
		const representatives = new Map<number, string>();
		this.#layoutFrames = this.#frames.map(frame => {
			const width = visibleWidth(frame);
			const representative = representatives.get(width);
			if (representative !== undefined) {
				return representative;
			}
			representatives.set(width, frame);
			return frame;
		});
		this.#layoutFrame = this.#layoutFrames[0];
		this.start();
	}

	override render(width: number): readonly string[] {
		const source = super.render(width);
		if (source !== this.#layoutSource) {
			const paddingX = getPaddingX(1);
			this.#layoutSource = source;
			this.#layout = source.map(line => {
				const clamped = visibleWidth(line) > width ? sliceByColumn(line, 0, width, true) : line;
				const body = clamped.slice(paddingX);
				const content = body.trimEnd();
				return {
					leading: clamped.slice(0, paddingX),
					content,
					trailing: body.slice(content.length),
				};
			});
		}

		const frame = this.#frames[this.#currentFrame];
		// The wrapped text carries one stable representative per frame width.
		// Same-width frames swap only the visible glyph here; crossing widths
		// rewraps against the representative selected by #syncText.
		const sentinel = this.#layoutFrame;
		const lines = [""];
		const layout = this.#layout ?? [];
		for (let i = 0; i < layout.length; i++) {
			const { leading, content, trailing } = layout[i];
			if (i === 0 && content.startsWith(sentinel)) {
				const remainder = content.slice(sentinel.length);
				const separator = remainder.startsWith(" ") ? " " : "";
				const message = remainder.slice(separator.length);
				lines.push(
					`${leading}${this.spinnerColorFn(frame)}${separator}${message ? this.#colorMessage(message) : ""}${trailing}`,
				);
			} else {
				lines.push(`${leading}${content ? this.#colorMessage(content) : ""}${trailing}`);
			}
		}
		return lines;
	}

	start() {
		this.#lastSpinnerTick = performance.now();
		this.#syncText();
		this.#requestSemanticPaint();
		const intervalMs = this.messageColorFn.animated === true ? RENDER_INTERVAL_MS : SPINNER_ADVANCE_MS;
		this.#scheduleTick(intervalMs, intervalMs);
	}

	stop() {
		if (this.#intervalId) {
			clearTimeout(this.#intervalId);
			this.#intervalId = undefined;
		}
	}

	/** Lifecycle teardown: stop the animation timer. Idempotent. */
	dispose() {
		this.stop();
	}

	/** Pause all loader motion, including shimmer produced during unrelated full renders. */
	setAnimationEnabled(enabled: boolean): void {
		if (enabled) {
			if (this.#animationEnabled) return;
			this.#animationEnabled = true;
			this.#frozenMessageColors.clear();
			this.start();
			return;
		}
		if (!this.#animationEnabled) return;
		const frozenMessage = this.messageColorFn(this.message);
		this.#frozenMessageColors.clear();
		this.#frozenMessageColors.set(this.message, frozenMessage);
		this.#animationEnabled = false;
		this.stop();
	}

	setMessage(message: string) {
		if (message === this.message) {
			return;
		}
		this.message = message;
		this.#syncText();
		this.#requestSemanticPaint();
	}

	/** Update non-essential status text without scheduling a component render when direct writes are unsafe. */
	setCosmeticMessage(message: string): void {
		if (message === this.message) return;
		this.message = message;
		this.#syncText();
		this.#ui?.tryDirectWrite(this);
	}

	#colorMessage(message: string): string {
		if (this.#animationEnabled) return this.messageColorFn(message);
		const frozen = this.#frozenMessageColors.get(message);
		if (frozen !== undefined) return frozen;
		const colored = this.messageColorFn(message);
		this.#frozenMessageColors.set(message, colored);
		return colored;
	}

	#scheduleTick(intervalMs: number, delayMs: number): void {
		const timer = setTimeout(() => {
			if (!this.#animationEnabled || this.#intervalId !== timer) return;
			const startedAt = performance.now();
			const elapsed = startedAt - this.#lastSpinnerTick;
			const shouldAdvanceSpinner = elapsed >= SPINNER_ADVANCE_MS;
			if (shouldAdvanceSpinner) {
				const steps = Math.floor(elapsed / SPINNER_ADVANCE_MS);
				// Advance at most one frame per callback. Catching up every missed step
				// makes the spinner jump after an event-loop stall; on a real miss reset
				// the baseline so subsequent ticks resume the normal cadence.
				this.#currentFrame = (this.#currentFrame + 1) % this.#frames.length;
				this.#lastSpinnerTick = steps > 1 ? startedAt : this.#lastSpinnerTick + SPINNER_ADVANCE_MS;
				this.#syncText();
			}
			if (shouldAdvanceSpinner || this.#ui?.synchronizedOutput === true) {
				this.#requestAnimationPaint();
			}

			const frameCostMs = performance.now() - startedAt;
			if (this.#intervalId !== timer) return;
			const cadenceDelayMs = Math.max(0, intervalMs - frameCostMs);
			// Idle for nine times the paint cost to keep animation at or below
			// 10% CPU, even when a slow ConPTY write exceeds the normal cadence.
			const backpressureDelayMs = frameCostMs * RENDER_BACKPRESSURE_MULTIPLIER;
			this.#scheduleTick(intervalMs, Math.max(cadenceDelayMs, backpressureDelayMs));
		}, delayMs);
		this.#intervalId = timer;
	}
	/** Re-wrap the underlying Text only when its message or frame width changes. */
	#syncText(): boolean {
		const layoutFrame = this.#layoutFrames[this.#currentFrame];
		this.#layoutFrame = layoutFrame;
		return this.setText(`${layoutFrame} ${this.message}`);
	}

	#requestSemanticPaint() {
		if (!this.#ui) return;
		if (typeof this.#ui.tryDirectWrite === "function") {
			if (!this.#ui.tryDirectWrite(this)) this.#ui.requestComponentRender(this);
			return;
		}
		if (typeof this.#ui.requestDirectWrite === "function") {
			this.#ui.requestDirectWrite(this);
			return;
		}
		this.#ui.requestComponentRender(this);
	}

	#requestAnimationPaint() {
		if (!this.#ui) return;
		if (typeof this.#ui.tryDirectWrite === "function") {
			this.#ui.tryDirectWrite(this);
			return;
		}
		if (typeof this.#ui.requestDirectWrite === "function") this.#ui.requestDirectWrite(this);
	}
}
