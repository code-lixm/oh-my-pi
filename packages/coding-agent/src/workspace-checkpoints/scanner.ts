/**
 * Workspace scanner.
 *
 * Walks `rootPath` using `lstat` so symlinks stay first-class entries; never
 * follows them. Produces a {@link WorkspaceManifest} snapshot and streams
 * file payloads into a caller-supplied {@link WorkspaceContentStore}. The
 * scanner never auto-creates a store — the caller owns the storage root so
 * it can live outside the workspace.
 *
 * Inclusion/exclusion rules:
 *
 *   - Git worktrees capture tracked paths and non-ignored untracked paths.
 *     Explicit `includePaths` re-adds ignored paths remembered by a prior scan.
 *   - Non-Git workspaces retain the full filesystem walk.
 *   - Never follows symlinks. `.git`, `node_modules`, and `target` remain
 *     protected from every scan mode.
 *   - The exclusion list captures anything selected for capture that could not
 *     be inspected; intentional absent Git/include paths are not errors.
 *
 * The scanner is path-tight: every produced entry's `path` is a slash-
 * normalised relative path with `..` segments rejected.
 */
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger, pathIsWithin } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import type { WorkspaceContentStore } from "./content-store";
import type {
	GitIndexSnapshot,
	GitRepositorySnapshot,
	WorkspaceCheckpointExclusion,
	WorkspaceManifest,
	WorkspaceManifestEntry,
	WorkspaceNodeKind,
} from "./types";

/** A captured workspace scan, raw entries before manifest shaping. */
export interface WorkspaceScanInput {
	/** Workspace root used for the scan. */
	rootPath: string;
	/** Required content store; the scanner never creates one inside the workspace. */
	contentStore: WorkspaceContentStore;
	/** Store file payloads in CAS; disable for read-only live-state comparisons. */
	persistFileContents?: boolean;
	/** Optional git snapshots the caller wants attached post-scan. */
	gitRepositories?: GitRepositorySnapshot[];
	/** Paths a previous Git scan deliberately retained despite ignore rules. */
	includePaths?: readonly string[];
}

/** Input for a scan limited to explicit workspace paths. */
export interface WorkspacePathScanInput {
	/** Workspace root used for the scan. */
	rootPath: string;
	/** Required content store; the scanner never creates one inside the workspace. */
	contentStore: WorkspaceContentStore;
	/** Paths to capture, normalised relative to `rootPath` without requiring they exist. */
	paths: readonly string[];
	/** Store file payloads in CAS; disable for read-only comparisons. */
	persistFileContents?: boolean;
	/** Optional git snapshots the caller wants attached post-scan. */
	gitRepositories?: GitRepositorySnapshot[];
}

/** Output of {@link scanWorkspace}. */
export interface WorkspaceScanResult {
	/** Absolute workspace root the scan was rooted at. */
	rootPath: string;
	/** Stable workspace id derived from the root path. */
	workspaceId: string;
	/** Manifest entries across the workspace. */
	entries: WorkspaceManifestEntry[];
	/** Paths we couldn't capture, with a one-line reason. */
	exclusions: WorkspaceCheckpointExclusion[];
	/** Git repository snapshots supplied by the caller (post-scan). */
	gitRepositories: GitRepositorySnapshot[];
	/** Ignored paths that must be passed back to a future live Git scan. */
	trackedIgnoredPaths: string[];
	/** Whether this was a full Git-aware scan that applied Git ignore rules. */
	respectsGitIgnore: boolean;
	/** Number of regular files captured. */
	fileCount: number;
	/** Sum of bytes represented by regular files. */
	totalBytes: number;
	/** `complete` if every directory was successfully walked, else `partial`. */
	completeness: "complete" | "partial";
}

/** Input for {@link compareWorkspaceToManifest}. */
export interface WorkspaceCompareInput {
	rootPath: string;
	contentStore: WorkspaceContentStore;
	previousManifest: WorkspaceManifest;
	gitRepositories?: GitRepositorySnapshot[];
}

/** One entry as captured vs as recorded in the previous manifest. */
export interface WorkspaceEntryChange {
	path: string;
	previous: WorkspaceManifestEntry;
	current: WorkspaceManifestEntry;
}

