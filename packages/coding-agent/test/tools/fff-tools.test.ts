import { afterEach, describe, expect, it } from "bun:test";
import type {
	FileFinderApi,
	FileItem,
	GrepMatch,
	GrepOptions,
	GrepResult,
	MultiGrepOptions,
	Result,
	Score,
	SearchOptions,
	SearchResult,
} from "@ff-labs/fff-bun";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	disposeSessionFffFinderManager,
	FffFinderManager,
	setSessionFffFinderManager,
} from "../../src/tools/fff-manager";
import { FffFindTool, FffGrepTool, FffMultiGrepTool } from "../../src/tools/fff-tools";

type FinderResponses = {
	fileSearch: Array<Result<SearchResult>>;
	grep: Array<Result<GrepResult>>;
	multiGrep: Array<Result<GrepResult>>;
};

class FakeFinder {
	isDestroyed = false;
	destroyCalls = 0;
	readonly fileSearchCalls: Array<{ query: string; options: SearchOptions | undefined }> = [];
	readonly grepCalls: Array<{ query: string; options: GrepOptions | undefined }> = [];
	readonly multiGrepCalls: MultiGrepOptions[] = [];

	constructor(private readonly responses: FinderResponses) {}

	async waitForScan(): Promise<Result<boolean>> {
		return { ok: true, value: true };
	}

	destroy(): void {
		this.destroyCalls++;
		this.isDestroyed = true;
	}

	fileSearch(query: string, options?: SearchOptions): Result<SearchResult> {
		this.fileSearchCalls.push({ query, options });
		return this.next("fileSearch");
	}

	grep(query: string, options?: GrepOptions): Result<GrepResult> {
		this.grepCalls.push({ query, options });
		return this.next("grep");
	}

	multiGrep(options: MultiGrepOptions): Result<GrepResult> {
		this.multiGrepCalls.push(options);
		return this.next("multiGrep");
	}

	private next<T extends keyof FinderResponses>(method: T): FinderResponses[T][number] {
		const response = this.responses[method].shift();
		if (!response) throw new Error(`Unexpected ${method} call`);
		return response;
	}
}

const sessions = new Set<ToolSession>();

afterEach(() => {
	for (const session of sessions) disposeSessionFffFinderManager(session);
	sessions.clear();
});

function createSession(cwd = "/tmp/fff-tools-test-workspace"): ToolSession {
	const session: ToolSession = {
		cwd,
		hasUI: false,
		hasEditTool: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	sessions.add(session);
	return session;
}

function installFinder(session: ToolSession, finder: FakeFinder, onCreate?: () => void): void {
	setSessionFffFinderManager(
		session,
		new FffFinderManager({
			finderStatic: {
				create: () => {
					onCreate?.();
					return { ok: true, value: finder as unknown as FileFinderApi };
				},
			},
		}),
	);
}

function score(): Score {
	return {
		total: 100,
		baseScore: 100,
		filenameBonus: 0,
		specialFilenameBonus: 0,
		frecencyBoost: 0,
		distancePenalty: 0,
		currentFilePenalty: 0,
		comboMatchBoost: 0,
		exactMatch: true,
		matchType: "exact",
	};
}

function searchResult(relativePaths: string[]): SearchResult {
	const items: FileItem[] = relativePaths.map(relativePath => ({
		relativePath,
		fileName: relativePath.split("/").at(-1) ?? relativePath,
		size: 0,
		modified: 0,
		accessFrecencyScore: 0,
		modificationFrecencyScore: 0,
		totalFrecencyScore: 0,
		gitStatus: "clean",
	}));
	return {
		items,
		scores: items.map(score),
		totalMatched: items.length,
		totalFiles: items.length,
	};
}

function grepMatch(relativePath: string, lineContent: string): GrepMatch {
	return {
		relativePath,
		fileName: relativePath.split("/").at(-1) ?? relativePath,
		gitStatus: "clean",
		size: 0,
		modified: 0,
		isBinary: false,
		totalFrecencyScore: 0,
		accessFrecencyScore: 0,
		modificationFrecencyScore: 0,
		lineNumber: 1,
		col: 0,
		byteOffset: 0,
		lineContent,
		matchRanges: [[0, lineContent.length]],
		contextBefore: [],
		contextAfter: [],
	};
}

function grepResult(items: GrepMatch[]): GrepResult {
	return {
		items,
		totalMatched: items.length,
		totalFilesSearched: items.length > 0 ? 1 : 0,
		totalFiles: 1,
		filteredFileCount: 1,
		nextCursor: null,
	};
}
function resultText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	const text = result.content.find(content => content.type === "text");
	if (!text || typeof text.text !== "string") throw new Error("Expected text tool result");
	return text.text;
}

