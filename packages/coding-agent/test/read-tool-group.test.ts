import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getDefault } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import {
	ReadToolGroupComponent,
	readArgsCollapseIntoGroup,
} from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { readToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/read";
import { setBasicToolDetailsVisible } from "@oh-my-pi/pi-coding-agent/tui/basic-tool-display-policy";
import { getSettingsUiLocale, setSettingsUiLocale } from "../src/i18n/settings-locale";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

function extractLinkTexts(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;[^\x1b]+\x1b\\([\s\S]*?)\x1b\]8;;\x1b\\/g)].map(match =>
		Bun.stripANSI(match[1]!),
	);
}
function visibleColumns(text: string): number[] {
	return text
		.split("\n")
		.filter(line => line.trim().length > 0)
		.map(line => line.search(/\S/));
}

describe("ReadToolGroupComponent", () => {
	let previousLocale = getSettingsUiLocale();

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	beforeEach(() => {
		previousLocale = getSettingsUiLocale();
		setBasicToolDetailsVisible(true);
	});

	afterEach(() => {
		settings.clearOverride("tui.hyperlinks");
		setBasicToolDetailsVisible(true);
		setSettingsUiLocale(previousLocale);
		vi.restoreAllMocks();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("keeps inline read previews disabled by default", () => {
		expect(getDefault("read.toolResultPreview")).toBe(false);

		const component = new ReadToolGroupComponent();
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: examplePath }, "read-0");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4" }],
			},
			false,
			"read-0",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(rendered).toContain(`Read: ${examplePath}`);
		expect(rendered).not.toContain("line 1");
		expect(rendered.toLowerCase()).not.toContain("ctrl+o");
	});

	it("hides read details behind the basic tool policy while preserving compact summaries", () => {
		setBasicToolDetailsVisible(false);

		const singlePath = path.resolve("/tmp/policy-off-single.ts");
		const single = new ReadToolGroupComponent({ showContentPreview: true });
		single.setExpanded(true);
		single.updateArgs({ path: singlePath }, "read-policy-off-single");
		single.updateResult(
			{ content: [{ type: "text", text: "SINGLE_PREVIEW_SHOULD_BE_HIDDEN" }] },
			false,
			"read-policy-off-single",
		);

		const singlePlain = Bun.stripANSI(single.render(120).join("\n"));
		const singleLines = singlePlain.split("\n").filter(line => line.trim().length > 0);
		expect(singleLines).toHaveLength(1);
		expect(singleLines[0]).toContain(`Read: ${singlePath}`);
		expect(singlePlain).not.toContain("SINGLE_PREVIEW_SHOULD_BE_HIDDEN");

		const onePath = path.resolve("/tmp/policy-off-one.ts");
		const twoPath = path.resolve("/tmp/policy-off-two.ts");
		const grouped = new ReadToolGroupComponent({ showContentPreview: true });
		grouped.setExpanded(true);
		grouped.updateArgs({ path: onePath }, "read-policy-off-one");
		grouped.updateArgs({ path: twoPath }, "read-policy-off-two");
		grouped.updateResult(
			{ content: [{ type: "text", text: "GROUPED_ONE_PREVIEW_SHOULD_BE_HIDDEN" }] },
			false,
			"read-policy-off-one",
		);
		grouped.updateResult(
			{ content: [{ type: "text", text: "GROUPED_TWO_PREVIEW_SHOULD_BE_HIDDEN" }] },
			false,
			"read-policy-off-two",
		);

		const groupedPlain = Bun.stripANSI(grouped.render(120).join("\n"));
		const groupedLines = groupedPlain.split("\n").filter(line => line.trim().length > 0);
		expect(groupedLines).toHaveLength(1);
		expect(groupedLines[0]).toContain("Read 2 paths");
		expect(groupedPlain).not.toContain(onePath);
		expect(groupedPlain).not.toContain(twoPath);
		expect(groupedPlain).not.toContain(themeModule.theme.tree.branch);
		expect(groupedPlain).not.toContain(themeModule.theme.tree.last);
		expect(groupedPlain).not.toContain("GROUPED_ONE_PREVIEW_SHOULD_BE_HIDDEN");
		expect(groupedPlain).not.toContain("GROUPED_TWO_PREVIEW_SHOULD_BE_HIDDEN");
	});

	it("keeps read path lists and content previews visible while the basic tool policy is on", () => {
		setBasicToolDetailsVisible(true);

		const list = new ReadToolGroupComponent();
		const onePath = path.resolve("/tmp/policy-on-one.ts");
		const twoPath = path.resolve("/tmp/policy-on-two.ts");
		list.updateArgs({ path: onePath }, "read-policy-on-one");
		list.updateArgs({ path: twoPath }, "read-policy-on-two");
		list.updateResult({ content: [{ type: "text", text: "one" }] }, false, "read-policy-on-one");
		list.updateResult({ content: [{ type: "text", text: "two" }] }, false, "read-policy-on-two");

		const listPlain = Bun.stripANSI(list.render(120).join("\n"));
		expect(listPlain.split("\n").filter(line => line.trim().length > 0)).toHaveLength(3);
		expect(listPlain).toContain("Read 2 paths");
		expect(listPlain).toContain(`${themeModule.theme.tree.branch} ${onePath}`);
		expect(listPlain).toContain(`${themeModule.theme.tree.last} ${twoPath}`);

		const previewPath = path.resolve("/tmp/policy-on-preview.ts");
		const preview = new ReadToolGroupComponent({ showContentPreview: true });
		preview.setExpanded(true);
		preview.updateArgs({ path: previewPath }, "read-policy-on-preview");
		preview.updateResult(
			{ content: [{ type: "text", text: "POLICY_ON_PREVIEW_LINE_1\nPOLICY_ON_PREVIEW_LINE_2" }] },
			false,
			"read-policy-on-preview",
		);

		const previewPlain = Bun.stripANSI(preview.render(120).join("\n"));
		expect(previewPlain.split("\n").filter(line => line.trim().length > 0).length).toBeGreaterThan(1);
		expect(previewPlain).toContain(`Read ${previewPath}`);
		expect(previewPlain).toContain("POLICY_ON_PREVIEW_LINE_1");
		expect(previewPlain).toContain("POLICY_ON_PREVIEW_LINE_2");
	});

	it("renders zh-CN grouped read chrome with raw Read titles and localized counts on column-1 headers", () => {
		setSettingsUiLocale("zh-CN");

		const empty = Bun.stripANSI(new ReadToolGroupComponent().render(120).join("\n"));

		const singleComponent = new ReadToolGroupComponent();
		const singlePath = path.resolve("/tmp/zh-single.ts");
		singleComponent.updateArgs({ path: singlePath }, "read-zh-single");
		singleComponent.updateResult({ content: [{ type: "text", text: "line 1" }] }, false, "read-zh-single");
		const single = Bun.stripANSI(singleComponent.render(120).join("\n"));

		const groupedComponent = new ReadToolGroupComponent();
		const onePath = path.resolve("/tmp/zh-one.ts");
		const twoPath = path.resolve("/tmp/zh-two.ts");
		groupedComponent.updateArgs({ path: onePath }, "read-zh-one");
		groupedComponent.updateArgs({ path: twoPath }, "read-zh-two");
		groupedComponent.updateResult({ content: [{ type: "text", text: "one" }] }, false, "read-zh-one");
		groupedComponent.updateResult({ content: [{ type: "text", text: "two" }] }, false, "read-zh-two");
		const grouped = Bun.stripANSI(groupedComponent.render(120).join("\n"));

		expect(visibleColumns(empty)).toEqual([1]);
		expect(empty).toContain("Read");
		expect(empty).not.toContain("读取");
		expect(visibleColumns(single)).toEqual([1]);
		expect(single).toContain(`Read: ${singlePath}`);
		expect(single).not.toContain("读取");
		expect(visibleColumns(grouped)).toEqual([1, 1, 1]);
		expect(grouped).toContain("Read 2 个路径");
		expect(grouped).toContain(`${themeModule.theme.tree.branch} ${onePath}`);
		expect(grouped).toContain(`${themeModule.theme.tree.last} ${twoPath}`);
		expect(grouped).not.toContain("读取");
	});

	it("keeps direct read calls and grouped single-path reads on the same Read: <path> header text after the status icon", async () => {
		const theme = await themeModule.getThemeByName("dark");
		expect(theme).toBeDefined();

		const examplePath = path.resolve("/tmp/consistent.ts");
		const direct = Bun.stripANSI(
			readToolRenderer
				.renderCall({ path: `${examplePath}:7-9` }, { expanded: false, isPartial: false }, theme!)
				.render(120)
				.join("\n"),
		);

		const component = new ReadToolGroupComponent();
		component.updateArgs({ path: `${examplePath}:7-9` }, "read-consistent");
		component.updateResult({ content: [{ type: "text", text: "line 7" }] }, false, "read-consistent");
		const grouped = Bun.stripANSI(component.render(120).join("\n"));
		const directHeader = direct.split("\n").find(line => line.trim().length > 0) ?? "";
		const groupedHeader = grouped.split("\n").find(line => line.trim().length > 0) ?? "";
		const directHeaderText = directHeader.slice(directHeader.indexOf("Read")).trimEnd();
		const groupedHeaderText = groupedHeader.slice(groupedHeader.indexOf("Read")).trimEnd();

		expect(directHeader.search(/\S/)).toBe(0);
		expect(groupedHeader.search(/\S/)).toBe(1);
		expect(directHeaderText).toBe(`Read: ${examplePath}:7-9`);
		expect(groupedHeaderText).toBe(directHeaderText);
	});

	it("uses the file icon, toolTitle color, and a column-1 header for completed reads", () => {
		const component = new ReadToolGroupComponent();
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: examplePath }, "read-success");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 1" }],
			},
			false,
			"read-success",
		);

		const rendered = component.render(120).join("\n");
		const plain = Bun.stripANSI(rendered);
		const headerLine = plain.split("\n").find(line => line.trim().length > 0) ?? "";

		expect(headerLine.search(/\S/)).toBe(1);
		expect(headerLine.includes(themeModule.theme.symbol("icon.file"))).toBe(true);
		expect(headerLine.slice(headerLine.indexOf("Read")).trimEnd()).toBe(`Read: ${examplePath}`);
		expect(plain).not.toContain(themeModule.theme.status.enabled);
		expect(rendered).toContain(themeModule.theme.fg("toolTitle", themeModule.theme.symbol("icon.file")));
		expect(rendered).toContain(themeModule.theme.fg("toolTitle", "Read"));
	});

	it("renders multi-read summaries as Read + N paths while keeping child rows marker-free", () => {
		const component = new ReadToolGroupComponent();
		const onePath = path.resolve("/tmp/one.ts");
		const twoPath = path.resolve("/tmp/two.ts");
		component.updateArgs({ path: onePath }, "read-one");
		component.updateArgs({ path: twoPath }, "read-two");
		component.updateResult({ content: [{ type: "text", text: "one" }] }, false, "read-one");
		component.updateResult({ content: [{ type: "text", text: "two" }] }, false, "read-two");

		const plain = Bun.stripANSI(component.render(120).join("\n"));

		expect(plain).toContain("Read 2 paths");
		expect(plain).toContain(`${themeModule.theme.tree.branch} ${onePath}`);
		expect(plain).toContain(`${themeModule.theme.tree.last} ${twoPath}`);
		expect(plain).not.toContain(`${themeModule.theme.tree.branch} ${themeModule.theme.status.enabled}`);
		expect(plain).not.toContain(`${themeModule.theme.tree.last} ${themeModule.theme.status.enabled}`);
	});

	it("splits a single selector-delimited read argument into child rows", () => {
		const component = new ReadToolGroupComponent();
		const onePath = path.resolve("/tmp/one.ts");
		const twoPath = path.resolve("/tmp/two.ts");
		const threePath = path.resolve("/tmp/three.ts");
		component.updateArgs({ path: `${onePath}:1-2,${twoPath}:3-4;${threePath}:5-6` }, "read-many");
		component.updateResult({ content: [{ type: "text", text: "combined" }] }, false, "read-many");

		const plain = Bun.stripANSI(component.render(120).join("\n"));

		expect(plain).toContain("Read 3 paths");
		expect(plain).toContain(`${themeModule.theme.tree.branch} ${onePath}:1-2`);
		expect(plain).toContain(`${themeModule.theme.tree.branch} ${twoPath}:3-4`);
		expect(plain).toContain(`${themeModule.theme.tree.last} ${threePath}:5-6`);
	});

	it("merges multi-range selectors into one file row", () => {
		const component = new ReadToolGroupComponent();
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: `${examplePath}:5-10,20-30` }, "read-ranges");
		component.updateResult({ content: [{ type: "text", text: "ranges" }] }, false, "read-ranges");

		const plain = Bun.stripANSI(component.render(120).join("\n"));

		expect(plain).toContain(`Read: ${examplePath}:5-10,20-30`);
		expect(plain).not.toContain("Read 2 paths");
		expect(plain).not.toContain("full file");
	});

	it("merges repeated same-file ranges and truncates long selector lists", () => {
		const component = new ReadToolGroupComponent();
		const renderPath = path.resolve("/tmp/render.ts");
		component.updateArgs({ path: `${renderPath}:507-605` }, "read-one");
		component.updateArgs({ path: `${renderPath}:1070-1194,1210-1240,1270-1274` }, "read-more");
		component.updateResult({ content: [{ type: "text", text: "one" }] }, false, "read-one");
		component.updateResult({ content: [{ type: "text", text: "more" }] }, false, "read-more");

		const plain = Bun.stripANSI(component.render(120).join("\n"));
		const pathMatches = plain.split(renderPath).length - 1;

		expect(pathMatches).toBe(1);
		expect(plain).toContain(`${renderPath}:507-605,1070-1194,…,1270-1274`);
		expect(plain).not.toContain("1210-1240");
	});

	it("uses result-provided recovered targets for delimited reads", () => {
		const component = new ReadToolGroupComponent();
		const onePath = path.resolve("/tmp/one.ts");
		const twoPath = path.resolve("/tmp/two.ts");
		component.updateArgs({ path: `${onePath} ${twoPath}` }, "read-recovered");
		component.updateResult(
			{
				content: [{ type: "text", text: "combined" }],
				details: { displayReadTargets: [onePath, twoPath] },
			},
			false,
			"read-recovered",
		);

		const plain = Bun.stripANSI(component.render(120).join("\n"));

		expect(plain).toContain("Read 2 paths");
		expect(plain).toContain(`${themeModule.theme.tree.branch} ${onePath}`);
		expect(plain).toContain(`${themeModule.theme.tree.last} ${twoPath}`);
	});

	it("renders warning previews with warning styling instead of success styling", () => {
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: examplePath }, "read-1");
		component.updateResult(
			{
				content: [{ type: "text", text: "const a = 1;\nconst b = 2;\nconst c = 3;" }],
				details: { suffixResolution: { from: path.resolve("/tmp/exampl.ts"), to: examplePath } },
			},
			false,
			"read-1",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(rendered).toContain(themeModule.theme.status.warning);
		expect(rendered).not.toContain(themeModule.theme.status.success);
		expect(rendered).toContain("corrected from");
	});

	it("highlights only the collapsed preview lines", () => {
		const highlightSpy = vi.spyOn(themeModule, "highlightCode");
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: examplePath }, "read-2");
		component.updateResult(
			{
				content: [
					{
						type: "text",
						text: "line 1\nline 2\nline 3\nline 4\nline 5",
					},
				],
			},
			false,
			"read-2",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		const highlightedInput = highlightSpy.mock.calls[0]?.[0];

		expect(highlightedInput).toBe("line 1\nline 2\nline 3");
		expect(rendered).toContain("line 1");
		expect(rendered).not.toContain("line 4");
		expect(rendered.toLowerCase()).toContain("ctrl+o");
	});

	it("does not render a duplicate summary row when inline previews are enabled", () => {
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: `${examplePath}:L10-L20` }, "read-3");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4" }],
			},
			false,
			"read-3",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		const matches = rendered.split(`Read ${examplePath}:L10-L20`).length - 1;

		expect(matches).toBe(1);
	});

	it("links grouped summary paths to resolved filesystem paths and selector lines", () => {
		settings.override("tui.hyperlinks", "always");
		const component = new ReadToolGroupComponent();
		const examplePath = path.resolve("/workspace/src/example.ts");
		component.updateArgs({ path: "src/example.ts:7-9" }, "read-link");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 7" }],
				details: { meta: { source: { type: "path", value: examplePath } } },
			},
			false,
			"read-link",
		);

		const rendered = component.render(120).join("\n");

		const exampleUri = new URL(url.pathToFileURL(path.resolve(examplePath)).href);
		exampleUri.searchParams.set("line", "7");
		expect(Bun.stripANSI(rendered)).toContain("Read: src/example.ts:7-9");
		expect(extractLinkUris(rendered)).toContain(exampleUri.href);
		expect(extractLinkTexts(rendered)).toContain("src/example.ts");
		expect(extractLinkTexts(rendered)).not.toContain("src/example.ts:7-9");
	});

	it("renders separate selector grouped summary paths while linking only the base path", () => {
		settings.override("tui.hyperlinks", "always");
		const component = new ReadToolGroupComponent();
		const resolvedPath = path.resolve("/workspace/src/grouped.ts");
		component.updateArgs({ path: "src/grouped.ts", selector: "2-3" }, "read-split-selector");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 2" }],
				details: { meta: { source: { type: "path", value: resolvedPath } } },
			},
			false,
			"read-split-selector",
		);

		const rendered = component.render(120).join("\n");

		const groupedUri = new URL(url.pathToFileURL(path.resolve(resolvedPath)).href);
		groupedUri.searchParams.set("line", "2");
		expect(Bun.stripANSI(rendered)).toContain("Read: src/grouped.ts:2-3");
		expect(extractLinkUris(rendered)).toContain(groupedUri.href);
		expect(extractLinkTexts(rendered)).toContain("src/grouped.ts");
		expect(extractLinkTexts(rendered)).not.toContain("src/grouped.ts:2-3");
	});

	it("ignores non-string selectors from malformed runtime args", () => {
		const component = new ReadToolGroupComponent();
		const malformedArgs = { path: "src/example.ts", selector: 10 } as unknown as {
			path: string;
			selector: string;
		};

		expect(() => component.updateArgs(malformedArgs, "read-malformed-selector")).not.toThrow();

		const plain = Bun.stripANSI(component.render(120).join("\n"));

		expect(plain).toContain("Read: src/example.ts");
		expect(plain).not.toContain("src/example.ts:10");
	});
	it("links inline preview titles when the summary row is suppressed", () => {
		settings.override("tui.hyperlinks", "always");
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		const previewPath = path.resolve("/workspace/src/preview.ts");
		component.updateArgs({ path: "src/preview.ts:20-22" }, "read-preview-link");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 20\nline 21\nline 22" }],
				details: { resolvedPath: previewPath },
			},
			false,
			"read-preview-link",
		);

		const rendered = component.render(120).join("\n");

		const previewUri = new URL(url.pathToFileURL(path.resolve(previewPath)).href);
		previewUri.searchParams.set("line", "20");
		expect(Bun.stripANSI(rendered)).toContain("Read src/preview.ts:20-22");
		expect(extractLinkUris(rendered)).toContain(previewUri.href);
		expect(extractLinkTexts(rendered)).toContain("src/preview.ts");
		expect(extractLinkTexts(rendered)).not.toContain("src/preview.ts:20-22");
	});
});

