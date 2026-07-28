import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { CodeGraphCacheIdentity, CodeGraphIndexLocation, CodeGraphLocationMetadata } from "../location";
import {
	clearAllCodeGraphIndexLocations,
	getCodeGraphIndexesRoot,
	listCodeGraphIndexSlots,
	pruneCodeGraphIndexes,
	resolveCodeGraphIndexLocation,
	writeCodeGraphLocationMetadata,
} from "../location";

const DAY_MS = 86_400_000;
const TEST_EXTRACTION_VERSION = "test.v1";

type SlotRecord = {
	key: string;
	indexDir: string;
	metadataPath: string;
	sourceRoot: string;
	ref: string;
};

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function lastUsedAtForDaysAgo(daysAgo: number): string {
	return new Date(Date.now() - daysAgo * DAY_MS).toISOString();
}

function computeIdentityKey(
	identity: Pick<CodeGraphCacheIdentity, "sourceRoot" | "worktreeRoot" | "commonDir" | "ref">,
): string {
	const hasher = new Bun.SHA256();
	for (const [index, field] of [
		2,
		identity.sourceRoot,
		identity.worktreeRoot,
		identity.commonDir,
		identity.ref,
	].entries()) {
		if (index > 0) hasher.update("\0");
		hasher.update(String(field ?? ""));
	}
	return hasher.digest("hex");
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

async function writeSlotMetadata(
	location: CodeGraphIndexLocation,
	{ daysAgo, payloadBytes = 256 }: { daysAgo: number; payloadBytes?: number },
): Promise<void> {
	const lastUsedAt = lastUsedAtForDaysAgo(daysAgo);
	await writeCodeGraphLocationMetadata(location, {
		extractionVersion: TEST_EXTRACTION_VERSION,
		indexSchemaVersion: 2,
		nativeContractVersion: null,
		lastSyncedAt: lastUsedAt,
	});
	const metadata: CodeGraphLocationMetadata = {
		schemaVersion: 2,
		identity: location.identity,
		extractionVersion: TEST_EXTRACTION_VERSION,
		indexSchemaVersion: 2,
		nativeContractVersion: null,
		lastSyncedAt: lastUsedAt,
		lastUsedAt,
	};
	await fs.writeFile(location.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
	await fs.writeFile(path.join(location.indexDir, "pad.bin"), Buffer.alloc(payloadBytes));
}

async function writeRepoSlot(
	repoRoot: string,
	refName: string,
	options: { daysAgo: number; payloadBytes?: number },
): Promise<SlotRecord> {
	git(repoRoot, ["checkout", "-q", "-B", refName]);
	const location = await resolveCodeGraphIndexLocation(repoRoot);
	await writeSlotMetadata(location, options);
	return {
		key: location.identity.key,
		indexDir: location.indexDir,
		metadataPath: location.metadataPath,
		sourceRoot: location.identity.sourceRoot,
		ref: location.identity.ref,
	};
}

async function writeOrphanSlot(
	repoRoot: string,
	{ daysAgo = 0, payloadBytes = 256 }: { daysAgo?: number; payloadBytes?: number } = {},
): Promise<SlotRecord> {
	const base = await resolveCodeGraphIndexLocation(repoRoot);
	const sourceRoot = path.join(tmpRoot, `missing-source-${randomUUID()}`);
	const identity: CodeGraphCacheIdentity = {
		...base.identity,
		sourceRoot,
		key: computeIdentityKey({
			sourceRoot,
			worktreeRoot: base.identity.worktreeRoot,
			commonDir: base.identity.commonDir,
			ref: base.identity.ref,
		}),
	};
	const metadata: CodeGraphLocationMetadata = {
		schemaVersion: 2,
		identity,
		extractionVersion: TEST_EXTRACTION_VERSION,
		indexSchemaVersion: 2,
		nativeContractVersion: null,
		lastSyncedAt: lastUsedAtForDaysAgo(daysAgo),
		lastUsedAt: lastUsedAtForDaysAgo(daysAgo),
	};
	const indexDir = path.join(getCodeGraphIndexesRoot(), identity.key);
	const metadataPath = path.join(indexDir, "metadata.json");
	await fs.mkdir(indexDir, { recursive: true });
	await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
	await fs.writeFile(path.join(indexDir, "pad.bin"), Buffer.alloc(payloadBytes));
	return {
		key: identity.key,
		indexDir,
		metadataPath,
		sourceRoot,
		ref: identity.ref,
	};
}

function requirePruneEntry(result: Awaited<ReturnType<typeof pruneCodeGraphIndexes>>, key: string) {
	const entry = result.entries.find(candidate => candidate.key === key);
	expect(entry).toBeDefined();
	return entry!;
}

let tmpRoot: string;
let isolatedConfigDir: string;
let isolatedConfigRoot: string;
let originalConfigDir: string | undefined;

beforeEach(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-codegraph-storage-policy-"));
	originalConfigDir = process.env.PI_CONFIG_DIR;
	isolatedConfigDir = `.omp-codegraph-storage-policy-${randomUUID()}`;
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

describe("CodeGraph storage policy contracts", () => {
	test("TTL pruning uses metadata.lastUsedAt and dryRun only reports wouldRemove", async () => {
		const repoRoot = await initGitRepo(path.join(tmpRoot, "ttl-repo"));
		const stale = await writeRepoSlot(repoRoot, "ttl-stale", { daysAgo: 60 });
		const fresh = await writeRepoSlot(repoRoot, "ttl-fresh", { daysAgo: 1 });

		const dryRun = await pruneCodeGraphIndexes({ ttlDays: 30, dryRun: true });
		const staleDryRun = requirePruneEntry(dryRun, stale.key);
		const freshDryRun = requirePruneEntry(dryRun, fresh.key);
		expect(staleDryRun.reason).toBe("lru_age");
		expect(staleDryRun.wouldRemove).toBe(true);
		expect(freshDryRun.removed).toBe(false);
		expect(await pathExists(stale.indexDir)).toBe(true);

		const applied = await pruneCodeGraphIndexes({ ttlDays: 30, dryRun: false });
		const staleApplied = requirePruneEntry(applied, stale.key);
		const freshApplied = requirePruneEntry(applied, fresh.key);
		expect(applied.removed).toBe(1);
		expect(staleApplied.reason).toBe("lru_age");
		expect(staleApplied.removed).toBe(true);
		expect(freshApplied.removed).toBe(false);
		expect(await pathExists(stale.indexDir)).toBe(false);
		expect(await pathExists(fresh.indexDir)).toBe(true);
	});

	test("deleteOrphans=false preserves orphan slots, deleteOrphans=true deletes them", async () => {
		const repoRoot = await initGitRepo(path.join(tmpRoot, "orphan-repo"));
		const orphan = await writeOrphanSlot(repoRoot);

		const kept = await pruneCodeGraphIndexes({ deleteOrphans: false, dryRun: false });
		expect(requirePruneEntry(kept, orphan.key).removed).toBe(false);
		expect((await listCodeGraphIndexSlots({ includeOrphans: true })).entries.map(entry => entry.key)).toContain(
			orphan.key,
		);

		const removed = await pruneCodeGraphIndexes({ deleteOrphans: true, dryRun: false });
		const orphanEntry = requirePruneEntry(removed, orphan.key);
		expect(orphanEntry.reason).toBe("identity_orphan");
		expect(orphanEntry.entry.orphan).toBe(true);
		expect(orphanEntry.removed).toBe(true);
		expect(await pathExists(orphan.indexDir)).toBe(false);
	});

	test("protectedKeys are never removed even when project index cap would otherwise evict them", async () => {
		const repoRoot = await initGitRepo(path.join(tmpRoot, "protected-repo"));
		const protectedOldest = await writeRepoSlot(repoRoot, "protected-old", { daysAgo: 40 });
		await writeRepoSlot(repoRoot, "protected-mid", { daysAgo: 10 });
		await writeRepoSlot(repoRoot, "protected-new", { daysAgo: 1 });

		const result = await pruneCodeGraphIndexes({
			maxProjectIndexes: 1,
			protectedKeys: [protectedOldest.key],
			dryRun: false,
		});

		const protectedEntry = requirePruneEntry(result, protectedOldest.key);
		expect(protectedEntry.removed).toBe(false);
		expect(result.entries.filter(entry => entry.removed).length).toBeGreaterThan(0);
		expect(await pathExists(protectedOldest.indexDir)).toBe(true);
	});

	test("per-project count and byte caps evict the least recently used slots within one sourceRoot", async () => {
		const repoRoot = await initGitRepo(path.join(tmpRoot, "project-cap-repo"));
		const oldest = await writeRepoSlot(repoRoot, "cap-oldest", { daysAgo: 30, payloadBytes: 1536 });
		const middle = await writeRepoSlot(repoRoot, "cap-middle", { daysAgo: 10, payloadBytes: 1536 });
		const newest = await writeRepoSlot(repoRoot, "cap-newest", { daysAgo: 1, payloadBytes: 1536 });

		const countResult = await pruneCodeGraphIndexes({ maxProjectIndexes: 2, dryRun: false });
		expect(requirePruneEntry(countResult, oldest.key).reason).toBe("project_index_limit");
		expect(requirePruneEntry(countResult, oldest.key).removed).toBe(true);
		expect(requirePruneEntry(countResult, middle.key).removed).toBe(false);
		expect(requirePruneEntry(countResult, newest.key).removed).toBe(false);

		await fs.rm(isolatedConfigRoot, { recursive: true, force: true });
		await fs.mkdir(isolatedConfigRoot, { recursive: true });

		const byteRepoRoot = await initGitRepo(path.join(tmpRoot, "project-bytes-repo"));
		const byteOldest = await writeRepoSlot(byteRepoRoot, "bytes-oldest", { daysAgo: 30, payloadBytes: 2048 });
		const byteMiddle = await writeRepoSlot(byteRepoRoot, "bytes-middle", { daysAgo: 10, payloadBytes: 2048 });
		const byteNewest = await writeRepoSlot(byteRepoRoot, "bytes-newest", { daysAgo: 1, payloadBytes: 2048 });
		const listed = await listCodeGraphIndexSlots({ cwd: byteRepoRoot });
		const totalBytes = listed.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
		const oldestBytes = listed.entries.find(entry => entry.key === byteOldest.key)?.sizeBytes;
		expect(oldestBytes).toBeDefined();

		const byteResult = await pruneCodeGraphIndexes({
			maxProjectBytes: totalBytes - oldestBytes!,
			dryRun: false,
		});
		expect(requirePruneEntry(byteResult, byteOldest.key).reason).toBe("project_bytes_limit");
		expect(requirePruneEntry(byteResult, byteOldest.key).removed).toBe(true);
		expect(requirePruneEntry(byteResult, byteMiddle.key).removed).toBe(false);
		expect(requirePruneEntry(byteResult, byteNewest.key).removed).toBe(false);
	});

	test("global byte cap evicts the oldest slots across projects by LRU", async () => {
		const repoA = await initGitRepo(path.join(tmpRoot, "global-a"));
		const repoB = await initGitRepo(path.join(tmpRoot, "global-b"));
		const aOld = await writeRepoSlot(repoA, "ga-old-4d", { daysAgo: 4, payloadBytes: 2048 });
		const aNew = await writeRepoSlot(repoA, "ga-new-1d", { daysAgo: 1, payloadBytes: 2048 });
		const bOldest = await writeRepoSlot(repoB, "gb-old-5d", { daysAgo: 5, payloadBytes: 2048 });
		const bMid = await writeRepoSlot(repoB, "gb-mid-2d", { daysAgo: 2, payloadBytes: 2048 });

		const listed = await listCodeGraphIndexSlots();
		const totalBytes = listed.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
		const bytesToDrop = [aOld.key, bOldest.key].map(
			key => listed.entries.find(entry => entry.key === key)?.sizeBytes ?? 0,
		);
		const result = await pruneCodeGraphIndexes({
			maxTotalBytes: totalBytes - bytesToDrop[0] - bytesToDrop[1],
			dryRun: false,
		});

		const removedKeys = result.entries.filter(entry => entry.removed).map(entry => entry.key);
		expect(removedKeys).toContain(aOld.key);
		expect(removedKeys).toContain(bOldest.key);
		expect(removedKeys).not.toContain(aNew.key);
		expect(removedKeys).not.toContain(bMid.key);
		for (const entry of result.entries.filter(entry => entry.removed)) {
			expect(entry.reason).toBe("total_bytes_limit");
		}
	});

	test("list excludes orphans by default, includes them on demand, and sorts by lastUsedAt descending", async () => {
		const repoRoot = await initGitRepo(path.join(tmpRoot, "list-repo"));
		const oldest = await writeRepoSlot(repoRoot, "list-oldest", { daysAgo: 20 });
		const middle = await writeRepoSlot(repoRoot, "list-middle", { daysAgo: 10 });
		const newest = await writeRepoSlot(repoRoot, "list-newest", { daysAgo: 1 });
		const orphan = await writeOrphanSlot(repoRoot, { daysAgo: 0 });

		const defaultList = await listCodeGraphIndexSlots();
		expect(defaultList.entries.map(entry => entry.key)).not.toContain(orphan.key);

		const withOrphans = await listCodeGraphIndexSlots({ includeOrphans: true });
		expect(withOrphans.entries.map(entry => entry.key)).toContain(orphan.key);

		const projectList = await listCodeGraphIndexSlots({ cwd: repoRoot });
		expect(projectList.entries.map(entry => entry.key)).toEqual([newest.key, middle.key, oldest.key]);
	});

	test("clearAll removes every ref for one sourceRoot and leaves another project untouched", async () => {
		const repoA = await initGitRepo(path.join(tmpRoot, "clear-a"));
		const repoB = await initGitRepo(path.join(tmpRoot, "clear-b"));
		const aOne = await writeRepoSlot(repoA, "clear-a-one", { daysAgo: 10 });
		const aTwo = await writeRepoSlot(repoA, "clear-a-two", { daysAgo: 1 });
		const bOne = await writeRepoSlot(repoB, "clear-b-one", { daysAgo: 5 });

		const dryRun = await clearAllCodeGraphIndexLocations({ dryRun: true }, repoA);
		expect(dryRun.entries.length).toBe(2);
		expect(dryRun.entries.every(entry => entry.removed === false)).toBe(true);
		expect(dryRun.entries.every(entry => entry.wouldRemove === true)).toBe(true);
		expect(await pathExists(aOne.indexDir)).toBe(true);
		expect(await pathExists(aTwo.indexDir)).toBe(true);

		const applied = await clearAllCodeGraphIndexLocations({ dryRun: false }, repoA);
		expect(applied.entries.length).toBe(2);
		expect(await pathExists(aOne.indexDir)).toBe(false);
		expect(await pathExists(aTwo.indexDir)).toBe(false);
		expect(await pathExists(bOne.indexDir)).toBe(true);
	});
});
