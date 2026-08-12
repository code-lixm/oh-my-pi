/**
 * Git sync hooks tests — adapted from upstream `__tests__/git-hooks.test.ts`
 * (MIT, Colby Mchenry). Covers installing/removing the opt-in
 * commit/merge/checkout hooks that keep the CodeGraph index fresh in OMP's
 * no-daemon architecture. Exercises real git repos in temp dirs — no mocking.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	DEFAULT_SYNC_HOOKS,
	type GitHookName,
	installGitSyncHook,
	isGitRepo,
	isSyncHookInstalled,
	removeGitSyncHook,
} from "../src/codegraph/git-hooks";

function gitInit(dir: string): void {
	execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
}

function isExecutable(file: string): boolean {
	if (process.platform === "win32") return true; // mode bits not meaningful
	return (fs.statSync(file).mode & 0o111) !== 0;
}

describe("git sync hooks", () => {
	let repo: string;

	beforeEach(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "omp-githooks-"));
	});

	afterEach(() => {
		if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
	});

	it("installs all default hooks, executable, invoking omp codegraph sync", () => {
		gitInit(repo);

		const result = installGitSyncHook(repo);
		expect(result.skipped).toBeUndefined();
		expect(result.installed.sort()).toEqual([...DEFAULT_SYNC_HOOKS].sort());
		expect(result.hooksDir).not.toBeNull();

		for (const hook of DEFAULT_SYNC_HOOKS) {
			const file = path.join(result.hooksDir!, hook);
			expect(fs.existsSync(file)).toBe(true);
			expect(isExecutable(file)).toBe(true);
			const content = fs.readFileSync(file, "utf8");
			expect(content).toContain("# >>> codegraph sync hook >>>");
			expect(content).toContain("omp codegraph sync");
			expect(content).toContain("command -v omp");
		}
		expect(isSyncHookInstalled(repo)).toBe(true);
	});

	it("is idempotent — re-install does not duplicate the block", () => {
		gitInit(repo);
		installGitSyncHook(repo);
		installGitSyncHook(repo);

		for (const hook of DEFAULT_SYNC_HOOKS) {
			const file = path.join(repo, ".git", "hooks", hook);
			const content = fs.readFileSync(file, "utf8");
			const occurrences = content.split("# >>> codegraph sync hook >>>").length - 1;
			expect(occurrences).toBe(1);
		}
	});

	it("preserves a pre-existing user hook and appends our block", () => {
		gitInit(repo);
		const hookFile = path.join(repo, ".git", "hooks", "post-commit");
		fs.writeFileSync(hookFile, "#!/bin/sh\necho 'user hook'\n");
		fs.chmodSync(hookFile, 0o755);

		installGitSyncHook(repo);

		const content = fs.readFileSync(hookFile, "utf8");
		expect(content).toContain("echo 'user hook'");
		expect(content).toContain("# >>> codegraph sync hook >>>");
		// The user content comes before our block.
		expect(content.indexOf("echo 'user hook'")).toBeLessThan(content.indexOf("# >>> codegraph sync hook >>>"));
	});

	it("remove strips our block; deletes a hook that was only ours", () => {
		gitInit(repo);
		installGitSyncHook(repo);

		const result = removeGitSyncHook(repo);
		expect(result.installed.sort()).toEqual([...DEFAULT_SYNC_HOOKS].sort());

		for (const hook of DEFAULT_SYNC_HOOKS) {
			const file = path.join(repo, ".git", "hooks", hook);
			expect(fs.existsSync(file)).toBe(false);
		}
		expect(isSyncHookInstalled(repo)).toBe(false);
	});

	it("remove keeps user content when the hook is shared", () => {
		gitInit(repo);
		const hookFile = path.join(repo, ".git", "hooks", "post-merge");
		fs.writeFileSync(hookFile, "#!/bin/sh\necho 'user hook'\n");
		fs.chmodSync(hookFile, 0o755);
		installGitSyncHook(repo);

		removeGitSyncHook(repo);

		expect(fs.existsSync(hookFile)).toBe(true);
		const content = fs.readFileSync(hookFile, "utf8");
		expect(content).toContain("echo 'user hook'");
		expect(content).not.toContain("# >>> codegraph sync hook >>>");
	});

	it("honors core.hooksPath", () => {
		gitInit(repo);
		const customHooks = path.join(repo, "custom-hooks");
		fs.mkdirSync(customHooks);
		execFileSync("git", ["config", "core.hooksPath", "custom-hooks"], { cwd: repo, stdio: "ignore" });

		installGitSyncHook(repo);

		const file = path.join(customHooks, "post-commit");
		expect(fs.existsSync(file)).toBe(true);
		expect(fs.readFileSync(file, "utf8")).toContain("# >>> codegraph sync hook >>>");
		expect(isSyncHookInstalled(repo)).toBe(true);
	});

	it("skips cleanly when not a git repository", () => {
		const result = installGitSyncHook(repo);
		expect(result.installed).toHaveLength(0);
		expect(result.skipped).toBe("not a git repository");
		expect(isGitRepo(repo)).toBe(false);
		expect(isSyncHookInstalled(repo)).toBe(false);
	});

	it("supports a custom hook subset and leaves other hooks untouched", () => {
		gitInit(repo);
		const subset: GitHookName[] = ["post-commit"];
		installGitSyncHook(repo, subset);

		expect(fs.existsSync(path.join(repo, ".git", "hooks", "post-commit"))).toBe(true);
		expect(fs.existsSync(path.join(repo, ".git", "hooks", "post-merge"))).toBe(false);
		expect(fs.existsSync(path.join(repo, ".git", "hooks", "post-checkout"))).toBe(false);
		expect(isSyncHookInstalled(repo, subset)).toBe(true);
		// The default hook set includes post-commit, so the default probe still
		// reports installed; only the other two hooks are absent on disk.
		expect(fs.existsSync(path.join(repo, ".git", "hooks", "post-merge"))).toBe(false);
	});
});