/** Diff result between a current scan and a prior manifest snapshot. */
export interface WorkspaceCompareResult {
	current: WorkspaceScanResult;
	previous: WorkspaceManifest;
	added: WorkspaceManifestEntry[];
	removed: WorkspaceManifestEntry[];
	changed: WorkspaceEntryChange[];
	unchanged: WorkspaceManifestEntry[];
	completeness: "complete" | "partial";
}

/** Reproducible dependency/build trees never captured as workspace state. */
const GENERATED_DIRECTORY_BASENAMES: Record<string, true> = { node_modules: true, target: true };
/** Default mode bits when lstat fails (matches POSIX 0755). */
const DIRECTORY_DEFAULT_MODE = 0o755;

export type WorkspaceScanErrorCode = "invalid_root" | "missing_root" | "not_directory" | "io";

export class WorkspaceScanError extends Error {
	readonly code: WorkspaceScanErrorCode;
	constructor(message: string, code: WorkspaceScanErrorCode, cause?: unknown) {
		super(message);
		this.name = "WorkspaceScanError";
		this.code = code;
		if (cause !== undefined) this.cause = cause;
	}
}

/** Subset of `Stats` we keep on each entry. */
export interface NodeStat {
	mode: number;
	mtimeMs: number;
	size: number;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

/** Capture a {@link WorkspaceScanResult} for `input.rootPath`. */
export async function scanWorkspace(input: WorkspaceScanInput): Promise<WorkspaceScanResult> {
	const rootPath = await resolveRoot(input.rootPath);
	const includePaths = normalizeWorkspacePaths(rootPath, input.includePaths);
	const ctx = createWalkContext(rootPath, input.contentStore, input.persistFileContents ?? true);
	let gitPlan: GitScanPlan | null = null;
	try {
		gitPlan = await buildGitScanPlan(rootPath, includePaths);
		if (gitPlan) {
			await captureSelectedPaths(ctx, gitPlan.selectedPaths);
		} else {
			await walkDirectory(ctx, rootPath, true);
		}
	} catch (err) {
		if (err instanceof WorkspaceScanError) throw err;
		throw new WorkspaceScanError(`Workspace scan failed for "${rootPath}": ${(err as Error).message}`, "io", err);
	}
	return finishWorkspaceScan(
		ctx,
		input.gitRepositories,
		gitPlan?.trackedIgnoredPaths ?? includePaths,
		gitPlan !== null,
	);
}

/**
 * Capture only caller-selected workspace paths and their ancestors. This
 * deliberately bypasses Git discovery; missing paths are tombstones, not I/O
 * failures, and remain in `trackedIgnoredPaths` for a later live scan.
 */
export async function scanWorkspacePaths(input: WorkspacePathScanInput): Promise<WorkspaceScanResult> {
	const rootPath = await resolveRoot(input.rootPath);
	const paths = normalizeWorkspacePaths(rootPath, input.paths);
	const ctx = createWalkContext(rootPath, input.contentStore, input.persistFileContents ?? true);
	try {
		await captureSelectedPaths(ctx, paths);
	} catch (err) {
		if (err instanceof WorkspaceScanError) throw err;
		throw new WorkspaceScanError(
			`Workspace path scan failed for "${rootPath}": ${(err as Error).message}`,
			"io",
			err,
		);
	}
	return finishWorkspaceScan(ctx, input.gitRepositories, paths, false);
}

/**
 * Re-scan a workspace and diff against `input.previousManifest` to produce a
 * per-path mutation set suitable for a restore planner.
 */
export async function compareWorkspaceToManifest(input: WorkspaceCompareInput): Promise<WorkspaceCompareResult> {
	const includePaths = input.previousManifest.respectsGitIgnore
		? (input.previousManifest.trackedIgnoredPaths ?? [])
		: input.previousManifest.entries.filter(entry => entry.path !== "").map(entry => entry.path);
	const current = await scanWorkspace({
		rootPath: input.rootPath,
		contentStore: input.contentStore,
		persistFileContents: false,
		gitRepositories: input.gitRepositories,
		includePaths,
	});
	const prevByPath = new Map<string, WorkspaceManifestEntry>();
	for (const entry of input.previousManifest.entries) prevByPath.set(entry.path, entry);
	const currByPath = new Map<string, WorkspaceManifestEntry>();
	for (const entry of current.entries) currByPath.set(entry.path, entry);

	const added: WorkspaceManifestEntry[] = [];
	const changed: WorkspaceEntryChange[] = [];
	const unchanged: WorkspaceManifestEntry[] = [];

	for (const [relPath, currentEntry] of currByPath) {
		const prev = prevByPath.get(relPath);
		if (!prev) {
			added.push(currentEntry);
			continue;
		}
		if (entryFingerprint(prev) === entryFingerprint(currentEntry)) {
			unchanged.push(currentEntry);
			continue;
		}
		changed.push({ path: relPath, previous: prev, current: currentEntry });
	}

	const removed: WorkspaceManifestEntry[] = [];
	for (const [relPath, prev] of prevByPath) {
		if (!currByPath.has(relPath)) removed.push(prev);
	}

	added.sort(compareEntries);
	removed.sort(compareEntries);
	changed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	unchanged.sort(compareEntries);

	return {
		current,
		previous: input.previousManifest,
		added,
		removed,
		changed,
		unchanged,
		completeness: current.completeness,
	};
}

/**
 * Stable workspace id for `rootPath`. Derived from the *physical* root
 * (resolved path + sha256 of that path string), not from the manifest
 * contents — a recap of the same workspace must produce the same id even
 * when zero files are captured.
 */
export function getStableWorkspaceId(rootPath: string): string {
	const resolved = path.resolve(rootPath);
	const digest = new Bun.CryptoHasher("sha256").update(resolved).digest("hex");
	return `ws:${digest}`;
}

/** Structural fingerprint of a manifest entry — mode, mtime, size, content id, link target. */
export function entryFingerprint(entry: WorkspaceManifestEntry): string {
	const link = entry.linkTarget ? `|link=${entry.linkTarget}` : "";
	const obj = entry.objectId ? `|obj=${entry.objectId}` : "";
	return `${entry.kind}|${entry.mode.toString(8)}|${entry.size}|${entry.mtimeMs.toFixed(3)}${obj}${link}`;
}

interface WalkContext {
	readonly rootPath: string;
	readonly store: WorkspaceContentStore;
	readonly persistFileContents: boolean;
	readonly entries: WorkspaceManifestEntry[];
	readonly entryPaths: Set<string>;
	readonly exclusions: WorkspaceCheckpointExclusion[];
	readonly exclusionKeys: Set<string>;
	hadError: boolean;
}

function createWalkContext(rootPath: string, store: WorkspaceContentStore, persistFileContents: boolean): WalkContext {
	return {
		rootPath,
		store,
		persistFileContents,
		entries: [],
		entryPaths: new Set<string>(),
		exclusions: [],
		exclusionKeys: new Set<string>(),
		hadError: false,
	};
}

function finishWorkspaceScan(
	ctx: WalkContext,
	gitRepositories: GitRepositorySnapshot[] | undefined,
	trackedIgnoredPaths: readonly string[],
	respectsGitIgnore: boolean,
): WorkspaceScanResult {
	const entries = ctx.entries.slice().sort(compareEntries);
	const fileCount = entries.reduce((count, entry) => count + (entry.kind === "file" ? 1 : 0), 0);
	const totalBytes = entries.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.size : 0), 0);
	return {
		rootPath: ctx.rootPath,
		workspaceId: getStableWorkspaceId(ctx.rootPath),
		entries,
		exclusions: ctx.exclusions,
		gitRepositories: (gitRepositories ?? []).slice(),
		trackedIgnoredPaths: trackedIgnoredPaths.slice(),
		respectsGitIgnore,
		fileCount,
		totalBytes,
		completeness: ctx.hadError ? "partial" : "complete",
	};
}

