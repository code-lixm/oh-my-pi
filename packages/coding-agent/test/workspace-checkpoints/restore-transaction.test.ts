import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireWorkspaceLock,
	WorkspaceLockUnavailableError,
	withWorkspaceLock,
} from "../../src/workspace-checkpoints/locks";
import {
	createFileObjectReader,
	createRestoreTransaction,
	recoverPendingRestoreTransactions,
	resolveRestoreTransactionJournalPath,
	WorkspaceRestoreTransactionError,
} from "../../src/workspace-checkpoints/restore-transaction";
import type { WorkspaceRestoreOperation } from "../../src/workspace-checkpoints/types";

const WORKSPACE_ID = "test-workspace-001";
const _roots: string[] = [];

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.promises.lstat(target);
		return true;
	} catch {
		return false;
	}
}

function isPathInsideRoot(root: string, target: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Isolated temp root, cleaned up in afterEach. */
async function makeRoot(label = "restore-tx"): Promise<string> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `omp-${label}-`));
	_roots.push(root);
	return root;
}

/** Writes a file under `root` and returns its absolute path. */
async function write(root: string, rel: string, content: string, mode?: number): Promise<string> {
	const abs = path.join(root, rel);
	await fs.promises.mkdir(path.dirname(abs), { recursive: true });
	await fs.promises.writeFile(abs, content, "utf8");
	if (mode !== undefined) await fs.promises.chmod(abs, mode);
	return abs;
}

/** Reads a file under `root`. Returns null if absent. */
async function read(root: string, rel: string): Promise<string | null> {
	const abs = path.join(root, rel);
	try {
		return await fs.promises.readFile(abs, "utf8");
	} catch {
		return null;
	}
}

/** Returns the file mode & 0o7777, or null if absent. */
async function fileMode(root: string, rel: string): Promise<number | null> {
	const abs = path.join(root, rel);
	try {
		const s = await fs.promises.lstat(abs);
		return s.mode & 0o7777;
	} catch {
		return null;
	}
}

/** Returns the symlink target, or null if not a symlink. */
async function readLink(root: string, rel: string): Promise<string | null> {
	const abs = path.join(root, rel);
	try {
		const s = await fs.promises.lstat(abs);
		if (!s.isSymbolicLink()) return null;
		return await fs.promises.readlink(abs);
	} catch {
		return null;
	}
}

interface ObjectStore {
	reader: (objectId: string) => Promise<Uint8Array | null>;
	put: (objectId: string, content: string | Uint8Array) => void;
	store: Map<string, Uint8Array>;
}

/** Maps objectId → content bytes. Self-contained per-test object store. */
function makeObjectStore(): ObjectStore {
	const store = new Map<string, Uint8Array>();
	return {
		store,
		reader: (objectId: string) => Promise.resolve(store.get(objectId) ?? null),
		put(objectId: string, content: string | Uint8Array) {
			store.set(objectId, typeof content === "string" ? new TextEncoder().encode(content) : content);
		},
	};
}

/** Returns the absolute journal path for the given tx id. */
function journalPath(root: string, txId: string, checkpointsBaseDir?: string): string {
	return resolveRestoreTransactionJournalPath({ rootPath: root, checkpointsBaseDir }, txId);
}

