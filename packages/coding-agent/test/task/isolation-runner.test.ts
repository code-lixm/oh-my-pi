import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	applyEligibleNestedPatches,
	mergeIsolatedChanges,
	runIsolatedSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as gitModule from "@oh-my-pi/pi-coding-agent/utils/git";
import * as natives from "@oh-my-pi/pi-natives";
import { $ } from "bun";

function result(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "NestedOnly",
		agent: "task",
		agentSource: "bundled",
		task: "Do nested work",
		assignment: "Do nested work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

const tempRoots: string[] = [];
const FOO_OLD_TO_NEW_PATCH = `diff --git a/foo.txt b/foo.txt
--- a/foo.txt
+++ b/foo.txt
@@ -1 +1 @@
-old
+new
`;

const FOO_AMBIGUOUS_OLD_BLOCK = `before1
before2
before3
old
after1
after2
after3
`;
const FOO_AMBIGUOUS_NEW_BLOCK = `before1
before2
before3
new
after1
after2
after3
`;
const FOO_AMBIGUOUS_CONTENT = `${FOO_AMBIGUOUS_OLD_BLOCK}${FOO_AMBIGUOUS_NEW_BLOCK}`;

// The hunk coordinates deliberately point forward apply at line 1 and reverse
// apply at line 8. Both checks therefore succeed against FOO_AMBIGUOUS_CONTENT.
const FOO_AMBIGUOUS_OLD_TO_NEW_PATCH = `diff --git a/foo.txt b/foo.txt
--- a/foo.txt
+++ b/foo.txt
@@ -1,7 +8,7 @@
 before1
 before2
 before3
-old
+new
 after1
 after2
 after3
`;

async function git(repoRoot: string, ...args: string[]): Promise<string> {
	const result = await $`git ${args}`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
	return result.text();
}

type FooRepoSeedOptions = {
	initialContent?: string;
	patchText?: string;
};

async function seedFooRepo(
	finalContent: string,
	{ initialContent = "old\n", patchText = FOO_OLD_TO_NEW_PATCH }: FooRepoSeedOptions = {},
): Promise<{ repoRoot: string; patchPath: string }> {
	if (!patchText.trim()) {
		throw new Error("seedFooRepo requires a non-empty patch fixture");
	}
	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-merge-"));
	tempRoots.push(repoRoot);

	await git(repoRoot, "init");
	await git(repoRoot, "config", "user.email", "repro@example.com");
	await git(repoRoot, "config", "user.name", "Repro");
	await Bun.write(path.join(repoRoot, "foo.txt"), initialContent);
	await git(repoRoot, "add", "foo.txt");
	await git(repoRoot, "commit", "-m", "base");

	const patchPath = path.join(repoRoot, "task.patch");
	await Bun.write(patchPath, patchText);

	if (finalContent !== initialContent) {
		await Bun.write(path.join(repoRoot, "foo.txt"), finalContent);
		await git(repoRoot, "commit", "-am", "set final content");
	}
	return { repoRoot, patchPath };
}

describe("runIsolatedSubprocess", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		await Promise.all(tempRoots.splice(0).map(tempRoot => fs.rm(tempRoot, { force: true, recursive: true })));
	});

	it("preserves branch-mode output as a patch when branch transfer fails", async () => {
		const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-run-"));
		tempRoots.push(repoRoot);
		const isolationDir = path.join(repoRoot, "isolated");
		const artifactsDir = path.join(repoRoot, "artifacts");
		const baseline = {
			root: {
				repoRoot,
				headCommit: "base",
				staged: "",
				unstaged: "",
				untracked: [],
				untrackedPatch: "",
			},
			nested: [],
		};
		const rootPatch = "diff --git a/task.txt b/task.txt\n--- a/task.txt\n+++ b/task.txt\n@@ -1 +1 @@\n-old\n+new\n";

		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: isolationDir,
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result({ id: "PreserveBranchFailure" }));
		vi.spyOn(worktreeModule, "commitToBranch").mockRejectedValue(new Error("remote: object corrupt"));
		const captureSpy = vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch,
			nestedPatches: [],
		});
		const cleanupSpy = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
		AgentRegistry.global().register({
			id: "PreserveBranchFailure",
			displayName: "PreserveBranchFailure",
			kind: "sub",
			session: null,
			status: "parked",
		});
		const deleteSpy = vi.spyOn(gitModule.branch, "tryDelete").mockResolvedValue(true);

		const outcome = await runIsolatedSubprocess({
			baseOptions: {
				cwd: repoRoot,
				agent: {
					name: "task",
					description: "Task agent",
					systemPrompt: "test",
					source: "bundled",
				},
				task: "Do work",
				index: 0,
				id: "PreserveBranchFailure",
			},
			context: { repoRoot, baseline },
			preferredBackend: undefined,
			agentId: "PreserveBranchFailure",
			mergeMode: "branch",
			artifactsDir,
			buildFailureResult: err => result({ exitCode: 1, error: String(err) }),
		});

		const patchPath = path.join(artifactsDir, "PreserveBranchFailure.patch");
		expect(outcome.error).toContain("Merge failed: remote: object corrupt");
		expect(outcome.patchPath).toBe(patchPath);
		expect(await Bun.file(patchPath).text()).toBe(rootPatch);
		expect(outcome.nestedPatches).toEqual([]);
		expect(captureSpy).toHaveBeenCalledWith(isolationDir, baseline);
		expect(deleteSpy).toHaveBeenCalledWith(repoRoot, "omp/task/PreserveBranchFailure");
		expect(cleanupSpy).toHaveBeenCalledTimes(1);
		expect(AgentRegistry.global().get("PreserveBranchFailure")?.history?.patchPath).toBe(patchPath);
	});

	it("keeps an isolated worktree until deferred child cleanup settles", async () => {
		const cleanupGate = Promise.withResolvers<void>();
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/repo/isolated",
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			options.onCleanupDeferred?.(cleanupGate.promise);
			return result({ exitCode: 1, aborted: true, error: "cleanup exceeded its deadline" });
		});
		const cleanupSpy = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();

		const outcome = await runIsolatedSubprocess({
			baseOptions: {
				cwd: "/repo",
				agent: {
					name: "task",
					description: "Task agent",
					systemPrompt: "test",
					source: "bundled",
				},
				task: "Do work",
				index: 0,
				id: "DeferredCleanup",
			},
			context: {
				repoRoot: "/repo",
				baseline: {
					root: {
						repoRoot: "/repo",
						headCommit: "base",
						staged: "",
						unstaged: "",
						untracked: [],
						untrackedPatch: "",
					},
					nested: [],
				},
			},
			preferredBackend: undefined,
			agentId: "DeferredCleanup",
			mergeMode: "patch",
			artifactsDir: "/artifacts",
			buildFailureResult: error => result({ exitCode: 1, error: String(error) }),
		});

		expect(outcome.exitCode).toBe(1);
		expect(cleanupSpy).not.toHaveBeenCalled();
		cleanupGate.resolve();
		await cleanupGate.promise;
		await Promise.resolve();
		await Promise.resolve();
		expect(cleanupSpy).toHaveBeenCalledTimes(1);
	});
});