interface GitScanPlan {
	readonly selectedPaths: readonly string[];
	readonly trackedIgnoredPaths: readonly string[];
}

interface GitWorktreePaths {
	readonly paths: readonly string[];
	readonly trackedIgnoredPaths: readonly string[];
}

interface WorkspacePathGuard {
	readonly path: string;
	readonly reason: string;
}

/** Normalize caller-provided workspace-relative paths without requiring them to exist. */
function normalizeWorkspacePaths(rootPath: string, candidates: readonly string[] | undefined): string[] {
	const normalized = new Set<string>();
	for (const candidate of candidates ?? []) {
		if (typeof candidate !== "string" || candidate.length === 0) {
			throw new WorkspaceScanError("Workspace include paths must be non-empty strings", "invalid_root");
		}
		const relativePath = toRelativePosix(rootPath, resolveWorkspacePath(rootPath, candidate));
		if (relativePath === "") {
			throw new WorkspaceScanError("Workspace include paths cannot name the workspace root", "invalid_root");
		}
		normalized.add(relativePath);
	}
	return [...normalized].sort();
}

async function buildGitScanPlan(rootPath: string, includePaths: readonly string[]): Promise<GitScanPlan | null> {
	const rootRepository = await git.repo.resolve(rootPath);
	if (!rootRepository) return null;
	if (!git.isGitAvailable()) {
		throw new WorkspaceScanError("Git is required to scan a Git workspace", "io");
	}
	if (!(await git.repo.isWorktree(rootPath))) return null;

	const nestedWorktrees = await discoverNestedGitWorktrees(rootPath);
	const worktreePaths = await Promise.all(
		[rootPath, ...nestedWorktrees].map(worktreePath => collectGitWorktreePaths(rootPath, worktreePath)),
	);
	const selectedPaths = new Set<string>(includePaths);
	const trackedIgnoredPaths = new Set<string>(includePaths);
	for (const worktree of worktreePaths) {
		for (const relativePath of worktree.paths) selectedPaths.add(relativePath);
		for (const relativePath of worktree.trackedIgnoredPaths) trackedIgnoredPaths.add(relativePath);
	}
	return {
		selectedPaths: [...selectedPaths].sort(),
		trackedIgnoredPaths: [...trackedIgnoredPaths].sort(),
	};
}

