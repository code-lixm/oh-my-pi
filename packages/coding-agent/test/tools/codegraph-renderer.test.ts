import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "../../src/modes/components/tool-execution";
import { codegraphToolRenderer } from "../../src/tools/codegraph-renderer";
import { formatStatusIcon } from "../../src/tools/render-utils";

const uiStub = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI;
const rendererContract = codegraphToolRenderer as {
	transcriptSurface?: string;
	mergeCallAndResult?: boolean;
};

describe("codegraphToolRenderer", () => {
	beforeAll(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
	});

	it("declares the bare transcript surface and merged call/result layout used by grep-style renderers", () => {
		expect(rendererContract.transcriptSurface).toBe("bare");
		expect(rendererContract.mergeCallAndResult).toBe(true);
	});

	it("renders a single merged success header with the search icon instead of the generic success icon", async () => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();
		const theme = uiTheme!;
		const result = {
			content: [{ type: "text", text: "semantic result" }],
			details: {
				query: "find request routing",
				maxFiles: 25,
				scopeApplied: false,
				fileCount: 1,
				entryCount: 1,
				truncated: false,
				files: [{ filePath: "src/server/routes.ts", language: "typescript", nodeCount: 4 }],
				entries: [
					{
						node: {
							filePath: "src/server/routes.ts",
							qualifiedName: "registerRoutes",
							name: "registerRoutes",
							kind: "function",
							startLine: 12,
						},
					},
				],
			},
		};

		const component = new ToolExecutionComponent(
			"codegraph",
			{ query: "find request routing", maxFiles: 25 },
			{},
			undefined,
			uiStub,
			process.cwd(),
		);
		component.updateResult(result as never, false);

		const renderedLines = component.render(160);
		const rendered = renderedLines.join("\n");
		const plainRendered = Bun.stripANSI(rendered);
		const header = renderedLines[0]!;
		const plainHeader = Bun.stripANSI(header);

		expect(header).toContain(theme.fg("toolTitle", theme.symbol("icon.search")));
		expect(header).toContain(theme.fg("toolTitle", "CodeGraph"));
		expect(plainHeader.startsWith(`${theme.symbol("icon.search")} CodeGraph`)).toBe(true);
		expect(header).not.toContain(formatStatusIcon("success", theme));
		expect(plainHeader.startsWith(`${theme.symbol("status.success")} CodeGraph`)).toBe(false);
		expect(plainRendered.match(/CodeGraph/g)?.length).toBe(1);
	});
});
