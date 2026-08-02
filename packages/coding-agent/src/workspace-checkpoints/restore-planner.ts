/**
 * Restore planner: pure compute layer that turns a checkpoint manifest and a
 * live manifest into a {@link WorkspaceRestorePlan}.
 *
 * No I/O lives here — the planner only reads {@link WorkspaceManifestEntry}
 * records and emits deterministic operations/conflicts. The coordinator owns
 * filesystem access, the store, and the restore transaction; this module is
 * the single source of truth for what a restore WOULD do.
 */
import { pathIsWithin } from "@oh-my-pi/pi-utils";
import type {
	ApplyWorkspaceRestoreRequest,
	CreateWorkspaceCheckpointRequest,
	PreviewWorkspaceRestoreRequest,
	WorkspaceManifest,
	WorkspaceManifestEntry,
	WorkspaceRestoreConflict,
	WorkspaceRestoreOperation,
	WorkspaceRestorePlan,
} from "./types";

interface PlannerInput {
	checkpointId: string;
	rootPath: string;
	target: WorkspaceManifest;
	current: WorkspaceManifest | null;
	request: PreviewWorkspaceRestoreRequest;
}

interface PlannerOutput {
	operations: WorkspaceRestoreOperation[];
	conflicts: WorkspaceRestoreConflict[];
	missingObjects: readonly string[];
}

function buildEntryIndex(entries: readonly WorkspaceManifestEntry[]): Map<string, WorkspaceManifestEntry> {
	const index = new Map<string, WorkspaceManifestEntry>();
	for (const entry of entries) index.set(entry.path, entry);
	return index;
}

function* sortedEntries(
	index: Map<string, WorkspaceManifestEntry>,
): IterableIterator<[string, WorkspaceManifestEntry]> {
	const keys = [...index.keys()].sort();
	for (const key of keys) {
		const value = index.get(key);
		if (value) yield [key, value];
	}
}

function isPathSelected(p: string, paths: readonly string[] | undefined): boolean {
	if (!paths || paths.length === 0) return true;
	for (const candidate of paths) if (candidate === p || p.startsWith(`${candidate}/`)) return true;
	return false;
}

function isPathInsideRoot(rootPath: string, targetRootPath: string, p: string): boolean {
	if (pathIsWithin(rootPath, targetRootPath) || pathIsWithin(targetRootPath, rootPath)) return true;
	return !p.startsWith("/") && !p.includes("..");
}

function expectedFrom(entry: WorkspaceManifestEntry): {
	expectedKind: WorkspaceManifestEntry["kind"];
	expectedObjectId: string | null;
	expectedMode: number;
	expectedLinkTarget: string | null;
} {
	return {
		expectedKind: entry.kind,
		expectedObjectId: entry.objectId ?? null,
		expectedMode: entry.mode,
		expectedLinkTarget: entry.linkTarget ?? null,
	};
}

