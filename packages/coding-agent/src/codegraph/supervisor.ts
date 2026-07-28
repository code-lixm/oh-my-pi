/**
 * In-process CodeGraph worker supervisor.
 *
 *   - Dedupe: one worker per `indexKey` (schema-2: same `sourceRoot +
 *     worktreeRoot + commonDir + normalized ref`). `Map<key, Handle>`.
 *   - Lifecycle: spawn the worker thread on first cold call for a key;
 *     subsequent cold calls share the same handle. When the worker closes
 *     (success or error) we drop the handle so the next cold call respawns.
 *   - Cold call contract: when the worker is active OR the slot's
 *     `progress.json` is not yet `ready`, callers receive an indexing
 *     fallback pointing at the persistent progress state — they never
 *     block on warm initialization.
 *   - `Worker.unref()`: the worker thread is `unref`ed so it doesn't keep
 *     an otherwise-idle agent process alive. The parent process exit
 *     reaps the worker automatically.
 *
 * The supervisor never owns the user's session lifetime. Workers are
 * disposable: spawn, hand off the request, exit. Long-running state lives
 * only in the slot's metadata + progress files.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import type { CodeGraphIndexLocation } from "./location";
import { resolveCodeGraphIndexLocation } from "./location";
import { isReadyState, readProgress } from "./progress";
import type { CodeGraphProgress } from "./runtime-types";
import type { CodeGraphWorkerInbound } from "./worker-protocol";
import { CODEGRAPH_WORKER_ARG, type CodeGraphWorkerOutbound, type CodeGraphWorkerRequest } from "./worker-protocol";

export interface SupervisorOptions {
	forceRebuild?: boolean;
}

export interface SupervisorProgressView {
	workerId: string;
	state: CodeGraphProgress["state"] | "unknown";
	phase: string;
	current: number;
	total: number;
	attempt: number;
}

export interface SupervisorResult {
	active: boolean;
	progress: SupervisorProgressView;
}

/** Schema-2 normalized key — supervisor's global slot identifier. */
function normalizedIdentityKey(identity: CodeGraphIndexLocation["identity"]): string {
	return identity.key;
}

interface CodeGraphWorkerHandle {
	readonly worker: Worker;
	readonly request: Promise<SupervisorResult>;
	readonly key: string;
	readonly progress: SupervisorProgressView;
}

const handles = new Map<string, CodeGraphWorkerHandle>();

/** Spawn-or-attach a worker for `location`. Idempotent. */
export function ensureWorker(location: CodeGraphIndexLocation, options: SupervisorOptions = {}): CodeGraphWorkerHandle {
	const key = normalizedIdentityKey(location.identity);
	const existing = handles.get(key);
	if (existing) return existing;

	const hostEntry = workerHostEntry();
	const worker = hostEntry
		? new Worker(hostEntry, { type: "module", argv: [CODEGRAPH_WORKER_ARG] })
		: new Worker(new URL("./worker-entry.ts", import.meta.url).href, { type: "module" });
	// `unref` keeps the agent process from waiting on an idle worker. The
	// worker thread exits naturally after a single request, so this only
	// matters in pathological cases where the worker is stuck — but the
	// contract is "Worker unref doesn't block exit", which we satisfy.
	worker.unref();

	const progress: SupervisorProgressView = {
		workerId: `sup-${Bun.randomUUIDv7().slice(0, 8)}`,
		state: "unknown",
		phase: "spawning",
		current: 0,
		total: 0,
		attempt: 1,
	};

	const handle: CodeGraphWorkerHandle = {
		worker,
		request: Promise.resolve({ active: true, progress }),
		key,
		progress,
	};
	handles.set(key, handle);
	wireMessages(handle);
	const message: CodeGraphWorkerRequest = {
		type: "index",
		id: progress.workerId,
		location,
		...(options.forceRebuild === true ? { forceRebuild: true } : {}),
	};
	worker.postMessage(message satisfies CodeGraphWorkerInbound);
	handleDropOnClose(key, worker);
	return handle;
}

function wireMessages(handle: CodeGraphWorkerHandle): void {
	handle.worker.addEventListener("message", (event: MessageEvent) => {
		const message = event.data as CodeGraphWorkerOutbound;
		if (!message || typeof message !== "object") return;
		if (message.type === "ready") {
			handle.progress.state = "indexing";
			handle.progress.phase = "ready";
			handle.progress.attempt = message.attempt;
			return;
		}
		if (message.type === "progress") {
			handle.progress.state = "indexing";
			handle.progress.phase = message.phase;
			handle.progress.current = message.current;
			handle.progress.total = message.total;
			handle.progress.attempt = message.attempt;
			return;
		}
		if (message.type === "done") {
			handle.progress.state = "ready";
			handle.progress.phase = "ready";
			handle.progress.current = message.filesIndexed;
			handle.progress.total = message.filesChecked;
			handle.progress.attempt = message.attempt;
			handles.delete(handle.key);
			return;
		}
		if (message.type === "error") {
			handle.progress.state = "failed";
			handle.progress.phase = message.error;
			handle.progress.attempt = message.attempt;
			handles.delete(handle.key);
		}
	});
}

