import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { getThemeByName, initTheme, type Theme, type ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	getOutputBlockBorderStyle,
	type OutputBlockBorderStyle,
	setOutputBlockBorderStyle,
} from "@oh-my-pi/pi-coding-agent/tui";
import { type Component, type TUI, visibleWidth } from "@oh-my-pi/pi-tui";

const WIDTH = 140;
const uiStub = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI;

function plainLines(lines: readonly string[]): string[] {
	return lines.map(line => Bun.stripANSI(line));
}

function firstNonEmptyLine(lines: readonly string[]): string {
	const line = lines.find(entry => entry.trim().length > 0);
	expect(line).toBeDefined();
	return line!;
}

function leadingSpaces(line: string): number {
	return line.length - line.trimStart().length;
}

function expectSingleOuterPadding(lines: readonly string[], label: string): void {
	const firstLine = firstNonEmptyLine(lines);
	expect(leadingSpaces(firstLine), `${label}: ${JSON.stringify(firstLine)}`).toBe(1);
}

function expectNoOuterPadding(lines: readonly string[], label: string): void {
	const firstLine = firstNonEmptyLine(lines);
	expect(leadingSpaces(firstLine), `${label}: ${JSON.stringify(firstLine)}`).toBe(0);
}

const ACCENT_SURFACE_COLORS = ["borderMuted", "success", "error", "warning"] as const satisfies readonly ThemeColor[];

function withBorderStyle<T>(
	style: OutputBlockBorderStyle,
	run: () => T,
): { previous: OutputBlockBorderStyle; value: T } {
	const previous = getOutputBlockBorderStyle();
	try {
		setOutputBlockBorderStyle(style);
		return { previous, value: run() };
	} finally {
		setOutputBlockBorderStyle(previous);
	}
}

function expectVisibleSnippets(lines: readonly string[], label: string, snippets: readonly string[]): void {
	const text = plainLines(lines).join("\n");
	for (const snippet of snippets) {
		expect(text, `${label}: missing ${JSON.stringify(snippet)} in ${JSON.stringify(text)}`).toContain(snippet);
	}
}

function expectNoAccentSurface(lines: readonly string[], label: string, uiTheme: Theme): void {
	const raw = lines.join("\n");
	const text = plainLines(lines).join("\n");
	expect(text, `${label}: rail leaked into ${JSON.stringify(text)}`).not.toContain("▌");
	for (const color of ACCENT_SURFACE_COLORS) {
		expect(raw, `${label}: ${color} tint leaked`).not.toContain(uiTheme.getSurfaceTintBgAnsi(color, 0.06));
	}
}

function expectPaintedAccentEdge(
	raw: string,
	label: string,
	edge: "top" | "bottom",
	uiTheme: Theme,
	color: ThemeColor = "borderMuted",
): void {
	const tint = uiTheme.getSurfaceTintBgAnsi(color, 0.06);
	const railFg = color === "borderMuted" ? uiTheme.getSurfaceTintFgAnsi(color) : uiTheme.getFgAnsi(color);
	const railPrefix = `${tint}${railFg}▌\x1b[39m\x1b[49m${tint} `;
	const visible = Bun.stripANSI(raw);

	expect(visible.trim(), `${label}: ${edge} edge must be a rail-only row`).toBe("▌");
	expect(raw.startsWith(railPrefix), `${label}: ${edge} edge must carry the tinted rail`).toBe(true);
	expect(raw.endsWith("\x1b[49m "), `${label}: ${edge} edge must leave the terminal inset unpainted`).toBe(true);
	expect(visibleWidth(raw), `${label}: ${edge} edge width`).toBe(WIDTH);
}

function expectSinglePaintedAccentPadding(
	lines: readonly string[],
	label: string,
	uiTheme: Theme,
	color: ThemeColor = "borderMuted",
): void {
	const plain = plainLines(lines);

	expect(lines.length, `${label}: expected content between accent edges`).toBeGreaterThan(2);
	expect(
		plain.filter(line => line.trim() === "▌"),
		`${label}: expected exactly one blank rail row at each edge`,
	).toHaveLength(2);

	for (const [edge, raw] of [
		["top", lines[0]!],
		["bottom", lines.at(-1)!],
	] as const) {
		expectPaintedAccentEdge(raw, label, edge, uiTheme, color);
	}
}