async function discoverNestedGitWorktrees(rootPath: string): Promise<string[]> {
	const worktreeRoots = new Set<string>();
	async function walkForWorktrees(absoluteDir: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(absoluteDir, { withFileTypes: true });
		} catch {
			// Discovery does not capture this directory. Selected paths still report
			// their own I/O failures when the capture phase reaches them.
			return;
		}
		for (const entry of entries) {
			if (entry.name === "" || entry.name === "." || entry.name === "..") continue;
			const entryPath = path.join(absoluteDir, entry.name);
			if (entry.name === ".git") {
				if (absoluteDir === rootPath) continue;
				const repository = await git.repo.resolve(absoluteDir);
				if (repository?.repoRoot === absoluteDir && (await git.repo.isWorktree(absoluteDir))) {
					worktreeRoots.add(absoluteDir);
				}
				continue;
			}
			if (!entry.isDirectory() || GENERATED_DIRECTORY_BASENAMES[entry.name]) continue;
			await walkForWorktrees(entryPath);
		}
	}
	await walkForWorktrees(rootPath);
	return [...worktreeRoots].sort();
}

async function collectGitWorktreePaths(rootPath: string, worktreePath: string): Promise<GitWorktreePaths> {
	const [tracked, untracked, trackedIgnored] = await Promise.all([
		git.ls.files(worktreePath),
		git.ls.untracked(worktreePath),
		git.ls.files(worktreePath, { ignored: true, excludeStandard: true }),
	]);
	const paths = new Set<string>();
	const trackedIgnoredPaths = new Set<string>();
	for (const candidate of tracked) {
		paths.add(toWorkspaceGitPath(rootPath, worktreePath, candidate));
	}
	for (const candidate of untracked) {
		paths.add(toWorkspaceGitPath(rootPath, worktreePath, candidate));
	}
	for (const candidate of trackedIgnored) {
		trackedIgnoredPaths.add(toWorkspaceGitPath(rootPath, worktreePath, candidate));
	}
	return {
		paths: [...paths].sort(),
		trackedIgnoredPaths: [...trackedIgnoredPaths].sort(),
	};
}

function toWorkspaceGitPath(rootPath: string, worktreePath: string, candidate: string): string {
	return toRelativePosix(rootPath, resolveWorkspacePath(worktreePath, candidate));
}

function workspacePathGuard(relativePath: string): WorkspacePathGuard | null {
	let currentPath = "";
	for (const segment of relativePath.split("/")) {
		currentPath = currentPath ? `${currentPath}/${segment}` : segment;
		if (segment === ".git") {
			return { path: currentPath, reason: "git administrative entry" };
		}
		if (GENERATED_DIRECTORY_BASENAMES[segment]) {
			return { path: currentPath, reason: "generated dependency/build directory" };
		}
	}
	return null;
}

async function captureSelectedPaths(ctx: WalkContext, selectedPaths: readonly string[]): Promise<void> {
	const rootStat = await safeLstat(ctx.rootPath);
	if (!rootStat?.isDirectory()) {
		recordExclusion(ctx, "", "workspace root disappeared during scan");
		ctx.hadError = true;
		return;
	}
	recordDirectoryEntry(ctx, "", rootStat);
	for (const relativePath of selectedPaths) {
		await captureSelectedPath(ctx, relativePath);
	}
}

