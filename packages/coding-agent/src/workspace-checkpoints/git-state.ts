// SPDX-License-Identifier: MIT
//
// Git state capture/restore for workspace checkpoints.
//
// Captures the root + nested (non-submodule) + submodule git repositories
// found under a workspace root, plus a per-repo capsule containing the
// raw HEAD file content, symbolic-ref target, commit SHA, and raw index
// bytes (with split-index companion files). Restoration writes the index
// atomically and either leaves HEAD untouched (default — file-system
// restore is responsible for moving branch refs) or applies an explicit
// compare-and-swap via `update-ref --stdin` after staging a safety ref.
//
// This module is the *only* writer of CAS blob payloads for git state;
// the workspace file tree is owned by the file-tree scanner.

import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import * as git from "../utils/git";
import type { GitIndexSnapshot, GitRepositorySnapshot } from "./types";

// ════════════════════════════════════════════════════════════════════════════
// Public types
// ════════════════════════════════════════════════════════════════════════════

/**
 * Content-addressed storage interface the capsule layer needs. The
 * concrete `ContentStore` implementation lives elsewhere; this module
 * takes a callback so the dependency can be wired at the service layer
 * without creating a cycle.
 *
 * - `put` MUST be deterministic on identical input (the returned `objectId`
 *   is the CAS key the snapshot records, so two captures of the same bytes
 *   must yield the same id).
 * - `get` returns the original bytes for an id previously returned by
 *   `put`, or `null` if the object is missing (e.g. GC evicted).
 */
export interface GitCheckpointCas {
	put(bytes: Uint8Array): Promise<string>;
	get(objectId: string): Promise<Uint8Array | null>;
}

/**
 * A discovered repository to capture. `worktreePath` is the absolute path
 * to the working tree root; `isSubmodule` distinguishes submodule repos
 * (whose parent tracks them via gitlinks) from nested repos (independent
 * worktrees the project happens to embed).
 */
export interface WorkspaceGitRepositoryRef {
	worktreePath: string;
	isSubmodule: boolean;
}

/**
 * Per-repository git capsule captured for checkpoint restore. Extends the
 * shared manifest-facing snapshot with restore-only fields:
 * - `rawHeadObjectId` preserves the raw HEAD file bytes (including unborn
 *   symbolic HEADs) in CAS.
 * - `isSubmodule` distinguishes gitlinks from ordinary nested repos.
 */
export interface WorkspaceGitRepositoryState extends GitRepositorySnapshot {
	rawHeadObjectId: string | null;
	isSubmodule: boolean;
}

/**
 * The complete git-state capture of a workspace.
 */
export interface WorkspaceGitStateSnapshot {
	/** Repository states indexed by absolute worktree path. */
	repositories: WorkspaceGitRepositoryState[];
}

export interface WorkspaceGitStateCaptureOptions {
	/** Cancellation handle. */
	signal?: AbortSignal;
	/**
	 * Filesystem entry names to skip during nested-repo discovery.
	 * Defaults to a conservative set: `node_modules`, `.git`, `.hg`,
	 * `.svn`, `.jj`, plus standard VCS/build caches.
	 */
	skipDirs?: ReadonlySet<string>;
	/** Maximum recursion depth for nested-repo discovery (default `8`). */
	maxDepth?: number;
}

export interface WorkspaceGitStateRestoreOptions {
	/** Cancellation handle. */
	signal?: AbortSignal;
	/**
	 * When `true`, atomically update the recorded `headRef` (when the
	 * snapshot is on a branch) to the captured `head` SHA via
	 * `update-ref --stdin` after first writing a safety ref under
	 * `${safetyRefNamespace}/<snowflake>` so the previous tip is
	 * recoverable. Default `false` — restore leaves branch refs
	 * untouched and only normalizes HEAD/index so a downstream
	 * file-tree restore can move refs deterministically.
	 */
	restoreRef?: boolean;
	/**
	 * Override the default ref namespace used for safety refs. Each
	 * restore writes the prior ref tip to
	 * `${safetyRefNamespace}/<snowflake>` so an undo path can locate
	 * it without scanning the reflog.
	 */
	safetyRefNamespace?: string;
	/**
	 * When non-null, a CAS guard: the live `headRef` is verified against
	 * this SHA before ref restoration proceeds. Mismatch aborts with
	 * `WorkspaceGitStateRestoreError` and leaves HEAD/index untouched.
	 */
	expectedRefSha?: string;
}