function planRestore(input: PlannerInput): PlannerOutput {
	const { target, current, request } = input;
	const operations: WorkspaceRestoreOperation[] = [];
	const conflicts: WorkspaceRestoreConflict[] = [];
	const missingObjects: string[] = [];

	if (request.scope === "conversation") {
		return { operations, conflicts, missingObjects };
	}

	const strategy = request.strategy;
	const targetIndex = buildEntryIndex(target.entries);
	const currentIndex = current ? buildEntryIndex(current.entries) : new Map<string, WorkspaceManifestEntry>();
	const filter = request.paths;

	for (const [path, targetEntry] of sortedEntries(targetIndex)) {
		if (!isPathSelected(path, filter)) continue;
		if (!isPathInsideRoot(input.rootPath, target.rootPath, path)) {
			conflicts.push({
				path,
				kind: "unsupported_node",
				message: `path "${path}" is outside the workspace root`,
			});
			continue;
		}
		const currentEntry = currentIndex.get(path);
		if (!currentEntry) {
			if (targetEntry.kind === "directory") continue;
			const op: WorkspaceRestoreOperation = {
				path: targetEntry.path,
				kind: "create",
				objectId: targetEntry.objectId,
				mode: targetEntry.mode,
				expectedKind: null,
			};
			if (targetEntry.kind === "symlink") op.linkTarget = targetEntry.linkTarget;
			operations.push(op);
			continue;
		}
		if (currentEntry.kind !== targetEntry.kind) {
			if (strategy === "preserve") {
				conflicts.push({
					path,
					kind: "path_type_changed",
					message: `type changed (${currentEntry.kind} → ${targetEntry.kind}); pass strategy:"exact" to overwrite`,
				});
				continue;
			}
			operations.push({ path, kind: "delete", ...expectedFrom(currentEntry) });
			const op: WorkspaceRestoreOperation = {
				path: targetEntry.path,
				kind: "create",
				objectId: targetEntry.objectId,
				mode: targetEntry.mode,
			};
			if (targetEntry.kind === "symlink") op.linkTarget = targetEntry.linkTarget;
			operations.push(op);
			continue;
		}
		if (targetEntry.kind === "directory") continue;
		if (targetEntry.kind === "symlink") {
			if (currentEntry.linkTarget !== targetEntry.linkTarget) {
				operations.push({
					path,
					kind: "symlink",
					linkTarget: targetEntry.linkTarget ?? "",
					...expectedFrom(currentEntry),
				});
			}
			continue;
		}
		if (currentEntry.objectId !== targetEntry.objectId) {
			operations.push({
				path: targetEntry.path,
				kind: "update",
				objectId: targetEntry.objectId,
				mode: targetEntry.mode,
				...expectedFrom(currentEntry),
			});
		}
		if (currentEntry.mode !== targetEntry.mode) {
			operations.push({
				path,
				kind: "chmod",
				mode: targetEntry.mode,
				...expectedFrom(currentEntry),
			});
		}
	}

	if (current) {
		for (const [path, currentEntry] of sortedEntries(currentIndex)) {
			if (!isPathSelected(path, filter)) continue;
			if (targetIndex.has(path)) continue;
			if (currentEntry.kind === "directory") continue;
			operations.push({ path, kind: "delete", ...expectedFrom(currentEntry) });
		}
	}

	for (const op of operations) {
		if ((op.kind === "create" || op.kind === "update") && op.objectId) missingObjects.push(op.objectId);
	}

	return { operations, conflicts, missingObjects };
}

export function computeRestorePlan(input: {
	checkpointId: string;
	rootPath: string;
	target: WorkspaceManifest;
	liveManifest: WorkspaceManifest | null;
	request: PreviewWorkspaceRestoreRequest;
}): WorkspaceRestorePlan {
	const { checkpointId, rootPath, target, liveManifest, request } = input;
	const { operations, conflicts } = planRestore({
		checkpointId,
		rootPath,
		target,
		current: liveManifest,
		request,
	});
	return {
		id: "",
		checkpointId,
		rootPath,
		scope: request.scope,
		strategy: request.strategy,
		operations,
		conflicts,
		conversationEntryId: null,
		createdAt: new Date().toISOString(),
	};
}

export function detectConflicts(input: {
	target: WorkspaceManifest;
	live: WorkspaceManifest | null;
}): readonly WorkspaceRestoreConflict[] {
	if (!input.live) return [];
	const conflicts: WorkspaceRestoreConflict[] = [];
	const targetIndex = buildEntryIndex(input.target.entries);
	const liveIndex = buildEntryIndex(input.live.entries);
	for (const [path, liveEntry] of sortedEntries(liveIndex)) {
		const targetEntry = targetIndex.get(path);
		if (!targetEntry) continue;
		if (liveEntry.kind !== targetEntry.kind) {
			conflicts.push({
				path,
				kind: "path_type_changed",
				message: `type changed (${liveEntry.kind} → ${targetEntry.kind})`,
			});
		}
	}
	return conflicts;
}

export function toApplyRequest(planId: string, allowConflicts = false): ApplyWorkspaceRestoreRequest {
	return { planId, allowConflicts };
}

export function previewCheckpointId(request: CreateWorkspaceCheckpointRequest): string {
	const stamp = Date.now().toString(36);
	const suffix = Bun.hash(`${request.rootPath}:${request.reason}:${stamp}`).toString(36);
	return `cp_${request.reason}_${suffix}`;
}