async function captureSelectedPath(ctx: WalkContext, relativePath: string): Promise<void> {
	const guard = workspacePathGuard(relativePath);
	if (guard) {
		recordExclusion(ctx, guard.path, guard.reason);
		return;
	}
	const segments = relativePath.split("/");
	let absolutePath = ctx.rootPath;
	for (const [index, segment] of segments.entries()) {
		absolutePath = path.join(absolutePath, segment);
		const currentRelativePath = segments.slice(0, index + 1).join("/");
		const stat = await safeLstat(absolutePath);
		if (!stat) return;
		if (index < segments.length - 1) {
			if (stat.isDirectory()) {
				recordDirectoryEntry(ctx, currentRelativePath, stat);
				continue;
			}
			if (stat.isSymbolicLink()) {
				await captureSymlink(ctx, absolutePath, currentRelativePath);
				return;
			}
			if (stat.isFile()) {
				await captureFile(ctx, absolutePath, currentRelativePath);
				return;
			}
			recordExclusion(ctx, currentRelativePath, "not a directory");
			ctx.hadError = true;
			return;
		}
		if (stat.isDirectory()) {
			recordDirectoryEntry(ctx, currentRelativePath, stat);
			return;
		}
		if (stat.isFile()) {
			await captureFile(ctx, absolutePath, currentRelativePath);
			return;
		}
		if (stat.isSymbolicLink()) {
			await captureSymlink(ctx, absolutePath, currentRelativePath);
			return;
		}
		recordExclusion(ctx, currentRelativePath, "unsupported node type");
		ctx.hadError = true;
		return;
	}
}

function recordDirectoryEntry(ctx: WalkContext, relativePath: string, stat: NodeStat | null): void {
	recordEntry(ctx, {
		path: relativePath,
		kind: "directory",
		mode: stat?.mode ?? DIRECTORY_DEFAULT_MODE,
		mtimeMs: stat?.mtimeMs ?? 0,
		size: 0,
	});
}

function recordEntry(ctx: WalkContext, entry: WorkspaceManifestEntry): void {
	if (ctx.entryPaths.has(entry.path)) return;
	ctx.entryPaths.add(entry.path);
	ctx.entries.push(entry);
}

async function walkDirectory(ctx: WalkContext, absoluteDir: string, isRoot: boolean): Promise<void> {
	if (!isRoot && !pathIsWithin(ctx.rootPath, absoluteDir)) {
		// Defensive: anything outside means escape. Should never trigger
		// because we only descend into `<root>/<child>` paths.
		recordExclusion(ctx, absoluteDir, "outside workspace root");
		return;
	}
	let dirent: Dirent[];
	try {
		dirent = await fs.readdir(absoluteDir, { withFileTypes: true });
	} catch (err) {
		recordExclusion(ctx, absoluteDir, describeFsError(err));
		ctx.hadError = true;
		return;
	}
	const absStat = await safeLstat(absoluteDir);
	const relativeRoot = isRoot ? "" : toRelativePosix(ctx.rootPath, absoluteDir);
	recordDirectoryEntry(ctx, relativeRoot, absStat);

	for (const entry of dirent) {
		if (entry.name === "" || entry.name === "." || entry.name === "..") continue;
		const entryAbs = path.join(absoluteDir, entry.name);
		const entryRel = toRelativePosix(ctx.rootPath, entryAbs);
		if (entry.name === ".git" && (entry.isDirectory() || entry.isFile() || entry.isSymbolicLink())) {
			// A normal repository uses a directory; submodules and linked worktrees
			// use a file. Neither belongs to the restorable workspace tree.
			recordExclusion(ctx, entryRel, "git administrative entry");
			continue;
		}
		if (entry.isDirectory() && GENERATED_DIRECTORY_BASENAMES[entry.name]) {
			recordExclusion(ctx, entryRel, "generated dependency/build directory");
			continue;
		}
		if (entry.isDirectory()) {
			await walkDirectory(ctx, entryAbs, false);
			continue;
		}
		if (entry.isFile()) {
			await captureFile(ctx, entryAbs, entryRel);
			continue;
		}
		if (entry.isSymbolicLink()) {
			await captureSymlink(ctx, entryAbs, entryRel);
			continue;
		}
		// Block/character/socket/fifo: surface an exclusion so the manifest
		// is honest about what could not be captured.
		recordExclusion(ctx, entryRel, "unsupported node type");
		ctx.hadError = true;
	}
}