/** Error raised when a restore encounters an unrecoverable conflict. */
export class WorkspaceGitStateRestoreError extends Error {
	override readonly cause?: unknown;
	constructor(message: string, options: { cause?: unknown } = {}) {
		super(message);
		this.name = "WorkspaceGitStateRestoreError";
		this.cause = options.cause;
	}
}

// ════════════════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════════════════

/**
 * Discover every git repository under `rootPath`: the root repo (if any),
 * every nested non-submodule repo, and every submodule of those. Repos
 * outside `rootPath` are NOT followed (e.g. a parent superproject).
 *
 * Submodules are identified via `git submodule foreach --recursive` and
 * excluded from the nested-repo walk. Bare worktrees of an already-found
 * repo (i.e. `worktreePath !== repoRoot`) are reported as separate
 * entries; this module captures each independently.
 */
export async function discoverWorkspaceGitRepositories(
	rootPath: string,
	options: WorkspaceGitStateCaptureOptions = {},
): Promise<WorkspaceGitRepositoryRef[]> {
	const root = path.resolve(rootPath);
	const maxDepth = options.maxDepth ?? 8;
	const skipDirs = options.skipDirs ?? DEFAULT_NESTED_REPO_SKIP_DIRS;

	const rootRepository = await git.repo.resolve(root);
	if (!rootRepository) return [];

	// Collect submodule paths from the root repo. Submodules of submodules
	// are included by `git submodule foreach --recursive`, and the relative
	// paths are stable across captures.
	const submoduleRelPaths = new Set(await git.ls.submodules(rootRepository.repoRoot, options.signal));
	const submoduleAbsPaths = new Set<string>();
	for (const rel of submoduleRelPaths) {
		submoduleAbsPaths.add(path.resolve(rootRepository.repoRoot, rel));
	}

	const discovered: WorkspaceGitRepositoryRef[] = [{ worktreePath: rootRepository.repoRoot, isSubmodule: false }];

	const seenWorktrees = new Set<string>([rootRepository.repoRoot]);
	// Walk the root worktree to find nested repos. Submodules are flagged
	// as such even when the walk happens to find them first; nested
	// (non-submodule) repos are independent worktrees the project
	// happens to embed.
	await walkForNestedRepos(
		rootRepository.repoRoot,
		0,
		maxDepth,
		skipDirs,
		submoduleAbsPaths,
		seenWorktrees,
		discovered,
	);

	// Append submodule paths that the walk skipped (e.g. blocked by a
	// skipDir entry, or filtered by depth). Their own nested/submodule
	// structure is captured when restore replays the snapshot, so we do
	// NOT recurse into them here.
	for (const sub of submoduleAbsPaths) {
		if (seenWorktrees.has(sub)) continue;
		seenWorktrees.add(sub);
		discovered.push({ isSubmodule: true, worktreePath: sub });
	}

	return discovered;
}

/**
 * Capture a complete git-state snapshot of the workspace. Each
 * repository's index is written to `cas` and only the resulting object
 * id is recorded on the returned snapshot — keeps snapshots small and
 * dedupes across captures of the same content.
 */
export async function captureWorkspaceGitState(
	rootPath: string,
	cas: GitCheckpointCas,
	options: WorkspaceGitStateCaptureOptions = {},
): Promise<WorkspaceGitStateSnapshot> {
	const root = path.resolve(rootPath);
	const discovered = await discoverWorkspaceGitRepositories(root, options);
	const repositories: WorkspaceGitRepositoryState[] = [];

	for (const entry of discovered) {
		repositories.push(await captureRepositoryState(entry.worktreePath, entry.isSubmodule, cas, options.signal));
	}

	return { repositories };
}

