import { Database } from "bun:sqlite";
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { closeDb, getStatsByFolder, initDb } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

const PROJECT_FOLDERS_KEY = "project_folders_v2";
const DESKTOP_BUCKET = "-Desktop-project-identity-a1b2";
const HOME_BUCKET = "home-name-identity-a1b2";
const TIMESTAMP = "2026-08-01T12:00:00.000Z";
const TIMESTAMP_MS = Date.parse(TIMESTAMP);

type SessionOptions = {
	cwd?: string;
	entries?: unknown[];
};

function assistantEntry(id: string, timestamp = TIMESTAMP): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			stopReason: "stop",
			timestamp: Date.parse(timestamp),
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
}

async function writeSession(bucket: string, fileName: string, options: SessionOptions): Promise<string> {
	const sessionDir = path.join(getSessionsDir(), bucket);
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, fileName);
	const lines = [
		...(options.cwd === undefined
			? []
			: [
					{
						type: "session",
						version: 3,
						id: `${bucket}-${fileName}`,
						timestamp: TIMESTAMP,
						cwd: options.cwd,
					},
				]),
		...(options.entries ?? [assistantEntry(`${bucket}-${fileName}-assistant`)]),
	].map(entry => JSON.stringify(entry));
	await fs.writeFile(sessionFile, `${lines.join("\n")}\n`);
	return sessionFile;
}

async function makeEquivalentProjectPath(): Promise<{ canonical: string; headerCwd: string }> {
	const temp = isolation.current();
	if (!temp) throw new Error("stats test isolation is not active");
	const canonical = temp.join("projects", "shared");
	const headerCwd = temp.join("project-alias");
	await fs.mkdir(canonical, { recursive: true });
	await fs.symlink(canonical, headerCwd, process.platform === "win32" ? "junction" : "dir");
	return { canonical: await fs.realpath(canonical), headerCwd };
}

const isolation = installStatsTestIsolation("@pi-stats-project-identity-");

