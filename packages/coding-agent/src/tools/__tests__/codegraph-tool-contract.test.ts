/**
 * Focused contract tests for `CodeGraphTool` availability gating, fallback shaping,
 * and same-index concurrency.
 *
 * Covers:
 *   1. createIf() gating: non-Git workspaces return null, Git repos with HEAD return a tool
 *   2. non-Git execute() degrades to a normal fallback result
 *   3. invalid path inputs (missing path / outside source root) remain hard errors
 *   4. runtime setup failure degrades to a normal fallback result
 *   5. fallback/error paths never create a project-local `.codegraph` directory
 *   6. empty query rejects early
 *   7. happy paths succeed from repo root, nested cwd, and concurrent same-index calls
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { getCodeGraphStorageRoot } from "../../codegraph/location-fs";
import { CodeGraphTool } from "../codegraph";

function makeSession(cwd: string) {
	return {
		cwd,
		settings: { get: () => undefined } as { get<T extends string>(key: T): unknown },
	};
}

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.lstat(targetPath);
		return true;
	} catch {
		return false;
	}
}

async function initGitRepo(root: string): Promise<string> {
	await fs.mkdir(root, { recursive: true });
	await fs.writeFile(
		path.join(root, "greeter.ts"),
		[
			`export function greet(name: string): string {`,
			`  return \`Hello, \${name}!\`;`,
			`}`,
			``,
			`export class Greeter {`,
			`  greet(name: string): string { return greet(name); }`,
			`}`,
		].join("\n"),
		"utf8",
	);
	git(root, ["init", "-q"]);
	git(root, ["add", "."]);
	git(root, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"]);
	return root;
}

// Real-time watchdog is intentional here: this integration test must fail fast
// if same-index lock serialization regresses and a concurrent tool call hangs.
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
		timer.unref?.();
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		clearTimeout(timer);
	}
}

describe("CodeGraphTool contract", () => {
	let tmp: string;
	let originalConfigDir: string | undefined;
	let isolatedConfigDir: string;
	let isolatedConfigRoot: string;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cg-tool-"));
		originalConfigDir = process.env.PI_CONFIG_DIR;
		isolatedConfigDir = `.omp-cg-tool-${randomUUID()}`;
		isolatedConfigRoot = path.join(os.homedir(), isolatedConfigDir);
		process.env.PI_CONFIG_DIR = isolatedConfigDir;
	});

	afterEach(async () => {
		if (originalConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalConfigDir;
		}
		await fs.rm(tmp, { recursive: true, force: true });
		await fs.rm(isolatedConfigRoot, { recursive: true, force: true });
	});

	test("tool is read-only", () => {
		const tool = new CodeGraphTool(makeSession(tmp));
		expect(tool.approval).toBe("read");
	});

	test("createIf() returns null outside a Git workspace", async () => {
		expect(await CodeGraphTool.createIf(makeSession(tmp))).toBeNull();
	});

	test("createIf() returns a tool for a Git repo with HEAD", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-create-if"));

		expect(await CodeGraphTool.createIf(makeSession(repoRoot))).toBeInstanceOf(CodeGraphTool);
	});

	test("non-git workspace returns fallback and does not create project .codegraph", async () => {
		const tool = new CodeGraphTool(makeSession(tmp));
		const result = await tool.execute("call-non-git", { query: "anything" });

		expect(result.isError).not.toBe(true);
		const details = result.details as { fallback?: string };
		expect(details.fallback).toContain("CodeGraph unavailable");
		expect(details.fallback).toContain("Fallback: use `grep`/`glob`/`read`.");
		expect(await pathExists(path.join(tmp, ".codegraph"))).toBe(false);
	});

	test("path outside source root stays an error and does not create project .codegraph", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-scope"));

		// outsidePath only needs to exist; active repo is always resolved from session.cwd.
		const siblingRoot = path.join(tmp, "sibling-git");
		await fs.mkdir(siblingRoot, { recursive: true });

		const tool = new CodeGraphTool(makeSession(repoRoot));
		const result = await tool.execute("call-scope", { query: "x", path: siblingRoot });

		expect(result.isError).toBe(true);
		const details = result.details as { fallback?: string };
		expect(details.fallback).toContain("Path is outside the active source root");
		expect(await pathExists(path.join(repoRoot, ".codegraph"))).toBe(false);
	});

	test("nonexistent path stays an error and does not create project .codegraph", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-missing-path"));
		const tool = new CodeGraphTool(makeSession(repoRoot));
		const missingPath = path.join(repoRoot, "lib", "missing.ts");

		const result = await tool.execute("call-missing-path", { query: "x", path: missingPath });

		expect(result.isError).toBe(true);
		const details = result.details as { fallback?: string };
		expect(details.fallback).toContain("Path does not exist on disk");
		expect(await pathExists(path.join(repoRoot, ".codegraph"))).toBe(false);
	});

	test("runtime setup failure returns fallback instead of throwing and still avoids project .codegraph", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-runtime-error"));
		const tool = new CodeGraphTool(makeSession(repoRoot));
		const storageRoot = getCodeGraphStorageRoot();

		await fs.mkdir(path.dirname(storageRoot), { recursive: true });
		await fs.writeFile(storageRoot, "block directory creation", "utf8");

		const result = await tool.execute("call-runtime-error", { query: "x" });

		expect(result.isError).not.toBe(true);
		const details = result.details as { fallback?: string };
		expect(details.fallback).toContain("CodeGraph runtime error");
		expect(details.fallback).toContain("Fallback: use `grep`/`glob`/`read`.");
		expect(await pathExists(path.join(repoRoot, ".codegraph"))).toBe(false);
	});

	test("empty query rejects before touching the runtime", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-empty-query"));
		const tool = new CodeGraphTool(makeSession(repoRoot));

		await expect(tool.execute("call-empty", { query: "   " })).rejects.toThrow(/query/i);
		expect(await pathExists(path.join(repoRoot, ".codegraph"))).toBe(false);
	});

	test("happy path: tool succeeds from Git repo root, no fallback, symbol found", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-happy"));
		const tool = new CodeGraphTool(makeSession(repoRoot));

		const result = await tool.execute("call-happy", { query: "greet" });

		expect(result.isError).not.toBe(true);
		const details = result.details as { fallback?: string; entries?: Array<{ node: { name: string } }> };
		expect(details.fallback).toBeUndefined();
		expect(details.entries).toBeDefined();
		expect(details.entries!.some(e => e.node.name === "greet")).toBe(true);
	});

	test("nested cwd + scoped path + same-index reuse: tool succeeds, no fallback, symbol found", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-nested-tool"));

		// Session 1: tool from repo root — establishes the index.
		const tool1 = new CodeGraphTool(makeSession(repoRoot));
		const result1 = await tool1.execute("call-root", { query: "greet" });
		expect(result1.isError).not.toBe(true);
		const details1 = result1.details as { fallback?: string; indexDir?: string; sourceRoot?: string };
		expect(details1.fallback).toBeUndefined();
		expect(details1.indexDir).toBeDefined();
		expect(details1.sourceRoot).toBeDefined();

		// Session 2: nested cwd with scoped path parameter.
		// Use "lib/" instead of "src/" — src is in DEFAULT_IGNORE_DIRS.
		const libDir = path.join(repoRoot, "lib");
		await fs.mkdir(libDir, { recursive: true });
		await fs.writeFile(path.join(libDir, "helper.ts"), `export function helper(): number { return 42; }\n`, "utf8");

		// cwd is the nested lib/ dir; path scopes to the helper file.
		const tool2 = new CodeGraphTool(makeSession(libDir));
		const result2 = await tool2.execute("call-nested", {
			query: "helper",
			path: path.join(libDir, "helper.ts"),
		});

		// Must succeed — no fallback, symbol found, and reuse the same Git-root index.
		expect(result2.isError).not.toBe(true);
		const details2 = result2.details as {
			fallback?: string;
			entries?: Array<{ node: { name: string } }>;
			indexDir?: string;
			sourceRoot?: string;
		};
		expect(details2.fallback).toBeUndefined();
		expect(details2.entries).toBeDefined();
		expect(details2.entries!.some(e => e.node.name === "helper")).toBe(true);
		expect(details2.indexDir).toBe(details1.indexDir);
		expect(details2.sourceRoot).toBe(details1.sourceRoot);
	});

	test("concurrent same-index execute() calls both finish without fallback", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-concurrent-tool"));
		const libDir = path.join(repoRoot, "lib");
		const helperPath = path.join(libDir, "helper.ts");
		await fs.mkdir(libDir, { recursive: true });
		await fs.writeFile(helperPath, `export function helper(): number { return 42; }\n`, "utf8");

		const rootTool = new CodeGraphTool(makeSession(repoRoot));
		const nestedTool = new CodeGraphTool(makeSession(libDir));

		const [rootResult, nestedResult] = await withTimeout(
			Promise.all([
				rootTool.execute("call-concurrent-root", { query: "greet" }),
				nestedTool.execute("call-concurrent-nested", { query: "helper", path: helperPath }),
			]),
			15000,
			"concurrent CodeGraphTool execute()",
		);

		expect(rootResult.isError).not.toBe(true);
		const rootDetails = rootResult.details as {
			fallback?: string;
			entries?: Array<{ node: { name: string } }>;
			indexDir?: string;
			sourceRoot?: string;
		};
		expect(rootDetails.fallback).toBeUndefined();
		expect(rootDetails.entries?.some(e => e.node.name === "greet")).toBe(true);
		expect(rootDetails.indexDir).toBeDefined();

		expect(nestedResult.isError).not.toBe(true);
		const nestedDetails = nestedResult.details as {
			fallback?: string;
			entries?: Array<{ node: { name: string } }>;
			indexDir?: string;
			sourceRoot?: string;
		};
		expect(nestedDetails.fallback).toBeUndefined();
		expect(nestedDetails.entries?.some(e => e.node.name === "helper")).toBe(true);
		expect(nestedDetails.indexDir).toBe(rootDetails.indexDir);
		expect(nestedDetails.sourceRoot).toBe(rootDetails.sourceRoot);
	});
});
