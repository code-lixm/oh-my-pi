/**
 * Contracts: AdvisorTranscriptRecorder persists the advisor agent's turns to a
 * subagent-style JSONL (`<session>/__advisor.jsonl`) so the advisor model's usage
 * is attributed in stats and its transcript shows in the Agent Hub.
 *
 * - Assistant turns land as `{type:"message", message:{role:"assistant", usage}}`
 *   entries — exactly the shape the stats parser reads for usage.
 * - Consecutive user deltas collapse to the final replay and are flagged
 *   `synthetic`/agent-attributed so stats' user-message metrics skip them.
 *   Oversized replays become bounded markers.
 * - Non-conversational message kinds are not persisted.
 * - The target follows the session file: a switch routes later turns to the new
 *   session's `__advisor.jsonl`, leaving the prior file intact.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	ADVISOR_TRANSCRIPT_FILENAME,
	AdvisorTranscriptRecorder,
	advisorCostLedgerFilename,
	advisorTranscriptFilename,
	loadAdvisorTranscriptCosts,
	migrateAdvisorTranscriptCostLedgers,
} from "@oh-my-pi/pi-coding-agent/advisor/transcript-recorder";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

interface AdvisorEntry {
	type?: string;
	id?: unknown;
	message?: {
		role?: string;
		model?: string;
		usage?: { input?: number };
		content?: Array<{ type?: string; text?: string }> | string;
		synthetic?: boolean;
		attribution?: string;
	};
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "advisor-recorder-"));
	try {
		return await fn(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

/** Parse the message entries (skipping the session header) from an advisor JSONL. */
async function readMessageEntries(file: string): Promise<AdvisorEntry[]> {
	const text = await Bun.file(file).text();
	// JSON.parse returns `any`; assigning to the typed array narrows reads below.
	const entries: AdvisorEntry[] = text
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
	return entries.filter(entry => entry.type === "message");
}

function messageText(entry: AdvisorEntry): string | undefined {
	const content = entry.message?.content;
	return Array.isArray(content) && content[0]?.type === "text" ? content[0].text : undefined;
}

function assistantMessage(text: string, inputTokens: number, cost = 0): AgentMessage {
	const message = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-advisor-model",
		usage: {
			input: inputTokens,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 3,
			cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason: "stop" as const,
		timestamp: 1,
	};
	return message as unknown as AgentMessage;
}

function userMessage(text: string): AgentMessage {
	const message = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 };
	return message as unknown as AgentMessage;
}

function developerMessage(text: string): AgentMessage {
	const message = { role: "developer" as const, content: [{ type: "text" as const, text }], timestamp: 1 };
	return message as unknown as AgentMessage;
}

