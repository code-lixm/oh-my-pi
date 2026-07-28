/**
 * Content-addressed object store for workspace checkpoint file payloads.
 *
 * Each object's id is `sha256:<hex>` derived from the raw bytes. Objects are
 * stored under `<storeDir>/checkpoints/v1/objects/<aa>/<rest>` with a
 * sharded two-character hex prefix — same layout as Git's loose-object
 * fan-out, but the namespace is isolated from any actual Git object store so
 * checkpoint blobs never collide with Git objects captured alongside them.
 *
 * `storeDir` is the *store root* — NOT a workspace root. Callers wire it to
 * something like `<agentDir>/checkpoints/v1/workspaces/<workspaceId>` so the
 * per-workspace data lives under the agent dir and never inside the user's
 * working tree. The store only touches its own `checkpoints/v1/objects/`
 * subtree, so positioning the store next to other agent state is fine.
 *
 * Writes are durable end-to-end:
 *
 *   1. stream source -> temp staging file in `<storeDir>/checkpoints/v1/.tmp/<rand>`,
 *   2. compute the SHA-256 hash while streaming,
 *   3. `fsync` the staging file, close the handle,
 *   4. `rename` the staging file onto its final sharded path (atomic on the
 *      same filesystem),
 *   5. fsync the parent directory so the rename is committed to disk.
 *
 * Re-uploading the exact same bytes is idempotent: the SHA-256 is the object
 * id, so the destination path is content-deterministic. Concurrent uploads of
 * the same bytes race to the same path; whichever rename wins writes the same
 * bytes, the loser unlinks a matching temp file and returns the canonical id.
 *
 * Reads stream objects lazily via `Bun.file().stream()`, so a multi-megabyte
 * blob never has to be materialised in memory just to restore it.
 */
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

/** Hex-encoded SHA-256 digest prefix (`sha256:` + 64 lowercase hex chars). */
export const OBJECT_ID_PREFIX = "sha256:";

/** Object layout uses Git's loose-object two-character shard fan-out. */
const SHARD_LENGTH = 2;

/** Random temp suffix length — large enough that parallel writers never collide. */
const TEMP_SUFFIX_BYTES = 12;

/** Read buffer for `putFile` streaming; large enough to amortise syscalls. */
const FILE_READ_BUFFER_BYTES = 64 * 1024;

/** Hex matching for the bare 64-char digest. */
const HEX_RE = /^[0-9a-f]{64}$/;

export type WorkspaceContentStoreErrorCode = "invalid_object_id" | "missing_object" | "io";

export class WorkspaceContentStoreError extends Error {
	readonly code: WorkspaceContentStoreErrorCode;
	constructor(message: string, code: WorkspaceContentStoreErrorCode, cause?: unknown) {
		super(message);
		this.name = "WorkspaceContentStoreError";
		this.code = code;
		if (cause !== undefined) this.cause = cause;
	}
}

export interface WorkspaceContentSweepResult {
	deletedObjectIds: string[];
	deletedBytes: number;
	keptObjectCount: number;
	deletedStagingFiles: number;
}

/** Public surface a checkpoint service can call against an open store. */
export interface WorkspaceContentStore {
	/** Absolute directory the store was opened against. */
	readonly storeDir: string;
	/** Resolved checkout/v1/objects directory. */
	readonly objectsDir: string;
	/** Alias for {@link storeDir}; kept for callers that predate the rename. */
	readonly rootPath: string;

	/** Whether `id` parses as a well-formed object id for this store. */

	hasId(id: string): boolean;

	/** Stream `id` back to callers. Resolves to `null` when missing. */
	readStream(id: string): Promise<ReadableStream<Uint8Array> | null>;

	/** Read the full bytes of `id`. */
	readBytes(id: string): Promise<Uint8Array | null>;

	/** Decode `id` as UTF-8 text (lossy on non-UTF-8 blobs). */
	readText(id: string): Promise<string | null>;

	/**
	 * Stream `source` into the store and return the resulting object id plus
	 * the byte size that was hashed. Bounded by the async iterator contract.
	 */
	putStream(source: AsyncIterable<Uint8Array>): Promise<{ id: string; bytes: number }>;

