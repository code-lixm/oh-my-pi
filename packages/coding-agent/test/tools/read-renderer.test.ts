import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { theme as activeTheme, getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { readToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/read";
import type { TUI } from "@oh-my-pi/pi-tui";
import { getBasicToolDetailsVisible, setBasicToolDetailsVisible } from "../../src/tui/basic-tool-display-policy";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

function extractLinkTexts(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;[^\x1b]+\x1b\\([\s\S]*?)\x1b\]8;;\x1b\\/g)].map(match =>
		Bun.stripANSI(match[1]!),
	);
}

const initialBasicToolDetailsVisible = getBasicToolDetailsVisible();

beforeAll(async () => {
	await initTheme();
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	settings.clearOverride("tui.hyperlinks");
	setBasicToolDetailsVisible(initialBasicToolDetailsVisible);
});

afterAll(() => {
	resetSettingsForTest();
});

describe("readToolRenderer hyperlinks", () => {
	it("links local-style read titles to the resolved filesystem path and selected line", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const handoffPath = path.resolve("/tmp/omp-local/handoff.md");
		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "second line" }],
				details: {
					resolvedPath: handoffPath,
					displayContent: { text: "second line", startLine: 2 },
					contentType: "text/plain",
				},
			},
			{ expanded: false, isPartial: false },
			theme!,
			{ path: "local://handoff.md:2" },
		);

		const rendered = component.render(200).join("\n");
		expect(rendered).toContain("local://handoff.md");
		expect(rendered).toContain(":2");
		const handoffUri = new URL(url.pathToFileURL(path.resolve(handoffPath)).href);
		handoffUri.searchParams.set("line", "2");
		expect(extractLinkUris(rendered)).toContain(handoffUri.href);
		expect(extractLinkTexts(rendered)).toContain("local://handoff.md");
		expect(extractLinkTexts(rendered)).not.toContain("local://handoff.md:2");
	});

	it("links absolute read call paths to file URIs with selector lines", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const examplePath = path.resolve("/tmp/omp-read/example.ts");
		const component = readToolRenderer.renderCall(
			{ path: `${examplePath}:10-12` },
			{ expanded: false, isPartial: false },
			theme!,
		);

		const rendered = component.render(200).join("\n");
		expect(Bun.stripANSI(rendered)).toContain(`${examplePath}:10-12`);
		const exampleUri = new URL(url.pathToFileURL(path.resolve(examplePath)).href);
		exampleUri.searchParams.set("line", "10");
		expect(extractLinkUris(rendered)).toContain(exampleUri.href);
		expect(extractLinkTexts(rendered)).toContain(examplePath);
		expect(extractLinkTexts(rendered)).not.toContain(`${examplePath}:10-12`);
	});

	it("renders the direct read call header with a toolTitle-colored Read title and path description", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const examplePath = path.resolve("/tmp/omp-read/native-title.ts");
		const rendered = readToolRenderer
			.renderCall({ path: `${examplePath}:4-6` }, { expanded: false, isPartial: false }, theme!)
			.render(200)
			.join("\n");
		const plain = Bun.stripANSI(rendered);

		expect(plain).toContain(`Read: ${examplePath}:4-6`);
		expect(rendered).toContain(theme!.fg("toolTitle", "Read"));
	});

	it("renders separate selector read call paths while linking only the base path", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const examplePath = path.resolve("/tmp/omp-read/separate-selector.ts");
		const component = readToolRenderer.renderCall(
			{ path: examplePath, selector: "10-12" },
			{ expanded: false, isPartial: false },
			theme!,
		);

		const rendered = component.render(200).join("\n");
		expect(Bun.stripANSI(rendered)).toContain(`${examplePath}:10-12`);
		const exampleUri = new URL(url.pathToFileURL(path.resolve(examplePath)).href);
		exampleUri.searchParams.set("line", "10");
		expect(extractLinkUris(rendered)).toContain(exampleUri.href);
		expect(extractLinkTexts(rendered)).toContain(examplePath);
		expect(extractLinkTexts(rendered)).not.toContain(`${examplePath}:10-12`);
	});

	it("renders separate raw read selectors while linking only the base path", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const examplePath = path.resolve("/tmp/omp-read/raw-selector.ts");
		const component = readToolRenderer.renderCall(
			{ path: examplePath, selector: "raw" },
			{ expanded: false, isPartial: false },
			theme!,
		);

		const rendered = component.render(200).join("\n");
		expect(Bun.stripANSI(rendered)).toContain(`${examplePath}:raw`);
		expect(extractLinkUris(rendered)).toContain(url.pathToFileURL(path.resolve(examplePath)).href);
		expect(extractLinkTexts(rendered)).toContain(examplePath);
		expect(extractLinkTexts(rendered)).not.toContain(`${examplePath}:raw`);
	});
	it("links HTTP read result headers to the final URL", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "---\n\nhello" }],
				details: {
					kind: "url",
					url: "http://example.com/start",
					finalUrl: "http://example.com/final",
					contentType: "text/plain",
					method: "fetch",
					truncated: false,
					notes: [],
				},
			} as never,
			{ expanded: false, isPartial: false },
			theme!,
			{ path: "http://example.com/start" },
		);

		const rendered = Bun.stripANSI(component.render(200).join("\n"));
		expect(rendered).toContain("read: example.com /final");
		expect(rendered).not.toContain("Read: example.com /final");
		expect(extractLinkUris(component.render(200).join("\n"))).toContain("http://example.com/final");
	});
});

