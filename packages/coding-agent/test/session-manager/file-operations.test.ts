import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	filterResumableSessions,
	findMostRecentSession,
	resolveResumableSession,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getTerminalId } from "@oh-my-pi/pi-tui";
import {
	getConfigRootDir,
	getSessionsDir,
	getTerminalSessionsDir,
	removeSyncWithRetries,
	resolveEquivalentPath,
	Snowflake,
	setAgentDir,
} from "@oh-my-pi/pi-utils";

const OLDER_MTIME = new Date("2000-01-01T00:00:00.000Z");
const NEWER_MTIME = new Date("2000-01-01T00:00:01.000Z");

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `session-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	it("loads valid session file", async () => {
		const file = path.join(tempDir, "valid.jsonl");
		fs.writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = await loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("skips malformed lines but keeps valid ones", async () => {
		const file = path.join(tempDir, "mixed.jsonl");
		fs.writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = await loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `session-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	it("returns single valid session file", async () => {
		const file = path.join(tempDir, "session.jsonl");
		fs.writeFileSync(
			file,
			`${[
				'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
				'{"type":"message","id":"m1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}',
			].join("\n")}\n`,
		);
		expect(await findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = path.join(tempDir, "older.jsonl");
		const file2 = path.join(tempDir, "newer.jsonl");

		fs.writeFileSync(
			file1,
			`${[
				'{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
				'{"type":"message","id":"m1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}',
			].join("\n")}\n`,
		);
		fs.utimesSync(file1, OLDER_MTIME, OLDER_MTIME);
		fs.writeFileSync(
			file2,
			`${[
				'{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
				'{"type":"message","id":"m2","parentId":null,"timestamp":"2025-01-01T00:00:02Z","message":{"role":"user","content":"hi","timestamp":2}}',
			].join("\n")}\n`,
		);
		fs.utimesSync(file2, NEWER_MTIME, NEWER_MTIME);

		expect(await findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = path.join(tempDir, "invalid.jsonl");
		const valid = path.join(tempDir, "valid.jsonl");

		fs.writeFileSync(invalid, '{"type":"not-session"}\n');
		fs.writeFileSync(
			valid,
			`${[
				'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
				'{"type":"message","id":"m1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}',
			].join("\n")}\n`,
		);

		expect(await findMostRecentSession(tempDir)).toBe(valid);
	});

	it("skips header-only sessions and returns the most recent with conversation", async () => {
		const empty = path.join(tempDir, "empty.jsonl");
		const valid = path.join(tempDir, "valid.jsonl");

		fs.writeFileSync(empty, '{"type":"session","id":"empty","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		fs.utimesSync(empty, NEWER_MTIME, NEWER_MTIME);
		fs.writeFileSync(
			valid,
			`${[
				'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
				'{"type":"message","id":"m1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}',
			].join("\n")}\n`,
		);

		expect(await findMostRecentSession(tempDir)).toBe(valid);
	});

	it("keeps a header-only session resumable when a draft artifact exists", async () => {
		const empty = path.join(tempDir, "empty.jsonl");
		fs.writeFileSync(empty, '{"type":"session","id":"empty","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		fs.mkdirSync(path.join(tempDir, "empty"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, "empty", "draft.txt"), "draft text");

		expect(await findMostRecentSession(tempDir)).toBe(empty);
	});
});

describe("resolveResumableSession", () => {
	let tempDir: string;
	let sessionDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `session-test-${Snowflake.next()}`);
		sessionDir = path.join(tempDir, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	function writeSession(fileName: string, headerCwd: string, id: string = Snowflake.next()): string {
		const filePath = path.join(sessionDir, fileName);
		fs.writeFileSync(
			filePath,
			`${[
				JSON.stringify({ type: "session", id, timestamp: "2025-01-01T00:00:00Z", cwd: headerCwd }),
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);
		return id;
	}

	it("returns undefined when no local session matches", async () => {
		writeSession("2025-01-01_demo.jsonl", "/tmp/project", "demo1234");

		const match = await resolveResumableSession("missing", "/tmp/project", sessionDir);

		expect(match).toBeUndefined();
	});

	it("matches by session id prefix", async () => {
		const id = writeSession("2025-01-01_resume.jsonl", "/tmp/project", "resume1234");

		const match = await resolveResumableSession(id.slice(0, 6), "/tmp/project", sessionDir);

		expect(match?.scope).toBe("local");
		expect(match?.session.id).toBe(id);
	});

	it("matches legacy timestamped filename prefixes and id suffixes", async () => {
		writeSession("2025-02-03T04-05-06-789Z_legacyabcd.jsonl", "/tmp/project", "legacyabcd");

		const byFilePrefix = await resolveResumableSession("2025-02-03T04-05", "/tmp/project", sessionDir);
		expect(byFilePrefix?.session.id).toBe("legacyabcd");

		const byFileSuffix = await resolveResumableSession("legacy", "/tmp/project", sessionDir);
		expect(byFileSuffix?.session.id).toBe("legacyabcd");
	});

	it("keeps local matches resumable when header cwd differs", async () => {
		writeSession("2025-01-01_moved.jsonl", "/Users/old-user/project", "moved1234");

		const match = await resolveResumableSession("moved", "/Users/new-user/project", sessionDir);

		expect(match?.scope).toBe("local");
		expect(match?.session.path).toBe(path.join(sessionDir, "2025-01-01_moved.jsonl"));
	});
});

describe("empty session filtering", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `session-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	function writeSessionFile(fileName: string, id: string, withMessage: boolean): string {
		const filePath = path.join(tempDir, fileName);
		const lines = [JSON.stringify({ type: "session", id, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp/project" })];
		if (withMessage) {
			lines.push(
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
			);
		}
		fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	it("omits header-only sessions from resumable listings while keeping real sessions", async () => {
		const emptyFile = writeSessionFile("2025-01-01_empty.jsonl", "emptyid1", false);
		const realFile = writeSessionFile("2025-01-02_real.jsonl", "realid1", true);
		// `list` returns recency (mtime) order; pin the mtimes instead of
		// relying on write ordering so the fixture is deterministic.
		fs.utimesSync(emptyFile, OLDER_MTIME, OLDER_MTIME);
		fs.utimesSync(realFile, NEWER_MTIME, NEWER_MTIME);

		const sessions = await SessionManager.list("/tmp/project", tempDir);
		const resumable = filterResumableSessions(sessions, new FileSessionStorage());

		expect(sessions.map(session => session.id)).toEqual(["realid1", "emptyid1"]);
		expect(resumable.map(session => session.path)).toEqual([realFile]);
	});
});

describe("SessionManager.refreshFromDisk", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `session-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	it("picks up entries appended by another writer without rewriting the file", async () => {
		const sessionFile = path.join(tempDir, "2025-01-01_mirror.jsonl");
		fs.writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({ type: "session", id: "mirror1", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp/project" }),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "before", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);
		const mirror = await SessionManager.open(sessionFile, tempDir);
		try {
			expect(mirror.getBranch().filter(entry => entry.type === "message")).toHaveLength(1);

			// Simulate the rpc-ui child appending while the mirror holds the file open.
			fs.appendFileSync(
				sessionFile,
				`${JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2025-01-01T00:00:02Z",
					message: { role: "assistant", content: "after", timestamp: 2 },
				})}\n`,
			);
			const mtimeBeforeRefresh = fs.statSync(sessionFile).mtimeMs;

			const refreshed = await mirror.refreshFromDisk();
			expect(refreshed).toBe(true);
			const branch = mirror.getBranch().filter(entry => entry.type === "message");
			expect(branch).toHaveLength(2);
			// The mirror must not rewrite the file the child owns.
			expect(fs.statSync(sessionFile).mtimeMs).toBe(mtimeBeforeRefresh);
		} finally {
			await mirror.close();
		}
	});

	it("leaves entries untouched when the on-disk session id diverges", async () => {
		const sessionFile = path.join(tempDir, "2025-01-01_diverged.jsonl");
		fs.writeFileSync(
			sessionFile,
			JSON.stringify({ type: "session", id: "original1", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp/project" }) +
				"\n",
		);
		const mirror = await SessionManager.open(sessionFile, tempDir);
		try {
			fs.writeFileSync(
				sessionFile,
				`${JSON.stringify({
					type: "session",
					id: "other-session",
					timestamp: "2025-01-01T00:00:00Z",
					cwd: "/tmp/project",
				})}\n`,
			);
			const refreshed = await mirror.refreshFromDisk();
			expect(refreshed).toBe(false);
			expect(mirror.getSessionId()).toBe("original1");
		} finally {
			await mirror.close();
		}
	});
});

describe("SessionManager temp cwd session dirs", () => {
	let testAgentDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	function expectedTempSessionDirName(tempCwd: string): string {
		return `-tmp-${path.relative(os.tmpdir(), path.resolve(tempCwd)).replace(/[/\\:]/g, "-")}`;
	}

	function toLegacyAbsoluteSessionDirName(cwd: string): string {
		return `--${path
			.resolve(cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`;
	}

	function clearTerminalBreadcrumb(): void {
		const terminalId = getTerminalId();
		if (!terminalId) return;
		fs.rmSync(path.join(getTerminalSessionsDir(), terminalId), { force: true });
	}

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-dir-test-"));
		setAgentDir(testAgentDir);
		clearTerminalBreadcrumb();
	});

	afterEach(() => {
		clearTerminalBreadcrumb();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(testAgentDir);
	});

	it("stores temp-root cwd sessions under -tmp-prefixed directories", () => {
		const tempCwd = path.join(testAgentDir, `temp-cwd-${Snowflake.next()}`);
		fs.mkdirSync(tempCwd, { recursive: true });

		const session = SessionManager.create(tempCwd);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file path");

		expect(path.dirname(sessionFile)).toBe(path.join(getSessionsDir(), expectedTempSessionDirName(tempCwd)));
	});

	it("migrates legacy temp-root absolute session dirs to -tmp prefixes", () => {
		const tempCwd = path.join(testAgentDir, `legacy-cwd-${Snowflake.next()}`);
		fs.mkdirSync(tempCwd, { recursive: true });

		const legacyDir = path.join(getSessionsDir(), toLegacyAbsoluteSessionDirName(tempCwd));
		const markerFile = path.join(legacyDir, "carried.jsonl");
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(markerFile, "marker\n");

		const session = SessionManager.create(tempCwd);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file path");

		const expectedDir = path.join(getSessionsDir(), expectedTempSessionDirName(tempCwd));
		expect(fs.existsSync(legacyDir)).toBe(false);
		expect(path.dirname(sessionFile)).toBe(expectedDir);
		expect(fs.existsSync(path.join(expectedDir, "carried.jsonl"))).toBe(true);
	});

	it("keeps hashed-scheme sessions in place while list, continue, and id resume find them", async () => {
		const tempCwd = path.join(testAgentDir, `hashed-cwd-${Snowflake.next()}`);
		fs.mkdirSync(tempCwd, { recursive: true });

		const canonicalCwd = resolveEquivalentPath(path.resolve(tempCwd));
		const normalized = canonicalCwd.replaceAll("\\", "/");
		const readable = path
			.basename(canonicalCwd)
			.replace(/[^a-zA-Z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(-80);
		const digest = Bun.SHA256.hash(normalized, "hex");
		const hashedDir = path.join(getSessionsDir(), `tmp-${readable || "project"}-${digest}`);
		const hashedSessionFile = path.join(hashedDir, "2026-01-01T00-00-00-000Z_develop-hashed-session.jsonl");
		const sessionId = "develop-hashed-session";
		fs.mkdirSync(hashedDir, { recursive: true });
		fs.writeFileSync(
			hashedSessionFile,
			`${[
				JSON.stringify({
					type: "session",
					id: sessionId,
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: canonicalCwd,
				}),
				JSON.stringify({
					type: "message",
					id: "develop-user-turn",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					message: { role: "user", content: "resume the develop session", timestamp: 0 },
				}),
			].join("\n")}\n`,
		);

		const session = SessionManager.create(tempCwd);
		const canonicalSessionFile = session.getSessionFile();
		if (!canonicalSessionFile) throw new Error("Expected session file path");
		await session.close();

		const expectedDir = path.join(getSessionsDir(), expectedTempSessionDirName(tempCwd));
		expect(path.dirname(canonicalSessionFile)).toBe(expectedDir);
		expect(fs.existsSync(hashedDir)).toBe(true);
		expect(fs.existsSync(hashedSessionFile)).toBe(true);

		clearTerminalBreadcrumb();
		const listed = await SessionManager.list(tempCwd, expectedDir);
		expect(listed).toContainEqual(expect.objectContaining({ id: sessionId, path: hashedSessionFile }));

		const continued = await SessionManager.continueRecent(tempCwd, expectedDir);
		try {
			expect(continued.getSessionFile()).toBe(hashedSessionFile);
		} finally {
			await continued.close();
		}

		clearTerminalBreadcrumb();
		const match = await resolveResumableSession(sessionId.slice(0, 8), tempCwd, expectedDir);
		expect(match).toMatchObject({ scope: "local", session: { id: sessionId, path: hashedSessionFile } });
	});
});

describe("SessionManager legacy session migration persistence", () => {
	let tempDir: string;
	let testAgentDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalTmuxPane = process.env.TMUX_PANE;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	function makeAssistantMessage() {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "legacy reply" }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-20250514",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};
	}

	function getHeader(entries: FileEntry[]): SessionHeader | undefined {
		return entries.find((entry): entry is SessionHeader => entry.type === "session");
	}

	function clearTerminalBreadcrumb() {
		const terminalId = getTerminalId();
		if (!terminalId) return;
		fs.rmSync(path.join(getTerminalSessionsDir(), terminalId), { force: true });
	}

	beforeEach(() => {
		// Deterministic, non-TTY terminal id so the per-terminal breadcrumb
		// (written by newSession/continueRecent) is scoped to this test and
		// cannot leak across files in the same suite run. Without it, a real
		// terminal id (WT_SESSION/TMUX_PANE) points continueRecent at stale
		// breadcrumb state from earlier tests in this file.
		process.env.TMUX_PANE = "%legacy-migration-test";
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-manager-legacy-agent-"));
		setAgentDir(testAgentDir);
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-manager-legacy-"));
		setAgentDir(path.join(tempDir, "agent"));
		clearTerminalBreadcrumb();
	});

	afterEach(() => {
		clearTerminalBreadcrumb();
		if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalTmuxPane;
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(tempDir);
		removeSyncWithRetries(testAgentDir);
	});

	it("keeps legacy migration in memory until later persisted activity rewrites the file", async () => {
		const sessionFile = path.join(tempDir, "legacy.jsonl");
		fs.writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({ type: "session", id: "legacy-session", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir }),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:02Z",
					message: makeAssistantMessage(),
				}),
			].join("\n")}\n`,
		);
		fs.utimesSync(sessionFile, OLDER_MTIME, OLDER_MTIME);
		const initialMtimeMs = fs.statSync(sessionFile).mtimeMs;

		const session = await SessionManager.open(sessionFile, tempDir);
		const migratedEntries = session.getEntries();

		expect(migratedEntries).toHaveLength(2);
		for (const entry of migratedEntries) {
			expect(entry.id).toBeDefined();
		}
		expect(migratedEntries[0]?.parentId).toBeNull();
		expect(migratedEntries[1]?.parentId).toBe(migratedEntries[0]?.id);

		await session.flush();
		expect(fs.statSync(sessionFile).mtimeMs).toBe(initialMtimeMs);

		session.appendMessage({ role: "user", content: "follow up", timestamp: Date.now() });
		await session.flush();

		const persistedEntries = await loadEntriesFromFile(sessionFile);
		const header = getHeader(persistedEntries);
		if (!header) throw new Error("Expected session header");

		expect(fs.statSync(sessionFile).mtimeMs).toBeGreaterThan(initialMtimeMs);
		expect(header.version).toBe(3);
		expect(persistedEntries).toHaveLength(4);
		for (const entry of persistedEntries.filter(entry => entry.type !== "session")) {
			expect(entry.id).toBeDefined();
		}
	});

	it("still rewrites immediately when explicitly requested", async () => {
		const sessionFile = path.join(tempDir, "legacy-rewrite.jsonl");
		fs.writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({ type: "session", id: "legacy-session", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir }),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);
		fs.utimesSync(sessionFile, OLDER_MTIME, OLDER_MTIME);
		const initialMtimeMs = fs.statSync(sessionFile).mtimeMs;

		const session = await SessionManager.open(sessionFile, tempDir);
		await session.rewriteEntries();

		const persistedEntries = await loadEntriesFromFile(sessionFile);
		const header = getHeader(persistedEntries);
		if (!header) throw new Error("Expected session header");

		expect(fs.statSync(sessionFile).mtimeMs).toBeGreaterThan(initialMtimeMs);
		expect(header.version).toBe(3);
		expect(persistedEntries).toHaveLength(2);
		expect(persistedEntries[1]?.type).toBe("message");
		if (persistedEntries[1]?.type !== "message") throw new Error("Expected message entry");
		expect(persistedEntries[1].id).toBeDefined();
		expect(persistedEntries[1].parentId).toBeNull();
	});

	it("forces a deferred legacy rewrite when ensureOnDisk is requested", async () => {
		const sessionFile = path.join(tempDir, "legacy-ensure-on-disk.jsonl");
		fs.writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({ type: "session", id: "legacy-session", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir }),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);
		fs.utimesSync(sessionFile, OLDER_MTIME, OLDER_MTIME);
		const initialMtimeMs = fs.statSync(sessionFile).mtimeMs;

		const session = await SessionManager.open(sessionFile, tempDir);
		await session.ensureOnDisk();

		const persistedEntries = await loadEntriesFromFile(sessionFile);
		const header = getHeader(persistedEntries);
		if (!header) throw new Error("Expected session header");

		expect(fs.statSync(sessionFile).mtimeMs).toBeGreaterThan(initialMtimeMs);
		expect(header.version).toBe(3);
		expect(persistedEntries).toHaveLength(2);
		expect(persistedEntries[1]?.type).toBe("message");
		if (persistedEntries[1]?.type !== "message") throw new Error("Expected message entry");
		expect(persistedEntries[1].id).toBeDefined();
		expect(persistedEntries[1].parentId).toBeNull();
	});

	it("honors a fresh /new boundary instead of recovering an older transcript", async () => {
		const previousTermSessionId = process.env.TERM_SESSION_ID;
		const terminalSessionId = `omp-fresh-new-boundary-${Snowflake.next()}`;
		process.env.TERM_SESSION_ID = terminalSessionId;
		let session: SessionManager | undefined;
		let resumed: SessionManager | undefined;

		try {
			clearTerminalBreadcrumb();
			session = SessionManager.create(tempDir, tempDir);
			session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() - 1 });
			session.appendMessage(makeAssistantMessage());
			await session.flush();

			const previousSessionFile = session.getSessionFile();
			if (!previousSessionFile) throw new Error("Expected persisted session file");

			const freshSessionFile = await session.newSession();
			expect(freshSessionFile).toBeDefined();
			expect(fs.existsSync(freshSessionFile!)).toBe(false);

			resumed = await SessionManager.continueRecent(tempDir, tempDir);
			expect(resumed.getSessionFile()).not.toBe(previousSessionFile);
			expect(JSON.stringify(resumed.getEntries())).not.toContain("hello");
			expect(resumed.getEntries()).toHaveLength(0);
		} finally {
			try {
				await resumed?.close();
			} finally {
				try {
					await session?.close();
				} finally {
					try {
						clearTerminalBreadcrumb();
					} finally {
						if (previousTermSessionId === undefined) {
							delete process.env.TERM_SESSION_ID;
						} else {
							process.env.TERM_SESSION_ID = previousTermSessionId;
						}
					}
				}
			}
		}
	});

	it("skips persisted empty sessions but resumes a newer non-empty session", async () => {
		const previous = SessionManager.create(tempDir, tempDir);
		previous.appendMessage({ role: "user", content: "previous", timestamp: Date.now() - 1 });
		previous.appendMessage(makeAssistantMessage());
		await previous.flush();
		const previousSessionFile = previous.getSessionFile();
		if (!previousSessionFile) throw new Error("Expected persisted session file");
		await previous.close();

		const empty = SessionManager.create(tempDir, tempDir);
		await empty.ensureOnDisk();
		await empty.flush();
		const emptySessionFile = empty.getSessionFile();
		if (!emptySessionFile) throw new Error("Expected empty session file");
		await empty.close();

		fs.utimesSync(previousSessionFile, new Date("2025-01-01T00:00:00Z"), new Date("2025-01-01T00:00:00Z"));
		fs.utimesSync(emptySessionFile, new Date("2025-01-01T00:00:01Z"), new Date("2025-01-01T00:00:01Z"));

		clearTerminalBreadcrumb();
		let resumed = await SessionManager.continueRecent(tempDir, tempDir);
		try {
			expect(resumed.getSessionFile()).toBe(previousSessionFile);
		} finally {
			await resumed.close();
		}

		const newer = SessionManager.create(tempDir, tempDir);
		newer.appendMessage({ role: "user", content: "newer", timestamp: Date.now() - 1 });
		newer.appendMessage(makeAssistantMessage());
		await newer.flush();
		const newerSessionFile = newer.getSessionFile();
		if (!newerSessionFile) throw new Error("Expected newer session file");
		await newer.close();
		fs.utimesSync(newerSessionFile, new Date("2025-01-01T00:00:02Z"), new Date("2025-01-01T00:00:02Z"));

		clearTerminalBreadcrumb();
		resumed = await SessionManager.continueRecent(tempDir, tempDir);
		try {
			expect(resumed.getSessionFile()).toBe(newerSessionFile);
		} finally {
			await resumed.close();
		}
	});

	it("materializes a fresh session after its first persisted activity", async () => {
		const session = SessionManager.create(tempDir, tempDir);
		try {
			session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() - 1 });
			session.appendMessage(makeAssistantMessage());
			await session.flush();

			const previousSessionFile = session.getSessionFile();
			if (!previousSessionFile) throw new Error("Expected persisted session file");

			const freshSessionFile = await session.newSession();
			if (!freshSessionFile) throw new Error("Expected fresh session file");
			expect(fs.existsSync(freshSessionFile)).toBe(false);
			// Lazy new-session persistence: nothing on disk yet, so materialize the
			// fresh session the way assistant output would (issue #5730).
			session.appendMessage({ role: "user", content: "first message of fresh session", timestamp: Date.now() });
			session.appendMessage(makeAssistantMessage());
			await session.flush();
			expect(fs.existsSync(freshSessionFile)).toBe(true);

			clearTerminalBreadcrumb();
			const resumed = await SessionManager.continueRecent(tempDir, tempDir);
			try {
				expect(resumed.getSessionFile()).toBe(freshSessionFile);
				expect(resumed.getSessionFile()).not.toBe(previousSessionFile);
			} finally {
				await resumed.close();
			}
		} finally {
			await session.close();
		}
	});

	it("prefers a newer draft-only session over an older non-empty transcript", async () => {
		const previous = SessionManager.create(tempDir, tempDir);
		previous.appendMessage({ role: "user", content: "previous", timestamp: Date.now() - 1 });
		previous.appendMessage(makeAssistantMessage());
		await previous.flush();
		const previousSessionFile = previous.getSessionFile();
		if (!previousSessionFile) throw new Error("Expected persisted session file");
		await previous.close();

		const draftOnly = SessionManager.create(tempDir, tempDir);
		draftOnly.appendModelChange("anthropic/claude-sonnet-4-20250514");
		await draftOnly.saveDraft("resume this draft");
		await draftOnly.flush();
		const draftOnlySessionFile = draftOnly.getSessionFile();
		if (!draftOnlySessionFile) throw new Error("Expected draft session file");
		await draftOnly.close();

		fs.utimesSync(previousSessionFile, new Date("2025-01-01T00:00:00Z"), new Date("2025-01-01T00:00:00Z"));
		fs.utimesSync(draftOnlySessionFile, new Date("2025-01-01T00:00:01Z"), new Date("2025-01-01T00:00:01Z"));
		clearTerminalBreadcrumb();

		const resumed = await SessionManager.continueRecent(tempDir, tempDir);
		try {
			expect(resumed.getSessionFile()).toBe(draftOnlySessionFile);
			expect(await resumed.consumeDraft()).toBe("resume this draft");
		} finally {
			await resumed.close();
		}
	});
});
