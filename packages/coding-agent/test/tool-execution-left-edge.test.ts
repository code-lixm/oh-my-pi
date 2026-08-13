import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { getThemeByName, initTheme, type Theme, type ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	getOutputBlockBorderStyle,
	OUTPUT_BLOCK_ACCENT_GLYPH,
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
	expect(text, `${label}: rail leaked into ${JSON.stringify(text)}`).not.toContain(OUTPUT_BLOCK_ACCENT_GLYPH);
	for (const color of ACCENT_SURFACE_COLORS) {
		expect(raw, `${label}: ${color} tint leaked`).not.toContain(uiTheme.getSurfaceTintBgAnsi(color, 0.06));
	}
}

function expectRootTreeChildren(lines: readonly string[], label: string, uiTheme: Theme): void {
	const nonEmpty = lines.filter(line => line.trim().length > 0);
	const first = nonEmpty[0];
	const last = nonEmpty.at(-1);
	const isRootTreeChild = (line: string) =>
		line.startsWith(`${uiTheme.tree.branch} `) || line.startsWith(`${uiTheme.tree.last} `);

	expect(first, `${label}: expected a result tree child`).toBeDefined();
	expect(isRootTreeChild(first!), `${label}: first result row must be a root-level tree child`).toBe(true);
	expect(leadingSpaces(first!), `${label}: first result tree depth`).toBe(0);
	expect(last, `${label}: expected a final result tree child`).toBeDefined();
	expect(last!.startsWith(`${uiTheme.tree.last} `), `${label}: final result row must terminate the tree`).toBe(true);
	expect(leadingSpaces(last!), `${label}: final result tree depth`).toBe(0);
}

function expectSharedAccentContentRows(
	lines: readonly string[],
	label: string,
	uiTheme: Theme,
	color: ThemeColor = "borderMuted",
): void {
	const tint = uiTheme.getSurfaceTintBgAnsi(color, 0.06);
	const railFg = color === "borderMuted" ? uiTheme.getSurfaceTintFgAnsi(color) : uiTheme.getFgAnsi(color);
	const railPrefix = `${tint}${railFg}▌\x1b[39m\x1b[49m${tint} `;
	const plain = plainLines(lines);

	expect(lines, `${label}: expected content rows`).not.toHaveLength(0);
	for (const [index, raw] of lines.entries()) {
		const visible = plain[index]!;
		expect(visible.trim(), `${label}: wrapper inserted a rail-only row at ${index}`).not.toBe("▌");
		expect(raw.startsWith(railPrefix), `${label}: row ${index} must carry the tinted rail`).toBe(true);
		expect(raw.endsWith("\x1b[49m "), `${label}: row ${index} must leave the terminal inset unpainted`).toBe(true);
		expect(visibleWidth(raw), `${label}: row ${index} width`).toBe(WIDTH);
	}
}