/** Reads and parses the journal file. Returns null if absent. */
async function readJournal(
	root: string,
	txId: string,
	checkpointsBaseDir?: string,
): Promise<Record<string, unknown> | null> {
	const p = journalPath(root, txId, checkpointsBaseDir);
	try {
		return JSON.parse(await fs.promises.readFile(p, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

// ─── restore-transaction tests ────────────────────────────────────────────────

describe("createRestoreTransaction", () => {
	describe("root-escape path rejection", () => {
		it("rejects a path that is ..-prefixed (relative parent)", async () => {
			const root = await makeRoot("escape-rel");
			const { reader, put } = makeObjectStore();
			put("aaaaaaaaaaaaaaaa", "hello");
			const ops: WorkspaceRestoreOperation[] = [
				{ path: "../etc/passwd", kind: "create", objectId: "aaaaaaaaaaaaaaaa" },
			];
			await expect(
				createRestoreTransaction({
					rootPath: root,
					workspaceId: WORKSPACE_ID,
					operations: ops,
					readObject: reader,
				}),
			).rejects.toThrow();
		});

		it("rejects an absolute path pointing outside the root", async () => {
			const root = await makeRoot("escape-abs");
			const { reader, put } = makeObjectStore();
			put("aaaaaaaaaaaaaaaa", "secret");
			const outside = path.join(os.tmpdir(), "outside-file");
			await fs.promises.writeFile(outside, "already there", "utf8");
			try {
				const ops: WorkspaceRestoreOperation[] = [{ path: outside, kind: "create", objectId: "aaaaaaaaaaaaaaaa" }];
				await expect(
					createRestoreTransaction({
						rootPath: root,
						workspaceId: WORKSPACE_ID,
						operations: ops,
						readObject: reader,
					}),
				).rejects.toThrow();
			} finally {
				await fs.promises.unlink(outside).catch(() => undefined);
			}
		});

		it("rejects a path with a symlink parent component that escapes root", async () => {
			const root = await makeRoot("escape-symlink-parent");
			const { reader, put } = makeObjectStore();
			put("aaaaaaaaaaaaaaaa", "data");

			// Create a symlink inside root that points outside.
			const link = path.join(root, "escape-link");
			await fs.promises.symlink(os.tmpdir(), link);

			try {
				const ops: WorkspaceRestoreOperation[] = [
					{ path: "escape-link/nested-file", kind: "create", objectId: "aaaaaaaaaaaaaaaa" },
				];
				const tx = await createRestoreTransaction({
					rootPath: root,
					workspaceId: WORKSPACE_ID,
					operations: ops,
					readObject: reader,
				});
				await expect(tx.prepare()).rejects.toThrow();
			} finally {
				await fs.promises.unlink(link).catch(() => undefined);
			}
		});
	});

	describe("journal lifecycle", () => {
		it("writes a PREPARED journal before any disk mutation (prepare)", async () => {
			const root = await makeRoot("journal-prepared");
			const checkpointsBaseDir = await makeRoot("journal-store");
			const { reader, put } = makeObjectStore();
			put("aaaaaaaaaaaaaaaa", "content-v1");
			const ops: WorkspaceRestoreOperation[] = [{ path: "a/b.txt", kind: "create", objectId: "aaaaaaaaaaaaaaaa" }];
			const tx = await createRestoreTransaction({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				operations: ops,
				readObject: reader,
				checkpointsBaseDir,
			});

			const j = await readJournal(root, tx.id, checkpointsBaseDir);
			expect(j).not.toBeNull();
			expect(j!.state).toBe("PREPARED");
			expect(await read(root, "a/b.txt")).toBeNull();

			await tx.prepare();
			const jAfter = await readJournal(root, tx.id, checkpointsBaseDir);
			expect(jAfter!.state).toBe("PREPARED");
			expect(await read(root, "a/b.txt")).toBe("content-v1");

			await tx.apply();
			const jCommitted = await readJournal(root, tx.id, checkpointsBaseDir);
			expect(jCommitted!.state).toBe("COMMITTED");
		});

		it("COMMITTED journal blocks rollback", async () => {
			const root = await makeRoot("committed-block-rollback");
			const { reader, put } = makeObjectStore();
			put("aaaaaaaaaaaaaaaa", "final");
			const ops: WorkspaceRestoreOperation[] = [{ path: "f.txt", kind: "create", objectId: "aaaaaaaaaaaaaaaa" }];
			const tx = await createRestoreTransaction({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				operations: ops,
				readObject: reader,
			});
			await tx.prepare();
			await tx.apply();

			await expect(tx.rollback()).rejects.toThrow();
		});

		it("ROLLLED_BACK journal is a no-op on second rollback", async () => {
			const root = await makeRoot("double-rollback");
			const { reader, put } = makeObjectStore();
			put("aaaaaaaaaaaaaaaa", "gone");
			const ops: WorkspaceRestoreOperation[] = [{ path: "z.txt", kind: "create", objectId: "aaaaaaaaaaaaaaaa" }];
			const tx = await createRestoreTransaction({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				operations: ops,
				readObject: reader,
			});
			await tx.prepare();
			await tx.rollback();

			// Second rollback — no-op, no throw.
			const result = await tx.rollback();
			expect(result.state).toBe("ROLLED_BACK");
			expect(result.rolledBackPaths).toHaveLength(0);
		});
	});

	describe("atomic create", () => {
		it("creates a file with correct content and default mode", async () => {
			const root = await makeRoot("atomic-create");
			const { reader, put } = makeObjectStore();
			put("aaaaaaaaaaaaaaaa", "hello world");
			const ops: WorkspaceRestoreOperation[] = [
				{ path: "created.txt", kind: "create", objectId: "aaaaaaaaaaaaaaaa" },
			];
			const tx = await createRestoreTransaction({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				operations: ops,
				readObject: reader,
			});
			await tx.prepare();
			await tx.apply();

			expect(await read(root, "created.txt")).toBe("hello world");
			const mode = await fileMode(root, "created.txt");
			expect(mode).toBe(0o600);
		});

		it("creates a file with explicit mode", async () => {
			const root = await makeRoot("atomic-create-mode");
			const { reader, put } = makeObjectStore();
			put("aaaaaaaaaaaaaaaa", "exec me");
			const ops: WorkspaceRestoreOperation[] = [
				{ path: "script.sh", kind: "create", objectId: "aaaaaaaaaaaaaaaa", mode: 0o755 },
			];
			const tx = await createRestoreTransaction({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				operations: ops,
				readObject: reader,
			});
			await tx.prepare();
			await tx.apply();

			expect(await read(root, "script.sh")).toBe("exec me");
			const mode = await fileMode(root, "script.sh");
			expect(mode).toBe(0o755);
		});

		it("rollback of create removes the file", async () => {
			const root = await makeRoot("rollback-create");
			const { reader, put } = makeObjectStore();
			put("aaaaaaaaaaaaaaaa", "temporary");
			const ops: WorkspaceRestoreOperation[] = [{ path: "temp.txt", kind: "create", objectId: "aaaaaaaaaaaaaaaa" }];
			const tx = await createRestoreTransaction({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				operations: ops,
				readObject: reader,
			});
			await tx.prepare();
			expect(await read(root, "temp.txt")).toBe("temporary");
			await tx.rollback();

			expect(await read(root, "temp.txt")).toBeNull();
		});
	});

	describe("atomic update", () => {
		it("overwrites existing file and snapshots original for rollback", async () => {
			const root = await makeRoot("atomic-update");
			await write(root, "target.txt", "original content", 0o644);
			const { reader, put } = makeObjectStore();
			put("aaaaaaaaaaaaaaaa", "updated content");

			const ops: WorkspaceRestoreOperation[] = [
				{ path: "target.txt", kind: "update", objectId: "aaaaaaaaaaaaaaaa" },
			];
			const tx = await createRestoreTransaction({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				operations: ops,
				readObject: reader,
			});
			await tx.prepare();

			expect(await read(root, "target.txt")).toBe("updated content");

			await tx.rollback();
			expect(await read(root, "target.txt")).toBe("original content");
			expect(await fileMode(root, "target.txt")).toBe(0o644);
		});

		it("rollback restores explicit mode change", async () => {
			const root = await makeRoot("update-chmod-rollback");
			await write(root, "mode-file", "data", 0o600);
			const { reader, put } = makeObjectStore();
			put("aaaaaaaaaaaaaaaa", "stricter");
			const ops: WorkspaceRestoreOperation[] = [
				{ path: "mode-file", kind: "update", objectId: "aaaaaaaaaaaaaaaa", mode: 0o644 },
			];
			const tx = await createRestoreTransaction({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				operations: ops,
				readObject: reader,
			});
			await tx.prepare();

			expect(await fileMode(root, "mode-file")).toBe(0o644);
			await tx.rollback();
			expect(await fileMode(root, "mode-file")).toBe(0o600);
		});
	});

	describe("atomic delete", () => {
		it("deletes existing file and snapshots for rollback", async () => {
			const root = await makeRoot("atomic-delete");
			await write(root, "delete-me.txt", "to be deleted");
			const { reader, put } = makeObjectStore();
			put("aaaaaaaaaaaaaaaa", "snapshot irrelevant");
			const ops: WorkspaceRestoreOperation[] = [
				{ path: "delete-me.txt", kind: "delete", objectId: "aaaaaaaaaaaaaaaa" },
			];
			const tx = await createRestoreTransaction({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				operations: ops,
				readObject: reader,
			});
			await tx.prepare();

			expect(await read(root, "delete-me.txt")).toBeNull();

			await tx.rollback();
			expect(await read(root, "delete-me.txt")).toBe("to be deleted");
		});

		it("delete of absent file is a no-op applied=false", async () => {
			const root = await makeRoot("delete-missing");
			const { reader, put } = makeObjectStore();
			put("aaaaaaaaaaaaaaaa", "data");
			const ops: WorkspaceRestoreOperation[] = [
				{ path: "does-not-exist.txt", kind: "delete", objectId: "aaaaaaaaaaaaaaaa" },
			];
			const tx = await createRestoreTransaction({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				operations: ops,
				readObject: reader,
			});
			const snap = await tx.prepare();

			expect(snap.state).toBe("PREPARED");
			expect(await read(root, "does-not-exist.txt")).toBeNull();
			const rb = await tx.rollback();
			expect(rb.rolledBackPaths).toContain("does-not-exist.txt");
		});
	});

	describe("chmod operation", () => {
		it("changes file mode and rollback restores original mode", async () => {
			const root = await makeRoot("chmod-basic");
			await write(root, "perms.bin", "data", 0o644);
			const { reader, put } = makeObjectStore();
			put("aaaaaaaaaaaaaaaa", "unused");
			const ops: WorkspaceRestoreOperation[] = [{ path: "perms.bin", kind: "chmod", mode: 0o755 }];
			const tx = await createRestoreTransaction({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				operations: ops,
				readObject: reader,
			});
			await tx.prepare();

			expect(await fileMode(root, "perms.bin")).toBe(0o755);

			await tx.rollback();
			expect(await fileMode(root, "perms.bin")).toBe(0o644);
			expect(await read(root, "perms.bin")).toBe("data");
		});

		it("chmod on absent file is a no-op", async () => {
			const root = await makeRoot("chmod-missing");
			const { reader, put } = makeObjectStore();
			put("aaaaaaaaaaaaaaaa", "data");
			const ops: WorkspaceRestoreOperation[] = [{ path: "absent.txt", kind: "chmod", mode: 0o700 }];
			const tx = await createRestoreTransaction({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				operations: ops,
				readObject: reader,
			});
			const snap = await tx.prepare();
			expect(snap.state).toBe("PREPARED");
			expect(await read(root, "absent.txt")).toBeNull();
		});
	});

	describe("symlink operation", () => {
		it("creates a symlink with the given target", async () => {
			const root = await makeRoot("symlink-basic");
			const { reader, put } = makeObjectStore();
			put("aaaaaaaaaaaaaaaa", "unused");
			const ops: WorkspaceRestoreOperation[] = [
				{ path: "link-to-readme", kind: "symlink", linkTarget: "README.md" },
			];
			const tx = await createRestoreTransaction({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				operations: ops,
				readObject: reader,
			});
			await tx.prepare();
			await tx.apply();

			expect(await readLink(root, "link-to-readme")).toBe("README.md");
		});

		it("refuses to clobber an existing node", async () => {
			const root = await makeRoot("symlink-clobber");
			await write(root, "existing.txt", "I exist");
			const { reader, put } = makeObjectStore();
			put("aaaaaaaaaaaaaaaa", "data");
			const ops: WorkspaceRestoreOperation[] = [{ path: "existing.txt", kind: "symlink", linkTarget: "now-a-link" }];
			const tx = await createRestoreTransaction({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				operations: ops,
				readObject: reader,
			});
			await expect(tx.prepare()).rejects.toThrow();
		});
	});

	describe("readObject failure → rollback", () => {
		it("partially-applied operations are rolled back when readObject fails mid-prepare", async () => {
			const root = await makeRoot("reader-fail");
			await write(root, "already.txt", "already on disk");

			const { reader: okReader, put: okPut } = makeObjectStore();
			okPut("aaaaaaaaaaaaaaaa", "first content");

			// A reader that fails for objectId "bbbbbbbbbbbbbbbb".
			const failingReader = async (objectId: string): Promise<Uint8Array | null> => {
				if (objectId === "bbbbbbbbbbbbbbbb") throw new Error("disk read error");
				return okReader(objectId);
			};

			// First operation succeeds, second fails.
			const ops: WorkspaceRestoreOperation[] = [
				{ path: "first.txt", kind: "create", objectId: "aaaaaaaaaaaaaaaa" },
				{ path: "second.txt", kind: "create", objectId: "bbbbbbbbbbbbbbbb" },
			];
			const tx = await createRestoreTransaction({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				operations: ops,
				readObject: failingReader,
			});
			await expect(tx.prepare()).rejects.toThrow();

			// First file must have been rolled back.
			expect(await read(root, "first.txt")).toBeNull();
			// Already-existed file untouched.
			expect(await read(root, "already.txt")).toBe("already on disk");
		});

		it("readObject returning null throws during apply", async () => {
			const root = await makeRoot("reader-null");
			const { reader: okReader, put: okPut } = makeObjectStore();
			okPut("aaaaaaaaaaaaaaaa", "data");
			// A reader that returns null for "bbbbbbbbbbbbbbbb".
			const nullReader = async (objectId: string): Promise<Uint8Array | null> => {
				if (objectId === "bbbbbbbbbbbbbbbb") return null;
				return okReader(objectId);
			};
			const ops: WorkspaceRestoreOperation[] = [
				{ path: "present.txt", kind: "create", objectId: "aaaaaaaaaaaaaaaa" },
				{ path: "missing.txt", kind: "create", objectId: "bbbbbbbbbbbbbbbb" },
			];
			const tx = await createRestoreTransaction({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				operations: ops,
				readObject: nullReader,
			});
			await expect(tx.prepare()).rejects.toThrow();
		});
	});
});

describe("recoverPendingRestoreTransactions", () => {
	it("PREPARED journal: rolls back and reports rolledBack count", async () => {
		const root = await makeRoot("recover-prepared");
		const checkpointsBaseDir = await makeRoot("recover-prepared-store");
		const { reader, put } = makeObjectStore();
		put("cccccccccccccccc", "prepared content");
		const tx = await createRestoreTransaction({
			rootPath: root,
			workspaceId: WORKSPACE_ID,
			operations: [{ path: "recover-prepared.txt", kind: "create", objectId: "cccccccccccccccc" }],
			readObject: reader,
			checkpointsBaseDir,
		});
		await tx.prepare();

		expect(await read(root, "recover-prepared.txt")).toBe("prepared content");

		const report = await recoverPendingRestoreTransactions({
			rootPath: root,
			workspaceId: WORKSPACE_ID,
			readObject: reader,
			checkpointsBaseDir,
		});

		expect(report.rolledBack).toBe(1);
		expect(report.journalStates).toContain("PREPARED");
		expect(await read(root, "recover-prepared.txt")).toBeNull();
		const jAfter = await readJournal(root, tx.id, checkpointsBaseDir);
		expect(jAfter!.state).toBe("ROLLED_BACK");
	});

	it("APPLYING journal: rolls back and reports rolledBack count", async () => {
		const root = await makeRoot("recover-applying");
		const checkpointsBaseDir = await makeRoot("recover-applying-store");
		const { reader, put } = makeObjectStore();
		put("dddddddddddddddd", "applying content");
		const tx = await createRestoreTransaction({
			rootPath: root,
			workspaceId: WORKSPACE_ID,
			operations: [{ path: "recover-applying.txt", kind: "create", objectId: "dddddddddddddddd" }],
			readObject: reader,
			checkpointsBaseDir,
		});
		await tx.prepare();

		const jFile = journalPath(root, tx.id, checkpointsBaseDir);
		const jBefore = await readJournal(root, tx.id, checkpointsBaseDir);
		expect(jBefore).not.toBeNull();
		await fs.promises.writeFile(
			jFile,
			`${JSON.stringify({ ...jBefore!, state: "APPLYING", updatedAt: new Date().toISOString() })}\n`,
			"utf8",
		);

		expect(await read(root, "recover-applying.txt")).toBe("applying content");

		const report = await recoverPendingRestoreTransactions({
			rootPath: root,
			workspaceId: WORKSPACE_ID,
			readObject: reader,
			checkpointsBaseDir,
		});

		expect(report.rolledBack).toBe(1);
		expect(report.journalStates).toContain("APPLYING");
		expect(await read(root, "recover-applying.txt")).toBeNull();
	});

	it("COMMITTED journal: ignored (no rollback)", async () => {
		const root = await makeRoot("recover-committed");
		const checkpointsBaseDir = await makeRoot("recover-committed-store");
		await write(root, "committed.txt", "already applied");

		const jId = `committed-recover-${Date.now()}`;
		const jFile = journalPath(root, jId, checkpointsBaseDir);
		await fs.promises.mkdir(path.dirname(jFile), { recursive: true, mode: 0o700 });
		await fs.promises.writeFile(
			jFile,
			JSON.stringify({
				id: jId,
				workspaceId: WORKSPACE_ID,
				rootPath: root,
				state: "COMMITTED",
				operations: [],
				rollbackActions: [],
				probeSignature: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			}),
			"utf8",
		);

		const report = await recoverPendingRestoreTransactions({
			rootPath: root,
			workspaceId: WORKSPACE_ID,
			readObject: async () => null,
			checkpointsBaseDir,
		});

		expect(report.recovered).toBe(0);
		expect(report.journalStates).toContain("COMMITTED");
		expect(await read(root, "committed.txt")).toBe("already applied");
	});

	it("mismatched workspaceId: journal ignored", async () => {
		const root = await makeRoot("recover-workspace-mismatch");
		const checkpointsBaseDir = await makeRoot("recover-mismatch-store");

		const jId = `workspace-mismatch-${Date.now()}`;
		const jFile = journalPath(root, jId, checkpointsBaseDir);
		await fs.promises.mkdir(path.dirname(jFile), { recursive: true, mode: 0o700 });
		await fs.promises.writeFile(
			jFile,
			JSON.stringify({
				id: jId,
				workspaceId: "other-workspace-999",
				rootPath: root,
				state: "PREPARED",
				operations: [],
				rollbackActions: [],
				probeSignature: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			}),
			"utf8",
		);

		const report = await recoverPendingRestoreTransactions({
			rootPath: root,
			workspaceId: WORKSPACE_ID,
			readObject: async () => null,
			checkpointsBaseDir,
		});

		expect(report.recovered).toBe(0);
		expect(report.scannedJournals).toBe(1);
	});

	it("reports scannedJournals correctly across multiple journals", async () => {
		const root = await makeRoot("recover-multi");
		const checkpointsBaseDir = await makeRoot("recover-multi-store");
		const journalDir = path.dirname(journalPath(root, "seed", checkpointsBaseDir));
		await fs.promises.mkdir(journalDir, { recursive: true, mode: 0o700 });

		for (let i = 0; i < 3; i++) {
			const jFile = path.join(journalDir, `journal-${i}.json`);
			await fs.promises.writeFile(
				jFile,
				JSON.stringify({
					id: `journal-${i}`,
					workspaceId: WORKSPACE_ID,
					rootPath: root,
					state: i === 0 ? "PREPARED" : "COMMITTED",
					operations: [],
					rollbackActions: [],
					probeSignature: null,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				}),
				"utf8",
			);
		}

		const report = await recoverPendingRestoreTransactions({
			rootPath: root,
			workspaceId: WORKSPACE_ID,
			readObject: async () => null,
			checkpointsBaseDir,
		});

		expect(report.scannedJournals).toBe(3);
		expect(report.recovered).toBe(1);
	});
});

describe("createFileObjectReader", () => {
	it("returns null for absent objectId", async () => {
		const root = await makeRoot("file-reader-miss");
		const reader = createFileObjectReader(root);
		const result = await reader("abababababababab");
		expect(result).toBeNull();
	});

	it("returns content bytes for existing file", async () => {
		const root = await makeRoot("file-reader-hit");
		await write(root, "objects/ffffffffffffffff", "binary content here");
		const reader = createFileObjectReader(path.join(root, "objects"));
		const result = await reader("ffffffffffffffff");
		expect(result).not.toBeNull();
		expect(new TextDecoder().decode(result!)).toBe("binary content here");
	});

	it("respects maxBytes option", async () => {
		const root = await makeRoot("file-reader-limit");
		const longContent = "x".repeat(200);
		await write(root, "objects/1111111111111111", longContent);
		const reader = createFileObjectReader(path.join(root, "objects"), { maxBytes: 50 });
		await expect(reader("1111111111111111")).rejects.toThrow();
	});
});

describe("WorkspaceRestoreTransactionError shape", () => {
	it("carries transactionId, path, stage, and cause", async () => {
		const root = await makeRoot("error-shape");
		try {
			const badTx = await createRestoreTransaction({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				operations: [{ path: "bad.txt", kind: "create", objectId: "eeeeeeeeeeeeeeee" }],
				readObject: async () => {
					throw new Error("reader failed");
				},
			});
			await badTx.prepare();
			throw new Error("prepare should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(WorkspaceRestoreTransactionError);
			const txErr = err as WorkspaceRestoreTransactionError;
			expect(typeof txErr.transactionId).toBe("string");
			expect(txErr.transactionId.length).toBeGreaterThan(0);
			expect(txErr.path).toBe("bad.txt");
			expect(txErr.stage).toBe("prepare");
			expect(txErr.cause).toBeInstanceOf(Error);
		}
	});
});

// ─── lock tests ───────────────────────────────────────────────────────────────

describe("acquireWorkspaceLock", () => {
	it("acquires a lock, keeps lock artifacts outside the workspace, and exposes handle fields", async () => {
		const root = await makeRoot("lock-acquire");
		const lockBaseDir = await makeRoot("lock-base");
		const handle = await acquireWorkspaceLock({ rootPath: root, workspaceId: WORKSPACE_ID, lockBaseDir });
		try {
			expect(handle.rootPath).toBe(path.resolve(root));
			expect(handle.workspaceId).toBe(WORKSPACE_ID);
			expect(typeof handle.token).toBe("string");
			expect(handle.token.length).toBeGreaterThan(0);
			expect(handle.ownerPid).toBe(process.pid);
			expect(handle.isReleased).toBe(false);
			expect(typeof handle.acquiredAt).toBe("string");
			expect(handle.heartbeatIntervalMs).toBeGreaterThan(0);
			expect(handle.staleHeartbeatMs).toBeGreaterThan(0);
			expect(handle.getLockPath()).toBe(handle.lockPath);
			expect(await pathExists(handle.getLockPath())).toBe(true);
			expect(isPathInsideRoot(root, handle.getLockPath())).toBe(false);
			expect(isPathInsideRoot(lockBaseDir, handle.getLockPath())).toBe(true);
			expect(await read(root, ".omp/checkpoints/v1/lock/lease.json")).toBeNull();
		} finally {
			await handle.release();
		}
	});

	it("release() marks isReleased true and removes the claimed lock path", async () => {
		const root = await makeRoot("lock-release");
		const lockBaseDir = await makeRoot("lock-release-base");
		const handle = await acquireWorkspaceLock({ rootPath: root, workspaceId: WORKSPACE_ID, lockBaseDir });
		const lockPath = handle.getLockPath();
		expect(handle.isReleased).toBe(false);
		await handle.release();
		expect(handle.isReleased).toBe(true);
		expect(await pathExists(lockPath)).toBe(false);
	});

	it("second acquire on the same canonical root is rejected (mutual exclusion)", async () => {
		const root = await makeRoot("lock-exclusive");
		const lockBaseDir = await makeRoot("lock-exclusive-base");
		const alias = `${root}-alias`;
		await fs.promises.symlink(root, alias);
		const first = await acquireWorkspaceLock({ rootPath: root, workspaceId: WORKSPACE_ID, lockBaseDir });
		try {
			await expect(
				acquireWorkspaceLock({
					rootPath: alias,
					workspaceId: WORKSPACE_ID,
					lockBaseDir,
					options: { maxAttempts: 3, retryDelayMs: 10 },
				}),
			).rejects.toThrow(WorkspaceLockUnavailableError);
		} finally {
			await first.release();
			await fs.promises.unlink(alias).catch(() => undefined);
		}
	});

	it("abort signal causes immediate rejection without creating workspace lock artifacts", async () => {
		const root = await makeRoot("lock-abort");
		const lockBaseDir = await makeRoot("lock-abort-base");
		const ac = new AbortController();
		ac.abort();

		await expect(
			acquireWorkspaceLock({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				lockBaseDir,
				options: { signal: ac.signal },
			}),
		).rejects.toThrow();

		expect(await read(root, ".omp/checkpoints/v1/lock/lease.json")).toBeNull();
	});

	it("throws on exceeded maxAttempts with reason 'held'", async () => {
		const root = await makeRoot("lock-max-attempts");
		const lockBaseDir = await makeRoot("lock-max-attempts-base");
		const handle = await acquireWorkspaceLock({ rootPath: root, workspaceId: WORKSPACE_ID, lockBaseDir });
		try {
			const lockPromise = acquireWorkspaceLock({
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				lockBaseDir,
				options: { maxAttempts: 2, retryDelayMs: 5 },
			});
			await expect(lockPromise).rejects.toThrow(WorkspaceLockUnavailableError);
		} finally {
			await handle.release();
		}
	});

	it("does not reap a live lease just because createdAt is old when heartbeat is fresh", async () => {
		const root = await makeRoot("lock-live-heartbeat");
		const lockBaseDir = await makeRoot("lock-live-heartbeat-base");
		const first = await acquireWorkspaceLock({
			rootPath: root,
			workspaceId: WORKSPACE_ID,
			lockBaseDir,
			options: { heartbeatIntervalMs: 10, staleHeartbeatMs: 40 },
		});
		const leasePath = path.join(first.getLockPath(), "lease.json");
		const readLeaseTokenAndHeartbeat = async (): Promise<{ token: string; heartbeatAt: string }> => {
			const parsed = JSON.parse(await fs.promises.readFile(leasePath, "utf8")) as {
				token: string;
				heartbeatAt: string;
			};
			return { token: parsed.token, heartbeatAt: parsed.heartbeatAt };
		};

		try {
			const initialLease = await readLeaseTokenAndHeartbeat();

			// Real time is required here: the regression only appears after a live
			// lease ages past 4× staleHeartbeatMs while heartbeats keep refreshing.
			await Bun.sleep(170);

			const beforeSecondAcquire = await readLeaseTokenAndHeartbeat();
			expect(beforeSecondAcquire.token).toBe(first.token);
			expect(Date.parse(beforeSecondAcquire.heartbeatAt)).toBeGreaterThan(Date.parse(initialLease.heartbeatAt));

			let rejection: unknown;
			try {
				await acquireWorkspaceLock({
					rootPath: root,
					workspaceId: WORKSPACE_ID,
					lockBaseDir,
					options: { maxAttempts: 2, retryDelayMs: 1, staleHeartbeatMs: 40 },
				});
			} catch (error) {
				rejection = error;
			}

			expect(rejection).toBeInstanceOf(WorkspaceLockUnavailableError);
			const lockError = rejection as WorkspaceLockUnavailableError;
			expect(lockError.reason).toBe("held");
			expect(lockError.heldBy?.token).toBe(first.token);

			const afterSecondAcquire = await readLeaseTokenAndHeartbeat();
			expect(afterSecondAcquire.token).toBe(first.token);
			expect(Date.parse(afterSecondAcquire.heartbeatAt)).toBeGreaterThanOrEqual(
				Date.parse(beforeSecondAcquire.heartbeatAt),
			);
		} finally {
			await first.release();
		}
	});
});

describe("withWorkspaceLock", () => {
	it("runs fn while holding the lock and releases afterwards", async () => {
		const root = await makeRoot("with-lock-basic");
		const lockBaseDir = await makeRoot("with-lock-basic-base");
		let ran = false;
		let observedLockPath = "";
		const result = await withWorkspaceLock(
			{ rootPath: root, workspaceId: WORKSPACE_ID, lockBaseDir },
			async handle => {
				expect(handle.workspaceId).toBe(WORKSPACE_ID);
				expect(handle.isReleased).toBe(false);
				observedLockPath = handle.getLockPath();
				ran = true;
				return 42;
			},
		);
		expect(ran).toBe(true);
		expect(result).toBe(42);
		expect(await pathExists(observedLockPath)).toBe(false);
	});

	it("releases the lock even when fn throws", async () => {
		const root = await makeRoot("with-lock-throw");
		const lockBaseDir = await makeRoot("with-lock-throw-base");
		let observedLockPath = "";
		await expect(
			withWorkspaceLock({ rootPath: root, workspaceId: WORKSPACE_ID, lockBaseDir }, async handle => {
				observedLockPath = handle.getLockPath();
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(await pathExists(observedLockPath)).toBe(false);
	});

	it("second withWorkspaceLock call after first completes succeeds", async () => {
		const root = await makeRoot("with-lock-reentrant");
		const lockBaseDir = await makeRoot("with-lock-reentrant-base");
		await withWorkspaceLock({ rootPath: root, workspaceId: WORKSPACE_ID, lockBaseDir }, async () => {});
		await withWorkspaceLock({ rootPath: root, workspaceId: WORKSPACE_ID, lockBaseDir }, async handle => {
			expect(handle.workspaceId).toBe(WORKSPACE_ID);
		});
	});
	it("second concurrent withWorkspaceLock is serialized and succeeds after the first", async () => {
		const root = await makeRoot("with-lock-concurrent-serial");
		const lockBaseDir = await makeRoot("with-lock-concurrent-serial-base");

		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const order: string[] = [];

		const first = withWorkspaceLock({ rootPath: root, workspaceId: WORKSPACE_ID, lockBaseDir }, async () => {
			order.push("first-start");
			firstEntered.resolve();
			await releaseFirst.promise;
			order.push("first-end");
		});

		await firstEntered.promise;

		const second = withWorkspaceLock(
			{
				rootPath: root,
				workspaceId: WORKSPACE_ID,
				lockBaseDir,
				options: { maxAttempts: 2, retryDelayMs: 1 },
			},
			async () => {
				order.push("second");
			},
		);

		await new Promise<void>(resolve => setImmediate(resolve));
		expect(order).toEqual(["first-start"]);

		releaseFirst.resolve();

		await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
		expect(order).toEqual(["first-start", "first-end", "second"]);
	});
});

describe("concurrent lock owners", () => {
	it("two processes cannot hold the same lock for one canonical root simultaneously", async () => {
		const root = await makeRoot("lock-concurrent");
		const lockBaseDir = await makeRoot("lock-concurrent-base");
		const scriptPath = path.join(root, "holder.mjs");
		const modulePath = path.resolve(process.cwd(), "src/workspace-checkpoints/index.ts");

		// Hold the lock for 30 s — long enough that the test acquire attempt is
		// guaranteed to find the holder still alive and therefore must fail.
		await fs.promises.writeFile(
			scriptPath,
			`
import { acquireWorkspaceLock } from ${JSON.stringify(modulePath)};
const marker = ${JSON.stringify(path.join(root, "holder-pid"))};
const rootPath = ${JSON.stringify(root)};
const workspaceId = ${JSON.stringify(WORKSPACE_ID)};
const lockBaseDir = ${JSON.stringify(lockBaseDir)};
const handle = await acquireWorkspaceLock({ rootPath, workspaceId, lockBaseDir, options: { heartbeatIntervalMs: 50_000 } });
await Bun.write(marker, String(process.pid));
await Bun.sleep(30_000);
await handle.release();
`,
			"utf8",
		);

		const holder = Bun.spawn(["bun", scriptPath], {
			stdout: "pipe",
			stderr: "pipe",
		});

		try {
			// Poll for the marker file — allow up to 5 s for the subprocess to start.
			for (let i = 0; i < 100; i++) {
				if (await read(root, "holder-pid")) break;
				await Bun.sleep(50);
			}

			const holderPid = await read(root, "holder-pid");
			expect(holderPid).not.toBeNull();

			try {
				await acquireWorkspaceLock({
					rootPath: root,
					workspaceId: WORKSPACE_ID,
					lockBaseDir,
					options: { maxAttempts: 3, retryDelayMs: 100 },
				});
				throw new Error("expected second lock acquisition to fail");
			} catch (error) {
				expect(error).toBeInstanceOf(WorkspaceLockUnavailableError);
				const lockError = error as WorkspaceLockUnavailableError;
				expect(lockError.reason).toBe("held");
				expect(lockError.attempts).toBe(3);
			}
		} finally {
			holder.kill();
			const exited = await Promise.race([holder.exited.then(() => true), Bun.sleep(1_000).then(() => false)]);
			if (!exited) {
				holder.kill("SIGKILL");
				await holder.exited;
			}
		}
	});
});

// ─── toPointer contract ───────────────────────────────────────────────────────

describe("RestoreTransaction.toPointer", () => {
	it("returns 'committed' state after apply", async () => {
		const root = await makeRoot("pointer-commit");
		const { reader, put } = makeObjectStore();
		put("aaaaaaaaaaaaaaaa", "data");
		const ops: WorkspaceRestoreOperation[] = [{ path: "p.txt", kind: "create", objectId: "aaaaaaaaaaaaaaaa" }];
		const tx = await createRestoreTransaction({
			rootPath: root,
			workspaceId: WORKSPACE_ID,
			operations: ops,
			readObject: reader,
		});
		await tx.prepare();
		await tx.apply();

		const ptr = tx.toPointer({ checkpointId: "ckpt-abc" });
		expect(ptr.state).toBe("committed");
		expect(ptr.id).toBe(tx.id);
		expect(ptr.workspaceId).toBe(WORKSPACE_ID);
		expect(ptr.checkpointId).toBe("ckpt-abc");
		expect(typeof ptr.completedAt).toBe("string");
	});

	it("returns 'rolled_back' state after rollback", async () => {
		const root = await makeRoot("pointer-rollback");
		const { reader, put } = makeObjectStore();
		put("aaaaaaaaaaaaaaaa", "data");
		const ops: WorkspaceRestoreOperation[] = [{ path: "rb.txt", kind: "create", objectId: "aaaaaaaaaaaaaaaa" }];
		const tx = await createRestoreTransaction({
			rootPath: root,
			workspaceId: WORKSPACE_ID,
			operations: ops,
			readObject: reader,
		});
		await tx.prepare();
		await tx.rollback();

		const ptr = tx.toPointer({ checkpointId: "ckpt-def" });
		expect(ptr.state).toBe("rolled_back");
		expect(typeof ptr.completedAt).toBe("string");
	});

	it("returns 'open' state while PREPARED", async () => {
		const root = await makeRoot("pointer-open");
		const { reader, put } = makeObjectStore();
		put("aaaaaaaaaaaaaaaa", "data");
		const ops: WorkspaceRestoreOperation[] = [{ path: "op.txt", kind: "create", objectId: "aaaaaaaaaaaaaaaa" }];
		const tx = await createRestoreTransaction({
			rootPath: root,
			workspaceId: WORKSPACE_ID,
			operations: ops,
			readObject: reader,
		});
		await tx.prepare();

		const ptr = tx.toPointer({ checkpointId: "ckpt-open" });
		expect(ptr.state).toBe("open");
		expect(ptr.completedAt).toBeUndefined();
	});

	it("includes optional planId when provided", async () => {
		const root = await makeRoot("pointer-planid");
		const { reader, put } = makeObjectStore();
		put("aaaaaaaaaaaaaaaa", "data");
		const tx = await createRestoreTransaction({
			rootPath: root,
			workspaceId: WORKSPACE_ID,
			operations: [{ path: "p2.txt", kind: "create", objectId: "aaaaaaaaaaaaaaaa" }],
			readObject: reader,
		});
		await tx.prepare();
		await tx.apply();

		const ptr = tx.toPointer({ planId: "plan-xyz", checkpointId: "ckpt-1" });
		expect(ptr.planId).toBe("plan-xyz");
	});
});

// ─── cleanup ─────────────────────────────────────────────────────────────────

afterEach(async () => {
	await Promise.all(
		_roots.splice(0).map(async r => {
			await fs.promises.rm(r, { recursive: true, force: true }).catch(() => undefined);
		}),
	);
});
