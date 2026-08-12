/**
 * Git Sync Hooks
 *
 * Adapted from upstream `src/sync/git-hooks.ts` (MIT, Colby Mchenry). OMP
 * keeps no long-lived CodeGraph process, so a live file watcher cannot own
 * index refresh the way the upstream daemon does. These opt-in git hooks are
 * the offline safety net: after commit/merge/checkout — the highest-frequency
 * bulk file-change events in an agent's workflow — they launch
 * `omp codegraph sync` in the background so the index catches up without
 * waiting for the next tool call.
 *
 * Hooks are injected into `.git/hooks/` under a marker block that `omp` fully
 * owns: installs are idempotent (re-running replaces the block, never
 * duplicates it), removals strip only the block, and any user-authored hook
 * content is preserved verbatim. `core.hooksPath` and git worktrees are
 * honored via `git rev-parse --git-path hooks`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { gitSpawnSyncText } from "../utils/git";

const MARKER_BEGIN = "# >>> codegraph sync hook >>>";
const MARKER_END = "# <<< codegraph sync hook <<<";

export type GitHookName = "post-commit" | "post-merge" | "post-checkout";

/** Hooks installed by default: commit, merge (git pull), and checkout. */
export const DEFAULT_SYNC_HOOKS: GitHookName[] = ["post-commit", "post-merge", "post-checkout"];

export interface GitHookResult {
	/** Hook names that were created, updated, or removed. */
	installed: GitHookName[];
	/** Resolved hooks directory, or null when not a git repo. */
	hooksDir: string | null;
	/** Reason nothing happened (e.g. not a git repository). */
	skipped?: string;
}

/**
 * Whether `projectRoot` is inside a git working tree. Returns false if git
 * isn't installed or the path isn't a repo.
 */
export function isGitRepo(projectRoot: string): boolean {
	const { exitCode, stdout } = gitSpawnSyncText(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
	return exitCode === 0 && stdout === "true";
}

/**
 * Resolve the git hooks directory for a project, honoring `core.hooksPath`
 * and git worktrees. Returns an absolute path, or null when not a repo.
 */
function gitHooksDir(projectRoot: string): string | null {
	const { exitCode, stdout } = gitSpawnSyncText(projectRoot, ["rev-parse", "--git-path", "hooks"]);
	if (exitCode !== 0 || !stdout) return null;
	return path.isAbsolute(stdout) ? stdout : path.resolve(projectRoot, stdout);
}

/** The shell snippet (between markers) injected into each hook. */
function markerBlock(): string {
	return [
		MARKER_BEGIN,
		"# Keeps the CodeGraph index fresh while no live file watcher is running.",
		"# Runs in the background so it never blocks git.",
		"# Managed by omp; remove with `omp codegraph hooks-remove` or delete this block.",
		"if command -v omp >/dev/null 2>&1; then",
		"  ( omp codegraph sync >/dev/null 2>&1 & ) >/dev/null 2>&1",
		"fi",
		MARKER_END,
	].join("\n");
}

/** Remove our marker block (and the marker lines) from hook content. */
function stripMarkerBlock(content: string): string {
	const lines = content.split("\n");
	const kept: string[] = [];
	let inBlock = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === MARKER_BEGIN) {
			inBlock = true;
			continue;
		}
		if (trimmed === MARKER_END) {
			inBlock = false;
			continue;
		}
		if (!inBlock) kept.push(line);
	}
	return kept.join("\n");
}

/** Whether a hook body is just a shebang / blank lines (i.e. only ever ours). */
function isEffectivelyEmpty(content: string): boolean {
	return content
		.split("\n")
		.map(line => line.trim())
		.every(line => line.length === 0 || line.startsWith("#!"));
}

function chmodExecutable(file: string): void {
	try {
		fs.chmodSync(file, 0o755);
	} catch {
		/* chmod is a no-op / unsupported on some platforms (e.g. Windows) */
	}
}

/**
 * Install (or update) the CodeGraph sync hooks in a git repository.
 * Idempotent: re-running replaces our marker block rather than duplicating
 * it, and any user-authored hook content is preserved.
 */
export function installGitSyncHook(projectRoot: string, hooks: GitHookName[] = DEFAULT_SYNC_HOOKS): GitHookResult {
	const hooksDir = gitHooksDir(projectRoot);
	if (!hooksDir) {
		return { installed: [], hooksDir: null, skipped: "not a git repository" };
	}

	try {
		fs.mkdirSync(hooksDir, { recursive: true });
	} catch {
		return { installed: [], hooksDir, skipped: "could not access the git hooks directory" };
	}

	const block = markerBlock();
	const installed: GitHookName[] = [];

	for (const hook of hooks) {
		const file = path.join(hooksDir, hook);
		let content: string;

		if (fs.existsSync(file)) {
			// Strip any prior block, then re-append the current one.
			const base = stripMarkerBlock(fs.readFileSync(file, "utf8")).replace(/\s*$/, "");
			content = base.length > 0 ? `${base}\n\n${block}\n` : `#!/bin/sh\n${block}\n`;
		} else {
			content = `#!/bin/sh\n${block}\n`;
		}

		fs.writeFileSync(file, content);
		chmodExecutable(file);
		installed.push(hook);
	}

	return { installed, hooksDir };
}

/**
 * Remove the CodeGraph sync hooks. Strips only our marker block; deletes the
 * hook file entirely when nothing but a shebang remains, otherwise rewrites
 * the user's content untouched.
 */
export function removeGitSyncHook(projectRoot: string, hooks: GitHookName[] = DEFAULT_SYNC_HOOKS): GitHookResult {
	const hooksDir = gitHooksDir(projectRoot);
	if (!hooksDir) {
		return { installed: [], hooksDir: null, skipped: "not a git repository" };
	}

	const removed: GitHookName[] = [];

	for (const hook of hooks) {
		const file = path.join(hooksDir, hook);
		if (!fs.existsSync(file)) continue;

		const original = fs.readFileSync(file, "utf8");
		if (!original.includes(MARKER_BEGIN)) continue;

		const stripped = stripMarkerBlock(original);
		if (isEffectivelyEmpty(stripped)) {
			fs.unlinkSync(file);
		} else {
			fs.writeFileSync(file, `${stripped.replace(/\s*$/, "")}\n`);
			chmodExecutable(file);
		}
		removed.push(hook);
	}

	return { installed: removed, hooksDir };
}

/** Whether any CodeGraph sync hook is currently installed. */
export function isSyncHookInstalled(projectRoot: string, hooks: GitHookName[] = DEFAULT_SYNC_HOOKS): boolean {
	const hooksDir = gitHooksDir(projectRoot);
	if (!hooksDir) return false;
	return hooks.some(hook => {
		const file = path.join(hooksDir, hook);
		return fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(MARKER_BEGIN);
	});
}
