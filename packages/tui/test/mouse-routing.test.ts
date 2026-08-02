/**
 * Phase 2 frame/component mouse routing.
 *
 * These tests cover the new shared normal-screen routing entry point on TUI:
 *  - multiple root components: a click on a non-focused root segment must
 *    reach that segment, not the focused one;
 *  - nested Container: child-local row translation;
 *  - Box: border + padding column translation;
 *  - overlays: topmost-first with `pointerEvents: "none"` pass-through;
 *  - Editor: `routeMouse` ignores autocomplete/non-content rows.
 *
 * They use the same VirtualTerminal + SGR injection pattern as the existing
 * `editor.test.ts` mouse cases, so the assertions read like the rendered
 * surface, not the implementation.
 */
import { describe, expect, it } from "bun:test";
import { Box, type BoxBorder, type Component, Container, Text, TUI } from "@oh-my-pi/pi-tui";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { defaultEditorTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

/** Component that records click positions passed through `routeMouse`. */
class Recorder implements Component {
	mouseTracking: boolean = false;
	label: string;
	clicks: { line: number; col: number }[] = [];
	inputs: string[] = [];
	routeReturns: boolean = true;

	constructor(label: string) {
		this.label = label;
	}

	render(width: number): readonly string[] {
		return [this.label.repeat(Math.max(1, width))];
	}

	routeMouse(_event: unknown, line: number, col: number): boolean {
		this.clicks.push({ line, col });
		return this.routeReturns;
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}
}

class MultiRowRecorder extends Recorder {
	constructor(private readonly rows: readonly string[]) {
		super("");
	}

	override render(_width: number): readonly string[] {
		return this.rows;
	}
}

const CHARS: BoxBorder["chars"] = {
	topLeft: "+",
	topRight: "+",
	bottomLeft: "+",
	bottomRight: "+",
	horizontal: "-",
	vertical: "|",
};

function borderedTextBox(paddingX = 1, paddingY = 0): Box {
	const box = new Box(paddingX, paddingY, undefined, {
		chars: CHARS,
	});
	box.setIgnoreTight(true);
	box.addChild(new Text("alpha", 0, 0));
	return box;
}

describe("frame-level mouse routing", () => {
	it("routes a click to the root segment that owns the row, ignoring an unrelated cursor marker", async () => {
		// Two root components stacked vertically:
		//   row 0 = recorderA (mouseTracking on so the cursor emits a marker
		//   on every visible render — the same one the legacy code would
		//   have trusted via `at(-1)`)
		//   row 1 = recorderB (mouseTracking off; receives clicks purely
		//   through the new frame-level router).
		const terminal = new VirtualTerminal(20, 4, 1_000);
		const tui = new TUI(terminal, true);
		const recorderA = new Recorder("AAAA");
		recorderA.mouseTracking = true;
		recorderA.label = "AAAA";
		// Override render so the focused-but-not-routed component still emits
		// a cursor marker (TUI's frameCursorMarkers list must include a row-0
		// marker that the legacy path would have mis-attributed).
		const originalARender = recorderA.render.bind(recorderA);
		recorderA.render = (width: number): readonly string[] => {
			const lines = originalARender(width);
			// Re-tag so TUI's marker extraction picks it up. Inject the
			// CURSOR_MARKER at the leftmost cell — its absolute frame row
			// becomes 0, which is also the only row that "looks like" the
			// recorderA row from the legacy fallback's perspective.
			return [lines[0]!.replace(/^./, `\x1b_pi:c\x07${`$&`.charAt(0)}`)];
		};
		const recorderB = new Recorder("BBBB");
		recorderB.mouseTracking = true;
		recorderB.label = "BBBB";
		// Manually mark B as the focused component (the one the legacy
		// handleMouse path would have routed to) — and yet a click on row
		// 1 (B's row) must still reach B through the shared router.
		tui.addChild(recorderA);
		tui.addChild(recorderB);
		tui.setFocus(recorderB);

		try {
			tui.start();
			await terminal.waitForRender();

			// SGR: col=5, row=2 (1-based) → event.col=4, event.row=1.
			// That sits inside B's row (row 1 of the composed frame).
			terminal.sendInput("\x1b[<0;5;2M");
			await terminal.waitForRender();

			// The shared router must have translated to B's child-local
			// coordinates (line 0, since B is the only row in its own render).
			expect(recorderB.clicks).toEqual([{ line: 0, col: 4 }]);
			// A is row 0 and was NOT clicked.
			expect(recorderA.clicks).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("does not forward an unhandled SGR mouse report as keyboard input", async () => {
		const terminal = new VirtualTerminal(20, 4, 1_000);
		const tui = new TUI(terminal, true);
		const recorder = new Recorder("BASE");
		recorder.mouseTracking = true;
		recorder.routeReturns = false;
		tui.addChild(recorder);
		tui.setFocus(recorder);

		try {
			tui.start();
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;3;1M");

			expect(recorder.clicks).toEqual([{ line: 0, col: 2 }]);
			expect(recorder.inputs).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("translates a click through a nested Container into the owning child", () => {
		const outer = new Container();
		const top = new Recorder("TOP1");
		const nested = new Container();
		const deepChild = new Recorder("DEEP");
		nested.addChild(deepChild);
		outer.addChild(top);
		outer.addChild(nested);

		// After render the memoized child spans are:
		//   outer: [TOP1(1 row), nested(1 row)]
		//   nested: [DEEP(1 row)]
		outer.render(10);

		// A click at outer-local line 1 must reach nested, which then
		// translates to deepChild at line 0.
		const consumed = outer.routeMouse(
			{
				button: 0,
				col: 3,
				row: 1,
				release: false,
				wheel: null,
				motion: false,
				leftClick: true,
			},
			1,
			3,
		);
		expect(consumed).toBe(true);
		expect(top.clicks).toEqual([]);
		expect(deepChild.clicks).toEqual([{ line: 0, col: 3 }]);
	});

	it("subtracts Box border and padding before forwarding to a child", () => {
		// paddingX=1, paddingY=0, bordered → 1 row top + 1 row content + 1 row
		// bottom. The content row starts at emitted row 1 (borderTop) and
		// its content begins at column 1 (border) + 1 (padding) = 2.
		const box = borderedTextBox(1, 0);
		const inner = new Recorder("inner");
		// Replace the static Text child so we can capture the routed click.
		box.clear();
		box.addChild(inner);
		box.render(20);

		// Click on row 2 (border bottom): outside content → reject.
		const rejected = box.routeMouse(
			{
				button: 0,
				col: 5,
				row: 2,
				release: false,
				wheel: null,
				motion: false,
				leftClick: true,
			},
			2,
			5,
		);
		expect(rejected).toBe(false);
		expect(inner.clicks).toEqual([]);

		// Click on row 1 (content) at column 5. The border eats column 0
		// and padding eats column 1, so the child-local col must be 5 - 2 = 3.
		const consumed = box.routeMouse(
			{
				button: 0,
				col: 5,
				row: 1,
				release: false,
				wheel: null,
				motion: false,
				leftClick: true,
			},
			1,
			5,
		);
		expect(consumed).toBe(true);
		expect(inner.clicks).toEqual([{ line: 0, col: 3 }]);

		// width=20, border=1 and paddingX=1 leave content columns 2..17.
		// Columns 18 and 19 are right padding and right border respectively.
		inner.clicks.length = 0;
		expect(
			box.routeMouse(
				{ button: 0, col: 18, row: 1, release: false, wheel: null, motion: false, leftClick: true },
				1,
				18,
			),
		).toBe(false);
		expect(
			box.routeMouse(
				{ button: 0, col: 19, row: 1, release: false, wheel: null, motion: false, leftClick: true },
				1,
				19,
			),
		).toBe(false);
		expect(inner.clicks).toEqual([]);
	});

	it("routes topmost overlay first and falls through when pointerEvents is none", async () => {
		const terminal = new VirtualTerminal(20, 4, 1_000);
		const tui = new TUI(terminal, true);
		const base = new Recorder("BASE");
		base.mouseTracking = true;
		base.label = "BASE";
		tui.addChild(base);
		tui.setFocus(base);

		const blocker = new Recorder("BLOCK");
		blocker.label = "BLOCK";
		const passthrough = new Recorder("PASS");
		passthrough.label = "PASS";
		passthrough.routeReturns = false; // explicit "not consumed"

		try {
			tui.start();
			await terminal.waitForRender();

			// BLOCK on top: every click on its rendered region is consumed.
			const blockerHandle = tui.showOverlay(blocker, {
				row: 0,
				col: 0,
				width: 20,
				maxHeight: 2,
				pointerEvents: "auto",
			});
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;3;1M");
			await terminal.waitForRender();
			expect(blocker.clicks.length).toBe(1);
			expect(base.clicks).toEqual([]);

			blocker.clicks.length = 0;
			base.clicks.length = 0;

			// Drop the auto overlay, replace with one that has
			// pointerEvents: "none". The router must skip the new overlay and
			// let the click fall through to the base layer.
			blockerHandle.hide();
			const noneOverlay = new Recorder("NONE");
			noneOverlay.label = "NONE";
			tui.showOverlay(noneOverlay, {
				row: 0,
				col: 0,
				width: 20,
				maxHeight: 2,
				pointerEvents: "none",
			});
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;3;1M");
			await terminal.waitForRender();
			// NONE never receives the click; the click still lands on BASE
			// (which occupies the same composed rows — the pointerEvents
			// overlay is composited on top visually, but mouse routing
			// ignores it).
			expect(noneOverlay.clicks).toEqual([]);
			expect(base.clicks.length).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("preserves component-local rows for a clipped bottom-anchored overlay", async () => {
		const terminal = new VirtualTerminal(20, 4, 1_000);
		const tui = new TUI(terminal, true);
		const base = new Recorder("BASE");
		base.mouseTracking = true;
		tui.addChild(base);
		tui.setFocus(base);
		const overlay = new MultiRowRecorder(["row-0", "row-1", "row-2", "row-3"]);

		try {
			tui.start();
			await terminal.waitForRender();
			tui.showOverlay(overlay, { anchor: "bottom-left", width: 20, maxHeight: 2 });
			await terminal.waitForRender();

			// The visible overlay rows are source rows 2 and 3 at screen rows 2 and 3.
			terminal.sendInput("\x1b[<0;3;3M");
			await terminal.waitForRender();
			expect(overlay.clicks).toEqual([{ line: 2, col: 2 }]);
		} finally {
			tui.stop();
		}
	});

	it("rejects bordered Editor right chrome but keeps blank content cells clickable", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.mouseTracking = true;
		editor.setBorderVisible(true);
		editor.setText("abc");
		editor.render(12);
		const event = { button: 0, col: 0, row: 1, release: false, wheel: null, motion: false, leftClick: true };

		// Default paddingX=2: content starts at col 3 and spans six cells (3..8).
		expect(editor.routeMouse(event, 1, 8)).toBe(true);
		expect(editor.getCursor()).toEqual({ line: 0, col: 3 });
		expect(editor.routeMouse(event, 1, 9)).toBe(false);
		expect(editor.routeMouse(event, 1, 11)).toBe(false);
	});

	it("ignores autocomplete and non-content rows when routing into an Editor", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.mouseTracking = true;
		editor.setBorderVisible(false);
		// Single visible row + autocomplete tail (one row).
		editor.setText("hello");

		// Force the autocomplete to be present via a stub provider so the
		// rendered output is `["hello|<cursor>", "<autocomplete-row>"]`.
		editor.setAutocompleteProvider({
			async getSuggestions() {
				return { items: [{ label: "/help", value: "/help" }], prefix: "/" };
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		});
		editor.handleInput("/");
		// Render once so the hit map is populated.
		editor.render(20);

		// Click on the autocomplete row (emitted line 1). The hit map only
		// knows about content rows; the editor must return false.
		const rejected = editor.routeMouse(
			{
				button: 0,
				col: 0,
				row: 1,
				release: false,
				wheel: null,
				motion: false,
				leftClick: true,
			},
			1,
			0,
		);
		expect(rejected).toBe(false);

		// Click on the content row (emitted line 0). The cursor must move.
		const consumed = editor.routeMouse(
			{
				button: 0,
				col: 4,
				row: 0,
				release: false,
				wheel: null,
				motion: false,
				leftClick: true,
			},
			0,
			4,
		);
		expect(consumed).toBe(true);
		// Position between "hell" and "o".
		expect(editor.getCursor()).toEqual({ line: 0, col: 4 });
	});

	it("snaps a trimmed wrap boundary click to the end of the visible text", () => {
		// Width 5 forces wrap: "hello" (5) + "world" (5). The trailing space
		// at chunk boundary is stripped during wrap; a click past "world"
		// must NOT land in trailing whitespace.
		const editor = new Editor(defaultEditorTheme);
		editor.mouseTracking = true;
		editor.setBorderVisible(false);
		editor.setText("hello world");
		editor.render(5);

		// Click at col 99 on the second wrapped row (line 1) → must snap to
		// the end of "world" (col 11 in the original line).
		const consumed = editor.routeMouse(
			{
				button: 0,
				col: 99,
				row: 1,
				release: false,
				wheel: null,
				motion: false,
				leftClick: true,
			},
			1,
			99,
		);
		expect(consumed).toBe(true);
		expect(editor.getCursor()).toEqual({ line: 0, col: 11 });
	});
});
