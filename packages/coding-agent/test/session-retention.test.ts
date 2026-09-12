/**
 * Contracts: automatic cold-session retention on session start.
 *
 * - The scan honors the `gc.archive` switch (disabled → no-op).
 * - Runs are throttled through a marker file in the agent dir: the first run
 *   archives eligible sessions and stamps the marker; an immediate second run
 *   is throttled.
 * - Archived sessions keep their stats: preservation is asserted here through
 *   the seeded stats.db rows surviving the auto run.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runAutoArchiveScan } from "@oh-my-pi/pi-coding-agent/cli/session-retention";
import { getAgentDir, getHistoryDbPath, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let root: string;
let settingsState: SettingsTestState | undefined;
let originalAgentDir: string;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	originalAgentDir = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-retention-"));
	setAgentDir(root);
});

afterEach(async () => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	setAgentDir(originalAgentDir);
	await fs.rm(root, { recursive: true, force: true });
});

async function writeOldSession(id: string, ageDays: number): Promise<string> {
	const sessionDir = path.join(getSessionsDir(root), "project");
	await fs.mkdir(sessionDir, { recursive: true });
	const file = path.join(sessionDir, `${id}.jsonl`);
	await fs.writeFile(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: [] } }),
			"",
		].join("\n"),
	);
	const ts = new Date(Date.now() - ageDays * 86_400_000);
	await fs.utimes(file, ts, ts);
	return file;
}

async function writeConfig(entries: string[]): Promise<void> {
	await Bun.write(path.join(root, "config.yml"), ["gc:", ...entries.map(entry => `  ${entry}`), ""].join("\n"));
}

describe("auto archive retention scan", () => {
	test("is a no-op when gc.archive is disabled", async () => {
		await writeOldSession("old-session", 90);
		await writeConfig([
			"archive: false",
			"coldArchiveAfterDays: 30",
			"retainNewestGlobal: 0",
			"retainNewestPerCwd: 0",
		]);

		const outcome = await runAutoArchiveScan(root);

		expect(outcome).toEqual({ ran: false, reason: "disabled" });
		expect(await Bun.file(path.join(getSessionsDir(root), "project", "old-session.jsonl")).exists()).toBe(true);
	});

	test("archives eligible sessions once, then throttles within the window", async () => {
		const file = await writeOldSession("old-session", 90);
		await writeConfig([
			"archive: true",
			"coldArchiveAfterDays: 30",
			"retainNewestGlobal: 0",
			"retainNewestPerCwd: 0",
		]);

		const first = await runAutoArchiveScan(root);
		expect(first.ran).toBe(true);
		expect(first.archived).toBe(1);
		expect(await Bun.file(file).exists()).toBe(false);
		expect(await Bun.file(path.join(root, "archive", "sessions", "project", "old-session.jsonl.gz")).exists()).toBe(
			true,
		);

		// Marker stamped by the first run: an immediate second scan is throttled
		// even though another aged session now exists.
		const second = await writeOldSession("old-session-2", 90);
		const secondOutcome = await runAutoArchiveScan(root);
		expect(secondOutcome).toEqual({ ran: false, reason: "throttled" });
		expect(await Bun.file(second).exists()).toBe(true);
	});

	test("preservation keeps seeded stats rows across the auto archive", async () => {
		const file = await writeOldSession("stats-session", 90);
		const statsDbPath = path.join(root, "stats.db");
		const tables = ["messages", "user_messages", "tool_calls", "file_offsets"] as const;
		const db = new Database(statsDbPath);
		for (const table of tables) {
			db.run(`CREATE TABLE ${table} (session_file TEXT NOT NULL)`);
			db.prepare(`INSERT INTO ${table} (session_file) VALUES (?)`).run(file);
		}
		db.close();

		await writeConfig([
			"archive: true",
			"coldArchiveAfterDays: 30",
			"retainNewestGlobal: 0",
			"retainNewestPerCwd: 0",
		]);
		const outcome = await runAutoArchiveScan(root);
		expect(outcome.ran).toBe(true);

		const check = new Database(statsDbPath);
		try {
			for (const table of tables) {
				const row = check.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
				expect(row.count).toBe(1);
			}
		} finally {
			check.close();
		}
	});

	test("runs even when the marker file is missing (fresh agent dir)", async () => {
		await writeOldSession("first-ever", 90);
		await writeConfig([
			"archive: true",
			"coldArchiveAfterDays: 30",
			"retainNewestGlobal: 0",
			"retainNewestPerCwd: 0",
		]);
		expect(await Bun.file(path.join(root, "last-auto-archive")).exists()).toBe(false);

		const outcome = await runAutoArchiveScan(root);
		expect(outcome.ran).toBe(true);
		expect(await Bun.file(path.join(root, "last-auto-archive")).exists()).toBe(true);
		expect(getHistoryDbPath(root)).toBeTruthy();
	});
});
