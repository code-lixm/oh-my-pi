import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getRecentSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resetSessionTitleIndexForTests } from "@oh-my-pi/pi-coding-agent/session/title-index";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

import { makeAssistantMessage } from "../session-manager/helpers";

function writeLegacySession(
	sessionDir: string,
	cwd: string,
	options: { fileName: string; id: string; title?: string; prompts?: string[] },
): string {
	const filePath = path.join(sessionDir, options.fileName);
	const lines = [
		JSON.stringify({
			type: "session",
			id: options.id,
			...(options.title === undefined ? {} : { title: options.title }),
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd,
		}),
		...(options.prompts ?? []).map((content, index) =>
			JSON.stringify({
				type: "message",
				id: `${options.id}-message-${index}`,
				parentId: index === 0 ? null : `${options.id}-message-${index - 1}`,
				timestamp: `2025-01-01T00:00:0${index}.000Z`,
				message: { role: "user", content, timestamp: index },
			}),
		),
	];
	fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
	return filePath;
}

describe("welcome recent sessions title index", () => {
	let testRoot: string;
	let testAgentDir: string;
	let cwd: string;
	let sessionDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(() => {
		resetSessionTitleIndexForTests();
		testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-recent-sessions-title-index-"));
		testAgentDir = path.join(testRoot, "agent");
		cwd = path.join(testRoot, "project");
		fs.mkdirSync(cwd, { recursive: true });
		setAgentDir(testAgentDir);
		sessionDir = SessionManager.getDefaultSessionDir(cwd);
	});

	afterEach(() => {
		resetSessionTitleIndexForTests();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(testRoot);
	});

	it("keeps a titled session in welcome recents after its JSONL is truncated", async () => {
		const title = "Indexed welcome title";
		const session = SessionManager.create(cwd);
		let sessionFile: string | undefined;
		try {
			session.appendMessage({ role: "user", content: "first prompt before a title", timestamp: 1 });
			await session.setSessionName(title, "user");
			session.appendMessage(makeAssistantMessage());
			await session.flush();
			sessionFile = session.getSessionFile();
		} finally {
			await session.close();
		}
		if (!sessionFile) throw new Error("Expected titled session to persist a JSONL file");

		// A fresh title-index connection must read the durable mapping, not process memory.
		resetSessionTitleIndexForTests();
		fs.truncateSync(sessionFile, 0);

		const recent = await getRecentSessions(sessionDir);
		expect(recent.map(({ path: recentPath, name }) => ({ path: recentPath, name }))).toEqual([
			{ path: sessionFile, name: title },
		]);
	});

	it("backfills a legacy header title before a later welcome lookup sees a truncated file", async () => {
		const id = "legacy-header-title";
		const title = "Legacy header title";
		const sessionFile = writeLegacySession(sessionDir, cwd, {
			fileName: `2025-01-01T00-00-00-000Z_${id}.jsonl`,
			id,
			title,
			prompts: ["legacy first prompt"],
		});

		const firstLookup = await getRecentSessions(sessionDir);
		expect(firstLookup.map(({ path: recentPath, name }) => ({ path: recentPath, name }))).toEqual([
			{ path: sessionFile, name: title },
		]);

		// Simulate the next welcome screen after the legacy fallback has filled the index.
		resetSessionTitleIndexForTests();
		fs.truncateSync(sessionFile, 0);

		const secondLookup = await getRecentSessions(sessionDir);
		expect(secondLookup.map(({ path: recentPath, name }) => ({ path: recentPath, name }))).toEqual([
			{ path: sessionFile, name: title },
		]);
	});

	it("orders welcome recents by mtime, honors limit, and labels untitled sessions from their first prompt", async () => {
		const oldest = writeLegacySession(sessionDir, cwd, {
			fileName: "a_oldest-session.jsonl",
			id: "oldest-session",
			title: "Old title outside the limit",
			prompts: ["old prompt"],
		});
		const newest = writeLegacySession(sessionDir, cwd, {
			fileName: "b_newest-session.jsonl",
			id: "newest-session",
			prompts: ["First user prompt", "Later user prompt must not replace the first"],
		});
		const middle = writeLegacySession(sessionDir, cwd, {
			fileName: "c_middle-session.jsonl",
			id: "middle-session",
			title: "Middle titled session",
			prompts: ["middle prompt"],
		});
		fs.utimesSync(oldest, new Date("2025-01-01T00:00:00.000Z"), new Date("2025-01-01T00:00:00.000Z"));
		fs.utimesSync(middle, new Date("2025-01-02T00:00:00.000Z"), new Date("2025-01-02T00:00:00.000Z"));
		fs.utimesSync(newest, new Date("2025-01-03T00:00:00.000Z"), new Date("2025-01-03T00:00:00.000Z"));

		const recent = await getRecentSessions(sessionDir, 2);
		expect(recent.map(({ path: recentPath, name }) => ({ path: recentPath, name }))).toEqual([
			{ path: newest, name: "First user prompt" },
			{ path: middle, name: "Middle titled session" },
		]);
	});
});
