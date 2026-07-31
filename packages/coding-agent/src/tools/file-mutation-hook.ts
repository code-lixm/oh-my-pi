/**
 * Shared `ToolSession.onFileMutation` adapter.
 *
 * Write/edit tools land their real source-file persistence in only a handful of
 * modules. To keep the LSP writethrough / FS cache / deferred-diagnostics
 * pipeline orthogonal to downstream consumers, every successful persistence
 * calls `notifyFileMutation` with the canonical absolute path of the file *as
 * it exists after the operation*, plus the operation kind and (for renames)
 * the previous path.
 *
 * Before persistence, callers await `prepareFileMutation`; it runs the optional
 * `beforeFileMutation` observer against the same event and propagates failure
 * so no underlying file mutation starts.
 *
 * The post-success hook fires ONLY after the underlying `await` for `fs.writeFile`,
 * `Bun.write`, `fs.rename`, `fs.rm`, or `fs.unlink` (and the ACP-bridged
 * equivalent) has resolved without throwing — failed or aborted writes never
 * emit. `DeferredDiagnostics.begin` and `bumpFileMutationVersion` are NOT
 * reliable persistence signals: they run *before* the writethrough awaits and
 * a downstream abort or post-write failure can still leave the bytes on the
 * previous state. The hook also deliberately skips the working-tree vs.
 * session-local artifact distinction — the contract document treats both as
 * source files. Internal archive rewrites (zip/tar member writes) and SQLite
 * member writes must NEVER be reported: those are not source files.
 *
 * ## Single ownership
 *
 * `onFileMutation` and `pendingFileMutations` cannot BOTH observe the same
 * event — exactly-once is the contract. When the callback is installed the
 * helper invokes it directly and skips the buffer; when the callback is
 * missing the helper parks the event in the buffer so a future runtime can
 * drain it. Mixing the two would cause a downstream drain to re-sync paths
 * the callback already saw.
 *
 * ## Sandboxing / archive / SQLite gating
 *
 * Each persistence site awaits `prepareFileMutation` immediately before its
 * underlying write / rm / rename, then invokes `notifyFileMutation` after a
 * successful await. The helpers own three gates that all persistence sites would
 * otherwise have to remember independently:
 *   1. Source-file filter (rejects `.zip`, `.tar`, `.sqlite`, …).
 *   2. Session-local sandbox (plan-mode writes `local://PLAN.md` etc.; those
 *      are session-owned, not source files, and CodeGraph does not index
 *      them.
 *   3. Canonicalization through `canonicalSnapshotKey` so callers do not
 *      have to realpath individually.
 */
import * as path from "node:path";
import { canonicalSnapshotKey } from "../edit/file-snapshot-store";
import type { ToolSession } from "./";
import { invalidateCodeGraphCoverage } from "./codegraph-coverage-ledger";
import { localSandboxRoot } from "./plan-mode-guard";

export type FileMutationKind = "create" | "update" | "delete" | "rename";

export interface FileMutationEvent {
	/** Absolute canonical path of the file *after* the operation. */
	path: string;
	kind: FileMutationKind;
	/** Required when `kind === "rename"`; absolute path the file was at before. */
	previousPath?: string;
}

export interface FileMutationOptions {
	previousPath?: string;
}

const NON_SOURCE_EXTENSIONS: Record<string, true> = {
	".zip": true,
	".tar": true,
	".tar.gz": true,
	".tgz": true,
	".tar.bz2": true,
	".tbz2": true,
	".tar.xz": true,
	".txz": true,
	".gz": true,
	".bz2": true,
	".xz": true,
	".7z": true,
	".rar": true,
	".sqlite": true,
	".sqlite3": true,
	".db": true,
};

/**
 * Determine whether `absolutePath` is a *source* file for the purposes of
 * `onFileMutation`. Archives (zip/tar/tar.gz/gz) and SQLite databases are
 * internal storage formats that an edit/write tool may legitimately open or
 * rewrite but which do not represent source code. The hook MUST NOT fire for
 * these.
 */
export function isSourceFilePath(absolutePath: string): boolean {
	const head = absolutePath.split(":", 1)[0] ?? "";
	const base = path.basename(head);
	if (!base) return false;
	const lower = base.toLowerCase();
	if (NON_SOURCE_EXTENSIONS[lower] === true) return false;
	for (const ext of Object.keys(NON_SOURCE_EXTENSIONS)) {
		if (lower.endsWith(ext)) return false;
	}
	return true;
}

