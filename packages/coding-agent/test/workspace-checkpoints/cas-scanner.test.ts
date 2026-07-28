import { afterEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import * as git from "../../src/utils/git";
import {
	OBJECT_ID_PREFIX,
	objectPathFor,
	openWorkspaceContentStoreAt,
	parseObjectId,
	type WorkspaceContentStore,
	WorkspaceContentStoreError,
} from "../../src/workspace-checkpoints/content-store";
import {
	loadWorkspaceManifest,
	saveWorkspaceManifest,
	serializeWorkspaceManifest,
} from "../../src/workspace-checkpoints/manifest";
import {
	compareWorkspaceToManifest,
	entryFingerprint,
	manifestFromScan,
	resolveWorkspacePath,
	scanWorkspace,
	toWorkspaceRelativePath,
	WorkspaceScanError,
} from "../../src/workspace-checkpoints/scanner";
import type { WorkspaceManifestEntry } from "../../src/workspace-checkpoints/types";

interface Harness {
	tempRoot: string;
	workspaceRoot: string;
	storeRoot: string;
	externalRoot: string;
	store: WorkspaceContentStore;
}

const tempRoots: string[] = [];

async function openHarness(label: string): Promise<Harness> {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `omp-cas-scanner-${label}-`));
	tempRoots.push(tempRoot);
	const workspaceRoot = path.join(tempRoot, "workspace");
	const storeRoot = path.join(tempRoot, "store");
	const externalRoot = path.join(tempRoot, "external");
	await Promise.all([
		fs.mkdir(workspaceRoot, { recursive: true }),
		fs.mkdir(storeRoot, { recursive: true }),
		fs.mkdir(externalRoot, { recursive: true }),
	]);
	const store = await openWorkspaceContentStoreAt(storeRoot);
	return { tempRoot, workspaceRoot, storeRoot, externalRoot, store };
}

afterEach(async () => {
	while (tempRoots.length > 0) {
		const target = tempRoots.pop();
		if (!target) continue;
		await removeWithRetries(target).catch(() => undefined);
	}
});

async function writeText(root: string, rel: string, content: string): Promise<void> {
	const absolute = path.join(root, rel);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	await fs.writeFile(absolute, content, "utf8");
}

async function writeBytes(root: string, rel: string, content: Uint8Array): Promise<void> {
	const absolute = path.join(root, rel);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	await fs.writeFile(absolute, content);
}

