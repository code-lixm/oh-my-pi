import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
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
	type WorkspaceContentStore,
} from "../../src/workspace-checkpoints/content-store";
import type { CoordinatorLimits } from "../../src/workspace-checkpoints/coordinator";
import { WorkspaceCheckpointError } from "../../src/workspace-checkpoints/coordinator";
import { loadWorkspaceManifest } from "../../src/workspace-checkpoints/manifest";
import {
	createWorkspaceCheckpointService,
	type WorkspaceCheckpointRetentionOptions,
	type WorkspaceCheckpointServiceImpl,
} from "../../src/workspace-checkpoints/service";
import { type CheckpointMetadataStore, createCheckpointMetadataStore } from "../../src/workspace-checkpoints/store";
import type {
	WorkspaceCheckpointConversationAdapter,
	WorkspaceCheckpointMutatorGuard,
	WorkspaceCheckpointRecord,
	WorkspaceRestoreOperation,
} from "../../src/workspace-checkpoints/types";

type SnapshotEntry =
	| { path: string; kind: "directory"; mode: number }
	| { path: string; kind: "file"; mode: number; contentHex: string }
	| { path: string; kind: "symlink"; mode: number; linkTarget: string };

class FakeConversationAdapter implements WorkspaceCheckpointConversationAdapter {
	readonly calls: Array<
		| { method: "recordCheckpointReference"; checkpointId: string; label: string | null }
		| { method: "restoreConversationEntry"; entryId: string; scope: "code" | "conversation" | "all" }
	> = [];

	fail = false;
	#nextId = 0;

	async recordCheckpointReference(request: { checkpointId: string; label: string | null }): Promise<string | null> {
		this.calls.push({
			method: "recordCheckpointReference",
			checkpointId: request.checkpointId,
			label: request.label,
		});
		if (this.fail) throw new Error("conversation restore failed");
		this.#nextId += 1;
		return `conversation-ref-${this.#nextId}`;
	}

	async restoreConversationEntry(request: {
		entryId: string;
		scope: "code" | "conversation" | "all";
	}): Promise<string | null> {
		this.calls.push({ method: "restoreConversationEntry", entryId: request.entryId, scope: request.scope });
		if (this.fail) throw new Error("conversation restore failed");
		return `restored-${request.entryId}`;
	}
}

class FakeMutatorGuard implements WorkspaceCheckpointMutatorGuard {
	active = false;
	waitCalls = 0;
	waitError: Error | null = null;

	isMutatorActive(): boolean {
		return this.active;
	}

	async waitForIdle(): Promise<void> {
		this.waitCalls += 1;
		if (this.waitError) throw this.waitError;
	}
}

interface Harness {
	root: string;
	workspaceRoot: string;
	storeDir: string;
	store: CheckpointMetadataStore;
	service: WorkspaceCheckpointServiceImpl;
	conversation: FakeConversationAdapter;
	guard: FakeMutatorGuard;
	limits?: CoordinatorLimits;
	now?: () => Date;
	retention?: WorkspaceCheckpointRetentionOptions;
}

const activeHarnesses: Harness[] = [];

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.lstat(target);
		return true;
	} catch {
		return false;
	}
}

function workspacePath(root: string, rel: string): string {
	return path.join(root, rel);
}

async function writeText(root: string, rel: string, content: string): Promise<void> {
	const absolute = workspacePath(root, rel);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	await fs.writeFile(absolute, content, "utf8");
}

async function readText(root: string, rel: string): Promise<string | null> {
	try {
		return await fs.readFile(workspacePath(root, rel), "utf8");
	} catch {
		return null;
	}
}

async function writeBytes(root: string, rel: string, content: Uint8Array): Promise<void> {
	const absolute = workspacePath(root, rel);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	await fs.writeFile(absolute, content);
}

async function readBytes(root: string, rel: string): Promise<Uint8Array | null> {
	try {
		return await fs.readFile(workspacePath(root, rel));
	} catch {
		return null;
	}
}

async function chmodPath(root: string, rel: string, mode: number): Promise<void> {
	await fs.chmod(workspacePath(root, rel), mode);
}

async function modeOf(root: string, rel: string): Promise<number | null> {
	try {
		const stat = await fs.lstat(workspacePath(root, rel));
		return stat.mode & 0o7777;
	} catch {
		return null;
	}
}

async function removePath(root: string, rel: string): Promise<void> {
	await fs.rm(workspacePath(root, rel), { recursive: true, force: true });
}

async function writeSymlink(root: string, rel: string, target: string): Promise<void> {
	const absolute = workspacePath(root, rel);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	await fs.symlink(target, absolute);
}

async function readSymlink(root: string, rel: string): Promise<string | null> {
	try {
		const absolute = workspacePath(root, rel);
		const stat = await fs.lstat(absolute);
		if (!stat.isSymbolicLink()) return null;
		return await fs.readlink(absolute);
	} catch {
		return null;
	}
}

async function snapshotWorkspace(root: string): Promise<SnapshotEntry[]> {
	const out: SnapshotEntry[] = [];

	async function walk(relative: string): Promise<void> {
		const absolute = relative === "" ? root : workspacePath(root, relative);
		const children = await fs.readdir(absolute, { withFileTypes: true });
		children.sort((a, b) => a.name.localeCompare(b.name));
		for (const child of children) {
			const childRel = relative === "" ? child.name : `${relative}/${child.name}`;
			const childAbs = workspacePath(root, childRel);
			const stat = await fs.lstat(childAbs);
			const mode = stat.mode & 0o7777;
			if (stat.isDirectory()) {
				out.push({ path: childRel, kind: "directory", mode });
				await walk(childRel);
				continue;
			}
			if (stat.isSymbolicLink()) {
				out.push({ path: childRel, kind: "symlink", mode, linkTarget: await fs.readlink(childAbs) });
				continue;
			}
			out.push({
				path: childRel,
				kind: "file",
				mode,
				contentHex: Buffer.from(await fs.readFile(childAbs)).toString("hex"),
			});
		}
	}

	await walk("");
	return out;
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
	const objectPaths: string[] = [];
	let totalBytes = 0;
	const shards = await fs.readdir(objectsDir, { withFileTypes: true });
	for (const shard of shards) {
		if (!shard.isDirectory()) continue;
		const shardPath = path.join(objectsDir, shard.name);
		const entries = await fs.readdir(shardPath, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const objectPath = path.join(shardPath, entry.name);
			objectPaths.push(path.relative(objectsDir, objectPath));
			totalBytes += (await fs.stat(objectPath)).size;
		}
	}
	objectPaths.sort();
	return { count: objectPaths.length, totalBytes, objectPaths };
}

async function expectRejected<T extends Error = Error>(promise: Promise<unknown>): Promise<T> {
	try {
		await promise;
	} catch (error) {
		return error as T;
	}
	throw new Error("Expected promise to reject");
}

function sortedOperationKeys(operations: readonly WorkspaceRestoreOperation[]): string[] {
	return operations.map(op => `${op.kind}:${op.path}`).sort();
}

function sortedPaths(paths: readonly string[]): string[] {
	return [...paths].sort();
}

function checkpointIds(checkpoints: readonly WorkspaceCheckpointRecord[]): string[] {
	return checkpoints.map(checkpoint => checkpoint.id);
}

function setCheckpointCreatedAt(store: CheckpointMetadataStore, checkpointId: string, createdAt: string): void {
	const db = new Database((store as CheckpointMetadataStore & { dbPath: string }).dbPath);
	try {
		db.prepare("UPDATE checkpoints SET created_at = ? WHERE id = ?").run(createdAt, checkpointId);
	} finally {
		db.close();
	}
}

