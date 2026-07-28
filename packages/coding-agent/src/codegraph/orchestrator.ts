/**
 * Sync orchestration — adapted from upstream
 * `src/extraction/index.ts::ExtractionOrchestrator.sync` (MIT, Colby Mchenry).
 *
 * The OMP port wires only the parts the `runtime.ts` facade exposes:
 *   - `initialize` runs a single bootstrap extraction pass and captures
 *     `metadata.lastSyncedAt`. It returns `{bootstrapped, ...syncCounts}` so
 *     the worker / runtime can detect a warm slot and skip the redundant
 *     full-project `sync` that the worker's warm full sync already performs
 *     in the background.
 *   - `sync` diffs the scan against the persisted `files` table and applies
 *     add/modify/remove deltas. Source content is read from `sourceRoot`
 *     (never DB-cached).
 *   - An optional `progressCallback` invoked with the cumulative
 *     `{phase, current, total}` during `initialize` so the worker can
 *     surface progress through `<indexDir>/progress.json`.
 *   - The optional native extractor (see `./native.ts`) is invoked when
 *     present; otherwise a file-level fallback record is stored so
 *     `status()` can still report.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { DatabaseConnection, QueryBuilder } from "./db";
import { logWarn } from "./errors";
import { type ExtractResult, extractFile } from "./extraction";
import type {
	CodeGraphInitializeOptions,
	CodeGraphInitializeResult,
	CodeGraphProgress,
	CodeGraphSyncResult,
} from "./runtime-types";
import { scanProject } from "./scanner";

export interface SyncOrchestratorOptions {
	sourceRoot: string;
	connection: DatabaseConnection;
	queryBuilder: QueryBuilder;
	progressCallback?: (progress: CodeGraphProgress) => void;
}

export interface SyncOrchestratorDeps extends SyncOrchestratorOptions {}

const PROGRESS_TICK = 16;

export class SyncOrchestrator {
	readonly #sourceRoot: string;
	readonly #connection: DatabaseConnection;
	readonly #queryBuilder: QueryBuilder;

	constructor(deps: SyncOrchestratorDeps) {
		this.#sourceRoot = deps.sourceRoot;
		this.#connection = deps.connection;
		this.#queryBuilder = deps.queryBuilder;
	}

	#emitProgress(
		callback: CodeGraphInitializeOptions["progressCallback"],
		phase: string,
		current: number,
		total: number,
	): void {
		if (!callback) return;
		try {
			callback({
				state: "indexing",
				phase,
				current,
				total,
				updatedAt: new Date().toISOString(),
				workerId: "orchestrator",
				attempt: 1,
			});
		} catch {
			// Progress callbacks are observability-only.
		}
	}

	async initialize(options: CodeGraphInitializeOptions = {}): Promise<CodeGraphInitializeResult> {
		const start = Date.now();
		this.#connection.ensureSchema();
		const previousSourceRoot = this.#queryBuilder.getMetadata("sourceRoot");
		const tracked = this.#queryBuilder.getAllFiles();
		const forceRebuild = options.forceRebuild === true;
		if (!forceRebuild && tracked.length > 0 && previousSourceRoot === this.#sourceRoot) {
			this.#emitProgress(options.progressCallback, "initialize", 0, 0);
			return {
				bootstrapped: false,
				filesChecked: 0,
				filesIndexed: 0,
				filesUpdated: 0,
				filesRemoved: 0,
				durationMs: Date.now() - start,
			};
		}
		for (const file of tracked) this.#queryBuilder.deleteFile(file.path);
		this.#queryBuilder.setMetadata("sourceRoot", this.#sourceRoot);
		const scanned = await scanProject(this.#sourceRoot);
		const total = scanned.length;
		this.#emitProgress(options.progressCallback, "scanning", 0, total);
		const results: ExtractResult[] = [];
		for (let i = 0; i < scanned.length; i++) {
			const scannedFile = scanned[i];
			try {
				results.push(await extractFile(this.#sourceRoot, scannedFile.filePath));
			} catch (err) {
				logWarn(`initialize: failed to extract ${scannedFile.filePath}: ${(err as Error).message}`);
			}
			const next = i + 1;
			if (next % PROGRESS_TICK === 0 || next === total) {
				this.#emitProgress(options.progressCallback, "extracting", next, total);
			}
		}
		this.#bulkPersist(results);
		try {
			this.#connection.getDb().exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
		} catch (err) {
			logWarn("FTS rebuild after initialize failed", { error: String(err) });
		}
		this.#emitProgress(options.progressCallback, "indexed", total, total);
		return {
			bootstrapped: true,
			filesChecked: total,
			filesIndexed: results.length,
			filesUpdated: 0,
			filesRemoved: 0,
			durationMs: Date.now() - start,
		};
	}

	/**
	 * Diff the scan against the persisted `files` table and apply
	 * add/modify/remove deltas. Source content is read from disk every
	 * time so we never serve stale DB bytes.
	 */
	async sync(opts: { paths?: readonly string[] } = {}): Promise<CodeGraphSyncResult> {
		const start = Date.now();
		this.#queryBuilder.setMetadata("sourceRoot", this.#sourceRoot);
		const paths = opts.paths;
		const normalizedScopes = paths?.map(p => normalizeScope(this.#sourceRoot, p)) ?? null;
		const scoped = normalizedScopes !== null && normalizedScopes.length > 0;
		const tracked = this.#queryBuilder.getAllFiles();
		const scanned = await scanProject(this.#sourceRoot, { paths });
		const scannedByPath = new Map(scanned.map(s => [s.filePath, s]));
		const trackedByPath = new Map(tracked.map(f => [f.path, f]));

		let indexed = 0;
		let updated = 0;
		const results: ExtractResult[] = [];
		for (const scannedEntry of scanned) {
			const prev = trackedByPath.get(scannedEntry.filePath);
			if (!prev) {
				try {
					results.push(await extractFile(this.#sourceRoot, scannedEntry.filePath));
					indexed++;
				} catch (err) {
					logWarn(`sync: failed to extract ${scannedEntry.filePath}: ${(err as Error).message}`);
				}
				continue;
			}
			const currentStat = await this.#stat(scannedEntry.filePath);
			if (!currentStat || currentStat.size !== prev.size || currentStat.mtimeMs !== prev.modifiedAt) {
				try {
					results.push(await extractFile(this.#sourceRoot, scannedEntry.filePath));
					updated++;
				} catch (err) {
					logWarn(`sync: failed to extract ${scannedEntry.filePath}: ${(err as Error).message}`);
				}
			}
		}
		this.#bulkPersist(results);

		let removed = 0;
		for (const prev of tracked) {
			if (scannedByPath.has(prev.path)) continue;
			if (scoped && normalizedScopes && !isWithinScopes(prev.path, normalizedScopes)) continue;
			this.#queryBuilder.deleteFile(prev.path);
			removed++;
		}
		try {
			this.#connection.getDb().exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
		} catch (err) {
			logWarn("FTS rebuild after removal loop failed", { error: String(err) });
		}
		return {
			filesChecked: scanned.length,
			filesIndexed: indexed,
			filesUpdated: updated,
			filesRemoved: removed,
			durationMs: Date.now() - start,
		};
	}

	#bulkPersist(results: ExtractResult[]): void {
		if (results.length === 0) return;
		const db = this.#connection.getDb();
		db.transaction(() => {
			for (const r of results) {
				this.#queryBuilder.clearFileGraph(r.file.path);
				for (const node of r.nodes) this.#queryBuilder.insertNode(node);
				for (const edge of r.edges) this.#queryBuilder.insertEdge(edge);
				for (const ref of r.refs) this.#queryBuilder.insertUnresolvedRef(ref);
				this.#queryBuilder.upsertFile(r.file);
			}
		})();
	}

	async #stat(relPath: string): Promise<{ size: number; mtimeMs: number } | null> {
		try {
			const st = await fs.stat(path.resolve(this.#sourceRoot, relPath));
			return { size: st.size, mtimeMs: st.mtimeMs };
		} catch {
			return null;
		}
	}
}

/**
 * Normalize a user-supplied scope to a sourceRoot-relative POSIX
 * path so directory predicates (`p === scope || p.startsWith(scope + '/')`)
 * line up with `tracked.path` values.
 */
function normalizeScope(sourceRoot: string, input: string): string {
	const trimmed = input.replace(/\\/g, "/");
	const abs = path.isAbsolute(trimmed) ? trimmed : path.join(sourceRoot, trimmed);
	const rel = path.relative(sourceRoot, abs);
	return rel.split(path.sep).join("/").replace(/^\.\//, "").replace(/\/+$/, "") || ".";
}

function isWithinScopes(filePath: string, scopes: readonly string[]): boolean {
	for (const scope of scopes) {
		if (!scope) continue;
		if (filePath === scope) return true;
		if (filePath.startsWith(`${scope}/`)) return true;
	}
	return false;
}