function handleDropOnClose(key: string, worker: Worker): void {
	const finalize = (): void => {
		handles.delete(key);
	};
	worker.addEventListener("close", finalize, { once: true });
	worker.addEventListener("error", finalize, { once: true });
}

/**
 * Probe the slot's persistent state. Returns the supervisor's view of
 * whether the worker is currently active and the latest progress. Never
 * blocks.
 */
export async function probeSlot(location: CodeGraphIndexLocation): Promise<SupervisorResult> {
	const key = normalizedIdentityKey(location.identity);
	const handle = handles.get(key);
	if (handle) {
		return { active: true, progress: handle.progress };
	}
	const progressFile = await readProgress(location).catch(() => null);
	const progress: SupervisorProgressView = progressFile
		? {
				workerId: progressFile.workerId,
				state: progressFile.state,
				phase: progressFile.phase,
				current: progressFile.current,
				total: progressFile.total,
				attempt: progressFile.attempt,
			}
		: {
				workerId: "sup-none",
				state: "unknown",
				phase: "no-worker",
				current: 0,
				total: 0,
				attempt: 0,
			};
	return { active: false, progress };
}

/**
 * Cold-call entry point used by the tool. Returns the supervisor's view
 * (always non-blocking) and spawns a worker if the slot is not already
 * active / ready. Callers turn `active === true` OR
 * `progress.state !== "ready"` into an indexing fallback.
 */
export function scheduleIndex(location: CodeGraphIndexLocation, options: SupervisorOptions = {}): SupervisorResult {
	const handle = ensureWorker(location, options);
	return { active: true, progress: handle.progress };
}

/**
 * Probe used by `tools/codegraph.ts` to decide whether to return an
 * indexing fallback vs. open the runtime. Cold callers must not block on
 * the worker; this is a single fs read.
 */
export async function isSlotReady(location: CodeGraphIndexLocation): Promise<boolean> {
	if (handles.has(normalizedIdentityKey(location.identity))) return false;
	const progress = await readProgress(location).catch(() => null);
	return progress !== null && isReadyState(progress.state);
}

/**
 * Used by tests / smoke probes to ensure the supervisor map is drained
 * between runs. Production code never invokes this — workers exit on
 * their own.
 */
export function disposeAllWorkersForTests(): void {
	for (const handle of handles.values()) {
		try {
			handle.worker.terminate();
		} catch {
			/* already gone */
		}
	}
	handles.clear();
}

/**
 * Smoke test used by `cli.ts` `runSmokeTest()`. Spawns a worker against a
 * throwaway Git repo, waits for `done`, asserts `progress.state === "ready"`,
 * then cleans up the temp repo + slot.
 */
export async function smokeTestCodeGraphWorker(timeoutMs = 30_000): Promise<void> {
	const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-codegraph-smoke-"));
	const repoRoot = path.join(tmpRoot, "repo");
	await fs.mkdir(repoRoot, { recursive: true });
	const initProc = Bun.spawnSync(["git", "-C", repoRoot, "init", "-q"], { stdout: "pipe", stderr: "pipe" });
	if (initProc.exitCode !== 0) {
		throw new Error(`git init failed: ${initProc.stderr?.toString() ?? ""}`);
	}
	await fs.writeFile(path.join(repoRoot, "index.ts"), "export const hello = 'world';\n", "utf8");
	const addProc = Bun.spawnSync(["git", "-C", repoRoot, "add", "-A"], { stdout: "pipe", stderr: "pipe" });
	if (addProc.exitCode !== 0) {
		throw new Error(`git add failed: ${addProc.stderr?.toString() ?? ""}`);
	}
	const commitProc = Bun.spawnSync(
		["git", "-C", repoRoot, "-c", "user.email=smoke@omp", "-c", "user.name=omp", "commit", "-q", "-m", "smoke"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (commitProc.exitCode !== 0) {
		throw new Error(`git commit failed: ${commitProc.stderr?.toString() ?? ""}`);
	}

	const location = await resolveCodeGraphIndexLocation(repoRoot);
	try {
		const handle = ensureWorker(location, { forceRebuild: true });
		const start = Date.now();
		let lastProgress = handle.progress;
		while (Date.now() - start < timeoutMs) {
			await Bun.sleep(50);
			lastProgress = handle.progress;
			if (lastProgress.state === "ready") break;
			if (lastProgress.state === "failed") {
				throw new Error(`codegraph worker smoke failed: ${lastProgress.phase}`);
			}
		}
		if (lastProgress.state !== "ready") {
			throw new Error(`codegraph worker smoke timed out after ${timeoutMs}ms`);
		}
		logger.debug("codegraph worker smoke completed", {
			durationMs: Date.now() - start,
			phase: lastProgress.phase,
		});
	} finally {
		disposeAllWorkersForTests();
		await fs.rm(location.indexDir, { recursive: true, force: true });
		try {
			await fs.rm(tmpRoot, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}
