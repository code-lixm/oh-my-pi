import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { RenderResultOptions } from "@oh-my-pi/pi-agent-core";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { bashToolRenderer, createShellRenderer } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { formatStatusIcon, previewWindowRows } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import {
	CachedOutputBlock,
	getOutputBlockBorderStyle,
	setOutputBlockBorderStyle,
} from "@oh-my-pi/pi-coding-agent/tui/output-block";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminal = TERMINAL as unknown as MutableTerminalInfo;

describe("bashToolRenderer", () => {
	const originalProtocol = TERMINAL.imageProtocol;

	afterEach(() => {
		vi.restoreAllMocks();
		terminal.imageProtocol = originalProtocol;
	});

	it("shows rendered env assignments in the command preview", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const component = bashToolRenderer.renderCall(
			{ command: "printf '%s' \"$MERMAID\"", env: { MERMAID: 'line "one"\ntwo' } },
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const rendered = sanitizeText(component.render(120).join("\n"));
		expect(rendered).toContain('MERMAID="line \\"one\\"\\ntwo"');
		expect(rendered).toContain("printf '%s' \"$MERMAID\"");
	});

	it("shows partial env assignments while tool args are still streaming", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const component = bashToolRenderer.renderCall(
			{
				command: "printf '%s' \"$MERMAID\"",
				__partialJson: '{"command":"printf \'%s\' "$MERMAID"","env":{"MERMAID":"line 1\\nline 2',
			},
			{ expanded: false, isPartial: true },
			uiTheme,
		);
		const rendered = sanitizeText(component.render(120).join("\n"));
		expect(rendered).toContain('MERMAID="line 1\\nline 2"');
		expect(rendered).toContain("printf '%s' \"$MERMAID\"");
	});

	it("sanitizes command tabs and shortens home cwd in previews", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const component = bashToolRenderer.renderCall(
			{
				command: "printf\t'%s'",
				cwd: path.join(os.homedir(), "projects", "demo"),
			},
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const rendered = sanitizeText(component.render(120).join("\n"));
		expect(rendered).toContain("~/projects/demo");
		expect(rendered).not.toContain(os.homedir());
		expect(rendered).not.toContain("\t");
	});

	it("renders partial call previews as neutral frames while preserving pending/running block state", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const blockRender = vi.spyOn(CachedOutputBlock.prototype, "render");
		const runningLines = bashToolRenderer.renderCall(
			{ command: "sleep 30" },
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			uiTheme,
		);
		const runningRendered = runningLines.render(60).join("\n");
		expect(blockRender.mock.calls.at(-1)?.[0]).toMatchObject({ state: "running", applyBg: false });
		blockRender.mockClear();
		const pendingLines = bashToolRenderer.renderCall(
			{ command: "sleep 30" },
			{ expanded: false, isPartial: true },
			uiTheme,
		);
		const pendingRendered = pendingLines.render(60).join("\n");
		expect(blockRender.mock.calls.at(-1)?.[0]).toMatchObject({ state: "pending", applyBg: false });

		const pendingBg = uiTheme.getBgAnsi("toolPendingBg");
		// Pending/running blocks share the same theme background token.
		const runningBg = uiTheme.getBgAnsi("toolPendingBg");
		const borderMuted = uiTheme.getFgAnsi("borderMuted");

		for (const rendered of [runningRendered, pendingRendered]) {
			expect(rendered).not.toContain(pendingBg);
			expect(rendered).not.toContain(runningBg);
			const strippedLines = Bun.stripANSI(rendered).split("\n");
			expect(strippedLines.length).toBeGreaterThanOrEqual(3);
			const header = rendered.split("\n")[0] ?? "";
			expect(header.startsWith(borderMuted)).toBe(true);
			expect(strippedLines[0]).not.toContain("Bash");
			expect(strippedLines[0]).not.toContain("sleep 30");
			expect(strippedLines.slice(1, -1).join("\n")).toContain("$ sleep 30");
		}
	});

	it("renders completed results borderlessly under display.borderStyle none", async () => {
		const previousBorderStyle = getOutputBlockBorderStyle();

		try {
			setOutputBlockBorderStyle("none");
			const theme = await getThemeByName("dark");
			expect(theme).toBeDefined();
			const uiTheme = theme!;
			const component = bashToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "line one\nline two\n\nWall time: 0.02 seconds" }],
					details: { timeoutSeconds: 300, wallTimeMs: 20 },
					isError: false,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ command: "printf 'line one\\nline two\\n'" },
			);
			const plainLines = component.render(80).map(line => Bun.stripANSI(line).trimEnd());
			const text = plainLines.join("\n");
			const commandIndex = plainLines.findIndex(line => line.includes("$ printf 'line one\\nline two\\n'"));
			// Search only after the command row so the "line one" sentinel does not
			// falsely match the command literal embedded in the command string.
			const outputIndex = plainLines.slice(commandIndex + 1).findIndex(line => line.includes("line one"));
			// separator: true emits one blank line between command and output sections.
			expect(
				plainLines.slice(commandIndex + 1, commandIndex + 1 + outputIndex).some(line => line.trim().length === 0),
			).toBe(true);

			expect(text).toContain(uiTheme.symbol("tool.bash"));
			expect(text).toContain("Bash");
			expect(text).toContain("$ printf 'line one\\nline two\\n'");
			expect(text).toContain("line one");
			expect(text).toContain("line two");
			expect(text).not.toContain("Output");
			for (const glyph of [
				uiTheme.tree.branch,
				uiTheme.tree.last,
				uiTheme.tree.vertical,
				uiTheme.symbol("boxRound.topLeft"),
				uiTheme.symbol("boxRound.topRight"),
				uiTheme.symbol("boxRound.bottomLeft"),
				uiTheme.symbol("boxRound.bottomRight"),
			]) {
				expect(text).not.toContain(glyph);
			}
		} finally {
			setOutputBlockBorderStyle(previousBorderStyle);
		}
	});

	it("renders bash results with no internal divider between command and output", async () => {
		const previousBorderStyle = getOutputBlockBorderStyle();

		try {
			const theme = await getThemeByName("dark");
			expect(theme).toBeDefined();
			const uiTheme = theme!;

			for (const borderStyle of ["full", "horizontal"] as const) {
				setOutputBlockBorderStyle(borderStyle);
				const component = bashToolRenderer.renderResult(
					{
						content: [{ type: "text", text: "line one\n\nWall time: 0.02 seconds" }],
						details: { timeoutSeconds: 300, wallTimeMs: 20 },
						isError: false,
					},
					{ expanded: false, isPartial: false },
					uiTheme,
					{ command: "printf 'line one\\n'" },
				);
				const text = component
					.render(80)
					.map(line => Bun.stripANSI(line))
					.join("\n");
				// New contract: no labeled "Output" divider between command and output
				expect(text).not.toContain("Output:");
				expect(text).not.toContain("Output ");
				expect(text).toContain("line one");
				// Command should be present
				expect(text).toContain("$ printf");
			}
		} finally {
			setOutputBlockBorderStyle(previousBorderStyle);
		}
	});

	it("shows the effective timeout from result details when it differs from call args", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const component = bashToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details: { timeoutSeconds: 120 }, isError: false },
			{ expanded: false, isPartial: false, renderContext: { timeout: 1200 } },
			uiTheme,
			{ command: "python3 scripts/edit-benchmark.py", timeout: 1200 },
		);
		const rendered = sanitizeText(component.render(120).join("\n"));
		expect(rendered).toContain("Timeout: 120s");
		expect(rendered).not.toContain("Timeout: 1200s");
	});

	it("renders wall time alongside the timeout label and strips the textual notice", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const component = bashToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "hello\n\nWall time: 1.23 seconds" }],
				details: { timeoutSeconds: 5, wallTimeMs: 1230 },
				isError: false,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
			{ command: "echo hi" },
		);
		const rendered = sanitizeText(component.render(120).join("\n"));
		expect(rendered).toContain("Wall: 1.23s");
		expect(rendered).toContain("Timeout: 5s");
		// Notice text must not appear in the output region — the styled label is the
		// only place wall time is shown so users don't read it twice.
		expect(rendered).not.toContain("Wall time: 1.23 seconds");
	});

	it("renders a backgrounded job as a static footer notice", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const component = bashToolRenderer.renderResult(
			{
				content: [
					{
						type: "text",
						text: "started\n\nBackgrounded as job bash-42; result will be delivered automatically.",
					},
				],
				details: {
					timeoutSeconds: 300,
					async: { state: "running", jobId: "bash-42", type: "bash" },
				},
				isError: false,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
			{ command: "sleep 30" },
		);
		const rendered = sanitizeText(component.render(120).join("\n"));
		expect(rendered).toContain("started");
		expect(rendered).toContain("Backgrounded: bash-42");
		expect(rendered).not.toContain("result will be delivered automatically");
	});

	it("folds raw output artifact notices into the status footer", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const component = bashToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "filtered\n[raw output: artifact://13]\n\nWall time: 0.08 seconds" }],
				details: { timeoutSeconds: 300, wallTimeMs: 80 },
				isError: false,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
			{ command: "bun run check:types" },
		);
		const rendered = sanitizeText(component.render(120).join("\n"));
		expect(rendered).toContain("filtered");
		expect(rendered).toContain("Wall: 0.08s");
		expect(rendered).toContain("Timeout: 300s");
		expect(rendered).toContain("Artifact: 13");
		expect(rendered).not.toContain("[raw output: artifact://13]");
		expect(rendered).not.toContain("artifact://13");
	});
	it("renders the exit status in the footer and strips the textual exit notice for failed commands", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const component = bashToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "boom\n\nWall time: 0.02 seconds\n\nCommand exited with code 1" }],
				details: { timeoutSeconds: 300, wallTimeMs: 20, exitCode: 1 },
				isError: true,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
			{ command: "false" },
		);
		const rendered = sanitizeText(component.render(120).join("\n"));
		// The footer carries the styled stats including the non-zero exit status.
		expect(rendered).toContain("Wall: 0.02s");
		expect(rendered).toContain("Timeout: 300s");
		expect(rendered).toContain("Exit: 1");
		// Both the exit-code and wall-time notices are folded into the footer, not
		// echoed verbatim in the output region.
		expect(rendered).not.toContain("Command exited with code 1");
		expect(rendered).not.toContain("Wall time: 0.02 seconds");
		// The command's own output still shows.
		expect(rendered).toContain("boom");
	});

	it("renders a timed-out command with a warning border instead of an error border", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const component = bashToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "[Command timed out after 1 seconds]\n" }],
				details: { timeoutSeconds: 1, timedOut: true },
				isError: true,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
			{ command: "sleep 3", timeout: 1 },
		);
		const rendered = component.render(120).join("\n");
		const warningAnsi = uiTheme.fg("warning", "").replace("\x1b[39m", "");
		const errorAnsi = uiTheme.fg("error", "").replace("\x1b[39m", "");

		expect(rendered).toContain(warningAnsi);
		expect(rendered).not.toContain(errorAnsi);
	});

	it("omits the status footer for a successful command", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const component = bashToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "ok\n\nWall time: 0.02 seconds" }],
				details: { timeoutSeconds: 300, wallTimeMs: 20 },
				isError: false,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
			{ command: "true" },
		);
		const rendered = sanitizeText(component.render(120).join("\n"));
		expect(rendered).toContain("Wall: 0.02s");
		expect(rendered).toContain("Timeout: 300s");
		expect(rendered).not.toContain("Exit:");
	});

	it("bypasses truncation/styling for SIXEL lines", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const sixel = "\x1bPqabc\x1b\\";
		const renderOptions: RenderResultOptions & {
			renderContext: {
				output: string;
				expanded: boolean;
				previewLines: number;
			};
		} = {
			expanded: false,
			isPartial: false,
			renderContext: {
				output: `line one\n${sixel}\nline two`,
				expanded: false,
				previewLines: 1,
			},
		};

		const component = bashToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details: {}, isError: false },
			renderOptions,
			uiTheme,
			{ command: "echo sixel" },
		);
		const lines = component.render(80);

		expect(lines.filter(line => line === sixel)).toHaveLength(1);
		expect(lines.some(line => line.includes("ctrl+o to expand"))).toBe(false);
	});

	it("drives real partial bash result cards through running vs pending block states without a whole-card state background", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "streaming output" }],
			details: { timeoutSeconds: 5 },
			isError: false,
		};
		const blockRender = vi.spyOn(CachedOutputBlock.prototype, "render");
		const runningLines = bashToolRenderer
			.renderResult(result, { expanded: false, isPartial: true, spinnerFrame: 0 }, uiTheme, { command: "sleep 1" })
			.render(80);
		expect(blockRender.mock.calls.at(-1)?.[0]).toMatchObject({ state: "running", applyBg: false });
		blockRender.mockClear();
		const pendingLines = bashToolRenderer
			.renderResult(result, { expanded: false, isPartial: true }, uiTheme, { command: "sleep 1" })
			.render(80);
		expect(blockRender.mock.calls.at(-1)?.[0]).toMatchObject({ state: "pending", applyBg: false });

		const pendingBg = uiTheme.getBgAnsi("toolPendingBg");
		// Pending/running blocks share the same theme background token.
		const runningBg = uiTheme.getBgAnsi("toolPendingBg");
		const borderMuted = uiTheme.getFgAnsi("borderMuted");
		const dim = uiTheme.getFgAnsi("dim");
		const accent = uiTheme.getFgAnsi("accent");

		for (const lines of [runningLines, pendingLines]) {
			const rendered = lines.join("\n");
			expect(rendered).not.toContain(pendingBg);
			expect(rendered).not.toContain(runningBg);
			const headerLine = lines[0]!;
			expect(headerLine.startsWith(borderMuted)).toBe(true);
			expect(headerLine.startsWith(dim)).toBe(false);
			expect(headerLine.startsWith(accent)).toBe(false);
			const plain = Bun.stripANSI(rendered);
			expect(plain).toContain("$ sleep 1");
			// New contract: no labeled divider between command and output
			expect(plain).not.toContain("Output:");
			expect(plain).toContain("streaming output");
		}
	});

	it("shared shell renderer switches spinner-bearing partial results from pending to running without changing the neutral frame or adding a whole-card state background", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const headeredBashRenderer = createShellRenderer<{ command: string }>({
			resolveTitle: () => "Bash",
			resolveCommand: args => args?.command,
		});
		const result = {
			content: [{ type: "text", text: "streaming output" }],
			details: { timeoutSeconds: 5 },
			isError: false,
		};
		const runningLines = headeredBashRenderer
			.renderResult(result, { expanded: false, isPartial: true, spinnerFrame: 0 }, uiTheme, { command: "sleep 1" })
			.render(80);
		const pendingLines = headeredBashRenderer
			.renderResult(result, { expanded: false, isPartial: true }, uiTheme, { command: "sleep 1" })
			.render(80);
		const runningIcon = Bun.stripANSI(formatStatusIcon("running", uiTheme, 0));
		const pendingIcon = Bun.stripANSI(formatStatusIcon("pending", uiTheme));
		const pendingBg = uiTheme.getBgAnsi("toolPendingBg");
		// Pending/running blocks share the same theme background token.
		const runningBg = uiTheme.getBgAnsi("toolPendingBg");
		const borderMuted = uiTheme.getFgAnsi("borderMuted");
		const dim = uiTheme.getFgAnsi("dim");
		const accent = uiTheme.getFgAnsi("accent");

		expect(Bun.stripANSI(runningLines[0] ?? "")).toContain(runningIcon);
		expect(Bun.stripANSI(runningLines[0] ?? "")).not.toContain(pendingIcon);
		expect(Bun.stripANSI(pendingLines[0] ?? "")).toContain(pendingIcon);
		expect(Bun.stripANSI(pendingLines[0] ?? "")).not.toContain(runningIcon);

		for (const lines of [runningLines, pendingLines]) {
			const rendered = lines.join("\n");
			expect(rendered).not.toContain(pendingBg);
			expect(rendered).not.toContain(runningBg);
			const headerLine = lines[0]!;
			expect(headerLine.startsWith(borderMuted)).toBe(true);
			expect(headerLine.startsWith(dim)).toBe(false);
			expect(headerLine.startsWith(accent)).toBe(false);
		}
	});

	it("highlights every line of a multi-line bash command in renderResult", async () => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();
		vi.spyOn(themeModule, "highlightCode").mockImplementation((code: string) =>
			code.split("\n").map(line => `\u001b[38;5;45m${line}\u001b[39m`),
		);
		const command = 'for f in a b; do\n\techo "$f"\ndone';
		const component = bashToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details: {}, isError: false },
			{ expanded: false, isPartial: false },
			uiTheme!,
			{ command },
		);
		const rendered = component.render(120);
		const sanitized = rendered.map(line => sanitizeText(line));
		// Every command line must appear in the output, untruncated.
		const findLine = (needle: string) => sanitized.findIndex(line => line.includes(needle));
		const forLine = findLine("for f in a b; do");
		const echoLine = findLine('echo "$f"');
		const doneLine = findLine("done");
		expect(forLine).toBeGreaterThanOrEqual(0);
		expect(echoLine).toBeGreaterThanOrEqual(0);
		expect(doneLine).toBeGreaterThanOrEqual(0);
		// Each command line carries its own SGR run so terminals don't drop
		// styling after the first newline (the bug this fix addresses).
		for (const idx of [forLine, echoLine, doneLine]) {
			expect(rendered[idx]).toMatch(/\u001b\[38;(?:2|5);/);
		}
	});

	it("caches the framed lines across repeated render() calls with identical inputs (issue #2081)", async () => {
		// The bash result renderer is called per TUI repaint; with a long
		// transcript and a 50KB-tail output that's the hot path that pinned the
		// main thread in #2081. The eval renderer already caches by (width,
		// previewLines) — this test pins the same contract for bash so future
		// refactors don't silently drop the cache.
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		// A non-trivial output so a missed cache hit would do real string work.
		const output = Array.from({ length: 200 }, (_, i) => `line ${i}: payload ${"x".repeat(20)}`).join("\n");
		const component = bashToolRenderer.renderResult(
			{
				content: [{ type: "text", text: output }],
				details: { timeoutSeconds: 5, wallTimeMs: 12 },
				isError: false,
			},
			{ expanded: false, isPartial: false, renderContext: { output, expanded: false, previewLines: 8 } },
			uiTheme,
			{ command: "printf '%s' big" },
		);

		const first = component.render(120);
		const second = component.render(120);
		// Identical inputs → cache hit returns the very same array reference.
		expect(second).toBe(first);

		// Width change busts the cache; fresh array.
		const wider = component.render(160);
		expect(wider).not.toBe(first);

		// Original width hits the cache slot's current binding — proving the
		// cache key includes width and isn't a stale-single-slot bug.
		const sameAgain = component.render(120);
		expect(sameAgain).not.toBe(first); // most-recent slot now holds the 160 result
		expect(sameAgain).not.toBe(wider);

		// Subsequent identical render reuses the freshly-cached 120 slot.
		const sameAgainCached = component.render(120);
		expect(sameAgainCached).toBe(sameAgain);

		// invalidate() clears the cache so the next render produces a brand-new array.
		(component as { invalidate?: () => void }).invalidate?.();
		const postInvalidate = component.render(120);
		expect(postInvalidate).not.toBe(sameAgainCached);
	});

	it("renders the collapsed command as a viewport tail window in every state — no stream→final expansion", async () => {
		// The collapsed command is a tail window sized from the viewport: the end
		// (the live edge while args stream) stays visible behind an "earlier
		// lines" marker. The finalized collapsed block MUST render the identical
		// window — snapping the full command open on completion makes the block
		// jump. Only ctrl+o (expanded) uncaps.
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const total = previewWindowRows() + 5;
		const command = Array.from({ length: total }, (_, i) => `echo step_${i}`).join("\n");
		const render = (opts: { expanded: boolean; isPartial: boolean }) => {
			const component = bashToolRenderer.renderResult(
				{ content: [{ type: "text", text: "" }], details: {}, isError: false },
				opts,
				uiTheme,
				{ command },
			);
			return sanitizeText(component.render(120).join("\n"));
		};

		for (const rendered of [
			render({ expanded: false, isPartial: true }),
			render({ expanded: false, isPartial: false }),
		]) {
			expect(rendered).toContain(`echo step_${total - 1}`);
			expect(rendered).toContain("earlier line");
			expect(rendered).not.toContain("echo step_0");
		}

		const expandedFinal = render({ expanded: true, isPartial: false });
		expect(expandedFinal).toContain("echo step_0");
		expect(expandedFinal).not.toContain("earlier line");
	});
});
