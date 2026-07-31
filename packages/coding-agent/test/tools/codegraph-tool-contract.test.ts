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

import { resolveCodeGraphIndexLocation } from "../../src/codegraph/location";
import { disposeAllWorkersForTests, probeSlot } from "../../src/codegraph/supervisor";
import { EditTool } from "../../src/edit";
import type { ToolSession } from "../../src/tools";
import { CodeGraphTool } from "../../src/tools/codegraph";

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
async function waitForSlotReady(repoRoot: string, label: string) {
	const location = await resolveCodeGraphIndexLocation(repoRoot);
	expect(location.available).toBe(true);
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const supervisor = await probeSlot(location);
		if (!supervisor.active && supervisor.progress.state === "ready") {
			return location;
		}
		if (!supervisor.active && supervisor.progress.state === "failed") {
			throw new Error(`${label} failed: ${supervisor.progress.phase}`);
		}
		// Worker progress is produced by a real background thread writing progress.json;
		// fake timers cannot advance that external lifecycle, so this poll uses a short real wait.
		await Bun.sleep(100);
	}
	throw new Error(`${label} timed out before the slot became ready`);
}

function expectIndexingFallback(details: { fallback?: string }) {
	expect(details.fallback).toContain("CodeGraph is ");
	expect(details.fallback).toContain("the worker is still preparing the index");
	expect(details.fallback).toContain("Fallback: use `grep`/`glob`/`read`.");
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
		disposeAllWorkersForTests();
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

	test("createIf() keeps CodeGraph available for a normal non-Git fallback", async () => {
		const tool = await CodeGraphTool.createIf(makeSession(tmp));
		expect(tool).toBeInstanceOf(CodeGraphTool);
		const result = await tool.execute("call-create-if-non-git", { query: "anything" });
		expect(result.isError).not.toBe(true);
		const details = result.details as { fallback?: string };
		expect(details.fallback).toContain("Do not wait for or retry CodeGraph");
	});

	test("projectPath selects an indexed Git project from a non-Git session", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "project-path-repo"));
		const tool = await CodeGraphTool.createIf(makeSession(tmp));
		const cold = await tool.execute("call-project-path-cold", { query: "greet", projectPath: repoRoot });
		expect(cold.isError).not.toBe(true);
		expectIndexingFallback(cold.details as { fallback?: string });
		await waitForSlotReady(repoRoot, "projectPath warmup");
		const warm = await tool.execute("call-project-path-warm", {
			query: "greet",
			projectPath: repoRoot,
			mode: "locate",
		});
		expect(warm.isError).not.toBe(true);
		const details = warm.details as { sourceRoot?: string; entries?: Array<{ node: { name: string } }> };
		expect(details.sourceRoot).toBe(await fs.realpath(repoRoot));
		expect(details.entries?.some(entry => entry.node.name === "greet")).toBe(true);
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

		const coldResult = await tool.execute("call-runtime-error-cold", { query: "x" });
		expect(coldResult.isError).not.toBe(true);
		expectIndexingFallback(coldResult.details as { fallback?: string });

		const location = await waitForSlotReady(repoRoot, "runtime-error warmup");
		await fs.rm(location.dbPath, { recursive: true, force: true });
		await fs.mkdir(location.dbPath, { recursive: true });

		const result = await tool.execute("call-runtime-error-warm", { query: "x" });

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

	test("happy path: first call falls back while indexing, second call returns the symbol", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-happy"));
		const session = makeSession(repoRoot);
		const tool = new CodeGraphTool(session);

		const coldResult = await withTimeout(
			tool.execute("call-happy-cold", { query: "greet" }),
			5000,
			"cold happy execute",
		);
		expect(coldResult.isError).not.toBe(true);
		expectIndexingFallback(coldResult.details as { fallback?: string });

		await waitForSlotReady(repoRoot, "happy path warmup");

		const result = await withTimeout(tool.execute("call-happy-warm", { query: "greet" }), 5000, "warm happy execute");

		expect(result.isError).not.toBe(true);
		const details = result.details as { fallback?: string; entries?: Array<{ node: { name: string } }> };
		expect(details.fallback).toBeUndefined();
		expect(details.entries).toBeDefined();
		expect(details.entries!.some(e => e.node.name === "greet")).toBe(true);
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		expect(text).toContain("Mode: understand");
		const header = /^\[greeter\.ts#[0-9A-F]{4}\]$/mu.exec(text)?.[0];
		expect(header).toBeDefined();
		const editSession = session as unknown as ToolSession;
		const editResult = await new EditTool(editSession).execute("edit-from-codegraph", {
			input: `${header}\nSWAP 2.=2:\n+  return \`Hi, \${name}!\`;`,
		});
		expect(editResult.isError).not.toBe(true);
		expect(await Bun.file(path.join(repoRoot, "greeter.ts")).text()).toMatch(/return `Hi, \$\{name\}!`;/u);
	});

	test("nested cwd + scoped path + same-index reuse: each first call falls back, warm retries reuse the same Git-root index", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-nested-tool"));
		const rootTool = new CodeGraphTool(makeSession(repoRoot));

		const coldRootResult = await rootTool.execute("call-root-cold", { query: "greet" });
		expect(coldRootResult.isError).not.toBe(true);
		expectIndexingFallback(coldRootResult.details as { fallback?: string });

		await waitForSlotReady(repoRoot, "root tool warmup");

		const rootResult = await rootTool.execute("call-root-warm", { query: "greet" });
		expect(rootResult.isError).not.toBe(true);
		const rootDetails = rootResult.details as { fallback?: string; indexDir?: string; sourceRoot?: string };
		expect(rootDetails.fallback).toBeUndefined();
		expect(rootDetails.indexDir).toBeDefined();
		expect(rootDetails.sourceRoot).toBeDefined();

		const libDir = path.join(repoRoot, "lib");
		const helperPath = path.join(libDir, "helper.ts");
		await fs.mkdir(libDir, { recursive: true });
		await fs.writeFile(helperPath, `export function helper(): number { return 42; }\n`, "utf8");

		const nestedTool = new CodeGraphTool(makeSession(libDir));
		const coldNestedResult = await nestedTool.execute("call-nested-cold", {
			query: "helper",
			path: helperPath,
		});
		expect(coldNestedResult.isError).not.toBe(true);
		expectIndexingFallback(coldNestedResult.details as { fallback?: string });

		await waitForSlotReady(repoRoot, "nested tool warmup");

		const nestedResult = await nestedTool.execute("call-nested-warm", {
			query: "helper",
			path: helperPath,
		});
		expect(nestedResult.isError).not.toBe(true);
		const nestedDetails = nestedResult.details as {
			fallback?: string;
			entries?: Array<{ node: { name: string } }>;
			indexDir?: string;
			sourceRoot?: string;
		};
		expect(nestedDetails.fallback).toBeUndefined();
		expect(nestedDetails.entries).toBeDefined();
		expect(nestedDetails.entries!.some(e => e.node.name === "helper")).toBe(true);
		expect(nestedDetails.indexDir).toBe(rootDetails.indexDir);
		expect(nestedDetails.sourceRoot).toBe(rootDetails.sourceRoot);
	});

	test("concurrent same-index execute() calls fall back cold, then both return real results after the slot is ready", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-concurrent-tool"));
		const libDir = path.join(repoRoot, "lib");
		const helperPath = path.join(libDir, "helper.ts");
		await fs.mkdir(libDir, { recursive: true });
		await fs.writeFile(helperPath, `export function helper(): number { return 42; }\n`, "utf8");

		const rootTool = new CodeGraphTool(makeSession(repoRoot));
		const nestedTool = new CodeGraphTool(makeSession(libDir));

		const [coldRootResult, coldNestedResult] = await withTimeout(
			Promise.all([
				rootTool.execute("call-concurrent-root-cold", { query: "greet" }),
				nestedTool.execute("call-concurrent-nested-cold", { query: "helper", path: helperPath }),
			]),
			15000,
			"cold concurrent CodeGraphTool execute()",
		);
		expect(coldRootResult.isError).not.toBe(true);
		expectIndexingFallback(coldRootResult.details as { fallback?: string });
		expect(coldNestedResult.isError).not.toBe(true);
		expectIndexingFallback(coldNestedResult.details as { fallback?: string });

		await waitForSlotReady(repoRoot, "concurrent warmup");

		const [rootResult, nestedResult] = await withTimeout(
			Promise.all([
				rootTool.execute("call-concurrent-root-warm", { query: "greet" }),
				nestedTool.execute("call-concurrent-nested-warm", { query: "helper", path: helperPath }),
			]),
			15000,
			"warm concurrent CodeGraphTool execute()",
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
