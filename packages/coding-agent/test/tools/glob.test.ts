import { afterEach, describe, expect, test, vi } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { GlobTool } from "../../src/tools/glob";
import { ToolError } from "../../src/tools/tool-errors";

const ROOT_SEARCH_ERROR = "Searching from root directory '/' is not allowed";

async function expectRootSearchRejected(searchPath: string): Promise<void> {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const tool = new GlobTool(session);
	let thrown: unknown;
	try {
		await tool.execute("glob-root-regression", { path: searchPath });
	} catch (error) {
		thrown = error;
	}

	if (!(thrown instanceof Error)) {
		throw new Error(`Expected glob path ${JSON.stringify(searchPath)} to reject`);
	}

	expect(thrown).toBeInstanceOf(ToolError);
	expect(thrown.message).toBe(ROOT_SEARCH_ERROR);
}

describe("GlobTool.execute", () => {
	test.each(["/", "//"])("rejects bare root search path %s", async searchPath => {
		await expectRootSearchRejected(searchPath);
	});
});

describe("GlobTool.execute natives.glob options", () => {
	// Spying on the shared `@oh-my-pi/pi-natives` namespace (NOT `mock.module`,
	// which would leak across files) follows the repo convention used in
	// theme-auto-detection.test.ts / lsp-regressions.test.ts.
	const globSpy = vi.spyOn(natives, "glob").mockResolvedValue({ matches: [], totalMatches: 0 });

	afterEach(() => {
		globSpy.mockClear();
	});

	async function captureGlobOptions(params: Record<string, unknown>): Promise<natives.GlobOptions> {
		globSpy.mockClear();
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
		const tool = new GlobTool(session);
		await tool.execute("glob-options-regression", params as never);
		const options = globSpy.mock.calls[0]?.[0];
		expect(options).toBeDefined();
		return options!;
	}

	test("defaults keep sortByMtime:true with no walker cache (unchanged behavior)", async () => {
		const options = await captureGlobOptions({ path: "**/*.ts" });
		expect(options.sortByMtime).toBe(true);
		expect(options.cache).toBeUndefined();
	});

	test('explicit sort:"mtime" keeps sortByMtime:true with no walker cache', async () => {
		const options = await captureGlobOptions({ path: "**/*.ts", sort: "mtime" });
		expect(options.sortByMtime).toBe(true);
		expect(options.cache).toBeUndefined();
	});

	test('sort:"path" disables mtime sort and enables the walker cache', async () => {
		const options = await captureGlobOptions({ path: "**/*.ts", sort: "path" });
		expect(options.sortByMtime).toBe(false);
		expect(options.cache).toBe(true);
	});
});
