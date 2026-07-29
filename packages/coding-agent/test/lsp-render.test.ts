import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { renderCall, renderResult } from "@oh-my-pi/pi-coding-agent/lsp/render";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getOutputBlockBorderStyle, setOutputBlockBorderStyle } from "@oh-my-pi/pi-coding-agent/tui/output-block";

beforeAll(async () => {
	await themeModule.initTheme(false, undefined, undefined, "dark", "light");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LSP render", () => {
	it("renders hover code through the cached theme highlighter", () => {
		const highlightSpy = vi.spyOn(themeModule, "highlightCode").mockReturnValue(["CACHED_HIGHLIGHT"]);
		const component = renderResult(
			{ content: [{ type: "text", text: "```ts\nconst value = 1;\n```" }] },
			{ expanded: true, isPartial: false },
			themeModule.theme,
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(highlightSpy).toHaveBeenCalledTimes(1);
		expect(highlightSpy).toHaveBeenCalledWith("const value = 1;", "ts", themeModule.theme);
		expect(rendered).toContain("CACHED_HIGHLIGHT");
	});

	it("renders pending, success, and error LSP states as accent cards with their semantic backgrounds", () => {
		const previousBorderStyle = getOutputBlockBorderStyle();
		const request = { action: "hover", file: "src/example.ts", line: 1, symbol: "value" } as never;
		try {
			setOutputBlockBorderStyle("accent");
			const cases = [
				{
					component: renderCall(request, { expanded: false, isPartial: false }, themeModule.theme),
					background: "toolPendingBg" as const,
				},
				{
					component: renderResult(
						{ content: [{ type: "text", text: "hover result" }] },
						{ expanded: false, isPartial: false },
						themeModule.theme,
						request,
					),
					background: "toolSuccessBg" as const,
				},
				{
					component: renderResult(
						{ content: [{ type: "text", text: "request failed" }], isError: true },
						{ expanded: false, isPartial: false },
						themeModule.theme,
						request,
					),
					background: "toolErrorBg" as const,
				},
			] as const;

			for (const { component, background } of cases) {
				const lines = component.render(88);
				expect(Bun.stripANSI(lines.join("\n"))).toContain("LSP");
				expect(lines.some(line => Bun.stripANSI(line).includes("▌"))).toBe(true);
				expect(lines.some(line => line.includes(themeModule.theme.getBgAnsi(background)))).toBe(true);
			}
		} finally {
			setOutputBlockBorderStyle(previousBorderStyle);
		}
	});
});
