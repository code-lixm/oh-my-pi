import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { FileFinderApi, GrepMatch, GrepOptions, GrepResult, Result } from "@ff-labs/fff-bun";
import { GREP_OUTPUT_MODES, runGrepCommand } from "../src/cli/grep-cli";
import GrepCommand from "../src/commands/grep";
import { FffFinderManager } from "../src/tools/fff-manager";

class FakeFinder {
	isDestroyed = false;
	readonly grepCalls: Array<{ query: string; options: GrepOptions | undefined }> = [];

	constructor(private readonly responses: Array<Result<GrepResult>>) {}

	async waitForScan(): Promise<Result<boolean>> {
		return { ok: true, value: true };
	}

	destroy(): void {
		this.isDestroyed = true;
	}

	grep(query: string, options?: GrepOptions): Result<GrepResult> {
		this.grepCalls.push({ query, options });
		const response = this.responses.shift();
		if (!response) throw new Error("Unexpected FFF grep call");
		return response;
	}
}

function grepMatch(
	relativePath: string,
	lineNumber: number,
	lineContent: string,
	context: { before?: string[]; after?: string[] } = {},
): GrepMatch {
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
		lineNumber,
		col: 0,
		byteOffset: 0,
		lineContent,
		matchRanges: [[0, lineContent.length]],
		contextBefore: context.before ?? [],
		contextAfter: context.after ?? [],
	};
}

function grepResult(items: GrepMatch[], nextCursor: GrepResult["nextCursor"]): GrepResult {
	return {
		items,
		totalMatched: items.length,
		totalFilesSearched: 4,
		totalFiles: 5,
		filteredFileCount: 4,
		nextCursor,
	};
}

async function captureGrep(
	run: () => Promise<void>,
): Promise<{ output: string; errors: string; exitCode: typeof process.exitCode }> {
	const output: string[] = [];
	const errors: string[] = [];
	const previousExitCode = process.exitCode;
	const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		output.push(args.map(String).join(" "));
	});
	const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	});

	try {
		process.exitCode = undefined;
		await run();
		return {
			output: Bun.stripANSI(output.join("\n")),
			errors: Bun.stripANSI(errors.join("\n")),
			exitCode: process.exitCode,
		};
	} finally {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		process.exitCode = previousExitCode;
	}
}

const managers = new Set<FffFinderManager>();

afterEach(() => {
	for (const manager of managers) manager.dispose();
	managers.clear();
});

function createManager(finder: FakeFinder): FffFinderManager {
	const manager = new FffFinderManager({
		finderStatic: {
			create: () => ({ ok: true, value: finder as unknown as FileFinderApi }),
		},
	});
	managers.add(manager);
	return manager;
}

function displayPath(cwd: string, relativePath: string): string {
	return path.join(cwd, relativePath).replaceAll("\\", "/");
}

describe("omp grep FFF command", () => {
	it("sends relative and absolute path constraints plus a glob to FFF and renders regex context", async () => {
		const cwd = path.join(os.tmpdir(), "omp-cli-grep-fff");
		const pattern = "Needle\\d+";
		const finder = new FakeFinder([
			{
				ok: true,
				value: grepResult(
					[
						grepMatch("src/relative.ts", 11, "Needle1 match", {
							before: ["before one", "before two"],
							after: ["after one", "after two"],
						}),
					],
					{ __brand: "GrepCursor", _offset: 3 },
				),
			},
			{
				ok: true,
				value: grepResult([grepMatch("lib/absolute.ts", 4, "Needle2 match")], null),
			},
		]);
		const manager = createManager(finder);

		const relative = await captureGrep(() =>
			runGrepCommand(
				{
					pattern,
					path: "src",
					glob: "**/*.ts",
					limit: 3,
					context: 2,
					mode: GREP_OUTPUT_MODES.Content,
				},
				{ cwd, manager },
			),
		);
		const absolute = await captureGrep(() =>
			runGrepCommand(
				{
					pattern,
					path: path.join(cwd, "lib"),
					glob: "**/*.ts",
					limit: 3,
					context: 2,
					mode: GREP_OUTPUT_MODES.Content,
				},
				{ cwd, manager },
			),
		);

		expect(finder.grepCalls).toEqual([
			{
				query: "src/ **/*.ts Needle\\d+",
				options: {
					mode: "regex",
					smartCase: true,
					maxMatchesPerFile: 3,
					pageSize: 3,
					beforeContext: 2,
					afterContext: 2,
				},
			},
			{
				query: "lib/ **/*.ts Needle\\d+",
				options: {
					mode: "regex",
					smartCase: true,
					maxMatchesPerFile: 3,
					pageSize: 3,
					beforeContext: 2,
					afterContext: 2,
				},
			},
		]);

		const relativePath = displayPath(cwd, "src/relative.ts");
		expect(relative.output).toContain(`${relativePath}-9- before one`);
		expect(relative.output).toContain(`${relativePath}-10- before two`);
		expect(relative.output).toContain(`${relativePath}:11: Needle1 match`);
		expect(relative.output).toContain(`${relativePath}-12- after one`);
		expect(relative.output).toContain(`${relativePath}-13- after two`);
		expect(relative.output).toContain("Limit reached: true");
		expect(relative.errors).toBe("");
		expect(relative.exitCode).toBeUndefined();

		expect(absolute.output).toContain(`${displayPath(cwd, "lib/absolute.ts")}:4: Needle2 match`);
		expect(absolute.errors).toBe("");
		expect(absolute.exitCode).toBeUndefined();
	});

	it("prints each matching file once and aggregates match counts per file", async () => {
		const cwd = path.join(os.tmpdir(), "omp-cli-grep-fff");
		const matches = [
			grepMatch("src/repeated.ts", 2, "needle first"),
			grepMatch("src/repeated.ts", 7, "needle second"),
			grepMatch("src/other.ts", 3, "needle other"),
		];
		const finder = new FakeFinder([
			{ ok: true, value: grepResult(matches, null) },
			{ ok: true, value: grepResult(matches, null) },
		]);
		const manager = createManager(finder);

		const files = await captureGrep(() =>
			runGrepCommand(
				{
					pattern: "needle",
					path: "src",
					limit: 10,
					context: 0,
					mode: GREP_OUTPUT_MODES.FilesWithMatches,
				},
				{ cwd, manager },
			),
		);
		const counts = await captureGrep(() =>
			runGrepCommand(
				{
					pattern: "needle",
					path: "src",
					limit: 10,
					context: 0,
					mode: GREP_OUTPUT_MODES.Count,
				},
				{ cwd, manager },
			),
		);

		const repeatedPath = displayPath(cwd, "src/repeated.ts");
		const otherPath = displayPath(cwd, "src/other.ts");
		expect(files.output.split(repeatedPath)).toHaveLength(2);
		expect(files.output.split(otherPath)).toHaveLength(2);
		expect(files.errors).toBe("");
		expect(files.exitCode).toBeUndefined();

		expect(counts.output).toContain(`${repeatedPath}: 2 matches`);
		expect(counts.output).toContain(`${otherPath}: 1 matches`);
		expect(counts.errors).toBe("");
		expect(counts.exitCode).toBeUndefined();
	});

	it("does not expose the removed --no-gitignore flag in public command metadata", () => {
		expect(GrepCommand.flags).not.toHaveProperty("no-gitignore");
	});
});
