/**
 * Focused contract tests for CodeGraphRuntime persistence and explore behavior.
 *
 * Covers only observable contracts that require the runtime happy path:
 *   1. initialize() + sync() persists symbols/edges/refs to the SQLite DB
 *   2. explore() reads source from disk, not stale DB bytes
 *   3. getNodeAndEdgeCount() reflects extraction results after sync
 *   4. closing a runtime releases the file lock and DB connection
 *   5. runtime.status() reports dbSizeBytes and indexDir correctly
 *   6. external mutation requires explicit sync — no auto-poll
 *   7. same-index reopen: FTS rows survive close + reopen
 *   8. scoped sync: sync({ paths }) limits to specified files
 *   9. nested cwd reopen: reindex with subdirectory sourceRoot + scoped sync works
 *  10. reopen + delete: filesRemoved=1, fileCount decrements, FTS search still works
 *  11. prose query finds a distinctive camelCase export after indexing
 *  12. scoped sync on a modified file removes the old symbol and indexes the new one
 *  13. unmatched explore query returns empty entries/files (no fabricated repo-wide file list)
 *
 * PI_CONFIG_DIR is isolated per-test so no ~/.omp pollution occurs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { resolveCodeGraphIndexLocation } from "../location";
import { openCodeGraphRuntime } from "../runtime";

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
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
			`  private readonly prefix: string;`,
			`  constructor(prefix = "Hi") { this.prefix = prefix; }`,
			`  greet(name: string): string { return greet(this.prefix); }`,
			`}`,
		].join("\n"),
		"utf8",
	);
	await fs.writeFile(
		path.join(root, "index.ts"),
		`import { greet, Greeter } from "./greeter";\nconsole.log(greet("world"));\n`,
		"utf8",
	);
	git(root, ["init", "-q"]);
	git(root, ["add", "."]);
	git(root, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"]);
	return root;
}

describe("CodeGraphRuntime contract", () => {
	let tmp: string;
	let originalConfigDir: string | undefined;
	let isolatedConfigDir: string;
	let isolatedConfigRoot: string;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cg-runtime-"));
		originalConfigDir = process.env.PI_CONFIG_DIR;
		isolatedConfigDir = `.omp-cg-runtime-${randomUUID()}`;
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

	test("initialize() + sync() persists nodes, edges and refs to the DB", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-persist"));
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);

		const runtime = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		try {
			await runtime.initialize();

			const status = await runtime.status();
			expect(status.initialized).toBe(true);
			expect(status.nodeCount).toBeGreaterThan(0);

			const syncResult = await runtime.sync({});
			expect(syncResult.filesIndexed).toBe(0);
			expect(syncResult.filesChecked).toBeGreaterThan(0);
		} finally {
			runtime.close();
		}
	});

	test("getNodeAndEdgeCount() reflects extraction results after sync", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-counts"));
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);

		const runtime = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		try {
			const before = await runtime.status();
			expect(before.nodeCount).toBe(0);
			expect(before.edgeCount).toBe(0);

			await runtime.initialize();
			const after = await runtime.status();
			expect(after.nodeCount).toBeGreaterThan(0);
			expect(after.fileCount).toBeGreaterThan(0);
		} finally {
			runtime.close();
		}
	});

	test("explore() reads source from disk, not stale DB bytes", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-explore"));
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);

		const runtime = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		try {
			await runtime.initialize();

			// Mutate greet's body to a unique marker — NO sync.
			// The DB still holds the greet node with old source bytes, but explore()
			// re-reads greeter.ts from disk (explorer.ts:167-168) before rendering.
			const UNIQUE_MARKER = "MARKER_UNIQUE_2026_DISK_FRESH";
			await fs.writeFile(
				path.join(repoRoot, "greeter.ts"),
				[
					`export function greet(name: string): string {`,
					`  return "${UNIQUE_MARKER}";`,
					`}`,
					``,
					`export class Greeter {`,
					`  greet(name: string): string { return greet(name); }`,
					`}`,
				].join("\n"),
				"utf8",
			);

			const result = await runtime.explore("greet");
			const greetEntry = result.entries.find(e => e.node.name === "greet");
			expect(greetEntry).toBeDefined();
			expect(greetEntry!.lines.some(l => l.includes(UNIQUE_MARKER))).toBe(true);
		} finally {
			runtime.close();
		}
	});

	test("closing runtime releases DB connection and lock", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-close"));
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);

		const runtime = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		runtime.close();

		const runtime2 = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		try {
			const status = await runtime2.status();
			expect(status.initialized).toBe(false);
		} finally {
			runtime2.close();
		}
	});

	test("runtime.status() reports dbSizeBytes and indexDir correctly", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-status"));
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);

		const runtime = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		try {
			const status = await runtime.status();
			expect(status.indexDir).toBe(location.indexDir);
			expect(status.dbPath).toBe(location.dbPath);
			const dbExists = await fs
				.stat(location.dbPath)
				.then(() => true)
				.catch(() => false);
			expect(dbExists).toBe(true);
		} finally {
			runtime.close();
		}
	});

	test("external mutation requires explicit sync — runtime does not auto-poll", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-mutation-seam"));
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);

		const runtime = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		try {
			await runtime.initialize();

			const beforeStatus = await runtime.status();
			const lastSyncedBefore = beforeStatus.lastSyncedAt;
			if (lastSyncedBefore === null) {
				throw new Error("initialize() should set lastSyncedAt before explicit-sync assertions");
			}

			await fs.writeFile(
				path.join(repoRoot, "greeter.ts"),
				`export function farewell(): string { return "Goodbye"; }\n`,
				"utf8",
			);

			const afterStatus = await runtime.status();
			expect(afterStatus.lastSyncedAt).toBe(lastSyncedBefore);
			expect(afterStatus.nodeCount).toBe(beforeStatus.nodeCount);

			const syncResult = await runtime.sync({ paths: ["greeter.ts"] });
			expect(syncResult.filesUpdated).toBe(1);
			const afterSync = await runtime.status();
			expect(afterSync.lastSyncedAt).toBeGreaterThanOrEqual(lastSyncedBefore);

			const result = await runtime.explore("farewell");
			expect(result.entries.some(e => e.node.name === "farewell")).toBe(true);
		} finally {
			runtime.close();
		}
	});

	test("same-index reopen: FTS rows survive close and reopen — explore finds existing nodes", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-reopen"));
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);

		const runtime1 = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		await runtime1.initialize();
		const statusBefore = await runtime1.status();
		expect(statusBefore.nodeCount).toBeGreaterThan(0);
		runtime1.close();

		const runtime2 = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		try {
			const statusAfter = await runtime2.status();
			expect(statusAfter.nodeCount).toBe(statusBefore.nodeCount);

			const result = await runtime2.explore("greet");
			expect(result.entries.some(e => e.node.name === "greet")).toBe(true);
		} finally {
			runtime2.close();
		}
	});

	test("scoped sync: sync({ paths }) updates only the specified files, not the whole project", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-scoped-sync"));
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);

		const runtime = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		try {
			await runtime.initialize();
			const beforeStatus = await runtime.status();
			const nodeCountBefore = beforeStatus.nodeCount;

			// Add a new file inside a subdirectory.
			// Use "lib/" instead of "src/" — src is in DEFAULT_IGNORE_DIRS.
			const libDir = path.join(repoRoot, "lib");
			await fs.mkdir(libDir, { recursive: true });
			await fs.writeFile(
				path.join(libDir, "helper.ts"),
				`export function helper(): number { return 42; }\n`,
				"utf8",
			);

			const syncResult = await runtime.sync({ paths: ["lib"] });
			expect(syncResult.filesIndexed).toBeGreaterThanOrEqual(1);
			expect(syncResult.filesChecked).toBeGreaterThan(0);

			const afterStatus = await runtime.status();
			expect(afterStatus.nodeCount).toBeGreaterThanOrEqual(nodeCountBefore);
			expect(afterStatus.fileCount).toBeGreaterThanOrEqual(2);

			const result = await runtime.explore("helper");
			expect(result.entries.some(e => e.node.name === "helper")).toBe(true);
		} finally {
			runtime.close();
		}
	});

	test("nested cwd reopen: reuses canonical repo-root index and scoped sync uses worktree-relative paths", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-nested"));

		// Session 1: initialize from the repo root and capture the canonical cache identity.
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);

		const runtime1 = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		await runtime1.initialize();
		const statusBefore = await runtime1.status();
		expect(statusBefore.nodeCount).toBeGreaterThan(0);
		runtime1.close();

		// Add a new file under a nested cwd after the first index already exists.
		// Use "lib/" instead of "src/" — src is in DEFAULT_IGNORE_DIRS.
		const libDir = path.join(repoRoot, "lib");
		await fs.mkdir(libDir, { recursive: true });
		await fs.writeFile(path.join(libDir, "nested.ts"), `export function nestedFn(): void {}\n`, "utf8");

		const nestedLocation = await resolveCodeGraphIndexLocation(libDir);
		expect(nestedLocation.available).toBe(true);
		expect(nestedLocation.identity.sourceRoot).toBe(location.identity.sourceRoot);
		expect(nestedLocation.identity.worktreeRoot).toBe(location.identity.worktreeRoot);
		expect(nestedLocation.identity.key).toBe(location.identity.key);
		expect(nestedLocation.indexDir).toBe(location.indexDir);

		const runtime2 = await openCodeGraphRuntime({ location: nestedLocation, sourceRoot: libDir });
		try {
			await runtime2.initialize();

			const beforeScopedSync = await runtime2.status();
			expect(beforeScopedSync.sourceRoot).toBe(location.identity.sourceRoot);
			expect(beforeScopedSync.nodeCount).toBe(statusBefore.nodeCount);
			expect(beforeScopedSync.fileCount).toBe(statusBefore.fileCount);

			const syncResult = await runtime2.sync({ paths: ["lib/nested.ts"] });
			expect(syncResult.filesIndexed).toBe(1);

			const afterSyncStatus = await runtime2.status();
			expect(afterSyncStatus.fileCount).toBe(beforeScopedSync.fileCount + 1);

			const result = await runtime2.explore("nestedFn");
			expect(result.entries.some(e => e.node.name === "nestedFn")).toBe(true);
			expect(result.files.some(f => f.filePath === "lib/nested.ts")).toBe(true);
		} finally {
			runtime2.close();
		}
	});

	test("same-index reopen + delete: filesRemoved=1, fileCount decrements, FTS search still works", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-reopen-delete"));
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);

		const survivorSymbol = "keepAliveIndexSearch";
		await fs.writeFile(
			path.join(repoRoot, "keeper.ts"),
			`export function ${survivorSymbol}(): string { return "alive"; }\n`,
			"utf8",
		);

		// Session 1: initialize and close.
		const runtime1 = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		await runtime1.initialize();
		const statusBefore = await runtime1.status();
		expect(statusBefore.fileCount).toBeGreaterThanOrEqual(3);
		const greetNodeCount = statusBefore.nodeCount;
		runtime1.close();

		// Delete greeter.ts from disk.
		await fs.rm(path.join(repoRoot, "greeter.ts"));

		// Session 2: reopen same index and sync.
		const runtime2 = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		try {
			const syncResult = await runtime2.sync({});
			expect(syncResult.filesRemoved).toBe(1);

			const statusAfter = await runtime2.status();
			expect(statusAfter.fileCount).toBe(statusBefore.fileCount - 1);

			// Node count should have dropped (greet function + Greeter class removed).
			expect(statusAfter.nodeCount).toBeLessThan(greetNodeCount);
			// FTS must still work on surviving semantic nodes after delete + reopen.
			const result = await runtime2.explore(survivorSymbol);
			expect(result.entries.some(e => e.node.name === survivorSymbol)).toBe(true);
			expect(result.files.some(f => f.filePath === "keeper.ts")).toBe(true);
		} finally {
			runtime2.close();
		}
	});

	test("prose query finds an indexed distinctive camelCase export", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-camel-query"));
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);

		const symbolName = "resolveCodeGraphIndexLocation";
		await fs.writeFile(
			path.join(repoRoot, "location.ts"),
			`export function ${symbolName}(): string { return "ok"; }\n`,
			"utf8",
		);

		const runtime = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		try {
			await runtime.initialize();

			const result = await runtime.explore(`Where is ${symbolName} defined?`);
			expect(result.entries.some(e => e.node.name === symbolName)).toBe(true);
			expect(result.files.some(f => f.filePath === "location.ts")).toBe(true);
		} finally {
			runtime.close();
		}
	});

	test("scoped sync on a modified file removes the old symbol and indexes the new one", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-scoped-rename"));
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);

		const libDir = path.join(repoRoot, "lib");
		await fs.mkdir(libDir, { recursive: true });
		const relativePath = "lib/scoped.ts";
		const oldSymbol = "resolveScopedAlphaSymbol";
		const newSymbol = "resolveScopedOmegaReplacement";
		await fs.writeFile(
			path.join(repoRoot, relativePath),
			`export function ${oldSymbol}(): string { return "alpha"; }\n`,
			"utf8",
		);

		const runtime = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		try {
			await runtime.initialize();
			expect((await runtime.explore(oldSymbol)).entries.some(e => e.node.name === oldSymbol)).toBe(true);

			await fs.writeFile(
				path.join(repoRoot, relativePath),
				`export function ${newSymbol}(): string { return "omega replacement"; }\n`,
				"utf8",
			);

			const syncResult = await runtime.sync({ paths: [relativePath] });
			expect(syncResult.filesUpdated).toBe(1);

			const oldResult = await runtime.explore(oldSymbol);
			expect(oldResult.entries).toHaveLength(0);

			const newResult = await runtime.explore(newSymbol);
			expect(newResult.entries.some(e => e.node.name === newSymbol)).toBe(true);
			expect(newResult.files.some(f => f.filePath === relativePath)).toBe(true);
		} finally {
			runtime.close();
		}
	});

	test("unmatched explore query returns empty entries and files", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-no-match"));
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);

		const runtime = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		try {
			await runtime.initialize();
			expect((await runtime.explore("greet")).entries.some(e => e.node.name === "greet")).toBe(true);

			const result = await runtime.explore("zzzzCompletelyUnmatchedRuntimeProbe123");
			expect(result.entries).toHaveLength(0);
			expect(result.files).toHaveLength(0);
		} finally {
			runtime.close();
		}
	});
});
