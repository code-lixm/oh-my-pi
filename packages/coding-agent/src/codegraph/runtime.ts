/**
 * Public runtime facade — the contract surface that downstream tools
 * import. Adapted from upstream `src/index.ts` (MIT, Colby Mchenry —
 * see ./UPSTREAM_LICENSE), rewritten to satisfy the OMP shared
 * contract (see `local://codegraph-contract.md`):
 *
 *   - All storage paths flow from the injected
 *     `CodeGraphIndexLocation`. The runtime never reads or writes
 *     `<sourceRoot>/.codegraph/`.
 *   - `Node.filePath` / `FileRecord.path` stay sourceRoot-relative.
 *   - `runtime.explore()` reads current source content from
 *     `sourceRoot` on disk — never from DB-cached bytes.
 *   - The optional native extractor (see `./native.ts`) is loaded
 *     lazily; if missing or ABI-mismatched, the runtime falls back to
 *     a TS/WASM path.
 *   - WAL/lock/metadata files all live under `indexDir`.
 *   - `initialize()` returns `{bootstrapped, ...syncCounts}` so the
 *     worker can detect a warm slot and avoid a redundant full sync.
 *   - `initialize()` accepts an optional `progressCallback` so the
 *     orchestrator's progress reaches `<indexDir>/progress.json`.
 */
import * as fs from "node:fs/promises";
import { DatabaseConnection, ensureIndexDirs, QueryBuilder, removeDatabaseFiles } from "./db";
import { runExplore } from "./explorer";
import { metadataIsStale, readMetadata, writeMetadata } from "./metadata";
import { describeNative, nativeContractMatches, tryLoadNative } from "./native";
import { SyncOrchestrator } from "./orchestrator";
import { readProgress } from "./progress";
import type {
	CodeGraphExploreOptions,
	CodeGraphExploreResult,
	CodeGraphInitializeOptions,
	CodeGraphRuntime,
	CodeGraphRuntimeOptions,
	CodeGraphStatus,
	CodeGraphSyncOptions,
} from "./runtime-types";
import { CodeGraphFileLock } from "./utils";

export type { CodeGraphIndexLocation } from "./location";
export * from "./runtime-types";

function metadataTimeMs(value: string | null): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Open a semantic graph runtime bound to `sourceRoot` and the injected
 * `location`. Rejects with an `Error` carrying `location.reason` when
 * the location is unavailable (e.g. non-Git project).
 */