	/** Convenience: hash the in-memory bytes and store them. */
	putBytes(data: Uint8Array): Promise<{ id: string; bytes: number }>;

	/** Convenience: UTF-8 encode `text` and store it. */
	putText(text: string): Promise<{ id: string; bytes: number }>;

	/** Hash a regular file without materialising it in the object store. */
	hashFile(absolutePath: string): Promise<{ id: string; bytes: number } | null>;

	/**
	 * Read the file at `absolutePath`, hashing as we go. Used by the scanner
	 * to capture file payloads without an intermediate buffer. Resolves to
	 * `null` when the path is missing or not a regular file.
	 */
	putFile(absolutePath: string): Promise<{ id: string; bytes: number } | null>;

	/** Cheaply check if an object's backing file already exists on disk. */
	has(id: string): Promise<boolean>;

	/**
	 * Delete every materialised object not present in `reachableObjectIds`.
	 * Callers MUST serialize this with puts for the same workspace store.
	 */
	sweepUnreachable(reachableObjectIds: ReadonlySet<string>): Promise<WorkspaceContentSweepResult>;
}

/**
 * Open (and create) a content store rooted at `storeDir`. The directory is
 * the *store* root, not a workspace root — callers typically derive it as
 * `<agentDir>/checkpoints/v1/workspaces/<workspaceId>` so the per-workspace
 * data sits under the agent dir and never inside the user's workspace.
 */
export async function openWorkspaceContentStoreAt(storeDir: string): Promise<WorkspaceContentStore> {
	const resolved = path.resolve(storeDir);
	const { checkpointRoot, objectsDir } = splitStoreRoot(resolved);
	await fs.mkdir(checkpointRoot, { recursive: true });
	await ensureShardedObjectsDir(objectsDir);
	return new FsWorkspaceContentStore(resolved, objectsDir);
}

/**
 * Alias retained for legacy callers expecting the original name. The store
 * root argument semantics are identical — what changes is the call-site
 * clarity.
 */
export const openWorkspaceContentStore = openWorkspaceContentStoreAt;

/** Build the on-disk path for `id`. Pure helper, used by tests and callers. */
export function objectPathFor(storeDir: string, id: string): string {
	const bare = id.startsWith(OBJECT_ID_PREFIX) ? id.slice(OBJECT_ID_PREFIX.length) : id;
	if (!HEX_RE.test(bare)) {
		throw new WorkspaceContentStoreError(`Invalid object id "${id}"`, "invalid_object_id");
	}
	const shard = bare.slice(0, SHARD_LENGTH);
	const rest = bare.slice(SHARD_LENGTH);
	return path.join(strippedObjectsDir(storeDir), shard, rest);
}

/** Parse `id` into its hex form, rejecting malformed identifiers. */
export function parseObjectId(id: string): string {
	if (typeof id !== "string") {
		throw new WorkspaceContentStoreError(`Invalid object id "${String(id)}"`, "invalid_object_id");
	}
	const bare = id.startsWith(OBJECT_ID_PREFIX) ? id.slice(OBJECT_ID_PREFIX.length) : id;
	if (!HEX_RE.test(bare)) {
		throw new WorkspaceContentStoreError(`Invalid object id "${id}"`, "invalid_object_id");
	}
	return bare;
}

function splitStoreRoot(storeDir: string): { checkpointRoot: string; objectsDir: string; tempDir: string } {
	const resolved = path.resolve(storeDir);
	const checkpointRoot = path.join(resolved, "checkpoints", "v1");
	const objectsDir = path.join(checkpointRoot, "objects");
	const tempDir = path.join(checkpointRoot, ".tmp");
	return { checkpointRoot, objectsDir, tempDir };
}

/** Resolve `objectsDir` for `storeDir` (caller may pass storeDir or already-prepared objectsDir). */
function strippedObjectsDir(storeDir: string): string {
	// When callers pass `objectsDir` (via direct constructor), we still produce
	// the same path by joining `<storeDir>/checkpoints/v1/objects`. Both `objectPathFor`
	// and the FS class agree on that layout, so the helper extracts the canonical
	// path without needing a separate probe.
	return splitStoreRoot(storeDir).objectsDir;
}

