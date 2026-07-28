import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import * as git from "../../src/utils/git";
import {
	captureWorkspaceGitState,
	discoverWorkspaceGitRepositories,
	type GitCheckpointCas,
	restoreWorkspaceGitState,
	WorkspaceGitStateRestoreError,
} from "../../src/workspace-checkpoints/git-state";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const realDir = await fs.realpath(dir);
	tempDirs.push(realDir);
	return realDir;
}

async function runGit(cwd: string, args: readonly string[], options: { trim?: boolean } = {}): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: "true",
		},
		stderr: "pipe",
		stdout: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode ?? 0}`);
	}
	return options.trim === false ? stdout : stdout.trim();
}

async function initRepo(prefix: string): Promise<string> {
	const repo = await makeTempDir(prefix);
	await runGit(repo, ["init", "-q", "-b", "main"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	return repo;
}

async function commitAll(repo: string, message: string): Promise<string> {
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-q", "--no-gpg-sign", "-m", message]);
	return await runGit(repo, ["rev-parse", "HEAD"]);
}

function createMapCas(): GitCheckpointCas {
	const blobs = new Map<string, Uint8Array>();
	return {
		async put(bytes: Uint8Array): Promise<string> {
			const copy = new Uint8Array(bytes);
			const objectId = createHash("sha256").update(copy).digest("hex");
			blobs.set(objectId, copy);
			return objectId;
		},
		async get(objectId: string): Promise<Uint8Array | null> {
			const bytes = blobs.get(objectId);
			return bytes ? new Uint8Array(bytes) : null;
		},
	};
}

function statusKey(root: string, worktreePath: string): string {
	const rel = path.relative(root, worktreePath);
	return rel === "" ? "." : rel;
}

async function listRefs(repo: string, prefix: string): Promise<Array<{ name: string; sha: string }>> {
	const text = await runGit(repo, ["for-each-ref", "--format=%(refname)%09%(objectname)", prefix], { trim: false });
	return text
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => {
			const [name, sha] = line.split("\t");
			return { name: name!, sha: sha! };
		});
}

afterEach(async () => {
	await Promise.allSettled(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

describe.skipIf(!git.isGitAvailable())("workspace checkpoint git-state", () => {
	it("round-trips a partial staged+unstaged file through raw index bytes and split-index companions", async () => {
		const repo = await initRepo("omp-git-state-index-");
		const file = path.join(repo, "notes.txt");
		await fs.writeFile(file, "base one\nbase two\nbase three\n", "utf8");
		await commitAll(repo, "base");

		await runGit(repo, ["config", "core.splitIndex", "true"]);
		await runGit(repo, ["update-index", "--split-index"]);

		await fs.writeFile(file, "staged one\nbase two\nbase three\n", "utf8");
		await runGit(repo, ["add", "notes.txt"]);
		await fs.writeFile(file, "staged one\nunstaged two\nbase three\n", "utf8");
		await runGit(repo, ["update-index", "--split-index"]);

		const expectedStatus = await runGit(repo, ["status", "--porcelain=v2", "--", "notes.txt"], { trim: false });
		expect(expectedStatus).toContain("1 MM ");
		const expectedIndexContent = await runGit(repo, ["show", ":notes.txt"], { trim: false });
		const expectedWorktreeContent = await fs.readFile(file, "utf8");
		const beforeCaptureIndex = await git.index.capture(repo);
		expect(beforeCaptureIndex.bytes).not.toBeNull();
		expect(beforeCaptureIndex.sharedIndexFiles.length).toBeGreaterThan(0);

		const cas = createMapCas();
		const snapshot = await captureWorkspaceGitState(repo, cas);

		await fs.writeFile(file, "replacement staged\nreplacement two\n", "utf8");
		await runGit(repo, ["add", "notes.txt"]);
		await fs.writeFile(file, "replacement staged\nreplacement unstaged\n", "utf8");
		expect(await runGit(repo, ["status", "--porcelain=v2", "--", "notes.txt"], { trim: false })).not.toBe(
			expectedStatus,
		);

		await fs.writeFile(file, expectedWorktreeContent, "utf8");
		await restoreWorkspaceGitState(repo, snapshot, cas);

		expect(await runGit(repo, ["status", "--porcelain=v2", "--", "notes.txt"], { trim: false })).toBe(expectedStatus);
		expect(await runGit(repo, ["show", ":notes.txt"], { trim: false })).toBe(expectedIndexContent);
		expect(await fs.readFile(file, "utf8")).toBe(expectedWorktreeContent);

		const restoredIndex = await git.index.capture(repo);
		expect(restoredIndex.bytes).toEqual(beforeCaptureIndex.bytes);
		const restoredSharedByName = new Map(restoredIndex.sharedIndexFiles.map(shared => [shared.name, shared.bytes]));
		for (const shared of beforeCaptureIndex.sharedIndexFiles) {
			expect(restoredSharedByName.get(shared.name)).toEqual(shared.bytes);
		}
	});

	it("discovers and captures nested repositories separately from local submodules", async () => {
		const repo = await initRepo("omp-git-state-discover-");
		await fs.writeFile(path.join(repo, "root.txt"), "root\n", "utf8");
		await commitAll(repo, "root");

		const submoduleSource = await initRepo("omp-git-state-submodule-source-");
		await fs.writeFile(path.join(submoduleSource, "module.txt"), "module\n", "utf8");
		await commitAll(submoduleSource, "module");

		const submodulePathRel = path.join("vendor", "local-submodule");
		const submodulePath = path.join(repo, submodulePathRel);
		await fs.mkdir(path.dirname(submodulePath), { recursive: true });
		await runGit(repo, [
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			"-q",
			submoduleSource,
			submodulePathRel,
		]);
		await runGit(repo, ["commit", "-q", "--no-gpg-sign", "-m", "add submodule"]);

		const nestedRepo = path.join(repo, "tools", "nested-repo");
		await fs.mkdir(nestedRepo, { recursive: true });
		await runGit(nestedRepo, ["init", "-q", "-b", "main"]);
		await runGit(nestedRepo, ["config", "user.name", "Nested User"]);
		await runGit(nestedRepo, ["config", "user.email", "nested@example.com"]);
		await fs.writeFile(path.join(nestedRepo, "nested.txt"), "nested\n", "utf8");
		await runGit(nestedRepo, ["add", "nested.txt"]);
		await runGit(nestedRepo, ["commit", "-q", "--no-gpg-sign", "-m", "nested"]);

		const discovered = await discoverWorkspaceGitRepositories(repo);
		expect(
			discovered
				.map(entry => ({ isSubmodule: entry.isSubmodule, path: statusKey(repo, entry.worktreePath) }))
				.sort((left, right) => left.path.localeCompare(right.path)),
		).toEqual([
			{ isSubmodule: false, path: "." },
			{ isSubmodule: false, path: path.join("tools", "nested-repo") },
			{ isSubmodule: true, path: submodulePathRel },
		]);

		const snapshot = await captureWorkspaceGitState(repo, createMapCas());
		expect(snapshot.repositories.map(entry => statusKey(repo, entry.worktreePath)).sort()).toEqual([
			".",
			path.join("tools", "nested-repo"),
			submodulePathRel,
		]);
	});

	it("keeps linked worktrees on a shared commonDir while restoring their indexes independently", async () => {
		const repo = await initRepo("omp-git-state-worktree-");
		await fs.writeFile(path.join(repo, "tracked.txt"), "tracked\n", "utf8");
		await commitAll(repo, "base");

		await git.branch.create(repo, "feature");
		const linkedWorktree = await makeTempDir("omp-git-state-linked-");
		await git.worktree.add(repo, linkedWorktree, "feature");

		const mainRepo = await git.repo.resolve(repo);
		const linkedRepo = await git.repo.resolve(linkedWorktree);
		expect(mainRepo).not.toBeNull();
		expect(linkedRepo).not.toBeNull();
		expect(mainRepo?.commonDir).toBe(linkedRepo?.commonDir);
		expect(mainRepo?.gitDir).not.toBe(linkedRepo?.gitDir);

		const mainIndexPath = (await git.index.capture(repo)).path;
		const linkedIndexPath = (await git.index.capture(linkedWorktree)).path;
		expect(mainIndexPath).not.toBe(linkedIndexPath);

		await fs.writeFile(path.join(repo, "main-only.txt"), "main staged\n", "utf8");
		await runGit(repo, ["add", "main-only.txt"]);
		await fs.writeFile(path.join(linkedWorktree, "feature-only.txt"), "feature staged\n", "utf8");
		await runGit(linkedWorktree, ["add", "feature-only.txt"]);

		const mainStatus = await runGit(repo, ["status", "--porcelain=v2", "--", "main-only.txt"], { trim: false });
		const linkedStatus = await runGit(linkedWorktree, ["status", "--porcelain=v2", "--", "feature-only.txt"], {
			trim: false,
		});
		expect(mainStatus).toContain("1 A. ");
		expect(linkedStatus).toContain("1 A. ");

		const mainCas = createMapCas();
		const linkedCas = createMapCas();
		const mainSnapshot = await captureWorkspaceGitState(repo, mainCas);
		const linkedSnapshot = await captureWorkspaceGitState(linkedWorktree, linkedCas);

		await fs.writeFile(path.join(repo, "main-only.txt"), "main replacement\n", "utf8");
		await runGit(repo, ["add", "main-only.txt"]);
		await fs.writeFile(path.join(linkedWorktree, "feature-only.txt"), "feature replacement\n", "utf8");
		await runGit(linkedWorktree, ["add", "feature-only.txt"]);
		await fs.writeFile(path.join(repo, "main-only.txt"), "main staged\n", "utf8");
		await fs.writeFile(path.join(linkedWorktree, "feature-only.txt"), "feature staged\n", "utf8");

		await restoreWorkspaceGitState(repo, mainSnapshot, mainCas);
		await restoreWorkspaceGitState(linkedWorktree, linkedSnapshot, linkedCas);

		expect(await runGit(repo, ["status", "--porcelain=v2", "--", "main-only.txt"], { trim: false })).toBe(mainStatus);
		expect(
			await runGit(linkedWorktree, ["status", "--porcelain=v2", "--", "feature-only.txt"], { trim: false }),
		).toBe(linkedStatus);
	});

	it("restores the saved index without moving the live branch ref by default", async () => {
		const repo = await initRepo("omp-git-state-default-ref-");
		const file = path.join(repo, "tracked.txt");
		await fs.writeFile(file, "version one\n", "utf8");
		const initialCommit = await commitAll(repo, "one");

		const cas = createMapCas();
		const snapshot = await captureWorkspaceGitState(repo, cas);

		await fs.writeFile(file, "version two\n", "utf8");
		const advancedCommit = await commitAll(repo, "two");
		expect(advancedCommit).not.toBe(initialCommit);

		await restoreWorkspaceGitState(repo, snapshot, cas);

		expect(await git.ref.resolve(repo, "refs/heads/main")).toBe(advancedCommit);
		expect(await git.head.resolve(repo)).toMatchObject({
			commit: advancedCommit,
			kind: "ref",
			ref: "refs/heads/main",
		});
		expect(await runGit(repo, ["show", "HEAD:tracked.txt"], { trim: false })).toBe("version two\n");
		expect(await runGit(repo, ["show", ":tracked.txt"], { trim: false })).toBe("version one\n");
	});

	it("creates a safety ref before a successful restoreRef CAS update", async () => {
		const repo = await initRepo("omp-git-state-restore-ref-");
		const file = path.join(repo, "tracked.txt");
		await fs.writeFile(file, "version one\n", "utf8");
		const initialCommit = await commitAll(repo, "one");

		const cas = createMapCas();
		const snapshot = await captureWorkspaceGitState(repo, cas);

		await fs.writeFile(file, "version two\n", "utf8");
		const advancedCommit = await commitAll(repo, "two");
		const safetyNamespace = "refs/omp-checkpoint-tests/safety";

		await restoreWorkspaceGitState(repo, snapshot, cas, {
			expectedRefSha: advancedCommit,
			restoreRef: true,
			safetyRefNamespace: safetyNamespace,
		});

		expect(await git.ref.resolve(repo, "refs/heads/main")).toBe(initialCommit);
		const safetyRefs = await listRefs(repo, safetyNamespace);
		expect(safetyRefs).toHaveLength(1);
		expect(safetyRefs[0]?.name.startsWith(`${safetyNamespace}/`)).toBe(true);
		expect(safetyRefs[0]?.sha).toBe(advancedCommit);
	});

	it("rejects restoreRef when expectedRefSha mismatches even if the live branch already equals the desired commit", async () => {
		const repo = await initRepo("omp-git-state-restore-ref-noop-guard-");
		const file = path.join(repo, "tracked.txt");
		await fs.writeFile(file, "version one\n", "utf8");
		const initialCommit = await commitAll(repo, "one");

		const cas = createMapCas();
		const snapshot = await captureWorkspaceGitState(repo, cas);
		const safetyNamespace = "refs/omp-checkpoint-tests/noop-guard";

		let restoreError: unknown = null;
		try {
			await restoreWorkspaceGitState(repo, snapshot, cas, {
				expectedRefSha: "1".repeat(40),
				restoreRef: true,
				safetyRefNamespace: safetyNamespace,
			});
		} catch (err) {
			restoreError = err;
		}

		expect(restoreError).toBeInstanceOf(WorkspaceGitStateRestoreError);
		expect(await git.ref.resolve(repo, "refs/heads/main")).toBe(initialCommit);
		expect(await listRefs(repo, safetyNamespace)).toEqual([]);
	});

	it("rejects restoreRef when the expected branch tip no longer matches and leaves no safety ref behind", async () => {
		const repo = await initRepo("omp-git-state-restore-ref-guard-");
		const file = path.join(repo, "tracked.txt");
		await fs.writeFile(file, "version one\n", "utf8");
		const initialCommit = await commitAll(repo, "one");

		const cas = createMapCas();
		const snapshot = await captureWorkspaceGitState(repo, cas);
		await fs.writeFile(file, "version two\n", "utf8");
		const advancedCommit = await commitAll(repo, "two");
		const safetyNamespace = "refs/omp-checkpoint-tests/guard";

		let restoreError: unknown = null;
		try {
			await restoreWorkspaceGitState(repo, snapshot, cas, {
				expectedRefSha: initialCommit,
				restoreRef: true,
				safetyRefNamespace: safetyNamespace,
			});
		} catch (err) {
			restoreError = err;
		}
		expect(restoreError).toBeInstanceOf(WorkspaceGitStateRestoreError);
		expect(await git.ref.resolve(repo, "refs/heads/main")).toBe(advancedCommit);
		expect(await listRefs(repo, safetyNamespace)).toEqual([]);
	});
});
