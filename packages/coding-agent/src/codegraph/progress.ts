/**
 * Persistent `<indexDir>/progress.json` — the worker's public progress
 * surface. The supervisor reads this file on every cold tool call to decide
 * whether the slot is `ready` (proceed) or still `queued`/`indexing`
 * (return an indexing fallback). The file is written atomically; partial
 * writes can never confuse a cold reader into seeing `ready`.
 *
 * The worker also reads it on startup to detect an interrupted previous run
 * (state stays `indexing` / `queued` because the supervisor crashed or was
 * SIGKILLed). In that case it schedules a `forceRebuild` so a stale partial
 * DB never leaks out as `ready`.
 */
import * as path from "node:path";
import type { CodeGraphIndexLocation } from "./location";
import { readTextFileIfExists, writeTextFileAtomically } from "./location-fs";
import type { CodeGraphIndexState, CodeGraphProgress } from "./runtime-types";

export const PROGRESS_FILE_NAME = "progress.json";

function progressPath(location: CodeGraphIndexLocation): string {
	return path.join(location.indexDir, PROGRESS_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProgress(value: unknown): CodeGraphProgress | null {
	if (!isRecord(value)) return null;
	const state = value.state;
	if (state !== "queued" && state !== "indexing" && state !== "ready" && state !== "failed") return null;
	const phase = typeof value.phase === "string" ? value.phase : "";
	const current = typeof value.current === "number" && Number.isFinite(value.current) ? value.current : 0;
	const total = typeof value.total === "number" && Number.isFinite(value.total) ? value.total : 0;
	const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString();
	const workerId = typeof value.workerId === "string" ? value.workerId : "unknown";
	const attempt = typeof value.attempt === "number" && Number.isFinite(value.attempt) ? value.attempt : 1;
	const error = typeof value.error === "string" ? value.error : undefined;
	const forceRebuild = typeof value.forceRebuild === "boolean" ? value.forceRebuild : undefined;
	const out: CodeGraphProgress = {
		state,
		phase,
		current,
		total,
		updatedAt,
		workerId,
		attempt,
	};
	if (error !== undefined) out.error = error;
	if (forceRebuild !== undefined) out.forceRebuild = forceRebuild;
	return out;
}

/**
 * Read the current progress file. Returns `null` when the file is missing,
 * unparseable, or the slot directory doesn't exist yet. Caller treats a
 * non-null result with `state === "ready"` as "proceed".
 */
export async function readProgress(location: CodeGraphIndexLocation): Promise<CodeGraphProgress | null> {
	const raw = await readTextFileIfExists(progressPath(location));
	if (raw === null) return null;
	try {
		return normalizeProgress(JSON.parse(raw));
	} catch {
		return null;
	}
}

/**
 * Atomic write of `<indexDir>/progress.json`. The temp file lives in the
 * same directory, so `fs.rename` is atomic on the same filesystem. The
 * parent dir is `mkdir -p`'d first so callers don't need to ensure it.
 */
export async function writeProgress(location: CodeGraphIndexLocation, progress: CodeGraphProgress): Promise<void> {
	await writeTextFileAtomically(progressPath(location), `${JSON.stringify(progress, null, 2)}\n`);
}

/**
 * Detect an interrupted previous worker run. A non-`ready` progress file
 * whose `updatedAt` is older than the metadata file (or the slot's
 * `lastSyncedAt`) means the worker exited before it could mark the slot
 * ready. The supervisor / worker should force a rebuild so a partial DB
 * never leaks out as `ready`.
 */
export async function detectInterruptedProgress(
	location: CodeGraphIndexLocation,
): Promise<{ interrupted: boolean; previous: CodeGraphProgress | null }> {
	const previous = await readProgress(location);
	if (!previous) return { interrupted: false, previous: null };
	return {
		interrupted:
			previous.state === "queued" ||
			previous.state === "indexing" ||
			previous.state === "failed" ||
			previous.forceRebuild === true,
		previous,
	};
}

/**
 * Convenience: mark the slot `ready`. Used at the end of a successful
 * worker run and immediately after the supervisor observes the worker
 * closed cleanly.
 */
export async function markReady(location: CodeGraphIndexLocation, workerId: string, attempt: number): Promise<void> {
	await writeProgress(location, {
		state: "ready",
		phase: "ready",
		current: 0,
		total: 0,
		updatedAt: new Date().toISOString(),
		workerId,
		attempt,
	});
}

/**
 * Convenience: mark the slot `failed`. Failure leaves the index in a
 * rebuild-required state so the next worker run rebuilds from scratch.
 */
export async function markFailed(
	location: CodeGraphIndexLocation,
	workerId: string,
	attempt: number,
	error: string,
): Promise<void> {
	await writeProgress(location, {
		state: "failed",
		phase: "failed",
		current: 0,
		total: 0,
		updatedAt: new Date().toISOString(),
		workerId,
		attempt,
		error,
		forceRebuild: true,
	});
}

/** Convenience: write a `queued` marker so cold callers see an indexing fallback. */
export async function markQueued(location: CodeGraphIndexLocation, workerId: string, attempt: number): Promise<void> {
	await writeProgress(location, {
		state: "queued",
		phase: "queued",
		current: 0,
		total: 0,
		updatedAt: new Date().toISOString(),
		workerId,
		attempt,
	});
}

export function isReadyState(state: CodeGraphIndexState): boolean {
	return state === "ready";
}