async function ensureShardedObjectsDir(objectsDir: string): Promise<string> {
	await fs.mkdir(objectsDir, { recursive: true });
	// Pre-create the 256 shard directories so the first PUT does not race
	// readdir/fsync/rename in a way that loses objects on a crash. mkdir
	// is idempotent when `recursive: true`.
	for (let i = 0; i < 16; i++) {
		for (let j = 0; j < 16; j++) {
			const shard = `${i.toString(16)}${j.toString(16)}`;
			await fs.mkdir(path.join(objectsDir, shard), { recursive: true });
		}
	}
	return objectsDir;
}

class FsWorkspaceContentStore implements WorkspaceContentStore {
	readonly #storeDir: string;
	readonly #objectsDir: string;
	readonly #tempDir: string;

	constructor(storeDir: string, objectsDir: string) {
		this.#storeDir = storeDir;
		this.#objectsDir = objectsDir;
		const layout = splitStoreRoot(storeDir);
		this.#tempDir = layout.tempDir;
	}

	get storeDir(): string {
		return this.#storeDir;
	}

	get rootPath(): string {
		return this.#storeDir;
	}

	get objectsDir(): string {
		return this.#objectsDir;
	}

	hasId(id: string): boolean {
		try {
			parseObjectId(id);
			return true;
		} catch {
			return false;
		}
	}