function expectAccentSurfaceEdges(lines: readonly string[], label: string): void {
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
	expect(plainLines(lines).join("\n"), `${label}: nested accent rails`).not.toContain("▌ ▌");
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
type XdevWriteRenderResult = {
	content: readonly { type: string; text?: string }[];
	details?: Record<string, unknown>;
	isError?: boolean;
};

type XdevWriteRenderSpec = {
	name: string;
	device: "checkpoint" | "rewind";
	title: "Checkpoint" | "Rewind";
	content: string;
	result: XdevWriteRenderResult;
	snippets: readonly string[];
	error?: boolean;
};

function renderXdevWriteResult({ device: name, content, result }: XdevWriteRenderSpec): string[] {
	const label = name === "checkpoint" ? "Checkpoint" : "Rewind";
	const device = { name, label } as unknown as AgentTool;
	const write = {
		name: "write",
		label: "Write",
		session: {
			xdev: {
				tools: new Map([[name, device]]),
				mountedNames: new Set([name]),
				builtInNames: new Set(["read", "write"]),
				isActive: () => false,
			},
		},
	} as unknown as AgentTool;
	const component = new ToolExecutionComponent(
		"write",
		{ path: `xd://${name}`, content },
		{},
		write,
		uiStub,
		process.cwd(),
	);

	try {
		component.updateResult({ ...result, content: [...result.content] }, false);
		return [...component.render(WIDTH)];
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

	// ─── bare status-and-tree renderers ──────────────────────────────────────

	it("renders Retain pending and result as bare Memory trees under global accent", async () => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();

		const { previous } = withBorderStyle("accent", () => {
			const { pending, success } = renderToolLifecycle("retain", false);

			for (const [state, lines] of [
				["pending", pending],
				["success", success],
			] as const) {
				const visible = plainLines(lines);
				const titleIndex = visible.findIndex(line => line.trim().length > 0);
				const title = firstNonEmptyLine(visible);

				expectNoOuterPadding(visible, `retain ${state}`);
				expectNoAccentSurface(lines, `retain ${state}`, uiTheme!);
				expect(title, `retain ${state} title`).toContain("Memory");
				expect(title, `retain ${state} operation`).toContain("retain");
				expectRootTreeChildren(visible.slice(titleIndex + 1), `retain ${state}`, uiTheme!);
			}

			expectVisibleSnippets(success, "retain success", ["memory accent padding sentinel"]);
		});

		expect(getOutputBlockBorderStyle()).toBe(previous);
	});
	const XDEV_WRITE_RENDER_CASES = [
		{
			name: "checkpoint success",
			device: "checkpoint",
			title: "Checkpoint",
			content: '{"goal":"verify bare xdev rendering"}',
			result: {
				content: [
					{
						type: "text",
						text: [
							"Checkpoint created.",
							"Goal: verify bare xdev rendering",
							"Run your investigation, then call rewind with a concise report.",
						].join("\n"),
					},
				],
				details: {
					xdev: {
						tool: "checkpoint",
						mode: "execute",
						args: { goal: "verify bare xdev rendering" },
						inner: { goal: "verify bare xdev rendering", startedAt: "2026-01-01T00:00:00.000Z" },
					},
				},
			},
			snippets: ["Checkpoint created."],
			error: false,
		},
		{
			name: "rewind success",
			device: "rewind",
			title: "Rewind",
			content: '{"report":"Renderer contract verified."}',
			result: {
				content: [
					{
						type: "text",
						text: ["Rewind requested.", "Report captured for context replacement."].join("\n"),
					},
				],
				details: {
					xdev: {
						tool: "rewind",
						mode: "execute",
						args: { report: "Renderer contract verified." },
						inner: { report: "Renderer contract verified.", rewound: true },
					},
				},
			},
			snippets: ["Rewind requested.", "Report captured for context replacement."],
			error: false,
		},
		{
			name: "rewind parse error",
			device: "rewind",
			title: "Rewind",
			content: "{",
			result: {
				content: [
					{
						type: "text",
						text: "xd://rewind expects a JSON args object as content (unterminated JSON).",
					},
				],
				details: { xdev: { tool: "rewind", mode: "execute" } },
				isError: true,
			},
			snippets: ["expects a JSON args object"],
			error: true,
		},
	] satisfies readonly XdevWriteRenderSpec[];

	it.each(XDEV_WRITE_RENDER_CASES)("renders write xd://$device $name as a bare delegated result", async spec => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();

		const { previous } = withBorderStyle("accent", () => {
			const rendered = renderXdevWriteResult(spec);
			const visible = plainLines(rendered);
			const titleIndex = visible.findIndex(line => line.trim().length > 0);
			const title = firstNonEmptyLine(visible);
			const resultLines = visible.slice(titleIndex + 1);

			expectNoOuterPadding(visible, `xd://${spec.device} ${spec.name}`);
			expectNoAccentSurface(rendered, `xd://${spec.device} ${spec.name}`, uiTheme!);
			expect(title, `xd://${spec.device} ${spec.name} title`).toContain(spec.title);
			expect(title, `xd://${spec.device} ${spec.name} must not retain Write title`).not.toContain("Write");
			expect(
				title.startsWith(`${uiTheme!.tree.last} `),
				`xd://${spec.device} ${spec.name} title must precede its result tree child`,
			).toBe(false);
			expectRootTreeChildren(resultLines, `xd://${spec.device} ${spec.name}`, uiTheme!);
			expectVisibleSnippets(resultLines, `xd://${spec.device} ${spec.name} result`, spec.snippets);
			expect(visible.join("\n"), `xd://${spec.device} ${spec.name} must not retain Write`).not.toContain("Write");
			if (spec.error) {
				expect(title, "rewind parse error must retain error status").toContain(uiTheme!.status.error);
			}
			if (!spec.error && spec.device === "checkpoint") {
				expect(title, "checkpoint success must use the success glyph").toContain(uiTheme!.status.success);
				expect(title, "checkpoint success must not use the rewind glyph").not.toContain(uiTheme!.icon.rewind);
			}
			if (!spec.error && spec.device === "rewind") {
				expect(title, "rewind success must use the rewind glyph").toContain(uiTheme!.icon.rewind);
			}
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

	it("keeps a self-framed Read result on its own accent surface without a nested rail", async () => {
		const { previous } = withBorderStyle("accent", () => {
			const { success } = renderToolLifecycle("read", false);
			expectNoOuterPadding(plainLines(success), "read success");
			expectAccentSurfaceEdges(success, "read success");
			expectVisibleSnippets(success, "read success", [
				"packages/coding-agent/src/example.ts",
				"export const answer = 42;",
			]);
		});

		expect(getOutputBlockBorderStyle()).toBe(previous);
	});

	it("renders LSP pending and result as bare status-and-tree output under global accent", async () => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();

		const { previous } = withBorderStyle("accent", () => {
			const { pending, success } = renderToolLifecycle("lsp", false);

			for (const [state, lines] of [
				["pending", pending],
				["success", success],
			] as const) {
				const visible = plainLines(lines);
				const text = visible.join("\n");

				expectNoOuterPadding(visible, `lsp ${state}`);
				expectNoAccentSurface(lines, `lsp ${state}`, uiTheme!);
				expect(firstNonEmptyLine(visible), `lsp ${state} title`).toContain("LSP");
				for (const corner of [
					uiTheme!.boxRound.topLeft,
					uiTheme!.boxRound.topRight,
					uiTheme!.boxRound.bottomLeft,
					uiTheme!.boxRound.bottomRight,
				]) {
					expect(text, `lsp ${state}: frame leaked`).not.toContain(corner);
				}
			}

			const visibleSuccess = plainLines(success);
			const titleIndex = visibleSuccess.findIndex(line => line.trim().length > 0);
			expectRootTreeChildren(visibleSuccess.slice(titleIndex + 1), "lsp success", uiTheme!);
			expectVisibleSnippets(success, "lsp success", ["Diagnostics", "src/example.ts", "OK"]);
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
			snippets: ["Web Search", "latest Bun release", "Bun shipped a release.", "Example Article"],
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

	it("wraps non-framed custom renderers in a tinted accent rail with top and bottom breathing rows", async () => {
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
			expect(pending, "custom renderer pending content plus breathing rows").toHaveLength(3);
			expectAccentSurfaceEdges(pending, "custom renderer pending");
			expectSharedAccentContentRows(pending.slice(1, -1), "custom renderer pending", uiTheme!);
			expectVisibleSnippets(pending, "custom renderer pending content", ["Custom Plain"]);

			component.updateResult({ content: [{ type: "text", text: "ignored" }], isError: true }, false);
			const first = component.render(WIDTH);
			const plain = plainLines(first);

			expect(childWidths).toEqual([WIDTH - 3]);
			expect(first, "custom renderer success content plus breathing rows").toHaveLength(childLines.length + 2);
			expectAccentSurfaceEdges(first, "custom renderer success");
			expectSharedAccentContentRows(first.slice(1, -1), "custom renderer success", uiTheme!, "error");
			expect(plain.slice(1, -1).map(line => line.trimEnd())).toEqual(childLines.map(line => `▌ ${line}`));
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

	it("does not paint a ghost accent surface around an empty non-framed custom renderer", () => {
		const emptyChild: Component = {
			render(): readonly string[] {
				return [];
			},
		};
		const tool = {
			name: "custom_empty",
			label: "Custom Empty",
			mergeCallAndResult: true,
			renderResult(): Component {
				return emptyChild;
			},
		} as unknown as AgentTool;

		const { previous } = withBorderStyle("accent", () => {
			const component = new ToolExecutionComponent("custom_empty", {}, {}, tool, uiStub, process.cwd());
			try {
				component.updateResult({ content: [{ type: "text", text: "ignored" }], isError: true }, false);
				expect(component.render(WIDTH), "empty custom renderer must not produce accent pad rows").toEqual([]);
			} finally {
				component.stopAnimation();
			}
		});

		expect(getOutputBlockBorderStyle()).toBe(previous);
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