describe("readArgsCollapseIntoGroup", () => {
	it.each([
		["skill://my-skill"],
		["skill://my-skill/file.md"],
		["omp://docs/tools/read.md"],
		["issue://123"],
		["pr://can1357/oh-my-pi/456"],
		["agent://abc"],
		["artifact://abc"],
		["memory://root"],
		["rule://name"],
		["mcp://server/resource"],
		["local://PLAN.md"],
	])("keeps %s as a full tool execution (not grouped)", target => {
		expect(readArgsCollapseIntoGroup({ path: target })).toBe(false);
		expect(readArgsCollapseIntoGroup({ file_path: target })).toBe(false);
	});

	it.each([
		[path.resolve("/tmp/example.ts")],
		["./relative/path.md"],
		["https://example.com/file"],
		["xd://"],
		["xd://generate_image"],
	])("collapses %s into the read group", target => {
		expect(readArgsCollapseIntoGroup({ path: target })).toBe(true);
		expect(readArgsCollapseIntoGroup({ file_path: target })).toBe(true);
	});

	it("returns false for non-record / missing arguments", () => {
		expect(readArgsCollapseIntoGroup(undefined)).toBe(false);
		expect(readArgsCollapseIntoGroup(null)).toBe(false);
		expect(readArgsCollapseIntoGroup("xd://x")).toBe(false);
		expect(readArgsCollapseIntoGroup(["xd://x"])).toBe(false);
		expect(readArgsCollapseIntoGroup({})).toBe(false);
		expect(readArgsCollapseIntoGroup({ path: 42 })).toBe(false);
	});
});
