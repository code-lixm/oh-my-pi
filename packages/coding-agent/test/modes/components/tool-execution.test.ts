import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Component, Image, ImageProtocol, TERMINAL, Text } from "@oh-my-pi/pi-tui";
import { Settings, settings } from "../../../src/config/settings";
import { renderMCPResult } from "../../../src/mcp/render";
import type { MCPToolDetails } from "../../../src/mcp/tool-bridge";
import { ToolExecutionComponent, type ToolExecutionUi } from "../../../src/modes/components/tool-execution";
import { getThemeByName, setThemeInstance, theme } from "../../../src/modes/theme/theme";
import {
	getOutputBlockBorderStyle,
	type OutputBlockBorderStyle,
	setOutputBlockBorderStyle,
} from "../../../src/tui/output-block";

class BoldTypeErrorComponent implements Component {
	render(_width: number): readonly string[] {
		throw new TypeError("th.bold is not a function");
	}
}

function visibleText(lines: readonly string[]): string {
	let text = lines.join("\n");
	text = text.replace(/\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g, "");
	text = text.replace(/\x1b\[[0-9;]*m/g, "");
	return text;
}

describe("ToolExecutionComponent custom renderer failures", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterEach(() => {
		settings.set("mcp.renderMarkdownResults", true);
	});

	it("falls back to the custom tool label when a renderCall child component throws during render", () => {
		const tool: AgentTool = {
			name: "graphify_graph",
			label: "Graphify Graph",
			description: "renders a graph",
			parameters: { type: "object", additionalProperties: true },
			renderCall() {
				return new BoldTypeErrorComponent();
			},
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const ui: ToolExecutionUi = {
			requestRender() {},
			requestComponentRender(_component: Component) {},
			resetDisplay() {},
		};
		const component = new ToolExecutionComponent(
			"graphify_graph",
			{},
			{ showImages: false },
			tool,
			ui,
			process.cwd(),
		);
		let text = "";

		expect(() => {
			text = visibleText(component.render(80));
		}).not.toThrow();
		expect(text).toContain("Graphify Graph");
	});

	it("preserves raw result text when a renderResult child component throws during render", () => {
		const rawResultText = "raw result survives child renderer failure";
		const tool: AgentTool = {
			name: "crashy_result_renderer",
			label: "Crashy Result Renderer",
			description: "renders result output",
			parameters: { type: "object", additionalProperties: true },
			renderCall() {
				return new Text(theme.fg("toolTitle", theme.bold("Crashy Result Renderer")), 0, 0);
			},
			renderResult() {
				return new BoldTypeErrorComponent();
			},
			async execute() {
				return { content: [{ type: "text", text: rawResultText }] };
			},
		};
		const ui: ToolExecutionUi = {
			requestRender() {},
			requestComponentRender(_component: Component) {},
			resetDisplay() {},
		};
		const component = new ToolExecutionComponent(
			"crashy_result_renderer",
			{},
			{ showImages: false },
			tool,
			ui,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: rawResultText }] }, false);
		let text = "";

		expect(() => {
			text = visibleText(component.render(80));
		}).not.toThrow();
		expect(text).toContain(rawResultText);
	});

	it("renders a same-named extension tool result with the generic renderer", () => {
		const resultText = "recalled postgres memory";
		const tool: AgentTool = {
			name: "recall",
			label: "Extension Recall",
			description: "recalls external memory",
			parameters: { type: "object", additionalProperties: true },
			async execute() {
				return { content: [{ type: "text", text: resultText }] };
			},
		};
		const ui: ToolExecutionUi = {
			requestRender() {},
			requestComponentRender(_component: Component) {},
			resetDisplay() {},
		};
		const component = new ToolExecutionComponent(
			"recall",
			{ query: "project context" },
			{ showImages: false, useBuiltInRenderer: false },
			tool,
			ui,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: resultText }] }, false);

		const rendered = visibleText(component.render(80));
		expect(rendered).toContain(resultText);
		expect(rendered).not.toContain("no matches");
	});
});

describe("ToolExecutionComponent image routing", () => {
	const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

	it("routes a rendered image click with the original result payload", () => {
		const previousProtocol = TERMINAL.imageProtocol;
		TERMINAL.imageProtocol = ImageProtocol.Kitty;
		try {
			const opened: Array<{ type: "image"; data: string; mimeType: string }> = [];
			const ui: ToolExecutionUi = {
				requestRender() {},
				requestComponentRender(_component: Component) {},
				resetDisplay() {},
			};
			const component = new ToolExecutionComponent(
				"image_result",
				{},
				{ openImage: image => opened.push(image), showImages: true },
				undefined,
				ui,
			);
			component.updateResult({
				content: [{ type: "image", data: onePixelPng, mimeType: "image/png" }],
			});

			const width = 80;
			component.render(width);
			const imageIndex = component.children.findIndex(child => child instanceof Image);
			expect(imageIndex).toBeGreaterThanOrEqual(0);
			const imageRow = component.children
				.slice(0, imageIndex)
				.reduce((rows, child) => rows + child.render(width).length, 0);
			const event = {
				button: 0,
				col: 0,
				row: imageRow,
				release: false,
				wheel: null,
				motion: false,
				leftClick: true,
			};

			expect(component.routeMouse(event, imageRow, 0)).not.toBe(false);
			expect(opened).toEqual([{ type: "image", data: onePixelPng, mimeType: "image/png" }]);
		} finally {
			TERMINAL.imageProtocol = previousProtocol;
		}
	});
});

