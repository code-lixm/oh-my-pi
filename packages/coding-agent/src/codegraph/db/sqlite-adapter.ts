/**
 * SQLite adapter — adapted from upstream `src/db/sqlite-adapter.ts`
 * (MIT, Copyright (c) 2026 Colby Mchenry — see ./UPSTREAM_LICENSE).
 *
 * Upstream wraps Node's built-in `node:sqlite` because CodeGraph ships
 * its own runtime; OMP is Bun-native, so this port uses `bun:sqlite`
 * instead. The shape exposed to the rest of the runtime is identical
 * (real SQLite, WAL + FTS5, prepared statements, transactions, mmap,
 * `@named` params) — only the import path differs.
 *
 * Per shared `local://codegraph-contract.md`: the adapter NEVER opens
 * a project-local `.codegraph/` path. Callers hand in the injected
 * `dbPath` from `CodeGraphIndexLocation.dbPath`.
 */
import { type Statement as BunStatement, Database } from "bun:sqlite";

export interface SqliteStatement {
	run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
	values(...params: unknown[]): unknown[];
	/** Lazy row iterator — added so callers don't materialize huge result sets. */
	iterate(...params: unknown[]): IterableIterator<unknown>;
}

export interface SqliteDatabase {
	prepare(sql: string): SqliteStatement;
	exec(sql: string): void;
	pragma(value: string, options?: { simple?: boolean }): unknown;
	transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
	close(): void;
	readonly open: boolean;
}

/** Active backend — surfaced through {@link CodeGraphStatus}. */
export type SqliteBackend = "bun-sqlite";

class BunSqliteAdapter implements SqliteDatabase {
	readonly #db: Database;
	#open: boolean;

	constructor(path: string, opts?: { readOnly?: boolean }) {
		this.#db = new Database(path, opts?.readOnly ? { readonly: true } : undefined);
		this.#open = true;
	}

	get open(): boolean {
		return this.#open;
	}

	prepare(sql: string): SqliteStatement {
		const stmt = this.#db.prepare(sql);
		return wrap(stmt);
	}

	exec(sql: string): void {
		this.#db.exec(sql);
	}

	pragma(value: string, _options?: { simple?: boolean }): unknown {
		const trimmed = value.trim();
		// bun:sqlite does not expose `Database.pragma()`; we issue
		// PRAGMA statements through prepared SQL. `=` is a set-only
		// PRAGMA, otherwise we read it via PRAGMA <name>.
		const setMatch = /^\s*([\w_]+)\s*=\s*(.+)$/.exec(trimmed);
		if (setMatch) {
			this.#db.exec(`PRAGMA ${trimmed}`);
			return undefined;
		}
		const stmt = this.#db.prepare(`PRAGMA ${trimmed}`);
		return stmt.values();
	}
	transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
		// bun:sqlite's transaction wrapper inspects `fn.length` to decide
		// how to bind arguments; passing a rest-args function with
		// `.length === 0` causes "cb must be of type function". Match
		// the wrapped function's arity exactly.
		const bound = fn as unknown as (...args: never[]) => T;
		const wrapped = this.#db.transaction(bound) as unknown as (...args: never[]) => T;
		return wrapped as (...args: unknown[]) => T;
	}

	close(): void {
		if (!this.#open) return;
		this.#db.close();
		this.#open = false;
	}
}

function normalizeStatementParams(params: unknown[]): unknown[] {
	if (params.length !== 1) return params;
	const first = params[0];
	if (!first || typeof first !== "object" || Array.isArray(first)) return params;

	const expanded: Record<string, unknown> = {};
	let mutated = false;
	for (const [key, value] of Object.entries(first as Record<string, unknown>)) {
		expanded[key] = value;
		if (key.startsWith("@") || key.startsWith(":") || key.startsWith("$")) continue;
		mutated = true;
		expanded[`@${key}`] = value;
		expanded[`:${key}`] = value;
		expanded[`$${key}`] = value;
	}

	return mutated ? [expanded] : params;
}

function wrap(stmt: BunStatement): SqliteStatement {
	const run = stmt.run.bind(stmt) as BunStatement["run"];
	const get = stmt.get.bind(stmt) as BunStatement["get"];
	const all = stmt.all.bind(stmt) as BunStatement["all"];
	const values = stmt.values.bind(stmt) as BunStatement["values"];
	const iterate = stmt.iterate.bind(stmt) as BunStatement["iterate"];
	return {
		run(...params: unknown[]) {
			const r = run(...normalizeStatementParams(params));
			return {
				changes: r.changes,
				lastInsertRowid: r.lastInsertRowid,
			};
		},
		get(...params: unknown[]) {
			return get(...normalizeStatementParams(params));
		},
		all(...params: unknown[]) {
			return all(...normalizeStatementParams(params));
		},
		values(...params: unknown[]) {
			return values(...normalizeStatementParams(params));
		},
		iterate(...params: unknown[]) {
			return iterate(...normalizeStatementParams(params));
		},
	};
}

/**
 * Create a database connection backed by `bun:sqlite` at the injected
 * `dbPath`. The caller owns `indexDir` placement — the adapter never
 * reaches for `<sourceRoot>/.codegraph/`.
 */
export function createDatabase(
	dbPath: string,
	opts?: { readOnly?: boolean },
): { db: SqliteDatabase; backend: SqliteBackend } {
	return { db: new BunSqliteAdapter(dbPath, opts), backend: "bun-sqlite" };
}
