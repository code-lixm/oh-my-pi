import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions, syncSessionFiles } from "@oh-my-pi/omp-stats/aggregator";
import { getOverallStats, getRecentRequests } from "@oh-my-pi/omp-stats/db";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-sync-serial-");

afterEach(() => {
	vi.restoreAllMocks();
});

async function writeSessionFile(options?: { includeCost?: boolean }): Promise<void> {
	const sessionDir = path.join(getSessionsDir(), "--tmp--sync-serial");
	await fs.mkdir(sessionDir, { recursive: true });
	const timestamp = new Date().toISOString();
	const sessionFile = path.join(sessionDir, "session.jsonl");
	const includeCost = options?.includeCost ?? true;
	const assistant = {
		type: "message",
		id: "assistant-1",
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				...(includeCost ? { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } : {}),
			},
			stopReason: "stop",
			timestamp: Date.now(),
			duration: 10,
			ttft: 5,
		},
	};
	await Bun.write(sessionFile, `${JSON.stringify(assistant)}\n`);
}

function rewriteSessionText(options: {
	entryId: string;
	model: string;
	input: number;
	output: number;
	totalTokens: number;
	timestamp: string;
}): string {
	const header = {
		type: "session",
		version: 3,
		id: "rewrite-session",
		timestamp: "2026-06-24T10:00:00.000Z",
		cwd: "/tmp/project",
	};
	const assistant = {
		type: "message",
		id: options.entryId,
		parentId: null,
		timestamp: options.timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: options.model,
			usage: {
				input: options.input,
				output: options.output,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: options.totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.parse(options.timestamp),
			duration: 10,
			ttft: 5,
		},
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n`;
}

async function writeRewriteSession(text: string): Promise<string> {
	const sessionDir = path.join(getSessionsDir(), "--tmp--sync-rewrite");
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, "session.jsonl");
	await fs.writeFile(sessionFile, text);
	return sessionFile;
}

describe("stats sync serial mode", () => {
	it("honors workers: 1 without spawning a worker", async () => {
		await writeSessionFile();
		const workerSpy = vi.spyOn(globalThis, "Worker");

		const synced = await syncAllSessions({ workers: 1 });
		const overall = getOverallStats();

		expect(synced.files).toBe(1);
		expect(overall.totalRequests).toBe(1);
		expect(workerSpy).not.toHaveBeenCalled();
	});

	it("syncs legacy session usage without a cost breakdown", async () => {
		await writeSessionFile({ includeCost: false });

		const synced = await syncAllSessions({ workers: 1 });
		const overall = getOverallStats();

		expect(synced).toEqual({ processed: 1, files: 1 });
		expect(overall.totalRequests).toBe(1);
		expect(overall.totalCost).toBeGreaterThan(0);
	});

	it("uses the serial parser by default on macOS", async () => {
		await writeSessionFile();
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		const workerSpy = vi.spyOn(globalThis, "Worker");

		const synced = await syncAllSessions();
		const overall = getOverallStats();

		expect(synced.files).toBe(1);
		expect(overall.totalRequests).toBe(1);
		expect(workerSpy).not.toHaveBeenCalled();
	});

	it("spawns a worker pool when callers explicitly request workers: 2 with a single file", async () => {
		await writeSessionFile();
		const workerProbe = new Error("worker probe");
		const workerSpy = vi.spyOn(globalThis, "Worker").mockImplementation(() => {
			throw workerProbe;
		});

		await expect(syncAllSessions({ workers: 2 })).rejects.toBe(workerProbe);
		expect(workerSpy).toHaveBeenCalled();
	});

	it("replaces prior aggregates after a same-size session rewrite", async () => {
		const originalText = rewriteSessionText({
			entryId: "rewrite-a",
			model: "gpt-5.4-a",
			input: 111,
			output: 222,
			totalTokens: 333,
			timestamp: "2026-06-24T10:00:00.000Z",
		});
		const replacementText = rewriteSessionText({
			entryId: "rewrite-b",
			model: "gpt-5.4-b",
			input: 444,
			output: 555,
			totalTokens: 999,
			timestamp: "2026-06-24T10:01:00.000Z",
		});
		expect(Buffer.byteLength(replacementText)).toBe(Buffer.byteLength(originalText));

		const sessionFile = await writeRewriteSession(originalText);
		await syncSessionFiles([sessionFile], { workers: 1 });
		expect(getOverallStats()).toMatchObject({
			totalRequests: 1,
			totalInputTokens: 111,
			totalOutputTokens: 222,
		});

		await fs.writeFile(sessionFile, replacementText);
		const bumped = new Date(Date.now() + 1_000);
		await fs.utimes(sessionFile, bumped, bumped);
		await syncSessionFiles([sessionFile], { workers: 1 });

		const overall = getOverallStats();
		expect(overall.totalRequests).toBe(1);
		expect(overall.totalInputTokens).toBe(444);
		expect(overall.totalOutputTokens).toBe(555);
		const requests = getRecentRequests(2);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			entryId: "rewrite-b",
			model: "gpt-5.4-b",
			usage: { input: 444, output: 555, totalTokens: 999 },
		});
	});
});