async function writeSymlink(root: string, rel: string, target: string): Promise<void> {
	const absolute = path.join(root, rel);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	await fs.symlink(target, absolute);
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		env: {
			...process.env,
			GIT_ASKPASS: "true",
			GIT_CONFIG_GLOBAL: path.join(cwd, ".git-test-config"),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
		},
		stderr: "pipe",
		stdout: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode ?? 0}`);
	}
}

async function initGitRepository(root: string): Promise<void> {
	await runGit(root, ["init", "-q"]);
}

async function createIgnoredGitFixture(root: string): Promise<{
	trackedPath: string;
	trackedText: string;
	untrackedIgnoredPath: string;
	untrackedIgnoredText: string;
}> {
	const trackedPath = "ignored/tracked.log";
	const trackedText = "tracked despite ignore\n";
	const untrackedIgnoredPath = "ignored/untracked.log";
	const untrackedIgnoredText = "ordinary ignored file\n";
	await initGitRepository(root);
	await writeText(root, trackedPath, trackedText);
	await runGit(root, ["add", "-f", "--", trackedPath]);
	await writeText(root, ".gitignore", "ignored/\n");
	await runGit(root, ["add", "--", ".gitignore"]);
	await writeText(root, untrackedIgnoredPath, untrackedIgnoredText);
	return { trackedPath, trackedText, untrackedIgnoredPath, untrackedIgnoredText };
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.lstat(target);
		return true;
	} catch {
		return false;
	}
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function* chunkBytes(data: Uint8Array, chunkSizes: readonly number[]): AsyncIterable<Uint8Array> {
	let offset = 0;
	let index = 0;
	while (offset < data.byteLength) {
		const size = chunkSizes[index % chunkSizes.length] ?? data.byteLength;
		const end = Math.min(offset + Math.max(1, size), data.byteLength);
		yield data.subarray(offset, end);
		offset = end;
		index += 1;
	}
}

async function listRegularFiles(root: string): Promise<string[]> {
	try {
		const stat = await fs.lstat(root);
		if (!stat.isDirectory()) return [root];
	} catch {
		return [];
	}
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		const children = await fs.readdir(dir, { withFileTypes: true });
		for (const child of children) {
			const absolute = path.join(dir, child.name);
			if (child.isDirectory()) {
				await walk(absolute);
				continue;
			}
			if (child.isFile()) out.push(absolute);
		}
	}
	await walk(root);
	return out.sort();
}

function entryAt(entries: readonly WorkspaceManifestEntry[], relPath: string): WorkspaceManifestEntry {
	const entry = entries.find(candidate => candidate.path === relPath);
	if (!entry) throw new Error(`Missing manifest entry for ${relPath}`);
	return entry;
}

function exclusionReason(exclusions: readonly { path: string; reason: string }[], relPath: string): string {
	const exclusion = exclusions.find(candidate => candidate.path === relPath);
	if (!exclusion) throw new Error(`Missing exclusion for ${relPath}`);
	return exclusion.reason;
}

async function expectRejected<T extends Error = Error>(promise: Promise<unknown>): Promise<T> {
	try {
		await promise;
	} catch (error) {
		return error as T;
	}
	throw new Error("Expected promise to reject");
}

async function expectStored(
	promise: Promise<{ id: string; bytes: number } | null>,
): Promise<{ id: string; bytes: number }> {
	const result = await promise;
	if (!result) throw new Error("putFile returned null");
	return result;
}

function expectThrown<T extends Error = Error>(run: () => unknown): T {
	try {
		run();
	} catch (error) {
		return error as T;
	}
	throw new Error("Expected function to throw");
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function sha256ObjectId(content: string | Uint8Array): string {
	return `${OBJECT_ID_PREFIX}${createHash("sha256").update(content).digest("hex")}`;
}

interface CasObjectInventory {
	count: number;
	totalBytes: number;
	objectPaths: string[];
}

async function casObjectInventory(objectsDir: string): Promise<CasObjectInventory> {
	const absolutePaths = await listRegularFiles(objectsDir);
	const stats = await Promise.all(absolutePaths.map(absolutePath => fs.stat(absolutePath)));
	return {
		count: absolutePaths.length,
		totalBytes: stats.reduce((total, stat) => total + stat.size, 0),
		objectPaths: absolutePaths.map(absolutePath => path.relative(objectsDir, absolutePath)).sort(),
	};
}

describe("workspace checkpoint CAS + scanner contracts", () => {
	it("round-trips large blobs via bytes, streams, and files while deduping concurrent identical writes", async () => {
		const harness = await openHarness("cas-roundtrip");
		const largePayload = randomBytes(1024 * 1024 + 333);
		const sourceFile = path.join(harness.workspaceRoot, "fixtures", "large.bin");
		await writeBytes(harness.workspaceRoot, "fixtures/large.bin", largePayload);

		const putBytesResult = await harness.store.putBytes(largePayload);
		expect(putBytesResult.bytes).toBe(largePayload.byteLength);
		expect(putBytesResult.id.startsWith(OBJECT_ID_PREFIX)).toBeTrue();
		expect(parseObjectId(putBytesResult.id).length).toBe(64);
		expect(await harness.store.has(putBytesResult.id)).toBeTrue();

		const putStreamResult = await harness.store.putStream(chunkBytes(largePayload, [1, 7, 257, 64 * 1024 + 13]));
		expect(putStreamResult).toEqual(putBytesResult);

		const putFileResult = await harness.store.putFile(sourceFile);
		expect(putFileResult).not.toBeNull();
		expect(putFileResult).toEqual(putBytesResult);

		const bytesRoundTrip = await harness.store.readBytes(putBytesResult.id);
		expect(bytesRoundTrip).not.toBeNull();
		expect(Buffer.from(bytesRoundTrip ?? []).equals(largePayload)).toBeTrue();

		const streamRoundTrip = await harness.store.readStream(putBytesResult.id);
		expect(streamRoundTrip).not.toBeNull();
		expect(
			Buffer.from(await streamToBytes(streamRoundTrip as ReadableStream<Uint8Array>)).equals(largePayload),
		).toBeTrue();

		const concurrentResults = await Promise.all([
			harness.store.putBytes(largePayload),
			harness.store.putBytes(largePayload),
			harness.store.putBytes(largePayload),
			harness.store.putStream(chunkBytes(largePayload, [3, 19, 4096, 71_111])),
			harness.store.putStream(chunkBytes(largePayload, [64 * 1024 - 1, 11, 5, 32_777])),
			expectStored(harness.store.putFile(sourceFile)),
			expectStored(harness.store.putFile(sourceFile)),
		]);
		expect(new Set(concurrentResults.map(result => result.id))).toEqual(new Set([putBytesResult.id]));
		expect(new Set(concurrentResults.map(result => result.bytes))).toEqual(new Set([largePayload.byteLength]));

		const canonicalObjectPath = objectPathFor(harness.store.storeDir, putBytesResult.id);
		expect(await pathExists(canonicalObjectPath)).toBeTrue();
		expect(Buffer.from(await fs.readFile(canonicalObjectPath)).equals(largePayload)).toBeTrue();
		expect(await listRegularFiles(path.join(harness.storeRoot, "checkpoints", "v1", "objects"))).toEqual([
			canonicalObjectPath,
		]);
		expect(await pathExists(path.join(harness.workspaceRoot, "checkpoints"))).toBeFalse();
	});

	it("hashes regular files without materializing their contents in the object store", async () => {
		const harness = await openHarness("hash-only-scan");
		const ordinaryContent = "ordinary file content\n";
		const largeContent = new Uint8Array(1024 * 1024 + 333).fill(0xa5);
		const files = [
			{ path: "ordinary.txt", content: ordinaryContent },
			{ path: "large.bin", content: largeContent },
		] as const;
		await writeText(harness.workspaceRoot, "ordinary.txt", ordinaryContent);
		await writeBytes(harness.workspaceRoot, "large.bin", largeContent);
		await harness.store.putText("pre-existing checkpoint object\n");

		const before = await casObjectInventory(harness.store.objectsDir);
		const hashOnlyScan = await scanWorkspace({
			rootPath: harness.workspaceRoot,
			contentStore: harness.store,
			persistFileContents: false,
		});
		const after = await casObjectInventory(harness.store.objectsDir);
		const persistedStore = await openWorkspaceContentStoreAt(path.join(harness.tempRoot, "persisted-store"));
		const persistedScan = await scanWorkspace({
			rootPath: harness.workspaceRoot,
			contentStore: persistedStore,
		});

		expect(hashOnlyScan.completeness).toBe("complete");
		expect(hashOnlyScan.fileCount).toBe(persistedScan.fileCount);
		expect(hashOnlyScan.totalBytes).toBe(persistedScan.totalBytes);
		for (const file of files) {
			const expectedObjectId = sha256ObjectId(file.content);
			const expectedBytes = typeof file.content === "string" ? byteLength(file.content) : file.content.byteLength;
			const hashOnlyEntry = entryAt(hashOnlyScan.entries, file.path);
			const persistedEntry = entryAt(persistedScan.entries, file.path);
			expect(hashOnlyEntry).toMatchObject({
				kind: "file",
				objectId: expectedObjectId,
				size: expectedBytes,
			});
			expect(persistedEntry.objectId).toBe(hashOnlyEntry.objectId);
			expect(persistedEntry.size).toBe(hashOnlyEntry.size);
		}
		expect(after.count).toBe(before.count);
		expect(after.totalBytes).toBe(before.totalBytes);
		expect(after.objectPaths).toEqual(before.objectPaths);
	});

	it("sweeps unmarked objects and crashed obj staging while retaining marked objects and unknown temp files", async () => {
		const harness = await openHarness("cas-sweep");
		const retainedPayload = "reachable payload\n";
		const orphanPayload = "unreachable payload\n";
		const stagingPayload = "crashed staging bytes\n";
		const retained = await harness.store.putText(retainedPayload);
		const orphan = await harness.store.putText(orphanPayload);
		const tempDir = path.join(harness.storeRoot, "checkpoints", "v1", ".tmp");
		const crashedStagingPath = path.join(tempDir, "obj-crashed-put");
		const unknownTempPath = path.join(tempDir, "keep-me");
		await fs.mkdir(tempDir, { recursive: true });
		await fs.writeFile(crashedStagingPath, stagingPayload, "utf8");
		await fs.writeFile(unknownTempPath, "unknown temp file\n", "utf8");

		const result = await harness.store.sweepUnreachable(new Set([retained.id]));

		expect(result).toEqual({
			deletedObjectIds: [orphan.id],
			deletedBytes: byteLength(orphanPayload) + byteLength(stagingPayload),
			deletedStagingFiles: 1,
			keptObjectCount: 1,
		});
		expect(await harness.store.readText(retained.id)).toBe(retainedPayload);
		expect(await harness.store.has(orphan.id)).toBeFalse();
		expect(await pathExists(objectPathFor(harness.store.storeDir, retained.id))).toBeTrue();
		expect(await pathExists(objectPathFor(harness.store.storeDir, orphan.id))).toBeFalse();
		expect(await pathExists(crashedStagingPath)).toBeFalse();
		expect(await pathExists(unknownTempPath)).toBeTrue();
	});

	it("distinguishes malformed ids, missing objects, and non-regular input files", async () => {
		const harness = await openHarness("cas-invalid");
		const missingId = `${OBJECT_ID_PREFIX}${"0".repeat(64)}`;
		const malformedId = `${OBJECT_ID_PREFIX}not-hex`;

		expect(await harness.store.readBytes(missingId)).toBeNull();
		expect(await harness.store.readStream(missingId)).toBeNull();
		expect(await harness.store.has(missingId)).toBeFalse();

		const bytesError = await expectRejected<WorkspaceContentStoreError>(harness.store.readBytes(malformedId));
		expect(bytesError).toBeInstanceOf(WorkspaceContentStoreError);
		expect(bytesError.code).toBe("invalid_object_id");

		const streamError = await expectRejected<WorkspaceContentStoreError>(harness.store.readStream(malformedId));
		expect(streamError).toBeInstanceOf(WorkspaceContentStoreError);
		expect(streamError.code).toBe("invalid_object_id");

		expect(await harness.store.putFile(path.join(harness.workspaceRoot, "missing.bin"))).toBeNull();
		await fs.mkdir(path.join(harness.workspaceRoot, "nested"), { recursive: true });
		expect(await harness.store.putFile(path.join(harness.workspaceRoot, "nested"))).toBeNull();
	});

	it("captures user files under a workspace checkpoints directory without creating store artifacts in place", async () => {
		const harness = await openHarness("user-checkpoints-dir");
		const notesText = "user checkpoint notes\n";
		await writeText(harness.workspaceRoot, "checkpoints/notes.txt", notesText);

		const scan = await scanWorkspace({
			rootPath: harness.workspaceRoot,
			contentStore: harness.store,
		});
		expect(scan.completeness).toBe("complete");
		expect(scan.exclusions).toEqual([]);

		const checkpointsDir = entryAt(scan.entries, "checkpoints");
		expect(checkpointsDir.kind).toBe("directory");
		const notesEntry = entryAt(scan.entries, "checkpoints/notes.txt");
		expect(notesEntry.kind).toBe("file");
		expect(notesEntry.objectId?.startsWith(OBJECT_ID_PREFIX)).toBeTrue();

		const notesObjectPath = objectPathFor(harness.store.storeDir, notesEntry.objectId!);
		expect(notesObjectPath.startsWith(path.resolve(harness.storeRoot))).toBeTrue();
		expect(notesObjectPath.startsWith(path.resolve(harness.workspaceRoot))).toBeFalse();

		const manifest = manifestFromScan(scan);
		const persisted = await saveWorkspaceManifest(harness.store, manifest);
		const loaded = await loadWorkspaceManifest(harness.store, persisted.manifestObjectId);
		expect(loaded).not.toBeNull();
		const loadedNotes = entryAt((loaded as NonNullable<typeof loaded>).entries, "checkpoints/notes.txt");
		expect(loadedNotes.kind).toBe("file");
		expect(loadedNotes.objectId).toBe(notesEntry.objectId);

		const restoredBytes = await harness.store.readBytes(loadedNotes.objectId!);
		expect(Buffer.from(restoredBytes ?? []).toString("utf8")).toBe(notesText);
		expect(await pathExists(path.join(harness.workspaceRoot, "checkpoints", "v1"))).toBeFalse();
		expect(await pathExists(path.join(harness.workspaceRoot, "checkpoints", "checkpoints", "v1"))).toBeFalse();
	});

	it("captures a symlink literally named checkpoints as user content rather than administrative metadata", async () => {
		const harness = await openHarness("user-checkpoints-symlink");
		await writeText(harness.workspaceRoot, "target.txt", "target body\n");
		await writeSymlink(harness.workspaceRoot, "checkpoints", "target.txt");

		const scan = await scanWorkspace({
			rootPath: harness.workspaceRoot,
			contentStore: harness.store,
		});
		expect(scan.completeness).toBe("complete");
		expect(scan.exclusions).toEqual([]);

		const linkEntry = entryAt(scan.entries, "checkpoints");
		expect(linkEntry.kind).toBe("symlink");
		expect(linkEntry.linkTarget).toBe("target.txt");
		expect(scan.entries.some(entry => entry.path === "target.txt" && entry.kind === "file")).toBeTrue();

		const manifest = manifestFromScan(scan);
		const persisted = await saveWorkspaceManifest(harness.store, manifest);
		const loaded = await loadWorkspaceManifest(harness.store, persisted.manifestObjectId);
		expect(loaded).not.toBeNull();
		const loadedLink = entryAt((loaded as NonNullable<typeof loaded>).entries, "checkpoints");
		expect(loadedLink.kind).toBe("symlink");
		expect(loadedLink.linkTarget).toBe("target.txt");
		expect((await fs.lstat(path.join(harness.workspaceRoot, "checkpoints"))).isSymbolicLink()).toBeTrue();
		expect(await pathExists(path.join(harness.workspaceRoot, "checkpoints", "v1"))).toBeFalse();
	});

	it("captures ignored and untracked files, empty directories, executables, and symlinks without following external targets", async () => {
		const harness = await openHarness("scan-tree");
		const gitignoreText = "ignored.log\n";
		const ignoredText = "ignored but preserved\n";
		const notesText = "untracked note\n";
		const scriptText = "#!/bin/sh\necho ready\n";
		const nestedText = "nested repository worktree file\n";
		await writeText(harness.workspaceRoot, ".gitignore", gitignoreText);
		await writeText(harness.workspaceRoot, "ignored.log", ignoredText);
		await writeText(harness.workspaceRoot, "notes.txt", notesText);
		await writeText(harness.workspaceRoot, "bin/tool.sh", scriptText);
		await fs.chmod(path.join(harness.workspaceRoot, "bin", "tool.sh"), 0o755);
		await fs.mkdir(path.join(harness.workspaceRoot, "empty"), { recursive: true });
		await fs.mkdir(path.join(harness.workspaceRoot, ".git"), { recursive: true });
		await writeText(harness.workspaceRoot, ".git/config", "[core]\nrepositoryformatversion = 0\n");
		await writeText(harness.workspaceRoot, "nested/.git", "gitdir: ../.git/modules/nested\n");
		await writeText(harness.workspaceRoot, "nested/src.txt", nestedText);

		const outsideTarget = path.join(harness.externalRoot, "outside-target.txt");
		await fs.writeFile(outsideTarget, "outside target content\n", "utf8");
		await fs.chmod(outsideTarget, 0o000);
		try {
			await writeSymlink(harness.workspaceRoot, "links/outside", outsideTarget);

			const scan = await scanWorkspace({
				rootPath: harness.workspaceRoot,
				contentStore: harness.store,
			});

			expect(scan.completeness).toBe("complete");
			expect(scan.rootPath).toBe(path.resolve(harness.workspaceRoot));
			expect(scan.fileCount).toBe(5);
			expect(scan.totalBytes).toBe(
				byteLength(gitignoreText) +
					byteLength(ignoredText) +
					byteLength(notesText) +
					byteLength(scriptText) +
					byteLength(nestedText),
			);
			expect(scan.entries.map(entry => entry.path)).toEqual([
				"",
				"bin",
				"empty",
				"links",
				"nested",
				".gitignore",
				"bin/tool.sh",
				"ignored.log",
				"nested/src.txt",
				"notes.txt",
				"links/outside",
			]);
			expect(scan.exclusions.map(exclusion => exclusion.path).sort()).toEqual([".git", "nested/.git"]);
			expect(exclusionReason(scan.exclusions, ".git")).toContain("git administrative");
			expect(exclusionReason(scan.exclusions, "nested/.git")).toContain("git administrative");

			const scriptEntry = entryAt(scan.entries, "bin/tool.sh");
			expect(scriptEntry.kind).toBe("file");
			expect(scriptEntry.mode & 0o111).not.toBe(0);
			expect(scriptEntry.objectId?.startsWith(OBJECT_ID_PREFIX)).toBeTrue();

			const symlinkEntry = entryAt(scan.entries, "links/outside");
			expect(symlinkEntry.kind).toBe("symlink");
			expect(symlinkEntry.linkTarget).toBe(outsideTarget);
			expect(scan.exclusions.some(exclusion => exclusion.path === "links/outside")).toBeFalse();
			expect(await pathExists(path.join(harness.workspaceRoot, "checkpoints"))).toBeFalse();
		} finally {
			await fs.chmod(outsideTarget, 0o644).catch(() => undefined);
		}
	});

	it("keeps manifest serialization stable across save/load and reports deterministic add-change-delete diffs", async () => {
		const harness = await openHarness("manifest-diff");
		await writeText(harness.workspaceRoot, "keep.txt", "before\n");
		await writeText(harness.workspaceRoot, "gone.txt", "remove me\n");

		const initialScan = await scanWorkspace({
			rootPath: harness.workspaceRoot,
			contentStore: harness.store,
		});
		const manifest = manifestFromScan(initialScan);
		const firstSave = await saveWorkspaceManifest(harness.store, manifest);
		const secondSave = await saveWorkspaceManifest(harness.store, manifest);
		expect(secondSave.manifestObjectId).toBe(firstSave.manifestObjectId);
		expect(Buffer.from(firstSave.bytes).toString("utf8")).toBe(serializeWorkspaceManifest(manifest));

		const loaded = await loadWorkspaceManifest(harness.store, firstSave.manifestObjectId);
		expect(loaded).not.toBeNull();
		expect(serializeWorkspaceManifest(loaded as NonNullable<typeof loaded>)).toBe(
			serializeWorkspaceManifest(manifest),
		);
		expect(await loadWorkspaceManifest(harness.store, `${OBJECT_ID_PREFIX}${"f".repeat(64)}`)).toBeNull();
		const beforeCompare = await casObjectInventory(harness.store.objectsDir);

		await writeText(harness.workspaceRoot, "keep.txt", "after\n");
		await fs.rm(path.join(harness.workspaceRoot, "gone.txt"));
		await writeText(harness.workspaceRoot, "added.txt", "new file\n");

		const diff = await compareWorkspaceToManifest({
			rootPath: harness.workspaceRoot,
			contentStore: harness.store,
			previousManifest: loaded as NonNullable<typeof loaded>,
		});
		const afterCompare = await casObjectInventory(harness.store.objectsDir);
		expect(afterCompare.count).toBe(beforeCompare.count);
		expect(afterCompare.totalBytes).toBe(beforeCompare.totalBytes);
		expect(afterCompare.objectPaths).toEqual(beforeCompare.objectPaths);
		expect(diff.completeness).toBe("complete");
		expect(diff.added.map(entry => entry.path)).toEqual(["added.txt"]);
		expect(diff.removed.map(entry => entry.path)).toEqual(["gone.txt"]);
		expect(diff.changed.map(entry => entry.path).filter(candidate => candidate !== "")).toEqual(["keep.txt"]);
		expect(diff.unchanged.map(entry => entry.path).filter(candidate => candidate !== "")).toEqual([]);
		expect(
			diff.changed.some(entry => entry.path === "") || diff.unchanged.some(entry => entry.path === ""),
		).toBeTrue();
		const keepChange = diff.changed.find(entry => entry.path === "keep.txt");
		expect(keepChange).toBeDefined();
		expect(entryFingerprint(keepChange!.previous)).not.toBe(entryFingerprint(keepChange!.current));

		const currentManifest = manifestFromScan(diff.current);
		expect(serializeWorkspaceManifest(currentManifest)).toBe(
			serializeWorkspaceManifest(manifestFromScan(diff.current)),
		);
	});

	it("marks unreadable files partial and rejects paths that escape the workspace root", async () => {
		const harness = await openHarness("scan-partial");
		await writeText(harness.workspaceRoot, "ok.txt", "still readable\n");
		await writeText(harness.workspaceRoot, "locked.txt", "secret\n");
		const lockedPath = path.join(harness.workspaceRoot, "locked.txt");
		await fs.chmod(lockedPath, 0o000);
		try {
			const scan = await scanWorkspace({
				rootPath: harness.workspaceRoot,
				contentStore: harness.store,
			});
			expect(scan.completeness).toBe("partial");
			expect(scan.entries.some(entry => entry.path === "ok.txt")).toBeTrue();
			expect(scan.entries.some(entry => entry.path === "locked.txt")).toBeFalse();
			expect(exclusionReason(scan.exclusions, "locked.txt")).toContain("put failed:");
			expect(exclusionReason(scan.exclusions, "locked.txt")).toMatch(/EACCES|EPERM|permission/i);
		} finally {
			await fs.chmod(lockedPath, 0o644).catch(() => undefined);
		}

		const outsidePath = path.join(harness.tempRoot, "outside.txt");
		await fs.writeFile(outsidePath, "outside\n", "utf8");

		const resolveError = expectThrown<WorkspaceScanError>(() =>
			resolveWorkspacePath(harness.workspaceRoot, "../outside.txt"),
		);
		expect(resolveError).toBeInstanceOf(WorkspaceScanError);
		expect(resolveError.code).toBe("invalid_root");

		const relativeError = expectThrown<WorkspaceScanError>(() =>
			toWorkspaceRelativePath(harness.workspaceRoot, outsidePath),
		);
		expect(relativeError).toBeInstanceOf(WorkspaceScanError);
		expect(relativeError.code).toBe("invalid_root");
	});
	it("captures ordinary .gitignore-ignored files while excluding node_modules and target generated dependency/build directories", async () => {
		const harness = await openHarness("generated-dirs");
		const ignoredText = "in .gitignore but still user content\n";
		await writeText(harness.workspaceRoot, ".gitignore", "debug.log\n");
		await writeText(harness.workspaceRoot, "debug.log", ignoredText);
		await writeText(
			harness.workspaceRoot,
			"node_modules/lodash/dist/lodash.js",
			"// lodash minified — 100 kB of reproducible dependency\n",
		);
		await writeText(
			harness.workspaceRoot,
			"target/debug/deps/app-abc123.def",
			"// rustc output — gigabytes of reproducible build artifact\n",
		);

		const scan = await scanWorkspace({
			rootPath: harness.workspaceRoot,
			contentStore: harness.store,
		});

		expect(scan.completeness).toBe("complete");

		const ignoredEntry = entryAt(scan.entries, "debug.log");
		expect(ignoredEntry.kind).toBe("file");
		expect(ignoredEntry.objectId).toBeDefined();
		expect(scan.exclusions.some(exclusion => exclusion.path === "debug.log")).toBeFalse();

		const allPaths = scan.entries.map(entry => entry.path);
		expect(
			allPaths.some(entryPath => entryPath === "node_modules" || entryPath.startsWith("node_modules/")),
		).toBeFalse();
		expect(allPaths.some(entryPath => entryPath === "target" || entryPath.startsWith("target/"))).toBeFalse();

		const nodeModulesExclusion = scan.exclusions.find(exclusion => exclusion.path === "node_modules");
		expect(nodeModulesExclusion).toBeDefined();
		expect(nodeModulesExclusion!.reason).toBe("generated dependency/build directory");

		const targetExclusion = scan.exclusions.find(exclusion => exclusion.path === "target");
		expect(targetExclusion).toBeDefined();
		expect(targetExclusion!.reason).toBe("generated dependency/build directory");
	});

	it.skipIf(!git.isGitAvailable())(
		"captures index-tracked ignored files on the first Git scan without capturing ordinary ignored files",
		async () => {
			const harness = await openHarness("git-initial-ignored");
			const fixture = await createIgnoredGitFixture(harness.workspaceRoot);

			const scan = await scanWorkspace({
				rootPath: harness.workspaceRoot,
				contentStore: harness.store,
			});

			expect(scan.completeness).toBe("complete");
			expect(scan.entries.map(entry => entry.path)).toEqual(["", "ignored", ".gitignore", fixture.trackedPath]);
			expect(scan.trackedIgnoredPaths).toEqual([fixture.trackedPath]);
			expect(scan.entries.some(entry => entry.path === fixture.untrackedIgnoredPath)).toBeFalse();

			const trackedEntry = entryAt(scan.entries, fixture.trackedPath);
			expect(trackedEntry.kind).toBe("file");
			const objectId = trackedEntry.objectId;
			if (!objectId) throw new Error(`Tracked entry ${fixture.trackedPath} has no content object`);
			const storedBytes = await harness.store.readBytes(objectId);
			if (!storedBytes) throw new Error(`Tracked entry ${fixture.trackedPath} content object is missing`);
			expect(Buffer.from(storedBytes).toString("utf8")).toBe(fixture.trackedText);
		},
	);

	it.skipIf(!git.isGitAvailable())(
		"merges normalized Git includes and tombstones through a persisted manifest comparison",
		async () => {
			const harness = await openHarness("git-include-tombstones");
			const fixture = await createIgnoredGitFixture(harness.workspaceRoot);
			const tombstonePath = "missing/tombstone.log";
			const expectedTrackedIgnoredPaths = [fixture.trackedPath, fixture.untrackedIgnoredPath, tombstonePath].sort();

			const scan = await scanWorkspace({
				rootPath: harness.workspaceRoot,
				contentStore: harness.store,
				includePaths: [
					fixture.untrackedIgnoredPath,
					"ignored/./untracked.log",
					path.join(harness.workspaceRoot, "ignored", "untracked.log"),
					tombstonePath,
					"missing/retained/../tombstone.log",
				],
			});

			expect(scan.completeness).toBe("complete");
			expect(scan.trackedIgnoredPaths).toEqual(expectedTrackedIgnoredPaths);
			expect(entryAt(scan.entries, fixture.untrackedIgnoredPath).kind).toBe("file");
			expect(scan.entries.some(entry => entry.path === tombstonePath)).toBeFalse();

			const manifest = manifestFromScan(scan);
			expect(manifest.trackedIgnoredPaths).toEqual(expectedTrackedIgnoredPaths);
			const persisted = await saveWorkspaceManifest(harness.store, manifest);
			expect(persisted.manifest.trackedIgnoredPaths).toEqual(expectedTrackedIgnoredPaths);
			const loaded = await loadWorkspaceManifest(harness.store, persisted.manifestObjectId);
			if (!loaded) throw new Error("Saved manifest was not loadable");
			expect(loaded.trackedIgnoredPaths).toEqual(expectedTrackedIgnoredPaths);
			expect(serializeWorkspaceManifest(loaded)).toBe(serializeWorkspaceManifest(manifest));

			const diff = await compareWorkspaceToManifest({
				rootPath: harness.workspaceRoot,
				contentStore: harness.store,
				previousManifest: loaded,
			});
			expect(diff.current.trackedIgnoredPaths).toEqual(expectedTrackedIgnoredPaths);
			expect(diff.current.entries.some(entry => entry.path === fixture.untrackedIgnoredPath)).toBeTrue();
			expect(diff.removed.some(entry => entry.path === fixture.untrackedIgnoredPath)).toBeFalse();
		},
	);

	it.skipIf(!git.isGitAvailable())(
		"prefixes tracked ignored paths from a nested Git repository relative to the source root",
		async () => {
			const harness = await openHarness("nested-git-prefix");
			await initGitRepository(harness.workspaceRoot);
			await writeText(harness.workspaceRoot, "root.txt", "root\n");
			await runGit(harness.workspaceRoot, ["add", "--", "root.txt"]);

			const nestedRoot = path.join(harness.workspaceRoot, "tools", "nested");
			await fs.mkdir(nestedRoot, { recursive: true });
			const nestedFixture = await createIgnoredGitFixture(nestedRoot);
			const nestedPrefix = "tools/nested";
			const trackedPath = `${nestedPrefix}/${nestedFixture.trackedPath}`;
			const untrackedIgnoredPath = `${nestedPrefix}/${nestedFixture.untrackedIgnoredPath}`;

			const scan = await scanWorkspace({
				rootPath: harness.workspaceRoot,
				contentStore: harness.store,
			});

			expect(scan.completeness).toBe("complete");
			expect(scan.trackedIgnoredPaths).toEqual([trackedPath]);
			expect(entryAt(scan.entries, trackedPath).kind).toBe("file");
			expect(scan.entries.some(entry => entry.path === untrackedIgnoredPath)).toBeFalse();
		},
	);
	it.skipIf(!git.isGitAvailable())(
		"captures tracked and nonignored untracked paths while excluding ordinary ignored Git paths",
		async () => {
			const harness = await openHarness("git-tracked-untracked");
			const trackedPath = "tracked.txt";
			const untrackedPath = "notes.txt";
			const ignoredPath = "build.cache";
			const untrackedText = "ordinary untracked workspace content\n";
			await initGitRepository(harness.workspaceRoot);
			await writeText(harness.workspaceRoot, ".gitignore", "*.cache\n");
			await writeText(harness.workspaceRoot, trackedPath, "tracked workspace content\n");
			await runGit(harness.workspaceRoot, ["add", "--", ".gitignore", trackedPath]);
			await writeText(harness.workspaceRoot, untrackedPath, untrackedText);
			await writeText(harness.workspaceRoot, ignoredPath, "ordinary ignored workspace content\n");

			const scan = await scanWorkspace({
				rootPath: harness.workspaceRoot,
				contentStore: harness.store,
			});

			expect(scan.completeness).toBe("complete");
			expect(scan.respectsGitIgnore).toBeTrue();
			expect(scan.entries.map(entry => entry.path)).toEqual(["", ".gitignore", untrackedPath, trackedPath]);
			expect(scan.trackedIgnoredPaths).toEqual([]);
			expect(scan.entries.some(entry => entry.path === ignoredPath)).toBeFalse();

			const untrackedEntry = entryAt(scan.entries, untrackedPath);
			expect(untrackedEntry.kind).toBe("file");
			if (!untrackedEntry.objectId) throw new Error(`Untracked entry ${untrackedPath} has no content object`);
			const storedBytes = await harness.store.readBytes(untrackedEntry.objectId);
			if (!storedBytes) throw new Error(`Untracked entry ${untrackedPath} content object is missing`);
			expect(Buffer.from(storedBytes).toString("utf8")).toBe(untrackedText);
		},
	);

	it.skipIf(!git.isGitAvailable())(
		"preserves newline-delimited Git pathnames as one persisted manifest entry",
		async () => {
			const harness = await openHarness("git-newline-path");
			const newlinePath = "notes/line\nbreak.txt";
			const newlineText = "newline filename content\n";
			await initGitRepository(harness.workspaceRoot);
			await writeText(harness.workspaceRoot, newlinePath, newlineText);

			const scan = await scanWorkspace({
				rootPath: harness.workspaceRoot,
				contentStore: harness.store,
			});

			expect(scan.completeness).toBe("complete");
			expect(scan.respectsGitIgnore).toBeTrue();
			expect(scan.entries.map(entry => entry.path)).toEqual(["", "notes", newlinePath]);
			const newlineEntry = entryAt(scan.entries, newlinePath);
			expect(newlineEntry.kind).toBe("file");
			if (!newlineEntry.objectId)
				throw new Error(`Newline entry ${JSON.stringify(newlinePath)} has no content object`);
			const storedBytes = await harness.store.readBytes(newlineEntry.objectId);
			if (!storedBytes) throw new Error(`Newline entry ${JSON.stringify(newlinePath)} content object is missing`);
			expect(Buffer.from(storedBytes).toString("utf8")).toBe(newlineText);

			const persisted = await saveWorkspaceManifest(harness.store, manifestFromScan(scan));
			const loaded = await loadWorkspaceManifest(harness.store, persisted.manifestObjectId);
			if (!loaded) throw new Error("Saved newline-path manifest was not loadable");
			expect(loaded.entries.filter(entry => entry.kind === "file").map(entry => entry.path)).toEqual([newlinePath]);
		},
	);

	it.skipIf(!git.isGitAvailable())("re-evaluates changed .gitignore rules on every Git-aware scan", async () => {
		const harness = await openHarness("gitignore-rule-change");
		const candidatePath = "artifact.cache";
		const candidateText = "captured when no longer ignored\n";
		await initGitRepository(harness.workspaceRoot);
		await writeText(harness.workspaceRoot, ".gitignore", "*.cache\n");
		await runGit(harness.workspaceRoot, ["add", "--", ".gitignore"]);
		await writeText(harness.workspaceRoot, candidatePath, candidateText);

		const initiallyIgnored = await scanWorkspace({
			rootPath: harness.workspaceRoot,
			contentStore: harness.store,
		});
		expect(initiallyIgnored.entries.map(entry => entry.path)).toEqual(["", ".gitignore"]);
		expect(initiallyIgnored.entries.some(entry => entry.path === candidatePath)).toBeFalse();

		await writeText(harness.workspaceRoot, ".gitignore", "*.tmp\n");
		const includedAfterRuleChange = await scanWorkspace({
			rootPath: harness.workspaceRoot,
			contentStore: harness.store,
		});
		expect(includedAfterRuleChange.entries.map(entry => entry.path)).toEqual(["", ".gitignore", candidatePath]);
		const candidateEntry = entryAt(includedAfterRuleChange.entries, candidatePath);
		expect(candidateEntry.kind).toBe("file");
		if (!candidateEntry.objectId) throw new Error(`Rule-change entry ${candidatePath} has no content object`);
		const storedBytes = await harness.store.readBytes(candidateEntry.objectId);
		if (!storedBytes) throw new Error(`Rule-change entry ${candidatePath} content object is missing`);
		expect(Buffer.from(storedBytes).toString("utf8")).toBe(candidateText);

		await writeText(harness.workspaceRoot, ".gitignore", "*.cache\n");
		const ignoredAgain = await scanWorkspace({
			rootPath: harness.workspaceRoot,
			contentStore: harness.store,
		});
		expect(ignoredAgain.entries.map(entry => entry.path)).toEqual(["", ".gitignore"]);
		expect(ignoredAgain.entries.some(entry => entry.path === candidatePath)).toBeFalse();
	});
});