/**
 * Per-session collector for events emitted before CodeGraph runs. The next
 * `CodeGraphTool` invocation drains the collector and scopes incremental sync
 * to the changed paths. See the file-level doc for the single-ownership rule.
 */
export interface PendingFileMutationCollector {
	push(event: FileMutationEvent): void;
	drain(): FileMutationEvent[];
	peek(): readonly FileMutationEvent[];
	clear(): void;
}

export interface FileMutationCollectorHost {
	pendingFileMutations?: PendingFileMutationCollector;
}

function newCollector(): PendingFileMutationCollector {
	const events: FileMutationEvent[] = [];
	const seenLatest = new Map<string, FileMutationEvent>();
	return {
		push(event) {
			const key = canonicalSnapshotKey(event.path);
			const previous = seenLatest.get(key);
			if (previous) {
				const merged = mergeEvents(previous, event);
				seenLatest.set(key, merged);
				const index = events.lastIndexOf(previous);
				if (index >= 0) events[index] = merged;
				else events.push(merged);
				return;
			}
			seenLatest.set(key, event);
			events.push(event);
		},
		drain() {
			const snapshot = dedupeConsecutive([...events]);
			events.length = 0;
			seenLatest.clear();
			return snapshot;
		},
		peek() {
			return dedupeConsecutive([...events]);
		},
		clear() {
			events.length = 0;
			seenLatest.clear();
		},
	};
}

function getCollector(session: FileMutationCollectorHost): PendingFileMutationCollector | undefined {
	if (!session.pendingFileMutations) {
		session.pendingFileMutations = newCollector();
	}
	return session.pendingFileMutations;
}

/**
 * Collapse two back-to-back events on the same path into one. Rules:
 * - a `delete` followed by a re-`create`/`update` -> supersede with the new
 *   event (the file came back; the delete is moot).
 * - a `create` followed by an `update` -> merge into the `update`.
 * - a `rename` followed by an `update` -> merge into the new `update`.
 * - any same-kind pair -> take the newer event.
 */
function mergeEvents(previous: FileMutationEvent, next: FileMutationEvent): FileMutationEvent {
	if (previous.kind === "delete" && next.kind !== "delete") return next;
	if (previous.kind === "rename" && next.kind === "update") return next;
	if (previous.kind === "create" && (next.kind === "update" || next.kind === "create")) return next;
	if (previous.kind === "update" && (next.kind === "update" || next.kind === "create")) return next;
	if (next.kind === "delete" && previous.kind !== "delete") return next;
	if (next.kind === "rename") return next;
	return next;
}

function dedupeConsecutive(events: FileMutationEvent[]): FileMutationEvent[] {
	const out: FileMutationEvent[] = [];
	for (const event of events) {
		const last = out[out.length - 1];
		if (last && canonicalSnapshotKey(last.path) === canonicalSnapshotKey(event.path)) {
			out[out.length - 1] = mergeEvents(last, event);
		} else {
			out.push(event);
		}
	}
	return out;
}

/**
 * Compute the absolute sandbox root for `session`, or `undefined` if no
 * sandbox is configured. Sessions without a sandbox (CLI read mode, ad-hoc
 * test harness, …) let every source-file mutation through.
 */
function sandboxRoot(session: ToolSession): string | undefined {
	const root = localSandboxRoot(session);
	return root ?? undefined;
}

function pathInsideSandbox(session: ToolSession, absolutePath: string): boolean {
	const root = sandboxRoot(session);
	if (!root) return false;
	const canonical = canonicalSnapshotKey(absolutePath);
	const canonicalRoot = canonicalSnapshotKey(root);
	if (canonical === canonicalRoot) return true;
	return canonical.startsWith(`${canonicalRoot}${path.sep}`);
}

/**
 * Build a fully-gated mutation event. Returns `undefined` when the path is
 * neither a source file nor within the session sandbox, or when `kind ===
 * "rename"` lacks `previousPath`. The single gate lives here so callers do
 * not have to remember it per site.
 */
