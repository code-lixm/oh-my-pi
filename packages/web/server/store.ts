import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { StoredEvent, StoredInteraction, StoredMessage, WebSessionRecord } from "./domain";

type EventListener = (event: StoredEvent) => void;

type SessionRow = {
	id: string;
	project_id: string;
	directory: string;
	session_path: string | null;
	parent_id: string | null;
	title: string;
	model: string | null;
	provider: string | null;
	created_at: number;
	updated_at: number;
};

type MessageRow = { id: string; session_id: string; data: string };
type EventRow = { sequence: number; session_id: string | null; directory: string; payload: string; created_at: number };
type InteractionRow = {
	id: string;
	session_id: string;
	kind: StoredInteraction["kind"];
	request: string;
	status: StoredInteraction["status"];
	created_at: number;
};

export class DurableStore {
	readonly #db: Database;
	readonly #listeners = new Set<EventListener>();

	static async open(file: string): Promise<DurableStore> {
		await fs.mkdir(path.dirname(file), { recursive: true });
		return new DurableStore(file);
	}

	constructor(file: string) {
		this.#db = new Database(file, { create: true, strict: true });
		this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				directory TEXT NOT NULL,
				session_path TEXT,
				parent_id TEXT,
				title TEXT NOT NULL,
				model TEXT,
				provider TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS sessions_directory_updated ON sessions(directory, updated_at DESC);
			CREATE TABLE IF NOT EXISTS messages (
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				id TEXT NOT NULL,
				data TEXT NOT NULL,
				PRIMARY KEY(session_id, id)
			);
			CREATE TABLE IF NOT EXISTS events (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT,
				directory TEXT NOT NULL,
				payload TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS events_session_sequence ON events(session_id, sequence);
			CREATE TABLE IF NOT EXISTS interactions (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				request TEXT NOT NULL,
				status TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS interactions_pending ON interactions(kind, status, created_at);
		`);
	}

	close(): void {
		this.#db.close();
	}

	onEvent(listener: EventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	upsertSession(session: WebSessionRecord): void {
		this.#db
			.query(`
				INSERT INTO sessions(id, project_id, directory, session_path, parent_id, title, model, provider, created_at, updated_at)
				VALUES($id, $projectID, $directory, $sessionPath, $parentID, $title, $model, $provider, $createdAt, $updatedAt)
				ON CONFLICT(id) DO UPDATE SET
					project_id = excluded.project_id,
					directory = excluded.directory,
					session_path = excluded.session_path,
					parent_id = excluded.parent_id,
					title = excluded.title,
					model = excluded.model,
					provider = excluded.provider,
					updated_at = excluded.updated_at
			`)
			.run({
				...session,
				sessionPath: session.sessionPath ?? null,
				parentID: session.parentID ?? null,
				model: session.model ?? null,
				provider: session.provider ?? null,
			});
	}

	getSession(id: string): WebSessionRecord | undefined {
		const row = this.#db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
		return row ? this.#session(row) : undefined;
	}

	listSessions(directory?: string): WebSessionRecord[] {
		const rows = directory
			? this.#db
					.query<SessionRow, [string]>("SELECT * FROM sessions WHERE directory = ? ORDER BY updated_at DESC")
					.all(directory)
			: this.#db.query<SessionRow, []>("SELECT * FROM sessions ORDER BY updated_at DESC").all();
		return rows.map(row => this.#session(row));
	}

	deleteSession(id: string): boolean {
		return this.#db.query("DELETE FROM sessions WHERE id = ?").run(id).changes > 0;
	}

	replaceMessages(sessionID: string, messages: StoredMessage[]): void {
		const replace = this.#db.transaction((items: StoredMessage[]) => {
			this.#db.query("DELETE FROM messages WHERE session_id = ?").run(sessionID);
			const insert = this.#db.query("INSERT INTO messages(session_id, id, data) VALUES (?, ?, ?)");
			for (const message of items) insert.run(sessionID, message.id, JSON.stringify(message.data));
		});
		replace(messages);
	}

	listMessages(sessionID: string): StoredMessage[] {
		return this.#db
			.query<MessageRow, [string]>("SELECT id, session_id, data FROM messages WHERE session_id = ? ORDER BY rowid")
			.all(sessionID)
			.map(row => ({ id: row.id, sessionID: row.session_id, data: JSON.parse(row.data) }));
	}

	appendEvent(directory: string, payload: unknown, sessionID?: string): StoredEvent {
		const createdAt = Date.now();
		const result = this.#db
			.query("INSERT INTO events(session_id, directory, payload, created_at) VALUES (?, ?, ?, ?)")
			.run(sessionID ?? null, directory, JSON.stringify(payload), createdAt);
		const event: StoredEvent = {
			sequence: Number(result.lastInsertRowid),
			sessionID,
			directory,
			payload,
			createdAt,
		};
		for (const listener of this.#listeners) listener(event);
		return event;
	}

	listEvents(after = 0, sessionID?: string, limit = 1000): StoredEvent[] {
		const rows = sessionID
			? this.#db
					.query<EventRow, [number, string, number]>(
						"SELECT * FROM events WHERE sequence > ? AND session_id = ? ORDER BY sequence LIMIT ?",
					)
					.all(after, sessionID, limit)
			: this.#db
					.query<EventRow, [number, number]>("SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?")
					.all(after, limit);
		return rows.map(row => ({
			sequence: row.sequence,
			sessionID: row.session_id ?? undefined,
			directory: row.directory,
			payload: JSON.parse(row.payload),
			createdAt: row.created_at,
		}));
	}

	upsertInteraction(interaction: StoredInteraction): void {
		this.#db
			.query(`
				INSERT INTO interactions(id, session_id, kind, request, status, created_at)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET request = excluded.request, status = excluded.status
			`)
			.run(
				interaction.id,
				interaction.sessionID,
				interaction.kind,
				JSON.stringify(interaction.request),
				interaction.status,
				interaction.createdAt,
			);
	}

	resolveInteraction(id: string, status: "resolved" | "rejected"): boolean {
		return (
			this.#db.query("UPDATE interactions SET status = ? WHERE id = ? AND status = 'pending'").run(status, id)
				.changes > 0
		);
	}

	listInteractions(kind?: StoredInteraction["kind"], sessionID?: string): StoredInteraction[] {
		const clauses = ["status = 'pending'"];
		const values: string[] = [];
		if (kind) {
			clauses.push("kind = ?");
			values.push(kind);
		}
		if (sessionID) {
			clauses.push("session_id = ?");
			values.push(sessionID);
		}
		const rows = this.#db
			.query<InteractionRow, string[]>(
				`SELECT * FROM interactions WHERE ${clauses.join(" AND ")} ORDER BY created_at`,
			)
			.all(...values);
		return rows.map(row => ({
			id: row.id,
			sessionID: row.session_id,
			kind: row.kind,
			request: JSON.parse(row.request),
			status: row.status,
			createdAt: row.created_at,
		}));
	}

	#session(row: SessionRow): WebSessionRecord {
		return {
			id: row.id,
			projectID: row.project_id,
			directory: row.directory,
			sessionPath: row.session_path ?? undefined,
			parentID: row.parent_id ?? undefined,
			title: row.title,
			model: row.model ?? undefined,
			provider: row.provider ?? undefined,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}
}