function expectSelfFramedAccentEdges(lines: readonly string[], label: string): void {
	expect(lines.length, `${label}: expected content between accent edges`).toBeGreaterThan(2);
	for (const [edge, raw] of [
		["top", lines[0]!],
		["bottom", lines.at(-1)!],
	] as const) {
		const visible = Bun.stripANSI(raw);
		expect(visible.trim(), `${label}: ${edge} edge must be a rail-only row`).toBe("▌");
		expect(raw, `${label}: ${edge} edge must paint a background`).toContain("\x1b[48;");
		expect(raw.endsWith("\x1b[49m "), `${label}: ${edge} edge must leave the terminal inset unpainted`).toBe(true);
		expect(visibleWidth(raw), `${label}: ${edge} edge width`).toBe(WIDTH);
	}
	expect(plainLines(lines).join("\n"), `${label}: nested shared and self-framed rails`).not.toContain("▌ ▌");
}

// Inline args keep rendering tests independent of the real tool executors.
function inlineArgsFor(name: string): unknown {
	switch (name) {
		case "grep":
			return { pattern: "useState", path: "packages/tui/src" };
		case "glob":
			return { pattern: "*.test.ts" };
		case "ast_grep":
			return { pattern: "useState($A)", language: "tsx", path: "packages/tui/src" };
		case "read":
			return { path: "packages/coding-agent/src/example.ts" };
		case "lsp":
			return { action: "diagnostics", file: "src/example.ts" };
		case "inspect_image":
			return { path: "/tmp/swatch.png", question: "What is shown?" };
		case "web_search":
			return { query: "latest Bun release" };
		case "irc":
			return { op: "send", to: "Worker", message: "status?" };
		case "job":
			return { list: true };
		case "edit":
			return {
				path: "src/greeting.ts",
				old_text: "export const greeting = 'hi';",
				new_text: "export const greeting = 'hello';",
			};
		case "bash":
			return { command: "git status --short" };
		case "retain":
			return { items: [{ content: "memory accent padding sentinel" }] };
		case "yield":
			return {};
		default:
			throw new Error(`No inline args for tool: ${name}`);
	}
}

type ToolResult = {
	content: { type: string; text?: string }[];
	details?: Record<string, unknown>;
	isError?: boolean;
};

function inlineResultFor(name: string): ToolResult {
	switch (name) {
		case "grep":
			return {
				content: [{ type: "text", text: "" }],
				details: {
					matchCount: 2,
					fileCount: 2,
					displayContent: "# src/\n## a.ts\n*1│const x = useState()",
				},
			};
		case "glob":
			return {
				content: [
					{ type: "text", text: "packages/coding-agent/test/a.test.ts\npackages/coding-agent/test/b.test.ts" },
				],
				details: {
					fileCount: 2,
					files: ["packages/coding-agent/test/a.test.ts", "packages/coding-agent/test/b.test.ts"],
				},
			};
		case "ast_grep":
			return {
				content: [{ type: "text", text: "" }],
				details: {
					matchCount: 1,
					fileCount: 1,
					filesSearched: 3,
					displayContent: "# src/\n## a.ts\n*1│const x = useState()\n  meta: $A=0",
				},
			};
		case "read":
			return {
				content: [{ type: "text", text: "1:export const answer = 42;" }],
				details: {
					displayContent: { text: "export const answer = 42;", startLine: 1 },
					contentType: "text/typescript",
				},
			};
		case "lsp":
			return {
				content: [{ type: "text", text: "OK" }],
				details: { action: "diagnostics", request: inlineArgsFor("lsp") },
			};
		case "inspect_image":
			return {
				content: [{ type: "text", text: "A tiny red square.\nSecond observation." }],
				details: { model: "gpt-4.1", imagePath: "/tmp/swatch.png", mimeType: "image/png" },
			};
		case "web_search":
			return {
				content: [{ type: "text", text: "Bun shipped a release." }],
				details: {
					response: {
						provider: "exa",
						answer: "Bun shipped a release.",
						sources: [{ title: "Example Article", url: "https://example.com/article", ageSeconds: 86_400 }],
						searchQueries: ["latest Bun release"],
						model: "exa-answer",
						authMode: "api_key",
					},
				},
			};
		case "irc":
			return {
				content: [{ type: "text", text: "Delivered to 1 peer(s):\n- Worker: revived" }],
				details: { op: "send", from: "Main", to: "Worker", receipts: [{ to: "Worker", outcome: "revived" }] },
			};
		case "job":
			return {
				content: [{ type: "text", text: "2 jobs settled." }],
				details: {
					jobs: [
						{ id: "job_a1", type: "bash", status: "completed", label: "bun test a", durationMs: 5000 },
						{ id: "job_b2", type: "task", status: "completed", label: "task b", durationMs: 10000 },
					],
				},
			};
		case "edit":
			return {
				content: [{ type: "text", text: "Edited src/greeting.ts" }],
				details: {
					path: "src/greeting.ts",
					diff: "@@ -1 +1 @@\n-export const greeting = 'hi';\n+export const greeting = 'hello';",
					firstChangedLine: 1,
				},
			};
		case "bash":
			return {
				content: [{ type: "text", text: "M src/cli/gallery-cli.ts\n?? src/new.ts" }],
				details: { exitCode: 0, wallTimeMs: 120 },
			};
		case "retain":
			return {
				content: [{ type: "text", text: "1 memory stored." }],
				details: { count: 1 },
			};
		case "yield":
			return {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success" },
			};
		default:
			throw new Error(`No inline result for tool: ${name}`);
	}
}

