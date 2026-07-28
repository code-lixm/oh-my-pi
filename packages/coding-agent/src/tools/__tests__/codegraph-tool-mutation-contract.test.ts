import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { resolveCodeGraphIndexLocation } from "../../codegraph/location";
import { disposeAllWorkersForTests, probeSlot } from "../../codegraph/supervisor";
import { Settings } from "../../config/settings";
import { CodeGraphTool, type CodeGraphToolSession } from "../codegraph";
import {
	notifyFileDeleted,
	notifyFileRenamed,
	notifyFileUpdated,
	type PendingFileMutationCollector,
	peekPendingFileMutations,
} from "../file-mutation-hook";
import type { ToolSession } from "../index";

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
		[`export function greet(name: string): string {`, `  return \`Hello, \${name}!\`;`, `}`].join("\n"),
		"utf8",
	);
	git(root, ["init", "-q"]);
	git(root, ["add", "."]);
	git(root, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"]);
	return root;
}

type MutationToolSession = ToolSession &
	CodeGraphToolSession & {
		pendingFileMutations?: PendingFileMutationCollector;
	};

function makeSession(cwd: string): MutationToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
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
		// Worker progress is written by a real background thread; fake timers cannot advance it,
		// so this bounded poll waits on the persisted ready signal instead of guessing a fixed settle delay.
		await Bun.sleep(100);
	}
	throw new Error(`${label} timed out before the slot became ready`);
}

describe("CodeGraphTool pending mutation contract", () => {
	let tmp: string;
	let originalConfigDir: string | undefined;
	let isolatedConfigDir: string;
	let isolatedConfigRoot: string;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cg-tool-mutation-"));
		originalConfigDir = process.env.PI_CONFIG_DIR;
		isolatedConfigDir = `.omp-cg-tool-mutation-${randomUUID()}`;
		isolatedConfigRoot = path.join(os.homedir(), isolatedConfigDir);
		process.env.PI_CONFIG_DIR = isolatedConfigDir;
	});

	afterEach(async () => {
		disposeAllWorkersForTests();
		if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
		else process.env.PI_CONFIG_DIR = originalConfigDir;
		await fs.rm(tmp, { recursive: true, force: true });
		await fs.rm(isolatedConfigRoot, { recursive: true, force: true });
	});

	test("execute() drains pending update/delete/rename mutations into a scoped sync and refreshes indexed symbols", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-tool-mutation"));
		const libDir = path.join(repoRoot, "lib");
		await fs.mkdir(libDir, { recursive: true });
		const updatePath = path.join(libDir, "update.ts");
		const renameBeforePath = path.join(libDir, "rename-before.ts");
		const renameAfterPath = path.join(libDir, "rename-after.ts");
		const deletePath = path.join(libDir, "remove.ts");
		const oldSymbol = "resolveBufferedOldSymbol";
		const newSymbol = "resolveBufferedNewSymbol";
		const renameSymbol = "resolveBufferedRenameSymbol";
		const deletedSymbol = "resolveBufferedDeleteSymbol";

		await fs.writeFile(updatePath, `export function ${oldSymbol}(): string { return "old"; }\n`, "utf8");
		await fs.writeFile(renameBeforePath, `export function ${renameSymbol}(): string { return "rename"; }\n`, "utf8");
		await fs.writeFile(deletePath, `export function ${deletedSymbol}(): string { return "delete"; }\n`, "utf8");

		const session = makeSession(repoRoot);
		const tool = new CodeGraphTool(session);

		const initial = await tool.execute("call-initial", { query: oldSymbol });
		expect(initial.isError).not.toBe(true);
		const initialDetails = initial.details as { fallback?: string; indexState?: string };
		expect(initialDetails.indexState).toBeDefined();
		expect(initialDetails.fallback).toContain("CodeGraph is ");
		expect(initialDetails.fallback).toContain("the worker is still preparing the index");
		expect(initialDetails.fallback).toContain("Fallback: use `grep`/`glob`/`read`.");

		await waitForSlotReady(repoRoot, "pending mutation warmup");

		const warm = await tool.execute("call-warm", { query: oldSymbol });
		expect(warm.isError).not.toBe(true);
		const warmDetails = warm.details as { entries?: Array<{ node: { name: string } }> };
		expect(warmDetails.entries?.some(e => e.node.name === oldSymbol)).toBe(true);

		await fs.writeFile(
			updatePath,
			`export function ${newSymbol}(): string { return "new buffered value"; }\n`,
			"utf8",
		);
		expect(notifyFileUpdated(session, updatePath)).toBe(true);
		await fs.rename(renameBeforePath, renameAfterPath);
		expect(notifyFileRenamed(session, renameBeforePath, renameAfterPath)).toBe(true);
		await fs.rm(deletePath);
		expect(notifyFileDeleted(session, deletePath)).toBe(true);
		expect(peekPendingFileMutations(session)).toHaveLength(3);

		const refreshed = await tool.execute("call-refresh", { query: newSymbol });
		expect(refreshed.isError).not.toBe(true);
		const refreshedDetails = refreshed.details as {
			scopeApplied?: boolean;
			pathScope?: string;
			entries?: Array<{ node: { name: string; filePath: string } }>;
		};
		expect(refreshedDetails.scopeApplied).toBe(true);
		expect(refreshedDetails.pathScope).toBeDefined();
		expect(
			refreshedDetails.entries?.some(e => e.node.name === newSymbol && e.node.filePath === "lib/update.ts"),
		).toBe(true);
		expect(peekPendingFileMutations(session)).toHaveLength(0);

		const oldResult = await tool.execute("call-old", { query: oldSymbol });
		const oldDetails = oldResult.details as { entries?: unknown[] };
		expect(oldDetails.entries).toHaveLength(0);

		const deletedResult = await tool.execute("call-deleted", { query: deletedSymbol });
		const deletedDetails = deletedResult.details as { entries?: unknown[] };
		expect(deletedDetails.entries).toHaveLength(0);

		const renamedResult = await tool.execute("call-renamed", { query: renameSymbol });
		const renamedDetails = renamedResult.details as { entries?: Array<{ node: { filePath: string } }> };
		expect(renamedDetails.entries?.some(e => e.node.filePath === "lib/rename-after.ts")).toBe(true);
	});
});
