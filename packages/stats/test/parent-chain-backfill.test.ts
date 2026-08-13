import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, getBehaviorOverall } from "@oh-my-pi/omp-stats/db";
import { getAgentDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-parent-chain-backfill-");

const TIMESTAMP = "2026-08-13T12:00:00.000Z";
const MESSAGE_TIMESTAMP = Date.parse(TIMESTAMP);
const MODEL = "gpt-5.4";
const PROVIDER = "openai";

function userEntry(id: string, content: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: TIMESTAMP,
		message: { role: "user", content },
	};
}

function customRunEntry(id: string, parentId: string): Record<string, unknown> {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: TIMESTAMP,
		customType: "session_run_start",
		data: {},
	};
}

function toolResultEntry(id: string, parentId: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "tool output" }],
			isError: false,
			timestamp: MESSAGE_TIMESTAMP,
		},
	};
}

function assistantEntry(id: string, parentId: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: PROVIDER,
			model: MODEL,
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: MESSAGE_TIMESTAMP,
			duration: 10,
			ttft: 5,
		},
	};
}

async function writeSessionFile(entries: Record<string, unknown>[]): Promise<string> {
	const sessionDir = path.join(getAgentDir(), "sessions", "--tmp--parent-chain-backfill");
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, "session.jsonl");
	const header = {
		type: "session",
		version: 3,
		id: "parent-chain-session",
		timestamp: TIMESTAMP,
		cwd: "/tmp/parent-chain-backfill",
	};
	await Bun.write(sessionFile, `${[header, ...entries].map(entry => JSON.stringify(entry)).join("\n")}\n`);
	return sessionFile;
}
async function syncSession(entries: Record<string, unknown>[]): Promise<string> {
	const sessionFile = await writeSessionFile(entries);
	await syncAllSessions({ workers: 1 });
	return sessionFile;
}

function readUserRows(sessionFile: string): Array<{ entry_id: string; model: string | null; provider: string | null }> {
	const database = new Database(getStatsDbPath(), { readonly: true });
	try {
		return database
			.prepare("SELECT entry_id, model, provider FROM user_messages WHERE session_file = ? ORDER BY entry_id")
			.all(sessionFile) as Array<{ entry_id: string; model: string | null; provider: string | null }>;
	} finally {
		database.close();
	}
}

describe("user-message model backfill through parent chains", () => {
	it("keeps direct assistant-to-user attribution working", async () => {
		const sessionFile = await syncSession([
			userEntry("user-1", "PLEASE FIX THIS NOW"),
			assistantEntry("assistant-1", "user-1"),
		]);

		expect(getBehaviorOverall(null).totalMessages).toBe(1);
		closeDb();
		expect(readUserRows(sessionFile)).toEqual([{ entry_id: "user-1", model: MODEL, provider: PROVIDER }]);
	});

	it("backfills through a custom lifecycle parent instead of falling back to a newer prompt", async () => {
		const sessionFile = await syncSession([
			userEntry("user-1", "PLEASE FIX THIS NOW"),
			customRunEntry("run-1", "user-1"),
			// This later prompt makes a broken one-hop lookup fall back to user-2.
			userEntry("user-2", "WAIT FOR THE FIRST RUN"),
			assistantEntry("assistant-1", "run-1"),
		]);

		expect(getBehaviorOverall(null).totalMessages).toBe(2);
		closeDb();
		expect(readUserRows(sessionFile)).toEqual([
			{ entry_id: "user-1", model: MODEL, provider: PROVIDER },
			{ entry_id: "user-2", model: null, provider: null },
		]);
	});

	it("backfills through a tool-result and custom lifecycle parent chain", async () => {
		const sessionFile = await syncSession([
			userEntry("user-1", "PLEASE FIX THIS NOW"),
			customRunEntry("run-1", "user-1"),
			// A distinct latest user proves the full multi-hop chain is used.
			userEntry("user-2", "WAIT FOR THE FIRST RUN"),
			toolResultEntry("tool-result-1", "run-1"),
			assistantEntry("assistant-2", "tool-result-1"),
		]);

		expect(getBehaviorOverall(null).totalMessages).toBe(2);
		closeDb();
		expect(readUserRows(sessionFile)).toEqual([
			{ entry_id: "user-1", model: MODEL, provider: PROVIDER },
			{ entry_id: "user-2", model: null, provider: null },
		]);
	});
});