	async has(id: string): Promise<boolean> {
		const target = this.#objectPath(id);
		try {
			const stat = await fs.lstat(target);
			return stat.isFile();
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	}

	async sweepUnreachable(reachableObjectIds: ReadonlySet<string>): Promise<WorkspaceContentSweepResult> {
		for (const objectId of reachableObjectIds) parseObjectId(objectId);
		const deletedObjectIds: string[] = [];
		const staging = await this.#reapStaging();
		let deletedBytes = staging.deletedBytes;
		let keptObjectCount = 0;
		const shards = await fs.readdir(this.#objectsDir, { withFileTypes: true });
		shards.sort((a, b) => a.name.localeCompare(b.name));
		for (const shard of shards) {
			if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
			const shardPath = path.join(this.#objectsDir, shard.name);
			const entries = await fs.readdir(shardPath, { withFileTypes: true });
			entries.sort((a, b) => a.name.localeCompare(b.name));
			let shardChanged = false;
			for (const entry of entries) {
				if (!entry.isFile() || !/^[0-9a-f]{62}$/.test(entry.name)) continue;
				const objectId = `${OBJECT_ID_PREFIX}${shard.name}${entry.name}`;
				if (reachableObjectIds.has(objectId)) {
					keptObjectCount++;
					continue;
				}
				const objectPath = path.join(shardPath, entry.name);
				try {
					const stat = await fs.lstat(objectPath);
					if (!stat.isFile()) continue;
					await fs.unlink(objectPath);
					deletedBytes += stat.size;
					deletedObjectIds.push(objectId);
					shardChanged = true;
				} catch (error) {
					if (!isEnoent(error)) throw error;
				}
			}
			if (shardChanged) await this.#fsyncDir(shardPath);
		}
		if (deletedObjectIds.length > 0) await this.#fsyncDir(this.#objectsDir);
		return {
			deletedObjectIds,
			deletedBytes,
			deletedStagingFiles: staging.deletedFiles,
			keptObjectCount,
		};
	}

	async readStream(id: string): Promise<ReadableStream<Uint8Array> | null> {
		const target = this.#objectPath(id);
		try {
			await fs.access(target, fs.constants.R_OK);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
		return Bun.file(target).stream();
	}

	async readBytes(id: string): Promise<Uint8Array | null> {
		const target = this.#objectPath(id);
		try {
			return await Bun.file(target).bytes();
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	async readText(id: string): Promise<string | null> {
		const bytes = await this.readBytes(id);
		if (bytes === null) return null;
		return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	}

	async putStream(source: AsyncIterable<Uint8Array>): Promise<{ id: string; bytes: number }> {
		const { stagingPath, handle } = await this.#openStaging();
		const hasher = new Bun.CryptoHasher("sha256");
		let bytes = 0;
		let removeOnError = true;
		try {
			try {
				for await (const chunk of source) {
					if (!chunk || chunk.byteLength === 0) continue;
					bytes += chunk.byteLength;
					hasher.update(chunk);
					const written = (await handle.write(chunk)).bytesWritten;
					if (written !== chunk.byteLength) {
						throw new WorkspaceContentStoreError(
							`Short write to staging file "${stagingPath}": expected ${chunk.byteLength}, wrote ${written}`,
							"io",
						);
					}
				}
				await handle.sync();
			} finally {
				await handle.close();
			}
		} catch (err) {
			await this.#cleanupStaging(stagingPath);
			throw new WorkspaceContentStoreError(
				`Failed to stream object into staging file "${stagingPath}": ${(err as Error).message}`,
				"io",
				err,
			);
		}
		const digest = hasher.digest("hex");
		const id = `${OBJECT_ID_PREFIX}${digest}`;
		const finalPath = this.#objectPath(id);
		try {
			if (await this.#pathExists(finalPath)) {
				// Same content was already materialised — discard the staging file
				// and return the canonical id. Object bytes are SHA-256 determin-
				// istic so reading either is identical.
				await this.#cleanupStaging(stagingPath);
				removeOnError = false;
				return { id, bytes };
			}
			await fs.mkdir(path.dirname(finalPath), { recursive: true });
			try {
				await fs.rename(stagingPath, finalPath);
				removeOnError = false;
			} catch (err) {
				// Race with a concurrent writer that just materialised this id.
				if (await this.#pathExists(finalPath)) {
					await this.#cleanupStaging(stagingPath);
					removeOnError = false;
					return { id, bytes };
				}
				throw new WorkspaceContentStoreError(
					`Failed to rename staging file to "${finalPath}": ${(err as Error).message}`,
					"io",
					err,
				);
			}
			// fsync the directory so the rename survives a crash.
			await this.#fsyncDir(path.dirname(finalPath));
			await this.#fsyncDir(this.#objectsDir);
			return { id, bytes };
		} finally {
			if (removeOnError) {
				await this.#cleanupStaging(stagingPath);
			}
		}
	}

	async putBytes(data: Uint8Array): Promise<{ id: string; bytes: number }> {
		const bytes = data.byteLength;
		// Include empty payloads explicitly so the hash is well-defined: every
		// PUT hashes the bytes we received, even if the stream was zero-length.
		const hasher = new Bun.CryptoHasher("sha256").update(data);
		const id = `${OBJECT_ID_PREFIX}${hasher.digest("hex")}`;
		const finalPath = this.#objectPath(id);
		if (await this.#pathExists(finalPath)) return { id, bytes };
		const { stagingPath, handle } = await this.#openStaging();
		try {
			try {
				if (bytes > 0) {
					const written = (await handle.write(data)).bytesWritten;
					if (written !== bytes) {
						throw new WorkspaceContentStoreError(
							`Short write to staging file "${stagingPath}": expected ${bytes}, wrote ${written}`,
							"io",
						);
					}
				}
				await handle.sync();
			} finally {
				await handle.close();
			}
		} catch (error) {
			await this.#cleanupStaging(stagingPath);
			throw error;
		}
		let removeOnError = true;
		try {
			await fs.mkdir(path.dirname(finalPath), { recursive: true });
			try {
				await fs.rename(stagingPath, finalPath);
				removeOnError = false;
			} catch (err) {
				if (await this.#pathExists(finalPath)) {
					await this.#cleanupStaging(stagingPath);
					removeOnError = false;
					return { id, bytes };
				}
				throw new WorkspaceContentStoreError(
					`Failed to rename staging file to "${finalPath}": ${(err as Error).message}`,
					"io",
					err,
				);
			}
			await this.#fsyncDir(path.dirname(finalPath));
			await this.#fsyncDir(this.#objectsDir);
			return { id, bytes };
		} finally {
			if (removeOnError) await this.#cleanupStaging(stagingPath);
		}
	}

	async putText(text: string): Promise<{ id: string; bytes: number }> {
		return this.putBytes(new TextEncoder().encode(text));
	}

	async hashFile(absolutePath: string): Promise<{ id: string; bytes: number } | null> {
		const handle = await openRegularFile(absolutePath);
		if (!handle) return null;
		try {
			const hasher = new Bun.CryptoHasher("sha256");
			let bytes = 0;
			for await (const chunk of readFileChunks(handle, FILE_READ_BUFFER_BYTES)) {
				hasher.update(chunk);
				bytes += chunk.byteLength;
			}
			return { id: `${OBJECT_ID_PREFIX}${hasher.digest("hex")}`, bytes };
		} finally {
			await handle.close().catch(() => {});
		}
	}

	async putFile(absolutePath: string): Promise<{ id: string; bytes: number } | null> {
		const handle = await openRegularFile(absolutePath);
		if (!handle) return null;
		const source = readFileChunks(handle, FILE_READ_BUFFER_BYTES);
		try {
			return await this.putStream(source);
		} finally {
			await handle.close().catch(() => {});
		}
	}

	#objectPath(id: string): string {
		return objectPathFor(this.#storeDir, id);
	}

	async #openStaging(): Promise<{ stagingPath: string; handle: FileHandle }> {
		await fs.mkdir(this.#tempDir, { recursive: true });
		const suffix = randomHex(TEMP_SUFFIX_BYTES);
		const stagingPath = path.join(this.#tempDir, `obj-${process.pid}-${Date.now().toString(36)}-${suffix}`);
		try {
			const handle = await fs.open(stagingPath, "wx", 0o600);
			return { stagingPath, handle };
		} catch (err) {
			throw new WorkspaceContentStoreError(
				`Failed to open staging file "${stagingPath}": ${(err as Error).message}`,
				"io",
				err,
			);
		}
	}

	async #reapStaging(): Promise<{ deletedFiles: number; deletedBytes: number }> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(this.#tempDir, { withFileTypes: true });
		} catch (error) {
			if (isEnoent(error)) return { deletedFiles: 0, deletedBytes: 0 };
			throw error;
		}
		let deletedFiles = 0;
		let deletedBytes = 0;
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.startsWith("obj-")) continue;
			const stagingPath = path.join(this.#tempDir, entry.name);
			try {
				const stat = await fs.lstat(stagingPath);
				if (!stat.isFile()) continue;
				await fs.unlink(stagingPath);
				deletedFiles++;
				deletedBytes += stat.size;
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		if (deletedFiles > 0) await this.#fsyncDir(this.#tempDir);
		return { deletedFiles, deletedBytes };
	}

	async #cleanupStaging(stagingPath: string): Promise<void> {
		await fs.rm(stagingPath, { force: true }).catch(() => {});
	}

	async #pathExists(target: string): Promise<boolean> {
		try {
			const stat = await fs.lstat(target);
			return stat.isFile();
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	}

	async #fsyncDir(target: string): Promise<void> {
		const handle = await fs.open(target, "r").catch(() => null);
		if (!handle) return;
		try {
			await handle.sync();
		} catch {
			// Filesystems that don't support directory fsync (e.g. some FUSE
			// mounts, WSL distros) silently no-op; durability is best-effort on
			// those, but the rename itself is still atomic.
		} finally {
			await handle.close().catch(() => {});
		}
	}
}

async function openRegularFile(absolutePath: string): Promise<FileHandle | null> {
	const target = path.resolve(absolutePath);
	try {
		const stat = await fs.lstat(target);
		if (!stat.isFile()) return null;
		return await fs.open(target, "r");
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function* readFileChunks(handle: FileHandle, chunkSize: number): AsyncIterable<Uint8Array> {
	const buffer = new Uint8Array(chunkSize);
	const fileStat = await handle.stat();
	let offset = 0;
	while (offset < fileStat.size) {
		const remaining = fileStat.size - offset;
		const toRead = Math.min(chunkSize, remaining);
		const slice = toRead === chunkSize ? buffer : buffer.subarray(0, toRead);
		const { bytesRead } = await handle.read(slice, 0, toRead, offset);
		if (bytesRead === 0) break;
		yield bytesRead === toRead ? slice : slice.subarray(0, bytesRead);
		offset += bytesRead;
	}
}

function randomHex(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}