describe("mergeIsolatedChanges", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(tempRoots.splice(0).map(tempRoot => fs.rm(tempRoot, { force: true, recursive: true })));
	});

	it("allows nested-only branch-mode patches to apply when no root branch was created", async () => {
		const mergeSpy = vi.spyOn(worktreeModule, "mergeTaskBranches");
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				nestedPatches: [{ relativePath: "nested", patch: "diff --git a/file b/file\n" }],
			}),
		});

		expect(mergeSpy).not.toHaveBeenCalled();
		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(true);
		expect(outcome.mergedBranchForNestedPatches).toBe(true);
		expect(outcome.summary).toContain("nested repository patches captured");
	});

	it("surfaces branch preparation errors instead of reporting no changes", async () => {
		const mergeSpy = vi.spyOn(worktreeModule, "mergeTaskBranches");
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				error: "Merge failed: git apply --3way failed for task dirty-context: conflict",
				patchPath: "/repo/artifacts/dirty-context.patch",
			}),
		});

		expect(mergeSpy).not.toHaveBeenCalled();
		expect(outcome.changesApplied).toBe(false);
		expect(outcome.hadAnyChanges).toBe(false);
		expect(outcome.mergedBranchForNestedPatches).toBe(false);
		expect(outcome.summary).toContain("Branch merge failed before a task branch could be created");
		expect(outcome.summary).toContain("git apply --3way failed");
		expect(outcome.summary).toContain("/repo/artifacts/dirty-context.patch");
		expect(outcome.summary).not.toContain("No changes to apply");
	});

	it("treats already-applied patch-mode diffs as successful no-ops", async () => {
		const { repoRoot, patchPath } = await seedFooRepo("new\n");

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(false);
		expect(outcome.summary).not.toContain("Patches were not applied");
		expect(await git(repoRoot, "status", "--porcelain", "--", "foo.txt")).toBe("");
	});

	it("rejects patch-mode conflicts without dirtying the worktree", async () => {
		const { repoRoot, patchPath } = await seedFooRepo("other\n");

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(outcome.changesApplied).toBe(false);
		expect(outcome.hadAnyChanges).toBe(false);
		expect(outcome.summary).toContain("Patches were not applied");
		expect(await git(repoRoot, "status", "--porcelain", "--", "foo.txt")).toBe("");
		expect(await Bun.file(path.join(repoRoot, "foo.txt")).text()).toBe("other\n");
		expect(await git(repoRoot, "ls-files", "-u", "--", "foo.txt")).toBe("");
	});

	it("applies a fresh patch-mode diff when context matches", async () => {
		const { repoRoot, patchPath } = await seedFooRepo("old\n");

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(true);
		expect(await Bun.file(path.join(repoRoot, "foo.txt")).text()).toBe("new\n");
	});

	it("applies forward when both forward and reverse patch checks succeed", async () => {
		const { repoRoot, patchPath } = await seedFooRepo(FOO_AMBIGUOUS_CONTENT, {
			initialContent: FOO_AMBIGUOUS_CONTENT,
			patchText: FOO_AMBIGUOUS_OLD_TO_NEW_PATCH,
		});

		await git(repoRoot, "apply", "--check", patchPath);
		await git(repoRoot, "apply", "--reverse", "--check", patchPath);

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(true);
		expect(await Bun.file(path.join(repoRoot, "foo.txt")).text()).toBe(
			`${FOO_AMBIGUOUS_NEW_BLOCK}${FOO_AMBIGUOUS_NEW_BLOCK}`,
		);
	});

	it("does not mark failed branch-mode runs as nested-patch eligible", async () => {
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				exitCode: 1,
				nestedPatches: [{ relativePath: "nested", patch: "diff --git a/file b/file\n" }],
			}),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(false);
		expect(outcome.mergedBranchForNestedPatches).toBe(false);
	});
});

describe("applyEligibleNestedPatches", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const nestedPatch = { relativePath: "nested", patch: "diff --git a/file b/file\n" };

	it("skips when patch-mode parent merge failed", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches");
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: false,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).not.toHaveBeenCalled();
	});

	it("skips when branch mode did not actually merge the root branch", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches");
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "branch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).not.toHaveBeenCalled();
	});

	it("applies nested patches and returns no warning on success", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue([]);
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).toHaveBeenCalledTimes(1);
	});

	it("returns a system-notification suffix on apply failure", async () => {
		vi.spyOn(worktreeModule, "applyNestedPatches").mockRejectedValue(new Error("boom"));
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "branch",
			changesApplied: true,
			mergedBranchForNestedPatches: true,
		});
		expect(suffix).toContain("Some nested repository patches failed to apply");
	});

	it("surfaces stash-restore warnings from applyNestedPatches as a system-notification", async () => {
		vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue([
			"Pre-existing dirty state in nested repo `nested` could not be auto-restored after the agent commit; stash entry preserved (conflict).",
		]);
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toContain("could not be auto-restored");
		expect(suffix).toContain("stash entry preserved");
		expect(suffix).toContain("<system-notification>");
	});
});