export function buildFileMutationEvent(
	session: ToolSession,
	absolutePath: string,
	kind: FileMutationKind,
	options: FileMutationOptions = {},
): FileMutationEvent | undefined {
	const isSandbox = pathInsideSandbox(session, absolutePath);
	if (!isSandbox && !isSourceFilePath(absolutePath)) return undefined;
	if (kind === "rename") {
		if (options.previousPath === undefined) return undefined;
		return {
			path: canonicalSnapshotKey(absolutePath),
			kind,
			previousPath: canonicalSnapshotKey(options.previousPath),
		};
	}
	return { path: canonicalSnapshotKey(absolutePath), kind };
}

/**
 * Run the optional pre-mutation observer for a path that is about to be
 * persisted. It shares {@link buildFileMutationEvent}'s source-file and
 * sandbox gates, and deliberately lets observer failures propagate so the
 * caller never starts the underlying mutation.
 */
export async function prepareFileMutation(
	session: ToolSession,
	absolutePath: string,
	kind: FileMutationKind,
	options: FileMutationOptions = {},
): Promise<void> {
	const event = buildFileMutationEvent(session, absolutePath, kind, options);
	if (!event || !session.beforeFileMutation) return;
	await session.beforeFileMutation(event);
}

/**
 * Emit a mutation event with single-ownership semantics:
 * - When `session.onFileMutation` is set, invoke it directly. Do NOT buffer.
 * - When it is missing, park the event in the session's pending collector so
 *   a future runtime can drain it.
 *
 * Either way, the gate in {@link buildFileMutationEvent} decides whether the
 * path qualifies as a source file (or a session sandbox file) at all; paths
 * it rejects never reach the callback or the buffer.
 *
 * Callers MUST only invoke this AFTER the persistence `await` has resolved.
 * Failed writes do not throw here — they return `false` so callers can log
 * or branch, but the more useful signal is "do not emit if the write threw".
 */
export function notifyFileMutation(
	session: ToolSession,
	absolutePath: string,
	kind: FileMutationKind,
	options: FileMutationOptions = {},
): boolean {
	const event = buildFileMutationEvent(session, absolutePath, kind, options);
	if (!event) return false;
	invalidateCodeGraphCoverage(session, [event.previousPath, event.path]);
	if (session.onFileMutation) {
		try {
			session.onFileMutation(event);
		} catch {
			// The downstream consumer owns its own error policy. The event
			// has been observed exactly once; intentionally NOT also parked
			// in the buffer to preserve the single-ownership contract.
		}
		return true;
	}
	getCollector(session)?.push(event);
	return true;
}

/**
 * Convenience for a single create event. Returns `true` when the event was
 * delivered to a callback or parked in the pending collector, `false` when
 * the path was filtered out.
 */
export function notifyFileCreated(session: ToolSession, absolutePath: string): boolean {
	return notifyFileMutation(session, absolutePath, "create");
}

/**
 * Convenience for a single update event.
 */
export function notifyFileUpdated(session: ToolSession, absolutePath: string): boolean {
	return notifyFileMutation(session, absolutePath, "update");
}

/**
 * Convenience for a single delete event.
 */
export function notifyFileDeleted(session: ToolSession, absolutePath: string): boolean {
	return notifyFileMutation(session, absolutePath, "delete");
}

/**
 * Convenience for a rename event. `previousPath` is required.
 */
export function notifyFileRenamed(session: ToolSession, previousPath: string, nextPath: string): boolean {
	return notifyFileMutation(session, nextPath, "rename", { previousPath });
}

/**
 * Drain and return the session's pending mutation events, clearing the
 * buffer. Returns an empty array when the session has not collected anything
 * yet.
 */
export function drainPendingFileMutations(session: FileMutationCollectorHost): FileMutationEvent[] {
	const collector = session.pendingFileMutations;
	if (!collector) return [];
	return collector.drain();
}

/**
 * Return the currently-buffered pending mutation events without clearing
 * them. Useful for inspection in diagnostics or tests.
 */
export function peekPendingFileMutations(session: FileMutationCollectorHost): readonly FileMutationEvent[] {
	const collector = session.pendingFileMutations;
	if (!collector) return [];
	return collector.peek();
}

/**
 * Clear the session's pending mutation events.
 */
export function clearPendingFileMutations(session: FileMutationCollectorHost): void {
	session.pendingFileMutations?.clear();
}
