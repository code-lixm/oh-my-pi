import { beforeAll, describe, expect, it } from "bun:test";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getOutputBlockBorderStyle, setOutputBlockBorderStyle } from "@oh-my-pi/pi-coding-agent/tui/output-block";
import type { TUI } from "@oh-my-pi/pi-tui";

const WIDTH = 140;
const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

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

// Inline args — no gallery-cli import chain, no inspect-image-renderer.
function inlineArgsFor(name: string): unknown {
	switch (name) {
		case "grep":
			return { pattern: "useState", path: "packages/tui/src" };
		case "glob":
			return { pattern: "*.test.ts" };
		case "ast_grep":
			return { pattern: "useState($A)", language: "tsx", path: "packages/tui/src" };
		case "irc":
			return { op: "send", to: "Worker", message: "status?" };
		case "job":
			return { list: true };
		case "bash":
			return { command: "git status --short" };
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
					displayContent: "# src/\n## a.ts\n*1│const x = useState()\n  meta: $A=0",
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
		case "bash":
			return {
				content: [{ type: "text", text: "M src/cli/gallery-cli.ts\n?? src/new.ts" }],
				details: { exitCode: 0, wallTimeMs: 120 },
			};
		default:
			throw new Error(`No inline result for tool: ${name}`);
	}
}

function renderToolLifecycle(name: string): { pending: string[]; success: string[] } {
	const args = inlineArgsFor(name);
	const component = new ToolExecutionComponent(name, args, {}, undefined, uiStub, process.cwd());

	try {
		// Pending: args still incomplete, no result yet.
		const pending = plainLines(component.render(WIDTH));

		// Switch to args-complete pending state.
		component.updateArgs(args);
		component.setArgsComplete();

		// Success: result is settled.
		const result = inlineResultFor(name);
		component.updateResult(result, false);
		const success = plainLines(component.render(WIDTH));

		return { pending, success };
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

	it("keeps non-framed grep pending and result title rows on a one-column outer gutter", () => {
		const { pending, success } = renderToolLifecycle("grep");
		expectSingleOuterPadding(pending, "grep pending");
		expectSingleOuterPadding(success, "grep success");
	});

	it("keeps non-framed glob pending and result title rows on a one-column outer gutter", () => {
		const { pending, success } = renderToolLifecycle("glob");
		expectSingleOuterPadding(pending, "glob pending");
		expectSingleOuterPadding(success, "glob success");
	});

	it("keeps non-framed ast_grep pending and result title rows on a one-column outer gutter", () => {
		const { pending, success } = renderToolLifecycle("ast_grep");
		expectSingleOuterPadding(pending, "ast_grep pending");
		expectSingleOuterPadding(success, "ast_grep success");
	});

	it("keeps non-framed irc pending and result title rows on a one-column outer gutter", () => {
		const { pending, success } = renderToolLifecycle("irc");
		expectSingleOuterPadding(pending, "irc pending");
		expectSingleOuterPadding(success, "irc success");
	});

	it("keeps non-framed job pending and result title rows on a one-column outer gutter", () => {
		const { pending, success } = renderToolLifecycle("job");
		expectSingleOuterPadding(pending, "job pending");
		expectSingleOuterPadding(success, "job success");
	});

	// ─── ReadToolGroup alignment ─────────────────────────────────────────────

	it("keeps ReadToolGroup title rows on the same column as non-framed tool execution blocks", () => {
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

	it("removes the outer gutter from unframed search blocks and ReadToolGroup when border style is none without shifting framed bash", async () => {
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

		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();

		const { success: bashSuccess } = renderToolLifecycle("bash");
		const firstLine = firstNonEmptyLine(bashSuccess);
		expect(leadingSpaces(firstLine), `bash success: ${JSON.stringify(firstLine)}`).toBe(0);
		expect(firstLine.startsWith(uiTheme!.boxRound.topLeft), `bash success: ${JSON.stringify(firstLine)}`).toBe(true);
	});

	// ─── framed built-in ─────────────────────────────────────────────────────

	it("keeps framed built-in tool results flush to column 0", async () => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();

		const { success } = renderToolLifecycle("bash");
		const firstLine = firstNonEmptyLine(success);

		expect(leadingSpaces(firstLine), JSON.stringify(firstLine)).toBe(0);
		expect(firstLine.startsWith(uiTheme!.boxRound.topLeft), JSON.stringify(firstLine)).toBe(true);
	});
});
