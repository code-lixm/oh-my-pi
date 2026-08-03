import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { lspToolRenderer, renderCall, renderResult } from "@oh-my-pi/pi-coding-agent/lsp/render";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { formatStatusIcon } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import {
	getOutputBlockBorderStyle,
	OUTPUT_BLOCK_ACCENT_GLYPH,
	setOutputBlockBorderStyle,
} from "@oh-my-pi/pi-coding-agent/tui/output-block";
import type { Component } from "@oh-my-pi/pi-tui";

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

	it("keeps LSP pending and result states bare under accent output styling", () => {
		const previousBorderStyle = getOutputBlockBorderStyle();
		const request = { action: "hover", file: "src/example.ts", line: 1, symbol: "value" } as never;
		try {
			setOutputBlockBorderStyle("accent");
			expect(lspToolRenderer.transcriptSurface).toBe("bare");

			const accentBackground = themeModule.theme.getSurfaceTintBgAnsi("borderMuted", 0.06);
			const backgroundAnsi = /\x1b\[(?:\d+;)*(?:4[0-9]|10[0-7]|48;5;\d+|48;2;\d+;\d+;\d+)m/;
			const cases: ReadonlyArray<{
				name: string;
				component: Component;
				body?: string;
				statusIcon?: string;
			}> = [
				{
					name: "pending",
					component: renderCall(request, { expanded: true, isPartial: false }, themeModule.theme),
					statusIcon: formatStatusIcon("pending", themeModule.theme),
				},
				{
					name: "success",
					component: renderResult(
						{ content: [{ type: "text", text: "hover result" }] },
						{ expanded: true, isPartial: false },
						themeModule.theme,
						request,
					),
					body: "hover result",
				},
				{
					name: "error",
					component: renderResult(
						{ content: [{ type: "text", text: "request failed" }], isError: true },
						{ expanded: true, isPartial: false },
						themeModule.theme,
						request,
					),
					body: "request failed",
					statusIcon: formatStatusIcon("error", themeModule.theme),
				},
				{
					name: "warning diagnostic",
					component: renderResult(
						{
							content: [{ type: "text", text: "1 warning(s)\nsrc/example.ts:1:1 [warning] unused value" }],
						},
						{ expanded: true, isPartial: false },
						themeModule.theme,
						request,
					),
					body: "unused value",
					statusIcon: formatStatusIcon("warning", themeModule.theme),
				},
			];

			for (const { component, body, statusIcon } of cases) {
				const lines = component.render(88);
				const raw = lines.join("\n");
				const rendered = Bun.stripANSI(raw);

				expect(Bun.stripANSI(lines[0] ?? "")).toContain("LSP");
				if (body) expect(rendered).toContain(body);
				if (statusIcon) expect(raw).toContain(statusIcon);
				expect(raw).not.toContain(OUTPUT_BLOCK_ACCENT_GLYPH);
				expect(raw).not.toContain(accentBackground);
				expect(raw).not.toMatch(backgroundAnsi);
				expect(rendered).not.toMatch(/[╭╮╰╯]/);
			}
		} finally {
			setOutputBlockBorderStyle(previousBorderStyle);
		}
	});
});