async function checkpointFileObjectId(
	contentStore: WorkspaceContentStore,
	checkpoint: WorkspaceCheckpointRecord,
	relativePath: string,
): Promise<string> {
	const manifest = await loadWorkspaceManifest(contentStore, checkpoint.manifestObjectId);
	if (!manifest) throw new Error(`Missing manifest ${checkpoint.manifestObjectId}`);
	const entry = manifest.entries.find(candidate => candidate.path === relativePath);
	if (!entry?.objectId) throw new Error(`Missing file object for ${relativePath}`);
	return entry.objectId;
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: "true",
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

async function openHarness(
	label: string,
	options: {
		limits?: CoordinatorLimits;
		now?: () => Date;
		retention?: WorkspaceCheckpointRetentionOptions;
	} = {},
): Promise<Harness> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-workspace-checkpoint-service-${label}-`));
	const workspaceRoot = path.join(root, "workspace");
	const storeDir = path.join(root, "store");
	await fs.mkdir(workspaceRoot, { recursive: true });
	await fs.mkdir(storeDir, { recursive: true });

	const store = createCheckpointMetadataStore({ storageDir: storeDir });
	const conversation = new FakeConversationAdapter();
	const guard = new FakeMutatorGuard();
	const service = await createWorkspaceCheckpointService({
		rootPath: workspaceRoot,
		storeDir,
		store,
		conversationAdapter: conversation,
		mutatorGuard: guard,
		limits: options.limits,
		now: options.now,
		retention: options.retention,
	});

	const harness: Harness = {
		root,
		workspaceRoot,
		storeDir,
		store,
		service,
		conversation,
		guard,
		limits: options.limits,
		now: options.now,
		retention: options.retention,
	};
	activeHarnesses.push(harness);
	return harness;
}

async function reopenService(harness: Harness): Promise<void> {
	harness.service.dispose();
	harness.store.close();
	harness.store = createCheckpointMetadataStore({ storageDir: harness.storeDir });
	harness.service = await createWorkspaceCheckpointService({
		rootPath: harness.workspaceRoot,
		storeDir: harness.storeDir,
		store: harness.store,
		conversationAdapter: harness.conversation,
		mutatorGuard: harness.guard,
		limits: harness.limits,
		now: harness.now,
		retention: harness.retention,
	});
}

afterEach(async () => {
	while (activeHarnesses.length > 0) {
		const harness = activeHarnesses.pop()!;
		harness.service.dispose();
		harness.store.close();
		await removeWithRetries(harness.root).catch(() => undefined);
	}
});

describe("workspace checkpoint service end-to-end contracts", () => {
	it("stores checkpoint artifacts outside the workspace and restores ordinary, ignored, symlink, mode, and binary changes", async () => {
		const harness = await openHarness("external-store", {
			limits: {
				mutatorTimeoutMs: 100,
				maxManifestEntries: 10_000,
				maxAutoBytes: 1_024,
			},
		});
		const { workspaceRoot, storeDir, store, service } = harness;
		const contentStoreDir = path.join(storeDir, "workspaces", store.workspaceIdForRoot(workspaceRoot));
		const originalBinary = randomBytes(4_096);
		const mutatedBinary = randomBytes(4_096);

		await writeText(workspaceRoot, ".gitignore", "ignored.txt\n");
		await writeText(workspaceRoot, "note.txt", "alpha\n");
		await writeText(workspaceRoot, "deleted.txt", "restore me\n");
		await writeText(workspaceRoot, "ignored.txt", "captured even if ignored\n");
		await writeText(workspaceRoot, "exec.sh", "#!/bin/sh\necho hi\n");
		await chmodPath(workspaceRoot, "exec.sh", 0o755);
		await writeBytes(workspaceRoot, "large.bin", originalBinary);
		await writeSymlink(workspaceRoot, "link.txt", "note.txt");

		const checkpoint = await service.create({ rootPath: workspaceRoot, reason: "manual" });

		expect(checkpoint.completeness).toBe("partial");
		expect(await pathExists(path.join(workspaceRoot, "checkpoints"))).toBeFalse();
		expect(await pathExists(path.join(workspaceRoot, ".omp", "checkpoints"))).toBeFalse();
		expect(await pathExists(path.join(storeDir, "metadata.db"))).toBeTrue();
		expect(await pathExists(objectPathFor(contentStoreDir, checkpoint.manifestObjectId))).toBeTrue();

		await writeText(workspaceRoot, "note.txt", "beta\n");
		await removePath(workspaceRoot, "deleted.txt");
		await removePath(workspaceRoot, "ignored.txt");
		await chmodPath(workspaceRoot, "exec.sh", 0o644);
		await removePath(workspaceRoot, "link.txt");
		await writeSymlink(workspaceRoot, "link.txt", "deleted.txt");
		await writeBytes(workspaceRoot, "large.bin", mutatedBinary);
		await writeText(workspaceRoot, "added.txt", "delete me\n");

		const plan = await service.previewRestore({
			checkpointId: checkpoint.id,
			scope: "code",
			strategy: "preserve",
		});

		expect(sortedOperationKeys(plan.operations)).toEqual([
			"chmod:exec.sh",
			"create:deleted.txt",
			"create:ignored.txt",
			"delete:added.txt",
			"symlink:link.txt",
			"update:large.bin",
			"update:note.txt",
		]);
		for (const operation of plan.operations) {
			if ((operation.kind === "create" || operation.kind === "update") && operation.objectId) {
				expect(await pathExists(objectPathFor(contentStoreDir, operation.objectId))).toBeTrue();
			}
		}

		const result = await service.restore({ planId: plan.id });

		expect(sortedPaths(result.restoredPaths)).toEqual([
			"added.txt",
			"deleted.txt",
			"exec.sh",
			"ignored.txt",
			"large.bin",
			"link.txt",
			"note.txt",
		]);
		expect(result.conversationEntryId).toBeNull();
		expect(result.redoAvailable).toBeFalse();
		expect(await readText(workspaceRoot, "note.txt")).toBe("alpha\n");
		expect(await readText(workspaceRoot, "deleted.txt")).toBe("restore me\n");
		expect(await readText(workspaceRoot, "ignored.txt")).toBe("captured even if ignored\n");
		expect(await readText(workspaceRoot, "added.txt")).toBeNull();
		expect(await modeOf(workspaceRoot, "exec.sh")).toBe(0o755);
		expect(await readSymlink(workspaceRoot, "link.txt")).toBe("note.txt");
		expect(Buffer.from((await readBytes(workspaceRoot, "large.bin")) ?? []).equals(originalBinary)).toBeTrue();
		expect(await pathExists(path.join(storeDir, "checkpoints", "v1", "transactions"))).toBeTrue();
		expect(await pathExists(path.join(workspaceRoot, "checkpoints"))).toBeFalse();
		expect(await pathExists(path.join(workspaceRoot, ".omp", "checkpoints"))).toBeFalse();
	});

	it("rejects a stale restore plan when the workspace diverges after preview", async () => {
		const harness = await openHarness("stale-plan");
		const { workspaceRoot, service } = harness;

		await writeText(workspaceRoot, "draft.txt", "checkpoint\n");
		const checkpoint = await service.create({ rootPath: workspaceRoot, reason: "manual" });
		await writeText(workspaceRoot, "draft.txt", "preview-basis\n");

		const plan = await service.previewRestore({
			checkpointId: checkpoint.id,
			scope: "code",
			strategy: "preserve",
		});
		expect(sortedOperationKeys(plan.operations)).toEqual(["update:draft.txt"]);

		await writeText(workspaceRoot, "draft.txt", "diverged-after-preview\n");

		const error = await expectRejected<WorkspaceCheckpointError>(service.restore({ planId: plan.id }));

		expect(error).toBeInstanceOf(WorkspaceCheckpointError);
		expect(error.conflicts).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "draft.txt", kind: "current_state_changed" })]),
		);
		expect(await readText(workspaceRoot, "draft.txt")).toBe("diverged-after-preview\n");
	});

	it("limits a paths preview and restore to the selected subtree", async () => {
		const harness = await openHarness("restore-path-subtree");
		const { workspaceRoot, service } = harness;

		await writeText(workspaceRoot, "src/app.ts", "checkpoint source\n");
		await writeText(workspaceRoot, "src/nested/removed.ts", "restore this source file\n");
		await writeText(workspaceRoot, "docs/guide.md", "checkpoint documentation\n");
		const checkpoint = await service.create({ rootPath: workspaceRoot, reason: "manual" });

		await writeText(workspaceRoot, "src/app.ts", "live source\n");
		await removePath(workspaceRoot, "src/nested/removed.ts");
		await writeText(workspaceRoot, "docs/guide.md", "live documentation\n");
		await writeText(workspaceRoot, "docs/added.md", "keep this documentation\n");

		const plan = await service.previewRestore({
			checkpointId: checkpoint.id,
			scope: "code",
			strategy: "preserve",
			paths: ["src"],
		});
		expect(sortedOperationKeys(plan.operations)).toEqual(["create:src/nested/removed.ts", "update:src/app.ts"]);

		const result = await service.restore({ planId: plan.id });
		expect(sortedPaths(result.restoredPaths)).toEqual(["src/app.ts", "src/nested/removed.ts"]);
		expect(await readText(workspaceRoot, "src/app.ts")).toBe("checkpoint source\n");
		expect(await readText(workspaceRoot, "src/nested/removed.ts")).toBe("restore this source file\n");
		expect(await readText(workspaceRoot, "docs/guide.md")).toBe("live documentation\n");
		expect(await readText(workspaceRoot, "docs/added.md")).toBe("keep this documentation\n");
	});

	it("rejects a create plan when its missing target appears before apply", async () => {
		const harness = await openHarness("create-target-stale-plan");
		const { workspaceRoot, service } = harness;

		await writeText(workspaceRoot, "recreated.txt", "checkpoint content\n");
		const checkpoint = await service.create({ rootPath: workspaceRoot, reason: "manual" });
		await removePath(workspaceRoot, "recreated.txt");

		const plan = await service.previewRestore({
			checkpointId: checkpoint.id,
			scope: "code",
			strategy: "preserve",
		});
		expect(sortedOperationKeys(plan.operations)).toEqual(["create:recreated.txt"]);

		await writeText(workspaceRoot, "recreated.txt", "created after preview\n");
		const error = await expectRejected<WorkspaceCheckpointError>(service.restore({ planId: plan.id }));

		expect(error).toBeInstanceOf(WorkspaceCheckpointError);
		expect(error.conflicts).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "recreated.txt", kind: "current_state_changed" })]),
		);
		expect(await readText(workspaceRoot, "recreated.txt")).toBe("created after preview\n");
	});

	it("rejects reapplying a successfully applied restore plan", async () => {
		const harness = await openHarness("applied-plan-single-use");
		const { workspaceRoot, service } = harness;

		await writeText(workspaceRoot, "note.txt", "checkpoint content\n");
		const checkpoint = await service.create({ rootPath: workspaceRoot, reason: "manual" });
		await writeText(workspaceRoot, "note.txt", "working content\n");
		const plan = await service.previewRestore({
			checkpointId: checkpoint.id,
			scope: "code",
			strategy: "preserve",
		});

		const firstResult = await service.restore({ planId: plan.id });
		expect(firstResult.restoredPaths).toEqual(["note.txt"]);
		expect(await readText(workspaceRoot, "note.txt")).toBe("checkpoint content\n");

		const error = await expectRejected<WorkspaceCheckpointError>(service.restore({ planId: plan.id }));
		expect(error).toBeInstanceOf(WorkspaceCheckpointError);
		expect(error.message).toContain("already applied");
	});

	it("rejects a session-bound preview of another session's checkpoint while offline preview remains available", async () => {
		const harness = await openHarness("preview-session-boundary");
		const { workspaceRoot, service } = harness;

		await writeText(workspaceRoot, "note.txt", "alpha checkpoint\n");
		const alphaCheckpoint = await service.create({ rootPath: workspaceRoot, reason: "manual", sessionId: "alpha" });
		await writeText(workspaceRoot, "note.txt", "live workspace\n");

		const crossSessionError = await expectRejected<WorkspaceCheckpointError>(
			service.previewRestore({
				checkpointId: alphaCheckpoint.id,
				sessionId: "beta",
				scope: "code",
				strategy: "preserve",
			}),
		);
		expect(crossSessionError).toBeInstanceOf(WorkspaceCheckpointError);

		const offlinePlan = await service.previewRestore({
			checkpointId: alphaCheckpoint.id,
			scope: "code",
			strategy: "preserve",
		});
		expect(offlinePlan.checkpointId).toBe(alphaCheckpoint.id);
		expect(sortedOperationKeys(offlinePlan.operations)).toEqual(["update:note.txt"]);
	});

	it("previews changed ordinary and large files without materializing their live contents", async () => {
		const harness = await openHarness("preview-hash-only");
		const { workspaceRoot, store, storeDir, service } = harness;
		const checkpointText = "checkpoint text\n";
		const liveText = "live text after checkpoint\n";
		const checkpointLarge = new Uint8Array(1024 * 1024 + 127).fill(0x31);
		const liveLarge = new Uint8Array(1024 * 1024 + 127).fill(0x9d);

		await writeText(workspaceRoot, "note.txt", checkpointText);
		await writeBytes(workspaceRoot, "large.bin", checkpointLarge);
		const checkpoint = await service.create({ rootPath: workspaceRoot, reason: "manual" });
		await writeText(workspaceRoot, "note.txt", liveText);
		await writeBytes(workspaceRoot, "large.bin", liveLarge);

		const contentStoreDir = path.join(storeDir, "workspaces", store.workspaceIdForRoot(workspaceRoot));
		const contentStore = await openWorkspaceContentStoreAt(contentStoreDir);
		const before = await casObjectInventory(contentStore.objectsDir);
		const plan = await service.previewRestore({
			checkpointId: checkpoint.id,
			scope: "code",
			strategy: "preserve",
		});
		const after = await casObjectInventory(contentStore.objectsDir);

		expect(sortedOperationKeys(plan.operations)).toEqual(["update:large.bin", "update:note.txt"]);
		for (const expected of [
			{
				path: "note.txt",
				targetObjectId: await checkpointFileObjectId(contentStore, checkpoint, "note.txt"),
				liveObjectId: sha256ObjectId(liveText),
			},
			{
				path: "large.bin",
				targetObjectId: await checkpointFileObjectId(contentStore, checkpoint, "large.bin"),
				liveObjectId: sha256ObjectId(liveLarge),
			},
		]) {
			const operation = plan.operations.find(
				candidate => candidate.kind === "update" && candidate.path === expected.path,
			);
			expect(operation).toEqual(
				expect.objectContaining({
					objectId: expected.targetObjectId,
					expectedKind: "file",
					expectedObjectId: expected.liveObjectId,
				}),
			);
		}
		expect(after.count).toBe(before.count);
		expect(after.totalBytes).toBe(before.totalBytes);
		expect(after.objectPaths).toEqual(before.objectPaths);
	});

	it("conversation-only restore leaves the filesystem untouched", async () => {
		const harness = await openHarness("conversation-only");
		const { workspaceRoot, service, conversation } = harness;

		await writeText(workspaceRoot, "note.txt", "saved\n");
		await writeText(workspaceRoot, "nested/file.txt", "nested\n");
		const checkpoint = await service.create({
			rootPath: workspaceRoot,
			reason: "manual",
			sessionId: "session-a",
			sessionEntryId: "entry-a",
		});
		await writeText(workspaceRoot, "note.txt", "live\n");
		await writeText(workspaceRoot, "nested/file.txt", "changed\n");

		const before = await snapshotWorkspace(workspaceRoot);
		const plan = await service.previewRestore({
			checkpointId: checkpoint.id,
			scope: "conversation",
			strategy: "preserve",
		});
		expect(plan.operations).toEqual([]);

		const result = await service.restore({ planId: plan.id });
		const after = await snapshotWorkspace(workspaceRoot);

		expect(after).toEqual(before);
		expect(result.restoredPaths).toEqual([]);
		expect(result.skippedPaths).toEqual([]);
		expect(result.conversationEntryId).not.toBeNull();
		expect(conversation.calls.length).toBeGreaterThan(0);
	});

	it("rolls back file restoration when an all-scope conversation restore fails", async () => {
		const harness = await openHarness("all-compensation");
		const { workspaceRoot, service, conversation } = harness;

		await writeText(workspaceRoot, "note.txt", "from checkpoint\n");
		const checkpoint = await service.create({
			rootPath: workspaceRoot,
			reason: "manual",
			sessionId: "session-a",
			sessionEntryId: "entry-a",
		});
		await writeText(workspaceRoot, "note.txt", "live before failed restore\n");
		conversation.fail = true;

		const before = await snapshotWorkspace(workspaceRoot);
		const stateBeforeRestore = await harness.store.getWorkspaceState(workspaceRoot);
		const plan = await service.previewRestore({
			checkpointId: checkpoint.id,
			scope: "all",
			strategy: "preserve",
		});
		expect(sortedOperationKeys(plan.operations)).toEqual(["update:note.txt"]);

		const error = await expectRejected(service.restore({ planId: plan.id }));
		const after = await snapshotWorkspace(workspaceRoot);
		const stateAfterFailedRestore = await harness.store.getWorkspaceState(workspaceRoot);

		expect((error as Error).message).toContain("conversation restore failed");
		expect(after).toEqual(before);
		expect(stateAfterFailedRestore).toEqual(stateBeforeRestore);
		expect(stateAfterFailedRestore).toEqual(expect.objectContaining({ lastCheckpointId: checkpoint.id }));
	});

	it("persists direct apply, undo, and redo state across reopens", async () => {
		const harness = await openHarness("redo-reopen");
		const { workspaceRoot, service } = harness;

		await writeText(workspaceRoot, "note.txt", "target workspace\n");
		const checkpoint = await service.create({ rootPath: workspaceRoot, reason: "manual" });
		await writeText(workspaceRoot, "note.txt", "pre-apply workspace\n");

		const plan = await service.previewRestore({
			checkpointId: checkpoint.id,
			scope: "code",
			strategy: "exact",
		});
		const applied = await service.restore({ planId: plan.id });
		const persistedDirectPlan = await harness.store.getRestorePlan(plan.id);
		if (!persistedDirectPlan) throw new Error("expected persisted direct restore plan");
		expect(applied).toMatchObject({
			scope: persistedDirectPlan.scope,
			strategy: persistedDirectPlan.strategy,
		});
		expect(applied.guardCheckpointId).not.toBeNull();
		const directGuardId = applied.guardCheckpointId!;

		expect(applied.redoAvailable).toBeFalse();
		expect(await readText(workspaceRoot, "note.txt")).toBe("target workspace\n");
		const stateAfterApply = await harness.store.getWorkspaceState(workspaceRoot);
		expect(stateAfterApply).toEqual(
			expect.objectContaining({
				undoHeadCheckpointId: directGuardId,
				redoHeadCheckpointId: null,
				lastCheckpointId: checkpoint.id,
			}),
		);
		expect(await harness.store.getRedoEdge(workspaceRoot)).toBeNull();
		expect(await harness.store.getCheckpoint(directGuardId)).toEqual(
			expect.objectContaining({
				reason: "restore_guard",
				parentId: checkpoint.id,
				pinned: false,
				label: null,
			}),
		);
		const rootsAfterApply = await harness.store.listGcRoots(workspaceRoot);
		expect(rootsAfterApply.find(root => root.checkpointId === directGuardId)?.reasons).toContain("workspace_pointer");
		const directRedoError = await expectRejected<WorkspaceCheckpointError>(
			harness.service.redo({ rootPath: workspaceRoot }),
		);
		expect(directRedoError).toBeInstanceOf(WorkspaceCheckpointError);
		expect(directRedoError.message).toContain("no redo");
		expect(await readText(workspaceRoot, "note.txt")).toBe("target workspace\n");
		expect(await harness.store.getWorkspaceState(workspaceRoot)).toEqual(stateAfterApply);

		await reopenService(harness);
		expect(await harness.store.getWorkspaceState(workspaceRoot)).toEqual(stateAfterApply);
		expect(await harness.store.getRedoEdge(workspaceRoot)).toBeNull();

		const undone = await harness.service.undo({ rootPath: workspaceRoot, scope: "code" });
		const undoTransaction = await harness.store.getTransaction(undone.transactionId);
		if (!undoTransaction?.planId) throw new Error("expected undo transaction to name its restore plan");
		const persistedUndoPlan = await harness.store.getRestorePlan(undoTransaction.planId);
		if (!persistedUndoPlan) throw new Error("expected persisted undo restore plan");
		expect(undone).toMatchObject({
			scope: persistedUndoPlan.scope,
			strategy: persistedUndoPlan.strategy,
		});
		expect(undone.guardCheckpointId).not.toBeNull();
		const undoGuardId = undone.guardCheckpointId!;

		expect(undone.checkpointId).toBe(directGuardId);
		expect(undone.redoAvailable).toBeTrue();
		expect(await readText(workspaceRoot, "note.txt")).toBe("pre-apply workspace\n");
		const stateAfterUndo = await harness.store.getWorkspaceState(workspaceRoot);
		expect(stateAfterUndo).toEqual(
			expect.objectContaining({
				undoHeadCheckpointId: null,
				redoHeadCheckpointId: undoGuardId,
				lastCheckpointId: checkpoint.id,
			}),
		);
		const redoEdgeAfterUndo = await harness.store.getRedoEdge(workspaceRoot);
		expect(redoEdgeAfterUndo).toEqual(
			expect.objectContaining({
				targetCheckpointId: undoGuardId,
				sourceCheckpointId: directGuardId,
			}),
		);

		const rootsAfterUndo = await harness.store.listGcRoots(workspaceRoot);
		expect(rootsAfterUndo.find(root => root.checkpointId === directGuardId)?.reasons).toContain("redo_edge");
		expect(rootsAfterUndo.find(root => root.checkpointId === undoGuardId)?.reasons).toEqual(
			expect.arrayContaining(["redo_edge", "workspace_pointer"]),
		);

		await reopenService(harness);
		expect(await harness.store.getWorkspaceState(workspaceRoot)).toEqual(stateAfterUndo);
		expect(await harness.store.getRedoEdge(workspaceRoot)).toEqual(redoEdgeAfterUndo);

		const redone = await harness.service.redo({ rootPath: workspaceRoot });
		const redoTransaction = await harness.store.getTransaction(redone.transactionId);
		if (!redoTransaction?.planId) throw new Error("expected redo transaction to name its restore plan");
		const persistedRedoPlan = await harness.store.getRestorePlan(redoTransaction.planId);
		if (!persistedRedoPlan) throw new Error("expected persisted redo restore plan");
		expect(redone).toMatchObject({
			scope: persistedRedoPlan.scope,
			strategy: persistedRedoPlan.strategy,
		});
		expect(redone.guardCheckpointId).not.toBeNull();
		const redoGuardId = redone.guardCheckpointId!;

		expect(redone.checkpointId).toBe(undoGuardId);
		expect(redone.redoAvailable).toBeFalse();
		expect(await readText(workspaceRoot, "note.txt")).toBe("target workspace\n");
		expect(await harness.store.getWorkspaceState(workspaceRoot)).toEqual(
			expect.objectContaining({
				undoHeadCheckpointId: redoGuardId,
				redoHeadCheckpointId: null,
				lastCheckpointId: checkpoint.id,
			}),
		);
		expect(await harness.store.getRedoEdge(workspaceRoot)).toBeNull();

		const undoneAgain = await harness.service.undo({ rootPath: workspaceRoot, scope: "code" });
		expect(undoneAgain.guardCheckpointId).not.toBeNull();
		const finalUndoGuardId = undoneAgain.guardCheckpointId!;

		expect(undoneAgain.checkpointId).toBe(redoGuardId);
		expect(undoneAgain.redoAvailable).toBeTrue();
		expect(await readText(workspaceRoot, "note.txt")).toBe("pre-apply workspace\n");
		expect(await harness.store.getWorkspaceState(workspaceRoot)).toEqual(
			expect.objectContaining({
				undoHeadCheckpointId: null,
				redoHeadCheckpointId: finalUndoGuardId,
				lastCheckpointId: checkpoint.id,
			}),
		);
		expect(await harness.store.getRedoEdge(workspaceRoot)).toEqual(
			expect.objectContaining({
				targetCheckpointId: finalUndoGuardId,
				sourceCheckpointId: redoGuardId,
			}),
		);
	});

	it("keeps same-root sessions' checkpoint histories and undo-redo cursors independent", async () => {
		const harness = await openHarness("session-isolation");
		const { workspaceRoot, service, store } = harness;

		await writeText(workspaceRoot, "note.txt", "alpha one\n");
		const alphaOne = await service.create({ rootPath: workspaceRoot, reason: "manual", sessionId: "alpha" });
		await writeText(workspaceRoot, "note.txt", "beta one\n");
		const betaOne = await service.create({ rootPath: workspaceRoot, reason: "manual", sessionId: "beta" });
		await writeText(workspaceRoot, "note.txt", "alpha two\n");
		const alphaTwo = await service.create({ rootPath: workspaceRoot, reason: "manual", sessionId: "alpha" });

		expect(betaOne.parentId).toBeNull();
		expect(alphaTwo.parentId).toBe(alphaOne.id);
		expect(checkpointIds(await service.list({ rootPath: workspaceRoot, sessionId: "alpha" })).sort()).toEqual(
			[alphaOne.id, alphaTwo.id].sort(),
		);
		expect(checkpointIds(await service.list({ rootPath: workspaceRoot, sessionId: "beta" }))).toEqual([betaOne.id]);

		const alphaBeforeUndo = await store.getWorkspaceState(workspaceRoot, "alpha");
		const betaBeforeUndo = await store.getWorkspaceState(workspaceRoot, "beta");
		expect(alphaBeforeUndo).toMatchObject({
			sessionId: "alpha",
			undoHeadCheckpointId: alphaTwo.id,
			lastCheckpointId: alphaTwo.id,
		});
		expect(betaBeforeUndo).toMatchObject({
			sessionId: "beta",
			undoHeadCheckpointId: betaOne.id,
			lastCheckpointId: betaOne.id,
		});

		await writeText(workspaceRoot, "note.txt", "working copy\n");
		const alphaUndone = await service.undo({ rootPath: workspaceRoot, sessionId: "alpha", scope: "code" });
		if (!alphaUndone.guardCheckpointId) throw new Error("expected alpha undo guard");
		const alphaRedoGuardId = alphaUndone.guardCheckpointId;
		expect(alphaUndone.checkpointId).toBe(alphaTwo.id);
		expect(await readText(workspaceRoot, "note.txt")).toBe("alpha two\n");
		const alphaAfterUndo = await store.getWorkspaceState(workspaceRoot, "alpha");
		const alphaRedoAfterUndo = await store.getRedoEdge(workspaceRoot, "alpha");
		expect(alphaAfterUndo).toMatchObject({
			sessionId: "alpha",
			undoHeadCheckpointId: null,
			redoHeadCheckpointId: alphaRedoGuardId,
			lastCheckpointId: alphaTwo.id,
		});
		expect(alphaRedoAfterUndo).toMatchObject({
			sessionId: "alpha",
			targetCheckpointId: alphaRedoGuardId,
			sourceCheckpointId: alphaTwo.id,
		});
		expect(await store.getWorkspaceState(workspaceRoot, "beta")).toEqual(betaBeforeUndo);
		expect(await store.getRedoEdge(workspaceRoot, "beta")).toBeNull();

		const betaUndone = await service.undo({ rootPath: workspaceRoot, sessionId: "beta", scope: "code" });
		if (!betaUndone.guardCheckpointId) throw new Error("expected beta undo guard");
		const betaRedoGuardId = betaUndone.guardCheckpointId;
		expect(betaUndone.checkpointId).toBe(betaOne.id);
		expect(await readText(workspaceRoot, "note.txt")).toBe("beta one\n");
		const betaAfterUndo = await store.getWorkspaceState(workspaceRoot, "beta");
		const betaRedoAfterUndo = await store.getRedoEdge(workspaceRoot, "beta");
		expect(betaAfterUndo).toMatchObject({
			sessionId: "beta",
			undoHeadCheckpointId: null,
			redoHeadCheckpointId: betaRedoGuardId,
			lastCheckpointId: betaOne.id,
		});
		expect(betaRedoAfterUndo).toMatchObject({
			sessionId: "beta",
			targetCheckpointId: betaRedoGuardId,
			sourceCheckpointId: betaOne.id,
		});
		expect(await store.getWorkspaceState(workspaceRoot, "alpha")).toEqual(alphaAfterUndo);
		expect(await store.getRedoEdge(workspaceRoot, "alpha")).toEqual(alphaRedoAfterUndo);

		const alphaRedone = await service.redo({ rootPath: workspaceRoot, sessionId: "alpha" });
		expect(alphaRedone.checkpointId).toBe(alphaRedoGuardId);
		expect(await readText(workspaceRoot, "note.txt")).toBe("working copy\n");
		expect(await store.getWorkspaceState(workspaceRoot, "beta")).toEqual(betaAfterUndo);
		expect(await store.getRedoEdge(workspaceRoot, "beta")).toEqual(betaRedoAfterUndo);

		const betaRedone = await service.redo({ rootPath: workspaceRoot, sessionId: "beta" });
		expect(betaRedone.checkpointId).toBe(betaRedoGuardId);
		expect(await readText(workspaceRoot, "note.txt")).toBe("alpha two\n");
	});

	it("undoes and redoes a checkpoint without a direct restore", async () => {
		const harness = await openHarness("manual-undo-redo");
		const { workspaceRoot, service } = harness;

		await writeText(workspaceRoot, "note.txt", "checkpoint content\n");
		const checkpoint = await service.create({ rootPath: workspaceRoot, reason: "manual", sessionId: "alpha" });
		await writeText(workspaceRoot, "note.txt", "working content\n");

		const undone = await service.undo({ rootPath: workspaceRoot, sessionId: "alpha", scope: "code" });
		expect(undone.checkpointId).toBe(checkpoint.id);
		expect(undone.redoAvailable).toBeTrue();
		expect(await readText(workspaceRoot, "note.txt")).toBe("checkpoint content\n");

		const redone = await service.redo({ rootPath: workspaceRoot, sessionId: "alpha" });
		expect(redone.redoAvailable).toBeFalse();
		expect(await readText(workspaceRoot, "note.txt")).toBe("working content\n");

		const undoneAgain = await service.undo({ rootPath: workspaceRoot, sessionId: "alpha", scope: "code" });
		expect(undoneAgain.redoAvailable).toBeTrue();
		expect(await readText(workspaceRoot, "note.txt")).toBe("checkpoint content\n");
	});

	it("clears a real redo edge when a new checkpoint is created but keeps prior history listable", async () => {
		const harness = await openHarness("redo-invalidated");
		const { workspaceRoot, service, store } = harness;

		await writeText(workspaceRoot, "note.txt", "checkpoint one\n");
		const checkpoint = await service.create({ rootPath: workspaceRoot, reason: "manual" });
		await writeText(workspaceRoot, "note.txt", "pre-apply workspace\n");
		const plan = await service.previewRestore({
			checkpointId: checkpoint.id,
			scope: "code",
			strategy: "preserve",
		});
		const applied = await service.restore({ planId: plan.id });
		expect(applied.guardCheckpointId).not.toBeNull();
		const directGuardId = applied.guardCheckpointId!;

		const undone = await service.undo({ rootPath: workspaceRoot, scope: "code" });
		expect(undone.guardCheckpointId).not.toBeNull();
		const redoGuardId = undone.guardCheckpointId!;

		expect(undone.redoAvailable).toBeTrue();
		expect(await readText(workspaceRoot, "note.txt")).toBe("pre-apply workspace\n");
		expect(await store.getWorkspaceState(workspaceRoot)).toEqual(
			expect.objectContaining({ undoHeadCheckpointId: null, redoHeadCheckpointId: redoGuardId }),
		);
		expect(await store.getRedoEdge(workspaceRoot)).toEqual(
			expect.objectContaining({ targetCheckpointId: redoGuardId, sourceCheckpointId: directGuardId }),
		);

		await writeText(workspaceRoot, "note.txt", "new head\n");
		const newCheckpoint = await service.create({ rootPath: workspaceRoot, reason: "manual" });
		const redoError = await expectRejected(service.redo({ rootPath: workspaceRoot }));
		const listed = await service.list({ rootPath: workspaceRoot });

		expect(await readText(workspaceRoot, "note.txt")).toBe("new head\n");
		expect(await store.getWorkspaceState(workspaceRoot)).toEqual(
			expect.objectContaining({
				undoHeadCheckpointId: newCheckpoint.id,
				redoHeadCheckpointId: null,
				lastCheckpointId: newCheckpoint.id,
			}),
		);
		expect(await store.getRedoEdge(workspaceRoot)).toBeNull();
		expect((redoError as Error).message).toContain("no redo");
		expect(checkpointIds(listed)).toEqual(expect.arrayContaining([checkpoint.id, newCheckpoint.id]));
	});

	it("fails instead of reporting success when a restore object is missing", async () => {
		const harness = await openHarness("missing-object");
		const { workspaceRoot, storeDir, store, service } = harness;
		const contentStoreDir = path.join(storeDir, "workspaces", store.workspaceIdForRoot(workspaceRoot));

		await writeText(workspaceRoot, "note.txt", "object payload\n");
		const checkpoint = await service.create({ rootPath: workspaceRoot, reason: "manual" });
		await removePath(workspaceRoot, "note.txt");

		const plan = await service.previewRestore({
			checkpointId: checkpoint.id,
			scope: "code",
			strategy: "preserve",
		});
		const createOperation = plan.operations.find(
			operation => operation.kind === "create" && operation.path === "note.txt",
		);
		expect(createOperation?.objectId).toBeTruthy();
		const objectPath = objectPathFor(contentStoreDir, createOperation!.objectId!);
		expect(await pathExists(objectPath)).toBeTrue();
		await fs.unlink(objectPath);

		const before = await snapshotWorkspace(workspaceRoot);
		const error = await expectRejected(service.restore({ planId: plan.id }));
		const after = await snapshotWorkspace(workspaceRoot);

		expect((error as Error).message).toContain("missing");
		expect(after).toEqual(before);
	});

	it("throttles automatic content sweeps for 15 minutes while public retention stays full", async () => {
		vi.useFakeTimers();
		try {
			let nowMs = Date.parse("2030-01-03T00:00:00.000Z");
			const harness = await openHarness("retention-content-sweep-throttle", {
				now: () => new Date(nowMs),
			});
			const originalRunRetention = harness.service.coordinator.runRetention.bind(harness.service.coordinator);
			const firstPassFinished = Promise.withResolvers<void>();
			const secondPassFinished = Promise.withResolvers<void>();
			const thirdPassFinished = Promise.withResolvers<void>();
			const explicitPassFinished = Promise.withResolvers<void>();
			const sweepContent: boolean[] = [];
			let callIndex = 0;
			const retentionSpy = spyOn(harness.service.coordinator, "runRetention").mockImplementation(async options => {
				const thisCall = callIndex++;
				sweepContent.push(options.sweepContent === true);
				try {
					return await originalRunRetention(options);
				} finally {
					if (thisCall === 0) firstPassFinished.resolve();
					if (thisCall === 1) secondPassFinished.resolve();
					if (thisCall === 2) thirdPassFinished.resolve();
					if (thisCall === 3) explicitPassFinished.resolve();
				}
			});

			try {
				await writeText(harness.workspaceRoot, "note.txt", "first automatic checkpoint\n");
				await harness.service.create({ rootPath: harness.workspaceRoot, reason: "turn" });
				vi.advanceTimersByTime(250);
				await firstPassFinished.promise;

				await writeText(harness.workspaceRoot, "note.txt", "second automatic checkpoint\n");
				await harness.service.create({ rootPath: harness.workspaceRoot, reason: "turn" });
				vi.advanceTimersByTime(250);
				await secondPassFinished.promise;

				nowMs += 15 * 60 * 1_000;
				await writeText(harness.workspaceRoot, "note.txt", "third automatic checkpoint\n");
				await harness.service.create({ rootPath: harness.workspaceRoot, reason: "turn" });
				vi.advanceTimersByTime(250);
				await thirdPassFinished.promise;

				expect(sweepContent).toEqual([true, false, true]);

				await harness.service.runRetention();
				await explicitPassFinished.promise;
				expect(sweepContent).toEqual([true, false, true, true]);
			} finally {
				retentionSpy.mockRestore();
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("reclaims exclusive blobs when throttled metadata retention evicts by age or count", async () => {
		vi.useFakeTimers();
		try {
			for (const scenario of [
				{
					name: "age",
					retention: { maxAgeDays: 1 },
					backdateMs: 2 * 24 * 60 * 60 * 1_000,
					extraUnprotectedCheckpoint: false,
				},
				{
					name: "count",
					retention: { maxPerSession: 1 },
					backdateMs: 60 * 1_000,
					extraUnprotectedCheckpoint: true,
				},
			]) {
				const nowMs = Date.parse("2030-01-03T00:00:00.000Z");
				const harness = await openHarness(`retention-throttled-${scenario.name}`, {
					now: () => new Date(nowMs),
					retention: scenario.retention,
				});
				const originalRunRetention = harness.service.coordinator.runRetention.bind(harness.service.coordinator);
				const firstPassFinished = Promise.withResolvers<void>();
				const secondPassFinished = Promise.withResolvers<void>();
				const sweepContent: boolean[] = [];
				let callIndex = 0;
				const retentionSpy = spyOn(harness.service.coordinator, "runRetention").mockImplementation(
					async options => {
						const thisCall = callIndex++;
						sweepContent.push(options.sweepContent === true);
						try {
							return await originalRunRetention(options);
						} finally {
							if (thisCall === 0) firstPassFinished.resolve();
							if (thisCall === 1) secondPassFinished.resolve();
						}
					},
				);

				try {
					const sessionId = "retention-session";
					await writeText(harness.workspaceRoot, "payload.txt", `${scenario.name} evicted payload\n`);
					const evicted = await harness.service.create({
						rootPath: harness.workspaceRoot,
						reason: "turn",
						sessionId,
					});
					const contentStoreDir = path.join(
						harness.storeDir,
						"workspaces",
						harness.store.workspaceIdForRoot(harness.workspaceRoot),
					);
					const contentStore = await openWorkspaceContentStoreAt(contentStoreDir);
					const evictedObjectId = await checkpointFileObjectId(contentStore, evicted, "payload.txt");

					vi.advanceTimersByTime(250);
					await firstPassFinished.promise;
					setCheckpointCreatedAt(harness.store, evicted.id, new Date(nowMs - scenario.backdateMs).toISOString());

					if (scenario.extraUnprotectedCheckpoint) {
						await writeText(harness.workspaceRoot, "payload.txt", "count intermediate payload\n");
						const intermediate = await harness.service.create({
							rootPath: harness.workspaceRoot,
							reason: "turn",
							sessionId,
						});
						setCheckpointCreatedAt(harness.store, intermediate.id, new Date(nowMs - 30 * 1_000).toISOString());
					}
					await writeText(harness.workspaceRoot, "payload.txt", `${scenario.name} current payload\n`);
					const current = await harness.service.create({
						rootPath: harness.workspaceRoot,
						reason: "turn",
						sessionId,
					});
					setCheckpointCreatedAt(harness.store, current.id, new Date(nowMs).toISOString());
					vi.advanceTimersByTime(250);
					await secondPassFinished.promise;

					const remainingIds = checkpointIds(await harness.service.list({ rootPath: harness.workspaceRoot }));
					expect(sweepContent).toEqual([true, false]);
					expect(remainingIds).not.toContain(evicted.id);
					expect(remainingIds).toContain(current.id);
					expect(await contentStore.has(evictedObjectId)).toBeFalse();
					expect(await pathExists(objectPathFor(contentStoreDir, evictedObjectId))).toBeFalse();
				} finally {
					retentionSpy.mockRestore();
				}
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("coalesces creates during a slow full sweep into one metadata-only rerun", async () => {
		vi.useFakeTimers();
		try {
			const nowMs = Date.parse("2030-01-03T00:00:00.000Z");
			const harness = await openHarness("retention-slow-full-sweep", {
				now: () => new Date(nowMs),
			});
			const originalRunRetention = harness.service.coordinator.runRetention.bind(harness.service.coordinator);
			const firstSweepStarted = Promise.withResolvers<void>();
			const releaseFirstSweep = Promise.withResolvers<void>();
			const firstSweepFinished = Promise.withResolvers<void>();
			const metadataPassFinished = Promise.withResolvers<void>();
			const sweepContent: boolean[] = [];
			let callIndex = 0;
			const retentionSpy = spyOn(harness.service.coordinator, "runRetention").mockImplementation(async options => {
				const thisCall = callIndex++;
				sweepContent.push(options.sweepContent === true);
				if (thisCall === 0) {
					firstSweepStarted.resolve();
					await releaseFirstSweep.promise;
				}
				try {
					return await originalRunRetention(options);
				} finally {
					if (thisCall === 0) firstSweepFinished.resolve();
					if (thisCall === 1) metadataPassFinished.resolve();
				}
			});

			try {
				await writeText(harness.workspaceRoot, "note.txt", "first checkpoint\n");
				await harness.service.create({ rootPath: harness.workspaceRoot, reason: "turn" });
				vi.advanceTimersByTime(250);
				await firstSweepStarted.promise;

				for (const content of ["second checkpoint\n", "third checkpoint\n"]) {
					await writeText(harness.workspaceRoot, "note.txt", content);
					await harness.service.create({ rootPath: harness.workspaceRoot, reason: "turn" });
					vi.advanceTimersByTime(250);
				}
				expect(sweepContent).toEqual([true]);

				releaseFirstSweep.resolve();
				await metadataPassFinished.promise;
				await Promise.resolve();
				await Promise.resolve();
				expect(sweepContent).toEqual([true, false]);
			} finally {
				releaseFirstSweep.resolve();
				await firstSweepFinished.promise;
				retentionSpy.mockRestore();
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("reclaims exclusive blobs after age or count retention while preserving named, pinned, and current checkpoints", async () => {
		const retentionNow = new Date("2030-01-03T00:00:00.000Z");
		for (const scenario of [
			{
				name: "age",
				retention: { maxAgeDays: 1 },
				evictedAt: "2029-12-31T00:00:00.000Z",
				successorAt: null,
			},
			{
				name: "count",
				retention: { maxPerSession: 1 },
				evictedAt: "2029-12-31T00:00:00.000Z",
				successorAt: "2029-12-31T01:00:00.000Z",
			},
		]) {
			const harness = await openHarness(`retention-${scenario.name}`);
			const { store, storeDir, workspaceRoot } = harness;
			const sessionId = "retention-session";

			await writeText(workspaceRoot, "payload.txt", `${scenario.name} evicted payload\n`);
			const evicted = await harness.service.create({ rootPath: workspaceRoot, reason: "turn", sessionId });

			let countSurvivor: WorkspaceCheckpointRecord | null = null;
			if (scenario.successorAt) {
				await writeText(workspaceRoot, "payload.txt", `${scenario.name} count survivor payload\n`);
				countSurvivor = await harness.service.create({ rootPath: workspaceRoot, reason: "turn", sessionId });
			}

			await writeText(workspaceRoot, "payload.txt", `${scenario.name} named payload\n`);
			const named = await harness.service.create({
				rootPath: workspaceRoot,
				reason: "manual",
				sessionId,
				label: "keep named",
			});
			await writeText(workspaceRoot, "payload.txt", `${scenario.name} pinned payload\n`);
			const pinned = await harness.service.create({
				rootPath: workspaceRoot,
				reason: "manual",
				sessionId,
				pinned: true,
			});
			await writeText(workspaceRoot, "payload.txt", `${scenario.name} current payload\n`);
			const current = await harness.service.create({ rootPath: workspaceRoot, reason: "turn", sessionId });
			harness.service.dispose();

			const contentStoreDir = path.join(storeDir, "workspaces", store.workspaceIdForRoot(workspaceRoot));
			const contentStore = await openWorkspaceContentStoreAt(contentStoreDir);
			const evictedObjectId = await checkpointFileObjectId(contentStore, evicted, "payload.txt");
			const retainedObjects = [
				{ checkpoint: named, objectId: await checkpointFileObjectId(contentStore, named, "payload.txt") },
				{ checkpoint: pinned, objectId: await checkpointFileObjectId(contentStore, pinned, "payload.txt") },
				{ checkpoint: current, objectId: await checkpointFileObjectId(contentStore, current, "payload.txt") },
			];
			if (countSurvivor) {
				retainedObjects.push({
					checkpoint: countSurvivor,
					objectId: await checkpointFileObjectId(contentStore, countSurvivor, "payload.txt"),
				});
			}

			setCheckpointCreatedAt(store, evicted.id, scenario.evictedAt);
			if (countSurvivor && scenario.successorAt) {
				setCheckpointCreatedAt(store, countSurvivor.id, scenario.successorAt);
			}
			for (const checkpoint of [named, pinned, current]) {
				setCheckpointCreatedAt(store, checkpoint.id, "2029-12-31T02:00:00.000Z");
			}

			harness.service = await createWorkspaceCheckpointService({
				rootPath: workspaceRoot,
				storeDir,
				store,
				conversationAdapter: harness.conversation,
				mutatorGuard: harness.guard,
				now: () => retentionNow,
				retention: scenario.retention,
			});
			const result = await harness.service.runRetention();
			const keptIds = checkpointIds(await harness.service.list({ rootPath: workspaceRoot }));

			expect(result.removedCheckpointIds).toEqual([evicted.id]);
			expect(result.releasedObjectIds).toContain(evictedObjectId);
			expect(keptIds).not.toContain(evicted.id);
			expect(await contentStore.has(evictedObjectId)).toBeFalse();
			expect(await pathExists(objectPathFor(contentStoreDir, evictedObjectId))).toBeFalse();
			for (const { checkpoint, objectId } of retainedObjects) {
				expect(keptIds).toContain(checkpoint.id);
				expect(result.keptCheckpointIds).toContain(checkpoint.id);
				expect(await contentStore.has(objectId)).toBeTrue();
			}
		}
	});

	describe.skipIf(!git.isGitAvailable())("runRetention preserves Git capsule objects", () => {
		it("retains raw HEAD, index, and shared-index objects referenced by surviving checkpoints while sweeping orphaned blobs", async () => {
			const harness = await openHarness("retention-git");
			const { workspaceRoot, store, storeDir } = harness;

			await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
			await runGit(workspaceRoot, ["init", "-q", "--initial-branch=main"]);
			await runGit(workspaceRoot, ["config", "user.name", "Test"]);
			await runGit(workspaceRoot, ["config", "user.email", "test@example.com"]);
			await writeText(workspaceRoot, "file.txt", "snapshot content\n");
			await runGit(workspaceRoot, ["add", "."]);
			await runGit(workspaceRoot, ["commit", "-q", "--no-gpg-sign", "-m", "initial"]);

			const contentStoreDir = path.join(storeDir, "workspaces", store.workspaceIdForRoot(workspaceRoot));
			const contentStore = await openWorkspaceContentStoreAt(contentStoreDir);

			// Checkpoint 1: captures git state (HEAD, index, sharedindex) into manifest.
			await harness.service.create({ rootPath: workspaceRoot, reason: "manual" });

			// Checkpoint 2: same HEAD / index (no new commit).
			// Both cp1 and cp2 manifests reference identical rawHeadObjectId / index.objectId /
			// sharedIndexObjectIds. When cp1 is evicted those shared Git capsule objects
			// remain reachable through cp2's manifest and must NOT be swept.
			await writeText(workspaceRoot, "file.txt", "touched to dirty workspace\n");
			const cp2 = await harness.service.create({ rootPath: workspaceRoot, reason: "turn" });
			const manifest2 = await loadWorkspaceManifest(contentStore, cp2.manifestObjectId);
			expect(manifest2).not.toBeNull();

			// Collect git capsule ids from cp2's (surviving) manifest.
			const cp2GitIds: string[] = [];
			for (const repo of manifest2!.gitRepositories) {
				if (repo.rawHeadObjectId) cp2GitIds.push(repo.rawHeadObjectId);
				if (repo.index?.objectId) cp2GitIds.push(repo.index.objectId);
				for (const sid of repo.index?.sharedIndexObjectIds ?? []) cp2GitIds.push(sid);
			}

			harness.service.dispose();
			// dispose cancels future timers; this lock-taking sweep also waits for any
			// timer callback that was already running before disposal.
			await harness.service.runRetention();

			// Plant artificial orphans only after the automatic retention service is
			// stopped, so this explicit sweep is the operation that releases them.
			const orphan1 = await contentStore.putText("orphan blob one\n");
			const orphan2 = await contentStore.putText("orphan blob two\n");
			expect(await contentStore.has(orphan1.id)).toBeTrue();
			expect(await contentStore.has(orphan2.id)).toBeTrue();
			harness.service = await createWorkspaceCheckpointService({
				rootPath: workspaceRoot,
				storeDir,
				store,
				conversationAdapter: harness.conversation,
				mutatorGuard: harness.guard,
				retention: { maxAgeDays: 30 },
			});
			const result = await harness.service.runRetention();

			// Both orphaned blobs must be swept.
			expect(result.releasedObjectIds).toContain(orphan1.id);
			expect(result.releasedObjectIds).toContain(orphan2.id);
			expect(await contentStore.has(orphan1.id)).toBeFalse();
			expect(await contentStore.has(orphan2.id)).toBeFalse();

			// Every git capsule object referenced by cp2's surviving manifest must be retained.
			for (const id of cp2GitIds) {
				expect(await contentStore.has(id)).toBeTrue();
			}

			// No checkpoint evicted.
			expect(result.removedCheckpointIds).toHaveLength(0);
		});
	});

	it("fresh pending restore plan protects checkpoint from age eviction; expired plan lets checkpoint be evicted", async () => {
		const retentionNow = new Date("2030-01-03T00:00:00.000Z");

		for (const scenario of [
			{
				name: "fresh plan protects",
				planAgeMs: 60 * 60 * 1000, // 1h ago — within 24h TTL
				expectProtected: true,
			},
			{
				name: "expired plan allows eviction",
				planAgeMs: 25 * 60 * 60 * 1000 + 1, // >24h ago
				expectProtected: false,
			},
		]) {
			const harness = await openHarness(`retention-pending-plan-${scenario.name}`);
			const { workspaceRoot, store } = harness;

			await writeText(workspaceRoot, "note.txt", "checkpoint content\n");
			const checkpoint = await harness.service.create({ rootPath: workspaceRoot, reason: "manual" });
			// A later checkpoint is the workspace current root, leaving the target's
			// retention outcome dependent only on its pending plan's TTL.
			await writeText(workspaceRoot, "note.txt", "current checkpoint\n");
			await harness.service.create({ rootPath: workspaceRoot, reason: "turn" });
			harness.service.dispose();

			// Backdate checkpoint so age eviction applies (maxAgeDays=1 means < 24h).
			const db = new Database((store as CheckpointMetadataStore & { dbPath: string }).dbPath);
			try {
				db.prepare("UPDATE checkpoints SET created_at = ? WHERE id = ?").run(
					"2029-12-31T02:00:00.000Z",
					checkpoint.id,
				);
			} finally {
				db.close();
			}

			// A pending restore plan protects the checkpoint (within 24h TTL).
			// An expired plan (>24h) is marked failed and no longer protects it.
			const plan = await store.createRestorePlan({
				checkpointId: checkpoint.id,
				rootPath: workspaceRoot,
				scope: "code",
				strategy: "preserve",
				operations: [],
				conflicts: [],
			});
			const planCreatedAt = new Date(retentionNow.getTime() - scenario.planAgeMs).toISOString();
			const planDb = new Database((store as CheckpointMetadataStore & { dbPath: string }).dbPath);
			try {
				planDb.prepare("UPDATE restore_plans SET created_at = ? WHERE id = ?").run(planCreatedAt, plan.id);
			} finally {
				planDb.close();
			}

			if (!scenario.expectProtected) {
				// Keep the checkpoint for one retention pass so the plan's terminal
				// status remains observable instead of being removed by FK cascade.
				await store.updateCheckpoint(checkpoint.id, { label: "observe expired plan" });
			}

			harness.service = await createWorkspaceCheckpointService({
				rootPath: workspaceRoot,
				storeDir: harness.storeDir,
				store,
				conversationAdapter: harness.conversation,
				mutatorGuard: harness.guard,
				now: () => retentionNow,
				retention: { maxAgeDays: 1 },
			});
			const firstResult = await harness.service.runRetention();

			if (scenario.expectProtected) {
				expect(firstResult.removedCheckpointIds).not.toContain(checkpoint.id);
				const list = await harness.service.list({ rootPath: workspaceRoot });
				expect(list.map(cp => cp.id)).toContain(checkpoint.id);
			} else {
				// It survives this pass solely because it is named; the expired pending
				// plan was terminally failed rather than used as a protection root.
				expect(firstResult.removedCheckpointIds).not.toContain(checkpoint.id);
				const expiredPlan = await store.getRestorePlan(plan.id);
				expect(expiredPlan?.status).toBe("failed");
				expect(expiredPlan?.failedReason).toBe("restore plan expired before apply");

				await store.updateCheckpoint(checkpoint.id, { label: null });
				const secondResult = await harness.service.runRetention();
				expect(secondResult.removedCheckpointIds).toContain(checkpoint.id);
				const list = await harness.service.list({ rootPath: workspaceRoot });
				expect(list.map(cp => cp.id)).not.toContain(checkpoint.id);
			}
		}
	});

	it("runRetention throws on corrupt manifest and deletes no CAS objects", async () => {
		const harness = await openHarness("retention-corrupt-manifest");
		const { workspaceRoot, store, storeDir } = harness;

		await writeText(workspaceRoot, "note.txt", "checkpoint content\n");
		const checkpoint = await harness.service.create({ rootPath: workspaceRoot, reason: "manual" });
		const contentStoreDir = path.join(storeDir, "workspaces", store.workspaceIdForRoot(workspaceRoot));
		const contentStore = await openWorkspaceContentStoreAt(contentStoreDir);
		const manifestPath = objectPathFor(contentStoreDir, checkpoint.manifestObjectId);

		// Plant a second orphan blob so the reachable set is non-trivial.
		const orphan = await contentStore.putText("orphan blob\n");

		// Corrupt the manifest blob (overwrite with non-JSON, breaking the stored hash).
		await fs.writeFile(manifestPath, "not valid json or wrong hash", "utf8");

		harness.service.dispose();
		harness.service = await createWorkspaceCheckpointService({
			rootPath: workspaceRoot,
			storeDir,
			store,
			conversationAdapter: harness.conversation,
			mutatorGuard: harness.guard,
			retention: { maxAgeDays: 1 },
		});

		const error = await expectRejected(harness.service.runRetention());
		expect(error).toBeInstanceOf(WorkspaceCheckpointError);
		expect((error as Error).message).toMatch(/manifest/i);

		// sweepUnreachable must NOT have been called — orphan is still present.
		expect(await contentStore.has(orphan.id)).toBeTrue();

		// Checkpoint metadata row is still present (deletion happens after sweep).
		const list = await harness.service.list({ rootPath: workspaceRoot });
		expect(list.map(cp => cp.id)).toContain(checkpoint.id);
	});

	it("putStream failure leaves no .tmp staging files behind", async () => {
		const harness = await openHarness("cas-staging-cleanup");
		const { workspaceRoot, storeDir, store } = harness;
		const contentStoreDir = path.join(storeDir, "workspaces", store.workspaceIdForRoot(workspaceRoot));
		const contentStore = await openWorkspaceContentStoreAt(contentStoreDir);
		const tempDir = path.join(contentStoreDir, "checkpoints", "v1", ".tmp");

		// Stream that yields one chunk then throws — mimics a source/read error mid-stream.
		async function* badStream(): AsyncIterable<Uint8Array> {
			yield new TextEncoder().encode("partial\n");
			throw new Error("simulated read failure");
		}

		await expectRejected(contentStore.putStream(badStream()));

		// After the rejected putStream, the .tmp directory must be empty (no orphaned staging files).
		const tmpFiles: string[] = [];
		try {
			const entries = await fs.readdir(tempDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isFile()) tmpFiles.push(entry.name);
			}
		} catch {
			// .tmp may not exist if the first mkdir also failed — also fine.
		}
		expect(tmpFiles.filter(n => n.startsWith("obj-"))).toHaveLength(0);
	});
	it.skipIf(!git.isGitAvailable())(
		"persists an ignored existing-file baseline across reopen and restores both updates and deletions",
		async () => {
			const harness = await openHarness("ignored-existing-baseline");
			const { workspaceRoot, store, storeDir } = harness;
			const ignoredPath = "ignored/existing.txt";
			const gitignoreText = "ignored/\n";
			const baselineText = "ignored state before mutation\n";
			const changedText = "ignored state after mutation\n";
			await runGit(workspaceRoot, ["init", "-q"]);
			await writeText(workspaceRoot, ".gitignore", gitignoreText);
			await runGit(workspaceRoot, ["add", "--", ".gitignore"]);
			await writeText(workspaceRoot, ignoredPath, baselineText);

			const checkpoint = await harness.service.create({ rootPath: workspaceRoot, reason: "manual" });
			const contentStoreDir = path.join(storeDir, "workspaces", store.workspaceIdForRoot(workspaceRoot));
			const contentStore = await openWorkspaceContentStoreAt(contentStoreDir);
			const initialManifest = await loadWorkspaceManifest(contentStore, checkpoint.manifestObjectId);
			if (!initialManifest) throw new Error("Initial Git-aware manifest was not loadable");
			expect(initialManifest.respectsGitIgnore).toBeTrue();
			expect(initialManifest.entries.some(entry => entry.path === ignoredPath)).toBeFalse();

			const baseline = await harness.service.captureIgnoredPathBaseline({
				rootPath: workspaceRoot,
				path: ignoredPath,
			});
			if (!baseline) throw new Error("Ignored existing path baseline was not captured");
			expect(baseline.id).toBe(checkpoint.id);
			expect(baseline.manifestObjectId).not.toBe(checkpoint.manifestObjectId);
			const baselineManifest = await loadWorkspaceManifest(contentStore, baseline.manifestObjectId);
			if (!baselineManifest) throw new Error("Updated ignored-path manifest was not loadable");
			expect(baselineManifest.respectsGitIgnore).toBeTrue();
			expect(baselineManifest.trackedIgnoredPaths).toEqual([ignoredPath]);
			const baselineEntry = baselineManifest.entries.find(entry => entry.path === ignoredPath);
			if (!baselineEntry?.objectId) throw new Error("Ignored existing path is missing from the updated manifest");
			const baselineBytes = await contentStore.readBytes(baselineEntry.objectId);
			if (!baselineBytes) throw new Error("Ignored existing path baseline object is missing");
			expect(Buffer.from(baselineBytes).toString("utf8")).toBe(baselineText);
			expect(baseline.fileCount).toBe(2);
			expect(baseline.totalBytes).toBe(Buffer.byteLength(gitignoreText) + Buffer.byteLength(baselineText));

			await reopenService(harness);
			const reopenedCheckpoint = await harness.store.getCheckpoint(checkpoint.id);
			if (!reopenedCheckpoint) throw new Error("Ignored existing path checkpoint did not survive reopen");
			expect(reopenedCheckpoint).toEqual(
				expect.objectContaining({
					manifestObjectId: baseline.manifestObjectId,
					fileCount: baseline.fileCount,
					totalBytes: baseline.totalBytes,
				}),
			);

			await writeText(workspaceRoot, ignoredPath, changedText);
			const updatePlan = await harness.service.previewRestore({
				checkpointId: checkpoint.id,
				scope: "code",
				strategy: "preserve",
			});
			expect(updatePlan.operations).toEqual([
				expect.objectContaining({
					path: ignoredPath,
					kind: "update",
					objectId: baselineEntry.objectId,
					expectedKind: "file",
					expectedObjectId: sha256ObjectId(changedText),
				}),
			]);
			const updateResult = await harness.service.restore({ planId: updatePlan.id });
			expect(updateResult.restoredPaths).toEqual([ignoredPath]);
			expect(await readText(workspaceRoot, ignoredPath)).toBe(baselineText);

			await removePath(workspaceRoot, ignoredPath);
			const recreatePlan = await harness.service.previewRestore({
				checkpointId: checkpoint.id,
				scope: "code",
				strategy: "preserve",
			});
			expect(recreatePlan.operations).toEqual([
				expect.objectContaining({ path: ignoredPath, kind: "create", objectId: baselineEntry.objectId }),
			]);
			const recreateResult = await harness.service.restore({ planId: recreatePlan.id });
			expect(recreateResult.restoredPaths).toEqual([ignoredPath]);
			expect(await readText(workspaceRoot, ignoredPath)).toBe(baselineText);
		},
	);

	it.skipIf(!git.isGitAvailable())(
		"records an ignored absence tombstone and deletes a later ignored file during restore",
		async () => {
			const harness = await openHarness("ignored-tombstone-baseline");
			const { workspaceRoot, store, storeDir } = harness;
			const ignoredPath = "ignored/later.txt";
			const gitignoreText = "ignored/\n";
			const laterText = "created after the checkpoint\n";
			await runGit(workspaceRoot, ["init", "-q"]);
			await writeText(workspaceRoot, ".gitignore", gitignoreText);
			await runGit(workspaceRoot, ["add", "--", ".gitignore"]);

			const checkpoint = await harness.service.create({ rootPath: workspaceRoot, reason: "manual" });
			const contentStoreDir = path.join(storeDir, "workspaces", store.workspaceIdForRoot(workspaceRoot));
			const contentStore = await openWorkspaceContentStoreAt(contentStoreDir);
			expect(await git.ignore.isIgnored(workspaceRoot, ignoredPath)).toBeTrue();
			const workspaceState = await harness.store.getWorkspaceState(workspaceRoot);
			expect(workspaceState?.undoHeadCheckpointId).toBe(checkpoint.id);
			const repositoryRoot = await git.repo.root(workspaceRoot);
			if (!repositoryRoot) throw new Error("Git repository root was not discoverable for tombstone capture");
			const repositoryRelativePath = path.relative(repositoryRoot, path.resolve(workspaceRoot, ignoredPath));
			expect(repositoryRelativePath).toBe(ignoredPath);
			expect(await git.ignore.isIgnored(repositoryRoot, repositoryRelativePath)).toBeTrue();
			const baseline = await harness.service.captureIgnoredPathBaseline({
				rootPath: workspaceRoot,
				path: ignoredPath,
			});
			if (!baseline) throw new Error("Ignored absence tombstone was not captured");
			const tombstoneManifest = await loadWorkspaceManifest(contentStore, baseline.manifestObjectId);
			if (!tombstoneManifest) throw new Error("Ignored tombstone manifest was not loadable");
			expect(tombstoneManifest.respectsGitIgnore).toBeTrue();
			expect(tombstoneManifest.trackedIgnoredPaths).toEqual([ignoredPath]);
			expect(tombstoneManifest.entries.some(entry => entry.path === ignoredPath)).toBeFalse();
			expect(baseline.fileCount).toBe(checkpoint.fileCount);
			expect(baseline.totalBytes).toBe(checkpoint.totalBytes);

			await writeText(workspaceRoot, ignoredPath, laterText);
			const plan = await harness.service.previewRestore({
				checkpointId: checkpoint.id,
				scope: "code",
				strategy: "preserve",
			});
			expect(plan.operations).toEqual([
				expect.objectContaining({
					path: ignoredPath,
					kind: "delete",
					expectedKind: "file",
					expectedObjectId: sha256ObjectId(laterText),
				}),
			]);
			const result = await harness.service.restore({ planId: plan.id });
			expect(result.restoredPaths).toEqual([ignoredPath]);
			expect(await readText(workspaceRoot, ignoredPath)).toBeNull();
		},
	);

	it.skipIf(!git.isGitAvailable())(
		"restores ignored files from a legacy full manifest after the workspace becomes Git-aware",
		async () => {
			const harness = await openHarness("legacy-full-manifest-git");
			const { workspaceRoot, store, storeDir } = harness;
			const ignoredPath = "ignored/legacy.txt";
			const baselineText = "legacy full snapshot content\n";
			const changedText = "changed after Git initialization\n";
			await writeText(workspaceRoot, ".gitignore", "ignored/\n");
			await writeText(workspaceRoot, ignoredPath, baselineText);

			const checkpoint = await harness.service.create({ rootPath: workspaceRoot, reason: "manual" });
			const contentStoreDir = path.join(storeDir, "workspaces", store.workspaceIdForRoot(workspaceRoot));
			const contentStore = await openWorkspaceContentStoreAt(contentStoreDir);
			const legacyManifest = await loadWorkspaceManifest(contentStore, checkpoint.manifestObjectId);
			if (!legacyManifest) throw new Error("Legacy full manifest was not loadable");
			expect(legacyManifest.respectsGitIgnore).toBeFalse();
			const legacyEntry = legacyManifest.entries.find(entry => entry.path === ignoredPath);
			if (!legacyEntry?.objectId) throw new Error("Legacy full manifest did not capture ignored content");

			await runGit(workspaceRoot, ["init", "-q"]);
			await writeText(workspaceRoot, ignoredPath, changedText);
			const plan = await harness.service.previewRestore({
				checkpointId: checkpoint.id,
				scope: "code",
				strategy: "preserve",
			});
			expect(plan.operations).toEqual([
				expect.objectContaining({
					path: ignoredPath,
					kind: "update",
					objectId: legacyEntry.objectId,
					expectedKind: "file",
					expectedObjectId: sha256ObjectId(changedText),
				}),
			]);
			const result = await harness.service.restore({ planId: plan.id });
			expect(result.restoredPaths).toEqual([ignoredPath]);
			expect(await readText(workspaceRoot, ignoredPath)).toBe(baselineText);
		},
	);

	it.skipIf(!git.isGitAvailable())(
		"excludes ordinary ignored large files from Git checkpoint metadata and CAS",
		async () => {
			const harness = await openHarness("git-ignored-large-metadata");
			const { workspaceRoot, store, storeDir } = harness;
			const gitignoreText = "ignored-large.bin\n";
			const trackedText = "tracked checkpoint content\n";
			const untrackedText = "nonignored untracked checkpoint content\n";
			const ignoredPayload = new Uint8Array(1024 * 1024 + 17).fill(0xa7);
			await runGit(workspaceRoot, ["init", "-q"]);
			await writeText(workspaceRoot, ".gitignore", gitignoreText);
			await writeText(workspaceRoot, "tracked.txt", trackedText);
			await runGit(workspaceRoot, ["add", "--", ".gitignore", "tracked.txt"]);
			await writeText(workspaceRoot, "notes.txt", untrackedText);
			await writeBytes(workspaceRoot, "ignored-large.bin", ignoredPayload);

			const checkpoint = await harness.service.create({ rootPath: workspaceRoot, reason: "manual" });
			const contentStoreDir = path.join(storeDir, "workspaces", store.workspaceIdForRoot(workspaceRoot));
			const contentStore = await openWorkspaceContentStoreAt(contentStoreDir);
			const manifest = await loadWorkspaceManifest(contentStore, checkpoint.manifestObjectId);
			if (!manifest) throw new Error("Git-aware checkpoint manifest was not loadable");
			const expectedFilePaths = [".gitignore", "notes.txt", "tracked.txt"];
			const expectedTotalBytes =
				Buffer.byteLength(gitignoreText) + Buffer.byteLength(trackedText) + Buffer.byteLength(untrackedText);
			expect(manifest.respectsGitIgnore).toBeTrue();
			expect(manifest.entries.filter(entry => entry.kind === "file").map(entry => entry.path)).toEqual(
				expectedFilePaths,
			);
			expect(manifest.entries.some(entry => entry.path === "ignored-large.bin")).toBeFalse();
			expect(checkpoint.fileCount).toBe(expectedFilePaths.length);
			expect(checkpoint.totalBytes).toBe(expectedTotalBytes);
			const storedCheckpoint = await harness.store.getCheckpoint(checkpoint.id);
			if (!storedCheckpoint) throw new Error("Git-aware checkpoint metadata was not persisted");
			expect(storedCheckpoint).toEqual(
				expect.objectContaining({ fileCount: expectedFilePaths.length, totalBytes: expectedTotalBytes }),
			);
			expect(await contentStore.has(sha256ObjectId(ignoredPayload))).toBeFalse();
		},
	);
});
