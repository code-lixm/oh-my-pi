/**
 * SGR mouse report parsing (`\x1b[<button;col;rowM` / `…m`).
 *
 * Mouse tracking is opt-in on the normal screen and enabled for fullscreen
 * alternate-screen overlays (see tui.ts). Reports expose 0-based terminal
 * cell coordinates; hosts translate them into component-local coordinates.
 */

/** A decoded SGR mouse report. */
export interface SgrMouseEvent {
	/** Raw button code (bit 32 = motion, bit 64 = wheel, low bits = button). */
	button: number;
	/** 0-based column of the event. */
	col: number;
	/** 0-based row of the event. */
	row: number;
	/** True for a release report (`m` suffix). */
	release: boolean;
	/** Wheel direction: -1 up, 1 down, null when not a wheel event. */
	wheel: -1 | 1 | null;
	/** True when the pointer moved (hover or drag) rather than clicked. */
	motion: boolean;
	/** True for a left-button press (not motion, not release, not wheel). */
	leftClick: boolean;
}

/**
 * Decode an SGR mouse report, or return null when `data` is not one.
 * Callers on hot keypress paths should pre-check `data.startsWith("\x1b[<")`
 * before paying for the regex.
 */
export function parseSgrMouse(data: string): SgrMouseEvent | null {
	const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (!match) return null;
	const button = Number(match[1]);
	const col = Number(match[2]) - 1;
	const row = Number(match[3]) - 1;
	const release = match[4] === "m";
	const wheel = button & 64 ? ((button & 1 ? 1 : -1) as 1 | -1) : null;
	const motion = (button & 32) !== 0 && wheel === null;
	const leftClick = !release && wheel === null && !motion && (button & 3) === 0;
	return { button, col, row, release, wheel, motion, leftClick };
}

/** Handler invoked with a decoded SGR event; returning `false` reports unhandled. */
export type SgrMouseHandler = (event: SgrMouseEvent) => boolean | undefined;

/**
 * Decode an SGR mouse report and forward it to `handler`. Returns `false` when
 * `data` is not an SGR mouse report (or fails to parse), so callers can fall
 * through to other input handling. Centralizes the repeated
 * `data.startsWith("\x1b[<")` + `parseSgrMouse()` pattern.
 */
export function routeSgrMouseInput(data: string, handler: SgrMouseHandler): boolean {
	if (!data.startsWith("\x1b[<")) return false;
	const event = parseSgrMouse(data);
	if (!event) return false;
	return handler(event) !== false;
}

/**
 * Structural view of a SelectList-like target for mouse routing. Declared here
 * (rather than importing the component) to keep this core module free of any
 * component-to-core import cycle.
 */
export interface SelectListMouseTarget {
	handleWheel(delta: -1 | 1): void;
	hitTest(line: number): number | undefined;
	setHoverIndex(index: number | null): void;
	clickItem(index: number): void;
}

/**
 * Route a decoded mouse event against a SelectList-like target at the given
 * 0-based frame-local `line`. Centralizes the repeated wheel/hit-test/hover/
 * click pattern. Returns `true` when the event was consumed.
 */
export function routeSelectListMouse(target: SelectListMouseTarget, event: SgrMouseEvent, line: number): boolean {
	if (event.wheel !== null) {
		target.handleWheel(event.wheel);
		return true;
	}
	const index = target.hitTest(line);
	if (event.motion) {
		target.setHoverIndex(index ?? null);
		return true;
	}
	if (event.leftClick && index !== undefined) {
		target.clickItem(index);
		return true;
	}
	return false;
}

/**
 * Implemented by components that accept routed mouse events at frame-local
 * coordinates. Hosts translate screen coordinates to the component's own
 * rendered lines before forwarding.
 *
 * Returning `void` (or implicitly `undefined`) means "consumed" — the host
 * stops routing. Returning `false` means "not consumed" — the host should
 * try the next layer (overlay beneath, root child below, etc.).
 */
export interface MouseRoutable {
	/** `line`/`col` are 0-based within the component's rendered output.
	 *  Returning `false` keeps routing alive; `void` / `true` / `undefined`
	 *  mark the event as consumed. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): boolean | void;
}

/** Structural probe: the value exposes a callable `routeMouse`. The narrow
 *  type is intentionally generic (not `Component & MouseRoutable`) because
 *  `mouse.ts` cannot import `Component` from `./tui` without creating a
 *  cycle — every host that calls this helper already has a typed value and
 *  needs only the boolean result. */
export function isMouseRoutable(value: unknown): value is { routeMouse: MouseRoutable["routeMouse"] } {
	return value !== null && value !== undefined && typeof (value as Partial<MouseRoutable>).routeMouse === "function";
}