/**
 * Restore the git-state of a workspace. For each snapshot:
 *
 * 1. Acquire the per-repo write lock (so concurrent captures/restores
 *    on the same primary repo serialize — see `withRepoLock`).
 * 2. Write the index atomically (companion `sharedindex.*` files first,
 *    then the primary index — temp + rename).
 * 3. Write the recorded raw `HEAD` blob back to `HEAD`.
 * 4. If `restoreRef: true`, CAS-update the recorded branch ref to the
 *    captured commit SHA, with a safety ref under
 *    `${safetyRefNamespace}/<snowflake>` recording the previous tip.
 *    Mismatch against `expectedRefSha` aborts before any ref change.
 *
 * Refuses `reset --hard`, `clean`, and `stash`: the only mutating
 * subprocesses invoked are `update-ref --stdin`. The worktree's files
 * are not touched here; the file-tree restore layer handles that.
 */
export async function restoreWorkspaceGitState(
	rootPath: string,
	snapshot: WorkspaceGitStateSnapshot,
	cas: GitCheckpointCas,
	options: WorkspaceGitStateRestoreOptions = {},
): Promise<void> {
	const root = path.resolve(rootPath);
	if (!git.isGitAvailable()) {
		throw new WorkspaceGitStateRestoreError("git is not installed; cannot restore git state");
	}
	if (!snapshot.repositories.length) return;

	const safetyNamespace = options.safetyRefNamespace ?? "refs/omp-checkpoint/safety";

	for (const repo of snapshot.repositories) {
		const rel = path.relative(root, repo.worktreePath);
		const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
		if (!inside) {
			throw new WorkspaceGitStateRestoreError(
				`Refusing to restore repo outside workspace root: ${repo.worktreePath}`,
			);
		}
		await restoreRepositoryState(repo, cas, safetyNamespace, options);
	}
}

// ════════════════════════════════════════════════════════════════════════════
// Internal: capture
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_NESTED_REPO_SKIP_DIRS: ReadonlySet<string> = new Set([
	"node_modules",
	".git",
	".hg",
	".svn",
	".jj",
	".idea",
	".vscode",
	".next",
	".nuxt",
	"target",
	"dist",
	"build",
	"out",
	"vendor",
]);

async function captureRepositoryState(
	worktreePath: string,
	isSubmodule: boolean,
	cas: GitCheckpointCas,
	signal: AbortSignal | undefined,
): Promise<WorkspaceGitRepositoryState> {
	const repository = await git.repo.resolve(worktreePath);
	if (!repository) {
		throw new WorkspaceGitStateRestoreError(`Cannot capture: ${worktreePath} is no longer a git repository`);
	}
	// All four reads run concurrently — they're independent and the
	// index capture does the heavy file I/O.
	const [headContent, headRef, headSha, index] = await Promise.all([
		git.readHeadRaw(repository.repoRoot, { signal }),
		git.headSymbolicRef(repository.repoRoot, { signal }),
		git.headCommitSha(repository.repoRoot, { signal }),
		git.index.capture(repository.repoRoot, { signal }),
	]);

	const rawHeadObjectId = headContent === null ? null : await cas.put(new TextEncoder().encode(`${headContent}\n`));

	let indexSnapshot: GitIndexSnapshot | null = null;
	if (index.bytes) {
		const objectId = await cas.put(index.bytes);
		const sharedIndexObjectIds: string[] = [];
		const sharedIndexNames: string[] = [];
		for (const shared of index.sharedIndexFiles) {
			sharedIndexObjectIds.push(await cas.put(shared.bytes));
			sharedIndexNames.push(shared.name);
		}
		indexSnapshot = { objectId, path: index.path, sharedIndexNames, sharedIndexObjectIds };
	}

	return {
		commonDir: repository.commonDir,
		gitDir: repository.gitDir,
		head: headSha,
		headRef,
		index: indexSnapshot,
		isSubmodule,
		rawHeadObjectId,
		worktreePath: repository.repoRoot,
	};
}

// ════════════════════════════════════════════════════════════════════════════
// Internal: restore
// ════════════════════════════════════════════════════════════════════════════