describe("readToolRenderer basic details policy", () => {
	it("summarizes a successful multi-line file read to one target/count header when details are hidden", async () => {
		setBasicToolDetailsVisible(false);
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const filePath = path.resolve("/tmp/omp-read/policy-file.ts");
		const renderedLines = readToolRenderer
			.renderResult(
				{
					content: [
						{ type: "text", text: "export const alpha = 1;\nexport const beta = 2;\nexport const gamma = 3;" },
					],
					details: {
						contentType: "text/plain",
						displayContent: {
							text: "export const alpha = 1;\nexport const beta = 2;\nexport const gamma = 3;",
							startLine: 1,
						},
						summary: { lines: 3, elidedSpans: 0, elidedLines: 0 },
					},
				} as never,
				{ expanded: true, isPartial: false },
				theme!,
				{ path: filePath },
			)
			.render(240)
			.map(line => Bun.stripANSI(line));

		expect(renderedLines).toHaveLength(1);
		const header = renderedLines[0]!;
		expect(header).toContain("Read");
		expect(header).toContain(filePath);
		expect(header).toContain("text/plain");
		expect(header).toContain("3 lines");
		expect(header).not.toContain("export const alpha");
		expect(header).not.toContain("export const beta");
		expect(header).not.toContain("export const gamma");
	});

	it("keeps file content visible when basic details policy is on", async () => {
		setBasicToolDetailsVisible(true);
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const filePath = path.resolve("/tmp/omp-read/policy-visible.ts");
		const rendered = Bun.stripANSI(
			readToolRenderer
				.renderResult(
					{
						content: [{ type: "text", text: "visible policy-on content" }],
						details: {
							contentType: "text/plain",
							displayContent: { text: "visible policy-on content", startLine: 1 },
						},
					} as never,
					{ expanded: true, isPartial: false },
					theme!,
					{ path: filePath },
				)
				.render(240)
				.join("\n"),
		);

		expect(rendered).toContain("visible policy-on content");
	});

	it("summarizes a successful URL read to one target/status header when details are hidden", async () => {
		setBasicToolDetailsVisible(false);
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const renderedLines = readToolRenderer
			.renderResult(
				{
					content: [{ type: "text", text: "---\n\nhello" }],
					details: {
						kind: "url",
						url: "http://example.com/start",
						finalUrl: "http://example.com/final",
						contentType: "text/plain",
						method: "fetch",
						truncated: false,
						notes: [],
					},
				} as never,
				{ expanded: true, isPartial: false },
				theme!,
				{ path: "http://example.com/start" },
			)
			.render(240)
			.map(line => Bun.stripANSI(line));

		expect(renderedLines).toHaveLength(1);
		const header = renderedLines[0]!;
		expect(header).toContain("read:");
		expect(header).toContain("http://example.com/start");
		expect(header).toContain("text/plain");
		expect(header).toContain("· fetch");
		expect(header).not.toContain("hello");
	});

	it("still renders read error diagnostics when details are hidden", async () => {
		setBasicToolDetailsVisible(false);
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const missingPath = path.resolve("/tmp/omp-read/missing.txt");
		const rendered = Bun.stripANSI(
			readToolRenderer
				.renderResult(
					{
						content: [{ type: "text", text: `Error: ENOENT: no such file or directory, open '${missingPath}'` }],
						isError: true,
					} as never,
					{ expanded: false, isPartial: false },
					theme!,
					{ path: missingPath },
				)
				.render(240)
				.join("\n"),
		);

		expect(rendered).toContain("ENOENT");
		expect(rendered).toContain(missingPath);
	});
});

describe("read ToolExecutionComponent framing", () => {
	it.each([
		{ name: "local URL", path: "local://shared-frame.md" },
		{ name: "internal URL", path: "skill://system-prompts/README.md" },
	] as const)("renders framed $name read results on the shared one-column gutter", ({ path }) => {
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent("read", { path }, {}, undefined, uiStub);
		component.updateResult(
			{
				content: [{ type: "text", text: "export const x = 1;" }],
				details: {
					displayContent: { text: "export const x = 1;", startLine: 1 },
					contentType: "text/plain",
				},
			},
			false,
		);

		try {
			const lines = component.render(80).map(line => Bun.stripANSI(line));
			const topBorderIndex = lines.findIndex(
				line => line.trimStart().startsWith(activeTheme.boxRound.topLeft) && line.includes("Read"),
			);

			const bottomBorderIndex = lines.findIndex(
				(line, index) => index > topBorderIndex && line.trimStart().startsWith(activeTheme.boxRound.bottomLeft),
			);
			const frameRows = lines.filter(line =>
				[
					activeTheme.boxRound.topLeft,
					activeTheme.boxRound.teeRight,
					activeTheme.boxRound.vertical,
					activeTheme.boxRound.bottomLeft,
				].includes(line.trimStart()[0] ?? ""),
			);

			expect(topBorderIndex).toBeGreaterThanOrEqual(0);
			expect(lines[topBorderIndex + 1]).toContain("export const x = 1;");
			expect(bottomBorderIndex).toBeGreaterThan(topBorderIndex);
			expect(frameRows.length).toBeGreaterThan(2);
			for (const row of frameRows) {
				expect(row.length - row.trimStart().length, JSON.stringify(row)).toBe(1);
			}
		} finally {
			component.stopAnimation();
		}
	});
});