function renderToolLifecycle(name: string, stripAnsi = true): { pending: string[]; success: string[] } {
	const args = inlineArgsFor(name);
	const component = new ToolExecutionComponent(name, args, {}, undefined, uiStub, process.cwd());

	try {
		// Pending: args still incomplete, no result yet.
		const pendingRaw = component.render(WIDTH);

		// Switch to args-complete pending state.
		component.updateArgs(args);
		component.setArgsComplete();

		// Success: result is settled.
		const result = inlineResultFor(name);
		component.updateResult(result, false);
		const successRaw = component.render(WIDTH);

		return {
			pending: stripAnsi ? plainLines(pendingRaw) : [...pendingRaw],
			success: stripAnsi ? plainLines(successRaw) : [...successRaw],
		};
	} finally {
		component.stopAnimation();
	}
}

function renderReadGroupLifecycle(): { pending: string[]; success: string[] } {
	const component = new ReadToolGroupComponent();
	component.updateArgs({ path: "packages/coding-agent/src/tools/glob.ts:437-448" }, "read-1");
	const pending = plainLines(component.render(WIDTH));

	component.updateResult(
		{ content: [{ type: "text", text: "437:export const globToolRenderer = {" }] },
		false,
		"read-1",
	);
	const success = plainLines(component.render(WIDTH));
	return { pending, success };
}