describe("AdvisorTranscriptRecorder", () => {
	it("persists assistant turns with usage to <session>/__advisor.jsonl", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("reviewing", 42));
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages).toHaveLength(1);
			expect(messages[0].message?.role).toBe("assistant");
			expect(messages[0].message?.model).toBe("test-advisor-model");
			expect(messages[0].message?.usage?.input).toBe(42);
			// Stats keys on a non-empty entry id; SessionManager must assign one.
			expect(typeof messages[0].id).toBe("string");
			expect(String(messages[0].id).length).toBeGreaterThan(0);
		});
	});

	it("marks advisor user deltas synthetic and agent-attributed", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(userMessage("### Session update"));
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages).toHaveLength(1);
			expect(messages[0].message?.role).toBe("user");
			expect(messages[0].message?.synthetic).toBe(true);
			expect(messages[0].message?.attribution).toBe("agent");
		});
	});

	it("skips non-conversational message kinds", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(developerMessage("noise"));
			recorder.record(assistantMessage("kept", 1));
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages.map(m => m.message?.role)).toEqual(["assistant"]);
		});
	});

	it("routes later turns to the new session file after a switch", async () => {
		await withTempDir(async dir => {
			let sessionFile = path.join(dir, "first.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("before switch", 1));
			sessionFile = path.join(dir, "second.jsonl");
			recorder.record(assistantMessage("after switch", 2));
			await recorder.close();

			const first = await readMessageEntries(path.join(dir, "first", ADVISOR_TRANSCRIPT_FILENAME));
			const second = await readMessageEntries(path.join(dir, "second", ADVISOR_TRANSCRIPT_FILENAME));
			expect(first).toHaveLength(1);
			expect(first[0].message?.usage?.input).toBe(1);
			expect(second).toHaveLength(1);
			expect(second[0].message?.usage?.input).toBe(2);
		});
	});

	it("loads cumulative costs by advisor slug", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const primary = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			const security = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
				advisorTranscriptFilename("security"),
			);
			primary.record(assistantMessage("primary", 1, 0.25));
			security.record(assistantMessage("first", 1, 0.25));
			security.record(assistantMessage("second", 1, 0.5));
			await Promise.all([primary.close(), security.close()]);

			expect(Object.fromEntries(await loadAdvisorTranscriptCosts(sessionFile))).toEqual({
				"": 0.25,
				security: 0.75,
			});
		});
	});

	it("atomically accumulates finalized assistant costs across recorder recovery", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const initial = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			initial.record(assistantMessage("first", 1, 0.25));
			initial.record(assistantMessage("second", 1, 0.5));
			await initial.close();

			const ledger = await Bun.file(
				path.join(dir, "sess", advisorCostLedgerFilename(ADVISOR_TRANSCRIPT_FILENAME)),
			).json();
			expect(ledger).toMatchObject({ total: 0.75 });

			const recovered = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recovered.record(assistantMessage("after restart", 1, 0.25));
			await recovered.close();

			expect(Object.fromEntries(await loadAdvisorTranscriptCosts(sessionFile))).toEqual({ "": 1 });
		});
	});

	it("migrates malformed legacy costs into a ledger that loads after legacy removal", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const sessionDir = sessionFile.slice(0, -".jsonl".length);
			await fs.mkdir(sessionDir, { recursive: true });
			const transcript = path.join(sessionDir, ADVISOR_TRANSCRIPT_FILENAME);
			const oversizedTail = `{ malformed oversized tail ${"x".repeat(1024 * 1024)}`;
			await fs.writeFile(
				transcript,
				`${[
					JSON.stringify({ type: "message", message: assistantMessage("first", 1, 0.25) }),
					"{ malformed legacy entry",
					JSON.stringify({
						type: "message",
						message: { role: "assistant", usage: { cost: { total: "not-a-number" } } },
					}),
					"null",
					JSON.stringify({ type: "message", message: assistantMessage("second", 1, 0.5) }),
					oversizedTail,
				].join("\n")}\n`,
			);

			expect(Object.fromEntries(await loadAdvisorTranscriptCosts(sessionFile))).toEqual({});
			expect(Object.fromEntries(await migrateAdvisorTranscriptCostLedgers(sessionFile))).toEqual({ "": 0.75 });

			const ledger = await Bun.file(
				path.join(sessionDir, advisorCostLedgerFilename(ADVISOR_TRANSCRIPT_FILENAME)),
			).json();
			expect(ledger).toMatchObject({ total: 0.75 });
			await fs.rm(transcript);
			expect(Object.fromEntries(await loadAdvisorTranscriptCosts(sessionFile))).toEqual({ "": 0.75 });
		});
	});

	it("persists only the final consecutive user replay before an assistant turn", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(userMessage("stale replay"));
			recorder.record(userMessage("latest replay"));
			recorder.record(assistantMessage("review", 1));
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages.map(message => message.message?.role)).toEqual(["user", "assistant"]);
			expect(messageText(messages[0]!)).toBe("latest replay");
		});
	});

	it("replaces oversized user replay with a bounded marker", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			const oversizedReplay = `oversized user replay ${"x".repeat(1024 * 1024)}`;
			recorder.record(userMessage(oversizedReplay));
			recorder.record(assistantMessage("review", 1));
			await recorder.close();

			const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const messages = await readMessageEntries(transcript);
			const persisted = messages.find(message => message.message?.role === "user")?.message;
			if (!persisted) throw new Error("Expected persisted advisor user replay");
			const text = messageText({ message: persisted });
			if (!text) throw new Error("Expected bounded advisor user replay marker");
			expect(text).toMatch(/^\[advisor input omitted: \d+ bytes\]$/);
			expect(persisted.content).toEqual([{ type: "text", text }]);
			expect(Buffer.byteLength(text)).toBeLessThan(128);
			expect(await Bun.file(transcript).text()).not.toContain(oversizedReplay);
		});
	});

	it("loads its ledger without scanning a huge corrupted legacy transcript", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("ledger-backed", 1, 0.25));
			await recorder.close();

			const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			await fs.writeFile(
				transcript,
				`${JSON.stringify({ type: "message", message: assistantMessage("legacy", 1, 9) })}\n{`,
			);
			await fs.truncate(transcript, 16 * 1024 * 1024);

			expect(Object.fromEntries(await loadAdvisorTranscriptCosts(sessionFile))).toEqual({ "": 0.25 });
		});
	});
});