async function restoreRepositoryState(
	state: WorkspaceGitRepositoryState,
	cas: GitCheckpointCas,
	safetyNamespace: string,
	options: WorkspaceGitStateRestoreOptions,
): Promise<void> {
	const worktree = state.worktreePath;
	await git.withRepoLock(
		worktree,
		async () => {
			const repository = await git.repo.resolve(worktree);
			if (!repository) {
				throw new WorkspaceGitStateRestoreError(`Repository no longer present: ${worktree}`);
			}
			// ── 1. Index: CAS-fetch each blob, then write atomically. The
			//    writer stages shared files before the primary index, so an
			//    observer can never see an index referencing a missing
			//    sharedindex.<sha>.
			if (state.index) {
				const indexBytes = await cas.get(state.index.objectId);
				if (!indexBytes) {
					throw new WorkspaceGitStateRestoreError(
						`Index blob missing from CAS: ${state.index.objectId} (${worktree})`,
					);
				}
				const sharedIndexFiles: git.SharedIndexFile[] = [];
				for (let i = 0; i < state.index.sharedIndexObjectIds.length; i++) {
					const objectId = state.index.sharedIndexObjectIds[i]!;
					const name = state.index.sharedIndexNames[i] ?? `sharedindex.${objectId}`;
					const bytes = await cas.get(objectId);
					if (!bytes) {
						throw new WorkspaceGitStateRestoreError(
							`Shared-index blob missing from CAS: ${objectId} (${worktree})`,
						);
					}
					// The primary index references the shared file by its
					// original on-disk name (the trailing SHA is part of
					// git's split-index extension), so the restore MUST
					// write each blob back to that name — not a CAS-derived
					// alias — or the index would point at a non-existent
					// companion and every subsequent `git` read would fail.
					sharedIndexFiles.push({ bytes, name });
				}
				await git.index.writeAtomic(repository.repoRoot, indexBytes, sharedIndexFiles, {
					signal: options.signal,
				});
			}

			// ── 2. HEAD: write the captured raw HEAD blob. For unborn
			//    branches this preserves the symbolic ref; for detached
			//    HEADs it preserves the raw SHA. We do NOT call
			//    `git checkout` or `git reset` — file content is owned by
			//    the file-tree restore layer.
			if (state.rawHeadObjectId !== null) {
				const rawHeadBytes = await cas.get(state.rawHeadObjectId);
				if (!rawHeadBytes) {
					throw new WorkspaceGitStateRestoreError(
						`HEAD blob missing from CAS: ${state.rawHeadObjectId} (${worktree})`,
					);
				}
				await Bun.write(repository.headPath, rawHeadBytes);
			} else if (state.headRef) {
				await Bun.write(repository.headPath, `ref: ${state.headRef}\n`);
			} else if (state.head) {
				await Bun.write(repository.headPath, `${state.head}\n`);
			}

			// ── 3. Optional branch-ref restoration with CAS guard.
			if (options.restoreRef && state.headRef && state.head) {
				await restoreBranchRef(repository.repoRoot, state.headRef, state.head, {
					...options,
					safetyNamespace,
				});
			}
		},
		options.signal,
	);
}

interface RestoreBranchRefOptions extends WorkspaceGitStateRestoreOptions {
	safetyNamespace: string;
}

