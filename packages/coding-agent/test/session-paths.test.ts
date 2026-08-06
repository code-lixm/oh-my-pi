import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	computeCompatibleSessionDirs,
	computeDefaultSessionDir,
	resolveManagedSessionRoot,
} from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const cleanup: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanup.push(dir);
	return dir;
}

function legacySessionDir(sessionsRoot: string, cwd: string): string {
	const name = `--${path
		.resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return path.join(sessionsRoot, name);
}

function legacyAndDevelopSessionDirNames(cwd: string): {
	canonicalCwd: string;
	legacyCanonicalDirName: string;
	developHashedDirName: string;
} {
	const canonicalCwd = fs.realpathSync(path.resolve(cwd));
	const homeRelative = path.relative(fs.realpathSync(path.resolve(os.homedir())), canonicalCwd);
	const tempRelative = path.relative(fs.realpathSync(path.resolve(os.tmpdir())), canonicalCwd);
	const inHome = homeRelative === "" || (!homeRelative.startsWith("..") && !path.isAbsolute(homeRelative));
	const inTemp = tempRelative === "" || (!tempRelative.startsWith("..") && !path.isAbsolute(tempRelative));
	const homeEncoded = homeRelative.replace(/[/\\:]/g, "-");
	const tempEncoded = tempRelative.replace(/[/\\:]/g, "-");
	const legacyCanonicalDirName = inHome
		? homeEncoded
			? `-${homeEncoded}`
			: "-"
		: inTemp
			? tempEncoded
				? `-tmp-${tempEncoded}`
				: "-tmp"
			: `--${canonicalCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const scope = inHome ? "home" : inTemp ? "tmp" : "abs";
	const readable = path
		.basename(canonicalCwd)
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(-80);
	const digest = Bun.SHA256.hash(canonicalCwd.replaceAll("\\", "/"), "hex");
	return {
		canonicalCwd,
		legacyCanonicalDirName,
		developHashedDirName: `${scope}-${readable || "project"}-${digest}`,
	};
}

afterEach(() => {
	for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("legacy session directory migration", () => {
	test("keeps a develop hashed session bundle in place while listing it through the restored cwd-derived directory", async () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const sessionDirNames = legacyAndDevelopSessionDirNames(cwd);
		const hashedDir = path.join(sessionsRoot, sessionDirNames.developHashedDirName);
		const legacyCanonicalDir = path.join(sessionsRoot, sessionDirNames.legacyCanonicalDirName);
		const sessionName = "2026-01-01T00-00-00-000Z_develop-session.jsonl";
		const sessionId = "develop-hashed-session";
		const prompt = "resume the session stored by develop";
		const artifactContents = "persisted develop artifact";
		const sourceSessionFile = path.join(hashedDir, sessionName);
		const sourceArtifactFile = path.join(hashedDir, path.basename(sessionName, ".jsonl"), "0.bash.log");

		fs.mkdirSync(path.dirname(sourceArtifactFile), { recursive: true });
		fs.writeFileSync(
			sourceSessionFile,
			`${[
				JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: sessionId,
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: sessionDirNames.canonicalCwd,
				}),
				JSON.stringify({
					type: "message",
					id: "develop-user-turn",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					message: { role: "user", content: prompt, timestamp: 0 },
				}),
			].join("\n")}\n`,
		);
		fs.writeFileSync(sourceArtifactFile, artifactContents);

		expect(computeCompatibleSessionDirs(cwd, storage, sessionsRoot)).toEqual([legacyCanonicalDir, hashedDir]);
		expect(resolveManagedSessionRoot(hashedDir, cwd)).toBe(sessionsRoot);

		const sessionDir = computeDefaultSessionDir(cwd, storage, sessionsRoot);
		expect(sessionDir).toBe(legacyCanonicalDir);
		expect(fs.existsSync(hashedDir)).toBe(true);
		expect(fs.existsSync(sourceSessionFile)).toBe(true);
		expect(fs.readFileSync(sourceArtifactFile, "utf8")).toBe(artifactContents);

		const listed = await SessionManager.list(cwd, legacyCanonicalDir, storage);
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ id: sessionId, path: sourceSessionFile, firstMessage: prompt });

		const resumed = await SessionManager.open(sourceSessionFile, legacyCanonicalDir, storage, {
			initialCwd: cwd,
			suppressBreadcrumb: true,
		});
		try {
			const artifact = await resumed.getArtifactPath("0");
			expect(artifact).toBe(sourceArtifactFile);
			if (!artifact) throw new Error("Expected develop artifact");
			expect(await Bun.file(artifact).text()).toBe(artifactContents);
		} finally {
			await resumed.close();
		}
	});
	test("keeps a colliding live legacy session reachable through its path", () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const canonicalDir = computeDefaultSessionDir(cwd, storage, sessionsRoot);
		const legacyDir = legacySessionDir(sessionsRoot, cwd);
		const source = path.join(legacyDir, "active.jsonl");
		const destination = path.join(canonicalDir, "active.jsonl");
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(source, "live-before\n");
		fs.writeFileSync(destination, "stale\n");
		const fd = fs.openSync(source, "a");

		computeDefaultSessionDir(cwd, storage, sessionsRoot);
		fs.writeSync(fd, "live-after\n");
		fs.closeSync(fd);

		expect(fs.readFileSync(source, "utf8")).toBe("live-before\nlive-after\n");
		expect(fs.readFileSync(destination, "utf8")).toBe("stale\n");
	});

	test("preserves writes when an older process recreates its cached legacy directory", () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const canonicalDir = computeDefaultSessionDir(cwd, storage, sessionsRoot);
		const legacyDir = legacySessionDir(sessionsRoot, cwd);
		const destination = path.join(canonicalDir, "active.jsonl");
		fs.writeFileSync(destination, "canonical\n");

		fs.mkdirSync(legacyDir, { recursive: true });
		const recreated = path.join(legacyDir, "active.jsonl");
		fs.writeFileSync(recreated, "older-process-write\n");
		computeDefaultSessionDir(cwd, storage, sessionsRoot);

		expect(fs.readFileSync(recreated, "utf8")).toBe("older-process-write\n");
		expect(fs.readFileSync(destination, "utf8")).toBe("canonical\n");
	});
});