describe("tool execution left-edge alignment", () => {
	beforeAll(async () => {
		await initTheme();
	});

	// ─── non-framed built-ins ─────────────────────────────────────────────────

	it.each(["grep", "glob", "ast_grep"] as const)(
		"keeps non-framed %s pending and result title rows on a one-column outer gutter under full style",
		toolName => {
			const { previous } = withBorderStyle("full", () => {
				const { pending, success } = renderToolLifecycle(toolName);
				expectSingleOuterPadding(pending, `${toolName} pending`);
				expectSingleOuterPadding(success, `${toolName} success`);
			});

			expect(getOutputBlockBorderStyle()).toBe(previous);
		},
	);

	it.each([
		{ toolName: "grep", snippets: ["Grep", "useState"] },
		{ toolName: "glob", snippets: ["Glob", "a.test.ts", "b.test.ts"] },
		{ toolName: "ast_grep", snippets: ["AST Grep", "1 match", "meta: $A=0"] },
	] as const)("renders bare $toolName wrappers under global accent while preserving status and body", async spec => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();

		const { previous } = withBorderStyle("accent", () => {
			const { pending, success } = renderToolLifecycle(spec.toolName, false);
			expectNoOuterPadding(plainLines(pending), `${spec.toolName} pending`);
			expectNoOuterPadding(plainLines(success), `${spec.toolName} success`);
			expectNoAccentSurface(pending, `${spec.toolName} pending`, uiTheme!);
			expectNoAccentSurface(success, `${spec.toolName} success`, uiTheme!);
			expectVisibleSnippets(success, `${spec.toolName} success`, spec.snippets);
		});

		expect(getOutputBlockBorderStyle()).toBe(previous);
	});

	// ─── shared accent-surface edge padding ──────────────────────────────────

	it.each([
		{
			path: "built-in Retain renderer",
			toolName: "retain",
			snippets: ["memory accent padding sentinel"],
		},
	] as const)("gives the $path exactly one painted accent pad row above and below nonempty content", async spec => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();

		const { previous } = withBorderStyle("accent", () => {
			const { pending, success } = renderToolLifecycle(spec.toolName, false);

			for (const [state, lines] of [
				["pending", pending],
				["success", success],
			] as const) {
				expectSinglePaintedAccentPadding(lines, `${spec.path} ${state}`, uiTheme!);
			}
			expectVisibleSnippets(success.slice(1, -1), `${spec.path} content`, spec.snippets);
		});

		expect(getOutputBlockBorderStyle()).toBe(previous);
	});

	it("keeps non-framed irc pending and result title rows on a one-column outer gutter under full style", () => {
		const { previous } = withBorderStyle("full", () => {
			const { pending, success } = renderToolLifecycle("irc");
			expectSingleOuterPadding(pending, "irc pending");
			expectSingleOuterPadding(success, "irc success");
		});

		expect(getOutputBlockBorderStyle()).toBe(previous);
	});

	it("keeps non-framed job pending and result title rows on a one-column outer gutter under full style", () => {
		const { previous } = withBorderStyle("full", () => {
			const { pending, success } = renderToolLifecycle("job");
			expectSingleOuterPadding(pending, "job pending");
			expectSingleOuterPadding(success, "job success");
		});

		expect(getOutputBlockBorderStyle()).toBe(previous);
	});

	// ─── ReadToolGroup alignment ─────────────────────────────────────────────

	it("keeps ReadToolGroup title rows on the same column as non-framed tool execution blocks under full style", () => {
		const { previous } = withBorderStyle("full", () => {
			const grepCol = leadingSpaces(firstNonEmptyLine(renderToolLifecycle("grep").pending));
			const read = renderReadGroupLifecycle();

			const readPending = firstNonEmptyLine(read.pending);
			const readSuccess = firstNonEmptyLine(read.success);

			expect(readPending).toContain("Read");
			expect(readSuccess).toContain("Read");
			expect(leadingSpaces(readPending), "read pending gutter").toBe(grepCol);
			expect(leadingSpaces(readSuccess), "read success gutter").toBe(grepCol);
			expectSingleOuterPadding(read.pending, "read pending");
			expectSingleOuterPadding(read.success, "read success");
		});

		expect(getOutputBlockBorderStyle()).toBe(previous);
	});

	it("removes the outer gutter from unframed search blocks and ReadToolGroup when border style is none", () => {
		const previousBorderStyle = getOutputBlockBorderStyle();

		try {
			setOutputBlockBorderStyle("none");

			for (const toolName of ["grep", "glob", "ast_grep"] as const) {
				const { pending, success } = renderToolLifecycle(toolName);
				expectNoOuterPadding(pending, `${toolName} pending`);
				expectNoOuterPadding(success, `${toolName} success`);
			}

			const read = renderReadGroupLifecycle();
			expectNoOuterPadding(read.pending, "read pending");
			expectNoOuterPadding(read.success, "read success");
		} finally {
			setOutputBlockBorderStyle(previousBorderStyle);
		}

		expect(getOutputBlockBorderStyle()).toBe(previousBorderStyle);
	});

	it.each([
		{
			toolName: "read",
			snippets: ["packages/coding-agent/src/example.ts", "export const answer = 42;"],
		},
		{ toolName: "lsp", snippets: ["Diagnostics", "src/example.ts", "OK"] },
	] as const)("keeps self-framed $toolName results on their own accent surface without a nested rail", async spec => {
		const { previous } = withBorderStyle("accent", () => {
			const { success } = renderToolLifecycle(spec.toolName, false);
			expectNoOuterPadding(plainLines(success), `${spec.toolName} success`);
			expectSelfFramedAccentEdges(success, `${spec.toolName} success`);
			expectVisibleSnippets(success, `${spec.toolName} success`, spec.snippets);
		});

		expect(getOutputBlockBorderStyle()).toBe(previous);
	});

	it.each([
		{
			toolName: "inspect_image",
			snippets: ["Inspect", "Question:", "What is shown?", "gpt-4.1", "image/png", "Second observation."],
		},
		{
			toolName: "web_search",
			snippets: [
				"Web Search",
				"latest Bun release",
				"Answer",
				"Bun shipped a release.",
				"Sources",
				"Example Article",
				"Provider:",
			],
		},
	] as const)("keeps bare $toolName results rail-free under global accent", async spec => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();

		const { previous } = withBorderStyle("accent", () => {
			const { pending, success } = renderToolLifecycle(spec.toolName, false);
			expectNoOuterPadding(plainLines(pending), `${spec.toolName} pending`);
			expectNoOuterPadding(plainLines(success), `${spec.toolName} success`);
			expectNoAccentSurface(pending, `${spec.toolName} pending`, uiTheme!);
			expectNoAccentSurface(success, `${spec.toolName} success`, uiTheme!);
			expectVisibleSnippets(success, `${spec.toolName} success`, spec.snippets);
		});

		expect(getOutputBlockBorderStyle()).toBe(previous);
	});

	it("renders a final yield result as one accent card with only the standard internal spacing", () => {
		const { previous } = withBorderStyle("accent", () => {
			const { success } = renderToolLifecycle("yield");
			const resultIndex = success.findIndex(line =>
				["Result submitted.", "结果已提交"].some(copy => line.includes(copy)),
			);
			expect(resultIndex, `yield result missing: ${JSON.stringify(success)}`).toBeGreaterThan(-1);

			const titleIndex = success.findIndex((line, index) => index < resultIndex && line.trim() !== "▌");
			expect(titleIndex, `yield title missing: ${JSON.stringify(success)}`).toBeGreaterThan(-1);
			expect(
				success.every(line => line.startsWith("▌")),
				`yield rail missing: ${JSON.stringify(success)}`,
			).toBe(true);
			expect(
				success.slice(0, titleIndex).filter(line => line.trim() === "▌"),
				"yield top edge spacing",
			).toHaveLength(1);
			expect(
				success.slice(titleIndex + 1, resultIndex).filter(line => line.trim() === "▌"),
				"yield title/result spacing",
			).toHaveLength(1);
			expect(
				success.slice(resultIndex + 1).filter(line => line.trim() === "▌"),
				"yield bottom edge spacing",
			).toHaveLength(1);
		});

		expect(getOutputBlockBorderStyle()).toBe(previous);
	});

	it("preserves explicit full and none geometry for direct read results", async () => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();

		const { previous: previousFull } = withBorderStyle("full", () => {
			const { success } = renderToolLifecycle("read");
			const text = success.join("\n");
			expectSingleOuterPadding(success, "read full success");
			expect(text).toContain(uiTheme!.boxRound.topLeft);
			expect(text).toContain(uiTheme!.boxRound.bottomLeft);
			expectVisibleSnippets(success, "read full success", ["Read", "export const answer = 42;"]);
		});
		expect(getOutputBlockBorderStyle()).toBe(previousFull);

		const { previous: previousNone } = withBorderStyle("none", () => {
			const { success } = renderToolLifecycle("read", false);
			const text = plainLines(success).join("\n");
			expectNoOuterPadding(plainLines(success), "read none success");
			expect(text).not.toContain(uiTheme!.boxRound.topLeft);
			expect(text).not.toContain(uiTheme!.boxRound.bottomLeft);
			expectNoAccentSurface(success, "read none success", uiTheme!);
			expectVisibleSnippets(success, "read none success", ["Read", "export const answer = 42;"]);
		});
		expect(getOutputBlockBorderStyle()).toBe(previousNone);
	});

	it("wraps non-framed custom renderers in a tinted accent rail with painted edge rows", async () => {
		const previousBorderStyle = getOutputBlockBorderStyle();
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();
		const childLines = ["plain custom row", "child line"] as const;
		const childWidths: number[] = [];
		const child: Component = {
			render(width: number): readonly string[] {
				childWidths.push(width);
				return childLines;
			},
		};
		const tool = {
			name: "custom_plain",
			label: "Custom Plain",
			mergeCallAndResult: true,
			renderResult(): Component {
				return child;
			},
		} as unknown as AgentTool;
		let component: ToolExecutionComponent | undefined;

		try {
			setOutputBlockBorderStyle("accent");
			component = new ToolExecutionComponent("custom_plain", {}, {}, tool, uiStub, process.cwd());

			const pending = component.render(WIDTH);
			expectSinglePaintedAccentPadding(pending, "custom renderer pending", uiTheme!);
			expectVisibleSnippets(pending.slice(1, -1), "custom renderer pending content", ["Custom Plain"]);

			component.updateResult({ content: [{ type: "text", text: "ignored" }], isError: true }, false);
			const first = component.render(WIDTH);
			const second = component.render(WIDTH);
			const plain = plainLines(first);
			const errorBg = uiTheme!.getSurfaceTintBgAnsi("error", 0.06);
			const errorRail = `${errorBg}${uiTheme!.getFgAnsi("error")}▌\x1b[39m\x1b[49m${errorBg} `;

			expect(second).toBe(first);
			expect(childWidths).toEqual([WIDTH - 3, WIDTH - 3]);
			expect(first.every(line => line.startsWith(errorRail))).toBe(true);
			expect(first.join("\n")).toContain(errorBg);
			expectSinglePaintedAccentPadding(first, "custom renderer success", uiTheme!, "error");
			expect(plain.slice(1, -1).map(line => line.trimEnd())).toEqual(childLines.map(line => `▌ ${line}`));
			expect(first.map(line => visibleWidth(line))).toEqual(Array(childLines.length + 2).fill(WIDTH));
			expect(plain.join("\n")).not.toContain("│");
			expect(plain.join("\n")).not.toContain("╭");
			expect(plain.join("\n")).not.toContain("╰");
			expect(plain.join("\n")).not.toContain("─");
		} finally {
			component?.stopAnimation();
			setOutputBlockBorderStyle(previousBorderStyle);
		}

		expect(getOutputBlockBorderStyle()).toBe(previousBorderStyle);
	});

	it("renders the final self-framed Edit block flush to its own top and bottom borders", async () => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();

		const { previous } = withBorderStyle("full", () => {
			const { success } = renderToolLifecycle("edit");
			const first = success[0];
			const last = success.at(-1);

			expect(first, `unexpected leading row: ${JSON.stringify(success)}`).toContain(uiTheme!.boxRound.topLeft);
			expect(first).toContain("Edit:");
			expect(last, `unexpected trailing row: ${JSON.stringify(success)}`).toContain(uiTheme!.boxRound.bottomLeft);
			expectVisibleSnippets(success, "edit final result", ["src/greeting.ts", "hello"]);
		});

		expect(getOutputBlockBorderStyle()).toBe(previous);
	});

	// ─── framed built-in ─────────────────────────────────────────────────────

	it("keeps framed bash lifecycle blocks on a one-column outer gutter under full style", async () => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();

		const { previous } = withBorderStyle("full", () => {
			const { pending, success } = renderToolLifecycle("bash");

			for (const [label, lines] of [
				["bash pending", pending],
				["bash success", success],
			] as const) {
				const firstLine = firstNonEmptyLine(lines);
				expect(leadingSpaces(firstLine), `${label}: ${JSON.stringify(firstLine)}`).toBe(1);
				expect(
					firstLine.trimStart().startsWith(uiTheme!.boxRound.topLeft),
					`${label}: ${JSON.stringify(firstLine)}`,
				).toBe(true);
			}
		});

		expect(getOutputBlockBorderStyle()).toBe(previous);
	});
});
