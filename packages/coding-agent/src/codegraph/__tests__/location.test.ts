import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	getCodeGraphIndexLocationStatus,
	resolveCodeGraphIndexLocation,
	writeCodeGraphLocationMetadata,
} from "../location";
import { getCodeGraphStorageRoot } from "../location-fs";

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
	git(root, ["init", "-q"]);
	await fs.writeFile(path.join(root, "src.ts"), "export const version = 1;\n", "utf8");
	git(root, ["add", "."]);
	git(root, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"]);
	return await fs.realpath(root);
}

describe("CodeGraph location contract", () => {
	let tmpRoot: string;
	let isolatedConfigDir: string;
	let isolatedConfigRoot: string;
	let originalConfigDir: string | undefined;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-codegraph-location-"));
		originalConfigDir = process.env.PI_CONFIG_DIR;
		isolatedConfigDir = `.omp-codegraph-location-${randomUUID()}`;
		isolatedConfigRoot = path.join(os.homedir(), isolatedConfigDir);
		process.env.PI_CONFIG_DIR = isolatedConfigDir;
	});

	afterEach(async () => {
		if (originalConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalConfigDir;
		}
		await fs.rm(tmpRoot, { recursive: true, force: true });
		await fs.rm(isolatedConfigRoot, { recursive: true, force: true });
	});

	test("resolve/status on a clean repo report missing index without creating any cache slot", async () => {
		const repoRoot = await initGitRepo(path.join(tmpRoot, "repo"));
		const location = await resolveCodeGraphIndexLocation(repoRoot);

		expect(location.available).toBe(true);
		expect(await pathExists(getCodeGraphStorageRoot())).toBe(false);
		expect(await pathExists(path.dirname(location.indexDir))).toBe(false);
		expect(await pathExists(location.indexDir)).toBe(false);

		const status = await getCodeGraphIndexLocationStatus(repoRoot);
		expect(status.exists).toBe(false);
		expect(status.verified).toBe(false);
		expect(status.reason).toBe("index_missing");
		expect(status.location.identity.key).toBe(location.identity.key);

		expect(await pathExists(getCodeGraphStorageRoot())).toBe(false);
		expect(await pathExists(path.dirname(location.indexDir))).toBe(false);
		expect(await pathExists(location.indexDir)).toBe(false);
	});

	test("different git worktrees in the same repo resolve to different cache keys and directories", async () => {
		const repoRoot = await initGitRepo(path.join(tmpRoot, "repo"));
		const mainLocation = await resolveCodeGraphIndexLocation(repoRoot);
		const worktreeRoot = path.join(tmpRoot, "feature-worktree");
		git(repoRoot, ["worktree", "add", "-q", "-b", "feature", worktreeRoot, "HEAD"]);

		const featureLocation = await resolveCodeGraphIndexLocation(worktreeRoot);
		expect(mainLocation.available).toBe(true);
		expect(featureLocation.available).toBe(true);
		expect(mainLocation.identity.commonDir).toBe(featureLocation.identity.commonDir);
		expect(mainLocation.identity.worktreeRoot).not.toBe(featureLocation.identity.worktreeRoot);
		expect(mainLocation.identity.ref).not.toBe(featureLocation.identity.ref);
		expect(mainLocation.identity.key).not.toBe(featureLocation.identity.key);
		expect(mainLocation.indexDir).not.toBe(featureLocation.indexDir);
	});

	test("detached HEAD gets a different cache key from the same worktree on a branch", async () => {
		const repoRoot = await initGitRepo(path.join(tmpRoot, "repo"));
		const branchLocation = await resolveCodeGraphIndexLocation(repoRoot);
		const headCommit = git(repoRoot, ["rev-parse", "HEAD"]);

		git(repoRoot, ["checkout", "--detach", "-q", headCommit]);
		const detachedLocation = await resolveCodeGraphIndexLocation(repoRoot);

		expect(branchLocation.available).toBe(true);
		expect(detachedLocation.available).toBe(true);
		expect(branchLocation.identity.worktreeRoot).toBe(detachedLocation.identity.worktreeRoot);
		expect(branchLocation.identity.commonDir).toBe(detachedLocation.identity.commonDir);
		expect(branchLocation.identity.ref).toMatch(/^refs\/heads\//);
		expect(detachedLocation.identity.ref).toBe("detached");
		expect(branchLocation.identity.key).not.toBe(detachedLocation.identity.key);
		expect(branchLocation.indexDir).not.toBe(detachedLocation.indexDir);
	});

	test("writeCodeGraphLocationMetadata validates a complete update before creating the slot", async () => {
		const repoRoot = await initGitRepo(path.join(tmpRoot, "repo"));
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		const lastSyncedAt = "2026-07-25T00:00:00.000Z";

		await expect(
			writeCodeGraphLocationMetadata(location, {
				extractionVersion: "omp.codegraph.v1",
			}),
		).rejects.toThrow(/missing required fields/i);
		expect(await pathExists(getCodeGraphStorageRoot())).toBe(false);
		expect(await pathExists(location.indexDir)).toBe(false);
		expect(await pathExists(location.metadataPath)).toBe(false);

		const metadata = await writeCodeGraphLocationMetadata(location, {
			extractionVersion: "omp.codegraph.v1",
			indexSchemaVersion: 1,
			nativeContractVersion: null,
			lastSyncedAt,
		});

		expect(await pathExists(getCodeGraphStorageRoot())).toBe(true);
		expect(await pathExists(location.indexDir)).toBe(true);
		expect(await pathExists(location.metadataPath)).toBe(true);
		expect(metadata.identity).toEqual(location.identity);
		expect(metadata.extractionVersion).toBe("omp.codegraph.v1");
		expect(metadata.indexSchemaVersion).toBe(1);
		expect(metadata.nativeContractVersion).toBeNull();
		expect(metadata.lastSyncedAt).toBe(lastSyncedAt);
		expect(typeof metadata.lastUsedAt).toBe("string");
		expect(Number.isNaN(Date.parse(String(metadata.lastUsedAt)))).toBe(false);

		const status = await getCodeGraphIndexLocationStatus(location);
		expect(status.exists).toBe(true);
		expect(status.verified).toBe(true);
		expect(status.metadata?.identity).toEqual(location.identity);
		expect(status.metadata?.lastSyncedAt).toBe(lastSyncedAt);
	});
});