async function restoreBranchRef(
	repoRoot: string,
	headRef: string,
	desiredSha: string,
	options: RestoreBranchRefOptions,
): Promise<void> {
	// Read the live ref value directly so we don't depend on `git`
	// printing a particular format. Falls back to absent when the
	// ref doesn't exist yet.
	const liveSha = await readRefLooseOrPacked(repoRoot, headRef);

	// Guard: caller-provided expected SHA. When set, the live ref
	// must match it before we treat the operation as a no-op; a
	// mismatched expectation is a real conflict even when the desired
	// SHA already matches the live ref.
	if (options.expectedRefSha !== undefined && liveSha !== options.expectedRefSha) {
		throw new WorkspaceGitStateRestoreError(
			`Ref guard failed: expected ${headRef}@${options.expectedRefSha}, found ${liveSha ?? "<absent>"}`,
		);
	}

	if (liveSha === desiredSha) return; // Already at the target.

	// Stage a safety ref BEFORE the CAS so the prior tip is always
	// recoverable. The safety ref namespace is owned by this module;
	// downstream undo/redo layers can prune it.
	const safetyRef = `${options.safetyNamespace}/${Snowflake.next()}`;
	const safetyScript = liveSha ? `create ${safetyRef} ${liveSha}\n` : "";

	// A single `update-ref --stdin` invocation takes the packed-refs
	// lock once for the whole transaction, so the safety ref and the
	// CAS update are atomic w.r.t. other ref writers in-process.
	const casLine = liveSha ? `update ${headRef} ${desiredSha} ${liveSha}\n` : `create ${headRef} ${desiredSha}\n`;

	try {
		await git.refUpdateFromStdin(repoRoot, `${safetyScript}${casLine}`, { signal: options.signal });
	} catch (err) {
		// On CAS failure, the safety ref may have been written in
		// isolation (the script is one stdin pipe but `update` can fail
		// after `create`). Best-effort cleanup; failure here is logged
		// but does not mask the original error.
		if (safetyScript) {
			await git.refUpdateFromStdin(repoRoot, `delete ${safetyRef}\n`, { signal: options.signal }).catch(() => {});
		}
		throw new WorkspaceGitStateRestoreError(
			`Ref CAS failed for ${headRef} (current=${liveSha ?? "<absent>"}, desired=${desiredSha})`,
			{ cause: err },
		);
	}
}

async function readRefLooseOrPacked(repoRoot: string, refName: string): Promise<string | null> {
	// Resolve the primary git dir; refs live there (linked worktrees
	// share the primary's refs via the common dir). A submodule of a
	// worktree in the workspace has its own git dir; resolving via
	// `git.repo.resolve` makes the correct choice without ad-hoc
	// commondir walking here.
	const repository = await git.repo.resolve(repoRoot);
	if (!repository) return null;

	const candidates =
		repository.gitDir === repository.commonDir ? [repository.gitDir] : [repository.gitDir, repository.commonDir];

	for (const dir of candidates) {
		const loose = await readOptionalText(path.join(dir, refName));
		const trimmed = loose?.trim();
		if (trimmed) return trimmed;
	}
	for (const dir of candidates) {
		const packed = await readOptionalText(path.join(dir, "packed-refs"));
		if (!packed) continue;
		for (const line of packed.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("^")) continue;
			const tabIndex = trimmed.indexOf(" ");
			if (tabIndex < 0) continue;
			const sha = trimmed.slice(0, tabIndex);
			const name = trimmed.slice(tabIndex + 1).trim();
			if (name === refName) return sha;
		}
	}
	return null;
}

async function readOptionalText(filePath: string): Promise<string | null> {
	try {
		return await Bun.file(filePath).text();
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

// ════════════════════════════════════════════════════════════════════════════
// Internal: nested-repo discovery
// ════════════════════════════════════════════════════════════════════════════

async function walkForNestedRepos(
	startDir: string,
	depth: number,
	maxDepth: number,
	skipDirs: ReadonlySet<string>,
	submodulePaths: ReadonlySet<string>,
	seen: Set<string>,
	out: WorkspaceGitRepositoryRef[],
): Promise<void> {
	const queue: Array<{ dir: string; depth: number }> = [{ depth, dir: startDir }];
	while (queue.length > 0) {
		const { depth: currentDepth, dir } = queue.shift()!;
		if (currentDepth >= maxDepth) continue;
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (skipDirs.has(entry.name)) continue;
			const full = path.join(dir, entry.name);
			const gitEntry = path.join(full, ".git");
			let entryStat: Stats | null = null;
			try {
				entryStat = await fs.stat(gitEntry);
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
			if (entryStat) {
				// Each nested repo is a leaf from the parent's perspective —
				// we capture its state independently and skip into its tree.
				if (!seen.has(full)) {
					seen.add(full);
					out.push({ isSubmodule: submodulePaths.has(full), worktreePath: full });
				}
				continue;
			}
			queue.push({ depth: currentDepth + 1, dir: full });
		}
	}
}