describe("MCP result Markdown rendering", () => {
	const details: MCPToolDetails = {
		serverName: "context-mode",
		mcpToolName: "ctx_search",
	};

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterEach(() => {
		settings.set("mcp.renderMarkdownResults", true);
	});

	it("renders inline Markdown by default", () => {
		const component = renderMCPResult(
			{ content: [{ type: "text", text: "**bold result** and `code`" }], details },
			{ expanded: true, isPartial: false },
			theme,
		);
		const rendered = visibleText(component.render(80));

		expect(rendered).toContain("bold result and code");
		expect(rendered).not.toContain("**bold result**");
		expect(rendered).not.toContain("`code`");
	});

	it("keeps Markdown syntax literal when the setting is disabled", () => {
		settings.set("mcp.renderMarkdownResults", false);
		const component = renderMCPResult(
			{ content: [{ type: "text", text: "**bold result**" }], details },
			{ expanded: true, isPartial: false },
			theme,
		);

		expect(visibleText(component.render(80))).toContain("**bold result**");
	});

	it("preserves structured JSON rendering when Markdown is enabled", () => {
		settings.set("mcp.renderMarkdownResults", true);
		const component = renderMCPResult(
			{ content: [{ type: "text", text: '{"status":"**ok**"}' }], details },
			{ expanded: true, isPartial: false },
			theme,
		);
		const rendered = visibleText(component.render(80));

		expect(rendered).toContain("status");
		expect(rendered).toContain("**ok**");
	});
});

/**
 * Contract: Hub and Todo results are NOT subject to the central `display.toolDetailMaxLines`
 * truncation budget, so long custom-rendered results remain fully visible when collapsed.
 * This test guards against these tools being re-added to `CENTRALLY_LIMITED_TOOL_RENDERERS`.
 */
describe("Hub and Todo bypass central toolDetailMaxLines truncation", () => {
	const manyLines = Array.from({ length: 20 }, (_, i) => `output line ${i + 1}`);
	const renderWidth = 80;
	const accentRailPad = "▌".padEnd(renderWidth);
	let previousBorderStyle: OutputBlockBorderStyle;

	beforeEach(() => {
		previousBorderStyle = getOutputBlockBorderStyle();
		setOutputBlockBorderStyle("accent");
	});

	afterEach(() => {
		setOutputBlockBorderStyle(previousBorderStyle);
	});

	function renderCollapsedResult(toolName: string, content: string[]): readonly string[] {
		const fakeTool: AgentTool = {
			name: toolName,
			label: toolName,
			description: "fake",
			parameters: { type: "object", additionalProperties: true },
			renderResult() {
				return new Text(content.join("\n"), 0, 0);
			},
			async execute() {
				return { content: [{ type: "text", text: content.join("\n") }] };
			},
		};
		const component = new ToolExecutionComponent(toolName, {}, { showImages: false }, fakeTool, {
			requestRender() {},
			requestComponentRender(_component: Component) {},
			resetDisplay() {},
		});
		component.updateResult({ content: [{ type: "text", text: content.join("\n") }] }, false);
		return component.render(renderWidth);
	}

	function expectAccentBreathingRows(plainLines: readonly string[]): void {
		expect(plainLines[0]).toBe(accentRailPad);
		expect(plainLines.at(-1)).toBe(accentRailPad);
	}

	it("hub result is fully visible when collapsed, not capped by toolDetailMaxLines", () => {
		const lines = renderCollapsedResult("hub", manyLines);
		const plainLines = lines.map(line => Bun.stripANSI(line));

		// The shared accent surface adds top and bottom rail-only breathing rows.
		expect(plainLines).toHaveLength(manyLines.length + 3);
		expectAccentBreathingRows(plainLines);
		// No omission marker should appear (would indicate truncation)
		expect(plainLines.some(line => line.includes("…") && line.includes("lines omitted"))).toBe(false);
		// Verify all content lines are present (use some() to handle renderer prefixes)
		manyLines.forEach(expected => {
			expect(plainLines.some(line => line.includes(expected))).toBe(true);
		});
	});

	it("todo result is fully visible when collapsed, not capped by toolDetailMaxLines", () => {
		const lines = renderCollapsedResult("todo", manyLines);
		const plainLines = lines.map(line => Bun.stripANSI(line));

		// The shared accent surface adds top and bottom rail-only breathing rows.
		expect(plainLines).toHaveLength(manyLines.length + 3);
		expectAccentBreathingRows(plainLines);
		// No omission marker should appear (would indicate truncation)
		expect(plainLines.some(line => line.includes("…") && line.includes("lines omitted"))).toBe(false);
		// Verify all content lines are present (use some() to handle renderer prefixes)
		manyLines.forEach(expected => {
			expect(plainLines.some(line => line.includes(expected))).toBe(true);
		});
	});

	it("contrast: a centrally-limited tool result is truncated when collapsed", () => {
		// "bash" IS in CENTRALLY_LIMITED_TOOL_RENDERERS, so its result should be truncated
		const lines = renderCollapsedResult("bash", manyLines);
		const plainLines = lines.map(line => Bun.stripANSI(line));
		const joined = plainLines.join("\n");

		// The collapsed result budget plus the accent breathing rows is exact.
		expect(plainLines).toHaveLength(7);
		expectAccentBreathingRows(plainLines);
		// Omission marker MUST appear for centrally-limited tools
		expect(plainLines.some(line => line.includes("…") && line.includes("lines omitted"))).toBe(true);
		// First and last output lines are preserved
		expect(joined).toContain("output line 1");
		expect(joined).toContain("output line 20");
	});
});