export async function openCodeGraphRuntime(options: CodeGraphRuntimeOptions): Promise<CodeGraphRuntime> {
	if (!options?.location) {
		throw new Error("openCodeGraphRuntime: missing location");
	}
	if (!options.location.available) {
		throw new Error(`openCodeGraphRuntime: location unavailable — ${options.location.reason ?? "unknown reason"}`);
	}
	await ensureIndexDirs(options.location);

	const fileLock = new CodeGraphFileLock(options.location.lockPath);
	let connection: DatabaseConnection | null = null;
	let queryBuilder: QueryBuilder | null = null;
	let orchestrator: SyncOrchestrator | null = null;
	let initialized = false;
	let closed = false;
	let lastSyncedAt = 0;
	let lastUsedAt = 0;
	const nativeProbe = await describeNative();
	const nativeBindings = await tryLoadNative();
	let nativeContractVersion: string | null = null;
	if (nativeProbe.available && nativeBindings) {
		const info = nativeBindings.contractInfo();
		if (nativeContractMatches(info)) nativeContractVersion = `${info.abiVersion}:${info.kernelVersion}`;
	}
	const nativeAvailable = nativeContractVersion !== null;

	try {
		await fileLock.acquire();
	} catch (err) {
		throw new Error(`openCodeGraphRuntime: cannot acquire lock — ${(err as Error).message}`);
	}
	try {
		let rebuildRequired = await metadataIsStale(options.location, nativeContractVersion);
		if (rebuildRequired) await removeDatabaseFiles(options.location.dbPath);
		const metadata = rebuildRequired
			? await writeMetadata(options.location, {
					nativeContractVersion,
					lastSyncedAt: 0,
				})
			: ((await readMetadata(options.location)) ??
				(await writeMetadata(options.location, { nativeContractVersion, lastSyncedAt: 0 })));
		lastSyncedAt = metadataTimeMs(metadata.lastSyncedAt);
		lastUsedAt = metadataTimeMs(metadata.lastUsedAt);
		const effectiveSourceRoot = options.location.identity.sourceRoot || options.sourceRoot;
		connection = DatabaseConnection.forLocation(options.location);
		queryBuilder = new QueryBuilder(connection.getDb());
		orchestrator = new SyncOrchestrator({
			sourceRoot: effectiveSourceRoot,
			connection,
			queryBuilder,
		});
		const status = async (): Promise<CodeGraphStatus> => {
			const counts = queryBuilder ? queryBuilder.getNodeAndEdgeCount() : { nodes: 0, edges: 0 };
			const fileCount = queryBuilder ? queryBuilder.getAllFiles().length : 0;
			let dbSizeBytes = 0;
			try {
				const st = await fs.stat(options.location.dbPath);
				dbSizeBytes = st.size;
			} catch {
				dbSizeBytes = 0;
			}
			const progress = await readProgress(options.location).catch(() => null);
			const statusOut: CodeGraphStatus = {
				initialized,
				sourceRoot: effectiveSourceRoot,
				indexDir: options.location.indexDir,
				dbPath: options.location.dbPath,
				dbSizeBytes,
				nodeCount: counts.nodes,
				edgeCount: counts.edges,
				fileCount,
				lastSyncedAt,
				lastUsedAt,
				nativeAvailable,
				...(progress ? { progress } : {}),
				reason: rebuildRequired ? "metadata mismatch — rebuild required" : undefined,
			};
			return statusOut;
		};

		const runtime: CodeGraphRuntime = {
			async initialize(initOpts: CodeGraphInitializeOptions = {}) {
				if (closed) throw new Error("runtime is closed");
				if (!orchestrator) throw new Error("runtime is not wired");
				const result = await orchestrator.initialize(initOpts);
				initialized = true;
				rebuildRequired = false;
				lastSyncedAt = Date.now();
				lastUsedAt = lastSyncedAt;
				await writeMetadata(options.location, {
					nativeContractVersion,
					lastSyncedAt,
					lastUsedAt,
				});
				return result;
			},
			async sync(syncOpts: CodeGraphSyncOptions = {}) {
				if (closed) throw new Error("runtime is closed");
				if (!orchestrator) throw new Error("runtime is not wired");
				const result = await orchestrator.sync({ paths: syncOpts.paths });
				lastSyncedAt = Date.now();
				lastUsedAt = lastSyncedAt;
				await writeMetadata(options.location, {
					nativeContractVersion,
					lastSyncedAt,
					lastUsedAt,
				});
				return result;
			},
			async explore(query: string, exploreOpts: CodeGraphExploreOptions = {}): Promise<CodeGraphExploreResult> {
				if (closed) throw new Error("runtime is closed");
				if (!connection || !queryBuilder) throw new Error("runtime is not wired");
				const maxFiles = exploreOpts.maxFiles ?? 25;
				const result = await runExplore(
					{
						sourceRoot: effectiveSourceRoot,
						connection,
						queryBuilder,
						maxFiles,
					},
					query,
				);
				lastUsedAt = Date.now();
				await writeMetadata(options.location, { nativeContractVersion, lastSyncedAt, lastUsedAt });
				return result;
			},
			async status() {
				return status();
			},
			close() {
				if (closed) return;
				closed = true;
				try {
					connection?.close();
				} catch {
					/* connection already gone */
				}
				fileLock.release();
			},
		};

		return runtime;
	} catch (error) {
		try {
			connection?.close();
		} catch {
			/* connection already gone */
		}
		fileLock.release();
		throw error;
	}
}

/**
 * Helper for callers that just need to read `status()` without
 * initializing — used by the CLI's `codegraph status` flow.
 */
export async function probeRuntime(options: CodeGraphRuntimeOptions): Promise<CodeGraphStatus> {
	const runtime = await openCodeGraphRuntime(options);
	try {
		return await runtime.status();
	} finally {
		runtime.close();
	}
}