async function captureFile(ctx: WalkContext, absPath: string, relPath: string): Promise<void> {
	if (ctx.entryPaths.has(relPath)) return;
	const stat = await safeLstat(absPath);
	if (!stat) {
		recordExclusion(ctx, relPath, "stat failed");
		ctx.hadError = true;
		return;
	}
	if (stat.isSymbolicLink()) {
		// Race: readdir said file but lstat says symlink. Treat as symlink
		// for honesty; the manifest entry covers symlinks explicitly.
		await captureSymlink(ctx, absPath, relPath);
		return;
	}
	if (!stat.isFile()) {
		recordExclusion(ctx, relPath, "not a regular file");
		ctx.hadError = true;
		return;
	}
	let put: { id: string; bytes: number } | null;
	try {
		put = ctx.persistFileContents ? await ctx.store.putFile(absPath) : await ctx.store.hashFile(absPath);
	} catch (err) {
		recordExclusion(ctx, relPath, `${ctx.persistFileContents ? "put" : "hash"} failed: ${describeFsError(err)}`);
		ctx.hadError = true;
		return;
	}
	if (!put) {
		recordExclusion(ctx, relPath, "file disappeared during scan");
		ctx.hadError = true;
		return;
	}
	if (put.bytes !== stat.size) {
		// Race: file changed after lstat. Surface the drift as an exclusion
		// so callers know the manifest mtime/size does not match the live
		// file.
		recordExclusion(ctx, relPath, `file size changed during scan (${stat.size} -> ${put.bytes})`);
	}
	recordEntry(ctx, {
		path: relPath,
		kind: "file",
		mode: stat.mode,
		mtimeMs: stat.mtimeMs,
		size: put.bytes,
		objectId: put.id,
	});
}

async function captureSymlink(ctx: WalkContext, absPath: string, relPath: string): Promise<void> {
	if (ctx.entryPaths.has(relPath)) return;
	const stat = await safeLstat(absPath);
	if (!stat) {
		recordExclusion(ctx, relPath, "lstat failed");
		ctx.hadError = true;
		return;
	}
	let target: string;
	try {
		target = await fs.readlink(absPath);
	} catch (err) {
		recordExclusion(ctx, relPath, `readlink failed: ${describeFsError(err)}`);
		ctx.hadError = true;
		return;
	}
	recordEntry(ctx, {
		path: relPath,
		kind: "symlink",
		mode: stat.mode,
		mtimeMs: stat.mtimeMs,
		size: target.length,
		linkTarget: target,
	});
}

