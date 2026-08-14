// biome-ignore-all lint/suspicious/noTemplateCurlyInString: sample source-code strings (read fixtures) intentionally contain literal ${...}.
// Gallery fixtures for filesystem tools (read, write, find).
import type { Usage } from "@oh-my-pi/pi-ai";
import { ReadToolGroupComponent } from "../../modes/components/read-tool-group";
import type { GalleryFixture, GalleryFixtureState, GalleryResult } from "./types";

const readSnippet = [
	"export const fffFindToolRenderer = {",
	"\tinline: true,",
	'\ttranscriptSurface: "bare" as const,',
	"\tmergeCallAndResult: true,",
	"\trenderCall(args: FindArgs, _options: RenderResultOptions, uiTheme: Theme): Component {",
	"\t\tconst meta: string[] = [];",
	'\t\tif (args.path) meta.push(tSettingsUi("in {paths}", { paths: sanitizeText(args.path) }));',
	"\t\tif (args.limit !== undefined) meta.push(`limit:${args.limit}`);",
	'\t\tif (args.cursor) meta.push(tSettingsUi("page"));',
	"\t\treturn new Text(",
	"\t\t\trenderStatusLine(",
	"\t\t\t\t{",
].join("\n");

const writtenContent = [
	'import { describe, expect, it } from "bun:test";',
	'import { parseSel } from "../src/tools/read";',
	"",
	'describe("parseSel", () => {',
	'\tit("parses a single line range", () => {',
	'\t\texpect(parseSel("42-58")).toEqual({',
	'\t\t\tkind: "lines",',
	"\t\t\tranges: [{ startLine: 42, endLine: 58 }],",
	"\t\t});",
	"\t});",
	"",
	'\tit("treats raw as a verbatim selector", () => {',
	'\t\texpect(parseSel("raw")).toEqual({ kind: "raw" });',
	"\t});",
	"});",
	"",
].join("\n");

const groupedReadTargets = [
	"packages/coding-agent/test/streaming-preview-height.test.ts:301-409",
	"packages/coding-agent/test/tool-live-region-scrollback.test.ts:143-310",
	"packages/tui/test/streaming-scrollback-defer.test.ts:89-464",
];

const groupedReadDelimitedPath = groupedReadTargets.join(",");
const groupedReadRepeatedFile = "packages/coding-agent/src/task/render.ts";
const groupedReadRepeatedRanges = `${groupedReadRepeatedFile}:507-605,1070-1194,1210-1240,1270-1274`;