describe("stats project identity", () => {
	it("uses the canonical header cwd instead of either physical session bucket", async () => {
		const { canonical, headerCwd } = await makeEquivalentProjectPath();
		const desktopFile = await writeSession(DESKTOP_BUCKET, "desktop.jsonl", { cwd: headerCwd });
		const homeFile = await writeSession(HOME_BUCKET, "home.jsonl", { cwd: headerCwd });

		const [desktop, home] = await Promise.all([parseSessionFile(desktopFile), parseSessionFile(homeFile)]);

		expect(desktop.stats).toHaveLength(1);
		expect(home.stats).toHaveLength(1);
		expect(desktop.stats[0]?.folder).toBe(canonical);
		expect(home.stats[0]?.folder).toBe(canonical);
	});

	it("keeps a relative session header cwd unchanged", async () => {
		const file = await writeSession("relative-cwd-project", "relative.jsonl", { cwd: "repo" });

		const parsed = await parseSessionFile(file);

		expect(parsed.stats).toHaveLength(1);
		expect(parsed.stats[0]?.folder).toBe("repo");
	});

	it("keeps the physical bucket fallback when the session header is absent", async () => {
		const file = await writeSession("--legacy--project", "headerless.jsonl", {
			entries: [assistantEntry("headerless-assistant")],
		});

		const parsed = await parseSessionFile(file);

		expect(parsed.stats).toHaveLength(1);
		expect(parsed.stats[0]?.folder).toBe("/legacy/project");
	});

	it("migrates legacy folder values in messages, user_messages, and tool_calls", async () => {
		await initDb();
		closeDb();

		const { canonical, headerCwd } = await makeEquivalentProjectPath();
		const desktopFile = await writeSession(DESKTOP_BUCKET, "desktop.jsonl", { cwd: headerCwd });
		const homeFile = await writeSession(HOME_BUCKET, "home.jsonl", { cwd: headerCwd });

		const legacy = new Database(getStatsDbPath());
		legacy.prepare("DELETE FROM meta WHERE key = ?").run(PROJECT_FOLDERS_KEY);
		const insertMessage = legacy.prepare(`
			INSERT INTO messages (
				session_file, entry_id, folder, model, provider, api, timestamp,
				duration, ttft, stop_reason, error_message,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
				cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const insertUser = legacy.prepare(`
			INSERT INTO user_messages (
				session_file, entry_id, folder, timestamp, model, provider,
				chars, words, yelling, profanity, anguish, negation, repetition, blame
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const insertTool = legacy.prepare(`
			INSERT INTO tool_calls (
				session_file, entry_id, tool_call_id, folder, tool_name, model, provider, timestamp,
				calls_in_turn, args_chars
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		const rows = [
			{ file: desktopFile, oldFolder: DESKTOP_BUCKET, suffix: "desktop", input: 10, output: 5, chars: 4, args: 3 },
			{ file: homeFile, oldFolder: HOME_BUCKET, suffix: "home", input: 20, output: 7, chars: 6, args: 4 },
		];
		for (const row of rows) {
			insertMessage.run(
				row.file,
				`assistant-${row.suffix}`,
				row.oldFolder,
				"gpt-5.4",
				"openai",
				"openai-responses",
				TIMESTAMP_MS,
				1000,
				100,
				"stop",
				null,
				row.input,
				row.output,
				0,
				0,
				row.input + row.output,
				0,
				0,
				0,
				0,
				0,
				0,
			);
			insertUser.run(
				row.file,
				`user-${row.suffix}`,
				row.oldFolder,
				TIMESTAMP_MS,
				null,
				null,
				row.chars,
				1,
				0,
				0,
				0,
				0,
				0,
				0,
			);
			insertTool.run(
				row.file,
				`assistant-${row.suffix}`,
				`tool-${row.suffix}`,
				row.oldFolder,
				"read",
				"gpt-5.4",
				"openai",
				TIMESTAMP_MS,
				1,
				row.args,
			);
		}
		legacy.close();

		const database = await initDb();
		const byFolder = getStatsByFolder();
		expect(byFolder).toHaveLength(1);
		expect(byFolder[0]).toMatchObject({
			folder: canonical,
			totalRequests: 2,
			totalInputTokens: 30,
			totalOutputTokens: 12,
		});

		const messageRows = database
			.prepare("SELECT session_file, folder FROM messages ORDER BY session_file")
			.all() as Array<{ session_file: string; folder: string }>;
		const userRows = database
			.prepare("SELECT session_file, folder FROM user_messages ORDER BY session_file")
			.all() as Array<{ session_file: string; folder: string }>;
		const toolRows = database
			.prepare("SELECT session_file, folder FROM tool_calls ORDER BY session_file")
			.all() as Array<{ session_file: string; folder: string }>;
		const expectedFiles = [desktopFile, homeFile].sort();

		for (const rowsForTable of [messageRows, userRows, toolRows]) {
			expect(rowsForTable).toHaveLength(2);
			expect(rowsForTable.map(row => row.session_file)).toEqual(expectedFiles);
			expect(rowsForTable.map(row => row.folder)).toEqual([canonical, canonical]);
		}

		const userTotals = database.prepare("SELECT COUNT(*) AS count, SUM(chars) AS chars FROM user_messages").get() as {
			count: number;
			chars: number;
		};
		const toolTotals = database
			.prepare("SELECT COUNT(*) AS count, SUM(args_chars) AS args FROM tool_calls")
			.get() as {
			count: number;
			args: number;
		};
		expect(userTotals).toEqual({ count: 2, chars: 10 });
		expect(toolTotals).toEqual({ count: 2, args: 7 });
	});

	it("migrates colliding legacy buckets per session file without merging projects", async () => {
		await initDb();
		closeDb();

		const temp = isolation.current();
		if (!temp) throw new Error("stats test isolation is not active");
		const firstHeaderCwd = temp.join("legacy-collision", "a-b", "c");
		const secondHeaderCwd = temp.join("legacy-collision", "a", "b-c");
		await Promise.all([
			fs.mkdir(firstHeaderCwd, { recursive: true }),
			fs.mkdir(secondHeaderCwd, { recursive: true }),
		]);
		const [firstCanonical, secondCanonical] = await Promise.all([
			fs.realpath(firstHeaderCwd),
			fs.realpath(secondHeaderCwd),
		]);
		const encodeLegacyBucket = (cwd: string) =>
			`--${path
				.resolve(cwd)
				.replace(/^[\\/]/, "")
				.replace(/[\\/:]/g, "-")}--`;
		const legacyBucket = encodeLegacyBucket(firstCanonical);
		expect(encodeLegacyBucket(secondCanonical)).toBe(legacyBucket);

		const firstFile = await writeSession(legacyBucket, "first.jsonl", { cwd: firstHeaderCwd });
		const secondFile = await writeSession(legacyBucket, "second.jsonl", { cwd: secondHeaderCwd });
		const rows = [
			{ file: firstFile, folder: firstCanonical, suffix: "first", input: 11, output: 2, chars: 7, args: 3 },
			{ file: secondFile, folder: secondCanonical, suffix: "second", input: 23, output: 5, chars: 13, args: 8 },
		];

		const legacy = new Database(getStatsDbPath());
		legacy.prepare("DELETE FROM meta WHERE key = ?").run(PROJECT_FOLDERS_KEY);
		const insertMessage = legacy.prepare(`
			INSERT INTO messages (
				session_file, entry_id, folder, model, provider, api, timestamp,
				duration, ttft, stop_reason, error_message,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
				cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const insertUser = legacy.prepare(`
			INSERT INTO user_messages (
				session_file, entry_id, folder, timestamp, model, provider,
				chars, words, yelling, profanity, anguish, negation, repetition, blame
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const insertTool = legacy.prepare(`
			INSERT INTO tool_calls (
				session_file, entry_id, tool_call_id, folder, tool_name, model, provider, timestamp,
				calls_in_turn, args_chars
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const row of rows) {
			insertMessage.run(
				row.file,
				`assistant-${row.suffix}`,
				legacyBucket,
				"gpt-5.4",
				"openai",
				"openai-responses",
				TIMESTAMP_MS,
				1000,
				100,
				"stop",
				null,
				row.input,
				row.output,
				0,
				0,
				row.input + row.output,
				0,
				0,
				0,
				0,
				0,
				0,
			);
			insertUser.run(
				row.file,
				`user-${row.suffix}`,
				legacyBucket,
				TIMESTAMP_MS,
				null,
				null,
				row.chars,
				1,
				0,
				0,
				0,
				0,
				0,
				0,
			);
			insertTool.run(
				row.file,
				`assistant-${row.suffix}`,
				`tool-${row.suffix}`,
				legacyBucket,
				"read",
				"gpt-5.4",
				"openai",
				TIMESTAMP_MS,
				1,
				row.args,
			);
		}
		legacy.close();

		const database = await initDb();
		const counts = database
			.prepare(`
				SELECT
					(SELECT COUNT(*) FROM messages) AS messages,
					(SELECT COUNT(*) FROM user_messages) AS user_messages,
					(SELECT COUNT(*) FROM tool_calls) AS tool_calls
			`)
			.get() as { messages: number; user_messages: number; tool_calls: number };
		expect(counts).toEqual({ messages: 2, user_messages: 2, tool_calls: 2 });

		for (const row of rows) {
			const message = database
				.prepare("SELECT folder, input_tokens, output_tokens FROM messages WHERE session_file = ?")
				.get(row.file);
			const userMessage = database
				.prepare("SELECT folder, chars FROM user_messages WHERE session_file = ?")
				.get(row.file);
			const toolCall = database
				.prepare("SELECT folder, args_chars FROM tool_calls WHERE session_file = ?")
				.get(row.file);
			expect(message).toEqual({ folder: row.folder, input_tokens: row.input, output_tokens: row.output });
			expect(userMessage).toEqual({ folder: row.folder, chars: row.chars });
			expect(toolCall).toEqual({ folder: row.folder, args_chars: row.args });
		}

		const statsByFolder = getStatsByFolder();
		expect(statsByFolder).toHaveLength(2);
		for (const row of rows) {
			expect(statsByFolder.find(stats => stats.folder === row.folder)).toMatchObject({
				folder: row.folder,
				totalRequests: 1,
				totalInputTokens: row.input,
				totalOutputTokens: row.output,
			});
		}
	});

	it("migrates readable legacy rows, keeps the folder backfill pending after a non-ENOENT read error, and retries later", async () => {
		await initDb();
		closeDb();

		const temp = isolation.current();
		if (!temp) throw new Error("stats test isolation is not active");
		const readableCwd = temp.join("migration", "readable");
		const unreadableCwd = temp.join("migration", "unreadable");
		await Promise.all([fs.mkdir(readableCwd, { recursive: true }), fs.mkdir(unreadableCwd, { recursive: true })]);
		const readableFile = await writeSession(HOME_BUCKET, "readable.jsonl", { cwd: readableCwd });
		const unreadableFile = await writeSession(DESKTOP_BUCKET, "unreadable.jsonl", { cwd: unreadableCwd });
		const [readableFolder, unreadableFolder] = await Promise.all([
			fs.realpath(readableCwd),
			fs.realpath(unreadableCwd),
		]);
		const rows = [
			{ file: readableFile, oldFolder: HOME_BUCKET, suffix: "readable", input: 13, output: 8, chars: 9, args: 5 },
			{
				file: unreadableFile,
				oldFolder: DESKTOP_BUCKET,
				suffix: "unreadable",
				input: 17,
				output: 6,
				chars: 11,
				args: 7,
			},
		];

		const legacy = new Database(getStatsDbPath());
		legacy.prepare("DELETE FROM meta WHERE key = ?").run(PROJECT_FOLDERS_KEY);
		const insertMessage = legacy.prepare(`
			INSERT INTO messages (
				session_file, entry_id, folder, model, provider, api, timestamp,
				duration, ttft, stop_reason, error_message,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
				cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const insertUser = legacy.prepare(`
			INSERT INTO user_messages (
				session_file, entry_id, folder, timestamp, model, provider,
				chars, words, yelling, profanity, anguish, negation, repetition, blame
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const insertTool = legacy.prepare(`
			INSERT INTO tool_calls (
				session_file, entry_id, tool_call_id, folder, tool_name, model, provider, timestamp,
				calls_in_turn, args_chars
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const row of rows) {
			insertMessage.run(
				row.file,
				`assistant-${row.suffix}`,
				row.oldFolder,
				"gpt-5.4",
				"openai",
				"openai-responses",
				TIMESTAMP_MS,
				1000,
				100,
				"stop",
				null,
				row.input,
				row.output,
				0,
				0,
				row.input + row.output,
				0,
				0,
				0,
				0,
				0,
				0,
			);
			insertUser.run(
				row.file,
				`user-${row.suffix}`,
				row.oldFolder,
				TIMESTAMP_MS,
				null,
				null,
				row.chars,
				1,
				0,
				0,
				0,
				0,
				0,
				0,
			);
			insertTool.run(
				row.file,
				`assistant-${row.suffix}`,
				`tool-${row.suffix}`,
				row.oldFolder,
				"read",
				"gpt-5.4",
				"openai",
				TIMESTAMP_MS,
				1,
				row.args,
			);
		}
		legacy.close();

		const readError = Object.assign(new Error("simulated permission failure"), { code: "EACCES" });
		const unreadableHandle = {
			slice: () => ({
				bytes: async () => {
					throw readError;
				},
			}),
		} as unknown as Bun.BunFile;
		const realBunFile = Bun.file.bind(Bun);
		const fileSpy = vi.spyOn(Bun, "file").mockImplementation((source, options) => {
			if (source === unreadableFile) return unreadableHandle;
			return realBunFile(source, options);
		});

		try {
			const database = await initDb();
			for (const table of ["messages", "user_messages", "tool_calls"] as const) {
				const migratedRows = database.prepare(`SELECT session_file, folder FROM ${table}`).all() as Array<{
					session_file: string;
					folder: string;
				}>;
				expect(migratedRows).toHaveLength(2);
				expect(migratedRows).toContainEqual({ session_file: readableFile, folder: readableFolder });
				expect(migratedRows).toContainEqual({ session_file: unreadableFile, folder: DESKTOP_BUCKET });
			}

			const sentinel = database.prepare("SELECT value FROM meta WHERE key = ?").get(PROJECT_FOLDERS_KEY) as
				| { value: string }
				| undefined;
			expect(sentinel).toEqual({ value: "pending" });
		} finally {
			fileSpy.mockRestore();
		}

		closeDb();
		const retriedDatabase = await initDb();
		for (const table of ["messages", "user_messages", "tool_calls"] as const) {
			const retriedUnreadable = retriedDatabase
				.prepare(`SELECT folder FROM ${table} WHERE session_file = ?`)
				.get(unreadableFile);
			expect(retriedUnreadable).toEqual({ folder: unreadableFolder });
		}
		const retriedSentinel = retriedDatabase
			.prepare("SELECT value FROM meta WHERE key = ?")
			.get(PROJECT_FOLDERS_KEY) as { value: string } | undefined;
		expect(retriedSentinel).toEqual({ value: "complete" });
	});
});
