/**
 * Database lifecycle — adapted from upstream `src/db/index.ts`
 * (MIT, Copyright (c) 2026 Colby Mchenry — see ./UPSTREAM_LICENSE).
 *
 * Per the OMP shared contract, every database/lock/metadata path is
 * rooted in the injected `indexDir`. There is NO `<sourceRoot>/.codegraph`
 * probing — `DatabaseConnection.open(absoluteDbPath)` is the only entry
 * point, and the caller supplies the path from
 * `CodeGraphIndexLocation.dbPath`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { CodeGraphIndexLocation } from "../location";
import { QueryBuilder } from "./queries";
import schemaSql from "./schema.sql" with { type: "text" };
import type { SqliteBackend, SqliteDatabase } from "./sqlite-adapter";
import { createDatabase } from "./sqlite-adapter";

export type { SqliteBackend, SqliteDatabase };
export { createDatabase, QueryBuilder };

export const DATABASE_FILENAME = "codegraph.db";

const WAL_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

export interface DatabaseConnectionOptions {
	readOnly?: boolean;
}

export class DatabaseConnection {
	#db: SqliteDatabase;
	#backend: SqliteBackend;
	readonly #dbPath: string;
	#opened = true;

	private constructor(db: SqliteDatabase, backend: SqliteBackend, dbPath: string) {
		this.#db = db;
		this.#backend = backend;
		this.#dbPath = dbPath;
	}

	static open(dbPath: string, opts: DatabaseConnectionOptions = {}): DatabaseConnection {
		const { db, backend } = createDatabase(dbPath, { readOnly: opts.readOnly });
		if (!opts.readOnly) configureConnection(db);
		const conn = new DatabaseConnection(db, backend, dbPath);
		conn.ensureSchema();
		return conn;
	}

	static forLocation(location: CodeGraphIndexLocation, opts: DatabaseConnectionOptions = {}): DatabaseConnection {
		return DatabaseConnection.open(location.dbPath, opts);
	}

	getDb(): SqliteDatabase {
		return this.#db;
	}

	getPath(): string {
		return this.#dbPath;
	}

	getBackend(): SqliteBackend {
		return this.#backend;
	}

	get open(): boolean {
		return this.#opened;
	}

	beginBulkNodeLoad(): void {
		// Upstream drops per-row FTS triggers for the bulk phase and
		// rebuilds `nodes_fts` once at the end. The minimal port keeps
		// the per-row triggers; the runtime surface still allows that
		// optimization to land later.
	}

	endBulkNodeLoad(): void {
		// See `beginBulkNodeLoad` — no-op until the FTS drop-rebuild is
		// ported.
	}

	ensureSchema(): void {
		this.#db.exec(schemaSql);
		// External-content FTS indexes can outlive rows after an interrupted or
		// older incremental update. Repair them before any upsert/delete trigger
		// runs; rebuilding only after sync is too late because the first trigger
		// would fail while trying to delete the orphaned rowid.
		this.#db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
	}

	close(): void {
		if (!this.#opened) return;
		this.#db.close();
		this.#opened = false;
	}
}

function configureConnection(db: SqliteDatabase): void {
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");
	db.pragma("busy_timeout = 5000");
	db.pragma("temp_store = MEMORY");
	db.pragma("foreign_keys = ON");
}

export async function removeDatabaseFiles(dbPath: string): Promise<void> {
	try {
		await fs.promises.unlink(dbPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	for (const suffix of WAL_SIDECAR_SUFFIXES) {
		try {
			await fs.promises.unlink(`${dbPath}${suffix}`);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
	}
}

/** Best-effort: create the cache slot's parent directories. */
export async function ensureIndexDirs(location: CodeGraphIndexLocation): Promise<void> {
	await fs.promises.mkdir(path.dirname(location.dbPath), { recursive: true });
	await fs.promises.mkdir(path.dirname(location.lockPath), { recursive: true });
	await fs.promises.mkdir(path.dirname(location.metadataPath), { recursive: true });
}