const GROUPED_READ_USAGE: Usage = {
	input: 2400,
	output: 113,
	cacheRead: 103_000,
	cacheWrite: 0,
	totalTokens: 105_513,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function textResult(text: string, details?: unknown, isError?: boolean): GalleryResult {
	return { content: [{ type: "text", text }], details, isError };
}

function addGroupedReadArgs(component: ReadToolGroupComponent): void {
	component.updateArgs({ path: groupedReadDelimitedPath }, "read-delimited");
	component.updateArgs({ path: groupedReadRepeatedRanges }, "read-ranges");
}

function renderReadGroupFixtureState(state: GalleryFixtureState, width: number, expanded: boolean): readonly string[] {
	const component = new ReadToolGroupComponent();
	component.setExpanded(expanded);

	if (state === "streaming") {
		component.updateArgs(
			{
				path: [
					"packages/coding-agent/test/streaming-preview-height.test.ts:301-409",
					"packages/coding-agent/test/tool-live-region-scrollback.test.ts:143-",
				].join(","),
			},
			"read-delimited",
		);
		return component.render(width);
	}

	addGroupedReadArgs(component);
	if (state === "progress") return component.render(width);

	component.updateResult(
		textResult("Read three focused test ranges.", { displayReadTargets: groupedReadTargets }),
		false,
		"read-delimited",
	);
	component.attachUsage(
		["read-delimited"],
		GROUPED_READ_USAGE,
		5300,
		2200,
		new Date(2026, 6, 28, 21, 5, 47).getTime(),
	);

	if (state === "error") {
		component.updateResult(
			textResult("Error: selector 1270-1274 is outside the file", undefined, true),
			false,
			"read-ranges",
		);
		component.attachUsage(
			["read-ranges"],
			GROUPED_READ_USAGE,
			4700,
			1900,
			new Date(2026, 6, 28, 21, 5, 52).getTime(),
		);
		return component.render(width);
	}

	component.updateResult(textResult("Read four render.ts ranges."), false, "read-ranges");
	component.attachUsage(["read-ranges"], GROUPED_READ_USAGE, 4700, 1900, new Date(2026, 6, 28, 21, 5, 52).getTime());
	return component.render(width);
}

export const fsFixtures: Record<string, GalleryFixture> = {
	read: {
		label: "Read",
		// Streaming: path still being typed, selector not yet appended.
		streamingArgs: { path: "packages/coding-agent/src/tools/fff-render" },
		args: { path: "packages/coding-agent/src/tools/fff-renderer.ts:32-43" },
		result: {
			content: [
				{
					type: "text",
					text: [
						"[packages/coding-agent/src/tools/fff-renderer.ts#E48E]",
						"32:export const fffFindToolRenderer = {",
						"33:\tinline: true,",
						'34:\ttranscriptSurface: "bare" as const,',
						"35:\tmergeCallAndResult: true,",
						"36:\trenderCall(args: FindArgs, _options: RenderResultOptions, uiTheme: Theme): Component {",
						"37:\t\tconst meta: string[] = [];",
						'38:\t\tif (args.path) meta.push(tSettingsUi("in {paths}", { paths: sanitizeText(args.path) }));',
						"39:\t\tif (args.limit !== undefined) meta.push(`limit:${args.limit}`);",
						'40:\t\tif (args.cursor) meta.push(tSettingsUi("page"));',
						"41:\t\treturn new Text(",
						"42:\t\t\trenderStatusLine(",
						"43:\t\t\t\t{",
					].join("\n"),
				},
			],
			details: {
				kind: "file",
				resolvedPath: "/Users/dev/Projects/pi/packages/coding-agent/src/tools/fff-renderer.ts",
				contentType: "text/typescript",
				displayContent: { text: readSnippet, startLine: 32 },
			},
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: "Error: ENOENT: no such file or directory, open 'packages/coding-agent/src/tools/fff-renderer.ts'",
				},
			],
		},
	},

	read_group: {
		label: "Read Groups",
		args: {},
		result: textResult("Rendered grouped read calls."),
		errorResult: textResult("Rendered grouped read errors.", undefined, true),
		renderState: renderReadGroupFixtureState,
	},

	write: {
		label: "Write",
		// Streaming: path known, content still arriving (only the imports so far).
		streamingArgs: {
			path: "packages/coding-agent/test/parse-sel.test.ts",
			content: 'import { describe, expect, it } from "bun:test";\nimport { parseSel } from "../src/tools/read";\n',
		},
		args: {
			path: "packages/coding-agent/test/parse-sel.test.ts",
			content: writtenContent,
		},
		result: {
			content: [
				{
					type: "text",
					text: "Created packages/coding-agent/test/parse-sel.test.ts (17 lines, 412 bytes).",
				},
			],
			details: {},
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: "Error: EACCES: permission denied, open 'packages/coding-agent/test/parse-sel.test.ts'",
				},
			],
		},
	},

	find: {
		label: "Find",
		// Streaming: fuzzy query and scope are still arriving.
		streamingArgs: { pattern: "tool render", path: "packages/coding-agent/src/tools/" },
		args: { pattern: "test", path: "packages/coding-agent/src/**/*.test.ts", limit: 50 },
		result: {
			content: [
				{
					type: "text",
					text: [
						"packages/coding-agent/src/tools/read.test.ts",
						"packages/coding-agent/src/tools/write.test.ts",
						"packages/coding-agent/src/tools/fff-tools.test.ts",
						"packages/coding-agent/src/cli/gallery-cli.test.ts",
						"packages/coding-agent/src/edit/edit.test.ts",
					].join("\n"),
				},
			],
			details: {
				scopePath: "packages/coding-agent/src",
				cwd: "/Users/dev/Projects/pi",
				fileCount: 5,
				truncated: false,
				files: [
					"packages/coding-agent/src/cli/gallery-cli.test.ts",
					"packages/coding-agent/src/edit/edit.test.ts",
					"packages/coding-agent/src/tools/fff-tools.test.ts",
					"packages/coding-agent/src/tools/read.test.ts",
					"packages/coding-agent/src/tools/write.test.ts",
				],
			},
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "Find failed: invalid path constraint '[unclosed'." }],
			details: { error: "invalid path constraint '[unclosed'" },
		},
	},
};