async function safeLstat(absolutePath: string): Promise<NodeStat | null> {
	try {
		const stat = await fs.lstat(absolutePath);
		return {
			mode: stat.mode,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			isFile: () => stat.isFile(),
			isDirectory: () => stat.isDirectory(),
			isSymbolicLink: () => stat.isSymbolicLink(),
		};
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

function recordExclusion(ctx: WalkContext, relPath: string, reason: string): void {
	const key = `${relPath}\0${reason}`;
	if (ctx.exclusionKeys.has(key)) return;
	ctx.exclusionKeys.add(key);
	ctx.exclusions.push({ path: relPath, reason });
	if (relPath !== "") {
		logger.warn("workspace-scan exclusion", { path: relPath, reason });
	}
}

function describeFsError(err: unknown): string {
	if (err && typeof err === "object" && "code" in err) {
		const code = (err as { code?: unknown }).code;
		if (typeof code === "string") return code;
	}
	if (err instanceof Error) return err.message;
	return String(err);
}

function toPosix(sep: string, value: string): string {
	return sep === "/" ? value : value.split(sep).join("/");
}

/**
 * Convert an absolute path under `rootPath` to a slash-normalised relative
 * path. Refuses to resolve `..` segments that would escape the root, and
 * treats the root itself as the empty path.
 */
export function toWorkspaceRelativePath(rootPath: string, absolutePath: string): string {
	const resolvedRoot = path.resolve(rootPath);
	const resolved = path.resolve(absolutePath);
	const rel = path.relative(resolvedRoot, resolved);
	if (rel === "" || rel === ".") return "";
	const normalised = path.normalize(rel);
	if (normalised === "" || normalised === ".") return "";
	const slashed = toPosix(path.sep, normalised);
	if (normalised === ".." || normalised.startsWith(`..${path.sep}`) || path.isAbsolute(normalised)) {
		throw new WorkspaceScanError(`Path "${absolutePath}" escapes workspace root "${rootPath}"`, "invalid_root");
	}
	return slashed;
}

function toRelativePosix(rootPath: string, absolutePath: string): string {
	return toWorkspaceRelativePath(rootPath, absolutePath);
}

function compareEntries(a: WorkspaceManifestEntry, b: WorkspaceManifestEntry): number {
	if (a.kind !== b.kind) {
		return kindRank(a.kind) - kindRank(b.kind);
	}
	if (a.path === b.path) return 0;
	return a.path < b.path ? -1 : 1;
}

/** Return a deterministic copy suitable for persisted manifest updates. */
export function sortWorkspaceEntries(entries: readonly WorkspaceManifestEntry[]): WorkspaceManifestEntry[] {
	return [...entries].sort(compareEntries);
}

function kindRank(kind: WorkspaceNodeKind): number {
	switch (kind) {
		case "directory":
			return 0;
		case "file":
			return 1;
		case "symlink":
			return 2;
	}
}

/**
 * Resolve `candidate` relative to `rootPath` if it is not already absolute,
 * and refuse any path that would escape the workspace root.
 */
export function resolveWorkspacePath(rootPath: string, candidate: string): string {
	if (!candidate) {
		throw new WorkspaceScanError(`Cannot resolve empty path against workspace root "${rootPath}"`, "invalid_root");
	}
	const resolvedRoot = path.resolve(rootPath);
	const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(resolvedRoot, candidate);
	const relative = path.relative(resolvedRoot, resolved);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new WorkspaceScanError(`Path "${candidate}" escapes workspace root "${rootPath}"`, "invalid_root");
	}
	return resolved;
}

async function resolveRoot(rootPath: string): Promise<string> {
	if (typeof rootPath !== "string" || rootPath.length === 0) {
		throw new WorkspaceScanError("Workspace root is required", "invalid_root");
	}
	const resolved = path.resolve(rootPath);
	let stat: Stats | null = null;
	try {
		stat = await fs.lstat(resolved);
	} catch (err) {
		if (isEnoent(err)) {
			throw new WorkspaceScanError(`Workspace root "${resolved}" does not exist`, "missing_root", err);
		}
		throw new WorkspaceScanError(`Failed to stat workspace root "${resolved}": ${(err as Error).message}`, "io", err);
	}
	if (stat.isSymbolicLink()) {
		throw new WorkspaceScanError(
			`Workspace root "${resolved}" is a symlink; refusing to walk through it`,
			"invalid_root",
		);
	}
	if (!stat.isDirectory()) {
		throw new WorkspaceScanError(`Workspace root "${resolved}" is not a directory`, "not_directory");
	}
	return resolved;
}

/** Convert a scan result into a {@link WorkspaceManifest} the service can persist. */
export function manifestFromScan(
	scan: WorkspaceScanResult,
	options: { workspaceId?: string; gitRepositories?: GitRepositorySnapshot[] } = {},
): WorkspaceManifest {
	const workspaceId = options.workspaceId ?? scan.workspaceId;
	const gitRepositories = options.gitRepositories ?? scan.gitRepositories;
	return {
		version: 1,
		workspaceId,
		rootPath: scan.rootPath,
		entries: scan.entries.slice(),
		gitRepositories: gitRepositories.slice(),
		exclusions: scan.exclusions.slice(),
		trackedIgnoredPaths: normalizeWorkspacePaths(scan.rootPath, scan.trackedIgnoredPaths ?? []),
		respectsGitIgnore: scan.respectsGitIgnore ?? false,
	};
}

/** Re-exported index-snapshot type for callers wiring Git data. */
export type CapturedIndexSnapshot = GitIndexSnapshot;

/** Verify a relative path is contained by the workspace root. */
export function isWorkspacePath(rootPath: string, relPath: string): boolean {
	if (!relPath) return true;
	const resolvedRoot = path.resolve(rootPath);
	const candidate = path.isAbsolute(relPath) ? path.resolve(relPath) : path.resolve(resolvedRoot, relPath);
	const relative = path.relative(resolvedRoot, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