describe("FFF built-in tools", () => {
	it("sends a find path and exclusions through fileSearch as one finder query", async () => {
		const session = createSession();
		const finder = new FakeFinder({
			fileSearch: [{ ok: true, value: searchResult(["src/fff-tools.ts"]) }],
			grep: [],
			multiGrep: [],
		});
		installFinder(session, finder);

		const result = await new FffFindTool(session).execute("find-with-constraints", {
			pattern: "fff tools",
			path: "src",
			exclude: ["test/", "generated/**"],
			limit: 7,
		});

		expect(finder.fileSearchCalls).toHaveLength(1);
		expect(finder.fileSearchCalls[0]?.query).toBe("src/ !test/ !generated/ fff tools");
		expect(result.details).toMatchObject({ files: ["src/fff-tools.ts"], fileCount: 1 });
	});
	it("continues one find tool with its original query and returns only the next page", async () => {
		const session = createSession();
		const finder = new FakeFinder({
			fileSearch: [
				{
					ok: true,
					value: { ...searchResult(["src/first.ts", "src/second.ts"]), totalMatched: 4, totalFiles: 4 },
				},
				{
					ok: true,
					value: { ...searchResult(["src/third.ts", "src/fourth.ts"]), totalMatched: 4, totalFiles: 4 },
				},
			],
			grep: [],
			multiGrep: [],
		});
		installFinder(session, finder);
		const tool = new FffFindTool(session);

		const first = await tool.execute("find-first-page", {
			pattern: "target",
			path: "src",
			exclude: ["test/", "generated/**"],
			limit: 2,
		});
		const cursor = resultText(first).match(/cursor="([^"]+)"/)?.[1];
		if (!cursor) throw new Error("Expected a find cursor in tool text");

		expect(first.details).toMatchObject({
			files: ["src/first.ts", "src/second.ts"],
			pageIndex: 0,
			hasMore: true,
			totalMatched: 4,
		});
		expect(finder.fileSearchCalls).toEqual([
			{ query: "src/ !test/ !generated/ target", options: { pageIndex: 0, pageSize: 2 } },
		]);

		const second = await tool.execute("find-second-page", {
			pattern: "ignored",
			path: "other",
			exclude: "ignored/",
			limit: 99,
			cursor,
		});

		expect(finder.fileSearchCalls).toEqual([
			{ query: "src/ !test/ !generated/ target", options: { pageIndex: 0, pageSize: 2 } },
			{ query: "src/ !test/ !generated/ target", options: { pageIndex: 1, pageSize: 2 } },
		]);
		expect(second.details).toMatchObject({
			files: ["src/third.ts", "src/fourth.ts"],
			pageIndex: 1,
			hasMore: false,
			totalMatched: 4,
		});
		const secondText = resultText(second);
		expect(secondText).toContain("src/third.ts");
		expect(secondText).toContain("src/fourth.ts");
		expect(secondText).not.toContain("src/first.ts");
	});

	it("retries a zero-result plain grep as fuzzy and marks the fallback result", async () => {
		const session = createSession();
		const finder = new FakeFinder({
			fileSearch: [],
			grep: [
				{ ok: true, value: grepResult([]) },
				{ ok: true, value: grepResult([grepMatch("src/finder.ts", "find needle")]) },
			],
			multiGrep: [],
		});
		installFinder(session, finder);

		const result = await new FffGrepTool(session).execute("grep-fuzzy-fallback", {
			pattern: "needle",
			literal: true,
			path: "src/",
			limit: 6,
		});

		expect(finder.grepCalls.map(call => call.options?.mode)).toEqual(["plain", "fuzzy"]);
		expect(result.details).toMatchObject({ fuzzyFallback: true, fileCount: 1 });
	});
	it("continues grep from the first native cursor without replaying the first page", async () => {
		const session = createSession();
		const firstNativeCursor = { __brand: "GrepCursor" as const, _offset: 17 };
		const finder = new FakeFinder({
			fileSearch: [],
			grep: [
				{
					ok: true,
					value: {
						...grepResult([
							grepMatch("src/first-page.ts", "first native page"),
							grepMatch("src/also-first-page.ts", "another first native page"),
						]),
						nextCursor: firstNativeCursor,
					},
				},
				{ ok: true, value: grepResult([grepMatch("src/second-page.ts", "second native page")]) },
			],
			multiGrep: [],
		});
		installFinder(session, finder);
		const tool = new FffGrepTool(session);

		const first = await tool.execute("grep-first-page", {
			pattern: "needle",
			literal: true,
			path: "src",
			exclude: "test/",
			limit: 2,
		});
		const cursor = first.details?.cursor;
		if (!cursor) throw new Error("Expected a grep cursor in tool details");

		expect(first.details).toMatchObject({
			files: ["src/first-page.ts", "src/also-first-page.ts"],
			matchCount: 2,
			cursor,
		});
		expect(finder.grepCalls).toHaveLength(1);

		const second = await tool.execute("grep-second-page", {
			pattern: "ignored",
			path: "other",
			exclude: "ignored/",
			limit: 99,
			cursor,
		});

		expect(finder.grepCalls).toHaveLength(2);
		expect(finder.grepCalls[1]?.query).toBe("src/ !test/ needle");
		expect(finder.grepCalls[1]?.options?.cursor).toBe(firstNativeCursor);
		expect(second.details).toMatchObject({
			files: ["src/second-page.ts"],
			matchCount: 1,
		});
		const secondText = resultText(second);
		expect(secondText).toContain("second-page.ts");
		expect(secondText).toContain("second native page");
		expect(secondText).not.toContain("first-page.ts");
		expect(secondText).not.toContain("first native page");
	});

	it("forwards multi_grep patterns, constraints, and requested context to the finder", async () => {
		const session = createSession();
		const finder = new FakeFinder({
			fileSearch: [],
			grep: [],
			multiGrep: [{ ok: true, value: grepResult([grepMatch("src/tools.ts", "read or write")]) }],
		});
		installFinder(session, finder);
		const patterns = ["read", "write"];
		const constraints = "src/**/*.{ts,tsx} !src/**/*.test.ts";

		const result = await new FffMultiGrepTool(session).execute("multi-grep-forwarding", {
			patterns,
			constraints,
			context: 4,
			limit: 8,
		});

		expect(finder.multiGrepCalls).toEqual([
			expect.objectContaining({
				patterns,
				constraints,
				beforeContext: 4,
				afterContext: 4,
			}),
		]);
		expect(result.details).toMatchObject({ patterns, fileCount: 1 });
	});
	it("runs multiple multi_grep patterns as one native OR search and renders both matches", async () => {
		const session = createSession();
		const patterns = ["read", "write"];
		const finder = new FakeFinder({
			fileSearch: [],
			grep: [],
			multiGrep: [
				{
					ok: true,
					value: grepResult([grepMatch("src/read.ts", "read only"), grepMatch("src/write.ts", "write only")]),
				},
			],
		});
		installFinder(session, finder);

		const result = await new FffMultiGrepTool(session).execute("multi-grep-or", {
			patterns,
			constraints: "src/",
			limit: 2,
		});

		expect(finder.multiGrepCalls).toHaveLength(1);
		expect(finder.multiGrepCalls[0]).toMatchObject({ patterns, constraints: "src/" });
		expect(result.details).toMatchObject({
			patterns,
			files: ["src/read.ts", "src/write.ts"],
			matchCount: 2,
		});
		const text = resultText(result);
		expect(text).toContain("read.ts");
		expect(text).toContain("read only");
		expect(text).toContain("write.ts");
		expect(text).toContain("write only");
	});

	it("shares one injected finder across all FFF tools in a session and destroys it on disposal", async () => {
		const session = createSession();
		const finder = new FakeFinder({
			fileSearch: [{ ok: true, value: searchResult(["src/one.ts"]) }],
			grep: [{ ok: true, value: grepResult([grepMatch("src/two.ts", "needle")]) }],
			multiGrep: [{ ok: true, value: grepResult([grepMatch("src/three.ts", "needle")]) }],
		});
		let createCount = 0;
		installFinder(session, finder, () => createCount++);

		await new FffFindTool(session).execute("shared-find", { pattern: "one", limit: 1 });
		await new FffGrepTool(session).execute("shared-grep", { pattern: "needle", literal: true, limit: 1 });
		await new FffMultiGrepTool(session).execute("shared-multi-grep", { patterns: ["needle"], limit: 1 });

		expect(createCount).toBe(1);
		disposeSessionFffFinderManager(session);
		expect(finder.isDestroyed).toBe(true);
		expect(finder.destroyCalls).toBe(1);
	});
});
