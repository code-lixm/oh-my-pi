/**
 * Worker core. Runs inside the CLI re-entered through the
 * `__omp_worker_codegraph_index` selector. Each request is a single full
 * pipeline run for a given `CodeGraphIndexLocation`:
 *
 *   1. Mark the slot `queued` (cold readers see an indexing fallback).
 *   2. Detect an interrupted previous run; if so, `forceRebuild` so a
 *      partial DB can never leak out as `ready`.
 *   3. Open the runtime, `initialize()` (with progress callback wired to
 *      `<indexDir>/progress.json`), and on warm slots skip the redundant
 *      full-project `sync()` — the worker IS the warm sync.
 *   4. Run a single full-project `sync()` (warm path) unless
 *      `initialize()` already bootstrapped.
 *   5. Mark the slot `ready`, run auto-prune in the background, then close
 *      the runtime and exit.
 *
 * The worker exits after one request so an idle CLI process reaps it
 * automatically — no explicit `unref` from this side.
 */
import * as logger from "@oh-my-pi/pi-utils/logger";
import { runAutoPrune } from "./auto-prune";
import { detectInterruptedProgress, markFailed, markQueued, markReady, writeProgress } from "./progress";
import { openCodeGraphRuntime } from "./runtime";
import type { CodeGraphProgress, CodeGraphRuntime } from "./runtime-types";
import type { CodeGraphWorkerInbound, CodeGraphWorkerOutbound, CodeGraphWorkerTransport } from "./worker-protocol";

const WORKER_NAMESPACE = "codegraph-worker";

function workerId(): string {
	return `${WORKER_NAMESPACE}-${Bun.randomUUIDv7().slice(0, 8)}`;
}

/**
 * Worker core — bound to a `CodeGraphWorkerTransport`. Holds no module
 * state; one instance per request.
 */
export class CodeGraphWorkerCore {
	readonly #transport: CodeGraphWorkerTransport;
	#bound = false;

	constructor(transport: CodeGraphWorkerTransport) {
		this.#transport = transport;
	}

	start(): void {
		if (this.#bound) return;
		this.#bound = true;
		this.#transport.onMessage(message => {
			void this.#handle(message).catch(err => {
				logger.warn("codegraph worker uncaught error", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		});
	}

	async #handle(message: CodeGraphWorkerInbound): Promise<void> {
		try {
			if (message.type !== "index") {
				this.#send({
					type: "error",
					id: "unknown",
					workerId: workerId(),
					attempt: 1,
					error: "unknown message type",
				});
				return;
			}
			await this.#runIndex(message);
		} finally {
			this.#transport.close();
		}
	}
	async #runIndex(message: Extract<CodeGraphWorkerInbound, { type: "index" }>): Promise<void> {
		const { id, location, forceRebuild: requestedForceRebuild } = message;
		const wId = workerId();
		const attempt = 1;
		this.#send({ type: "ready", id, workerId: wId, attempt });

		const effectiveSourceRoot = location.identity.sourceRoot || location.identity.worktreeRoot;
		let runtime: CodeGraphRuntime | null = null;
		let progressWrites = Promise.resolve();
		try {
			const { interrupted, previous } = await detectInterruptedProgress(location);
			const forceRebuild =
				requestedForceRebuild === true ||
				interrupted ||
				previous?.forceRebuild === true ||
				previous?.state === "failed";
			await markQueued(location, wId, attempt);

			runtime = await openCodeGraphRuntime({ sourceRoot: effectiveSourceRoot, location });
			const progressCallback = (progress: CodeGraphProgress): void => {
				const workerProgress: CodeGraphProgress = { ...progress, workerId: wId, attempt };
				progressWrites = progressWrites.then(() => writeProgress(location, workerProgress));
				this.#send({
					type: "progress",
					id,
					workerId: wId,
					attempt,
					phase: progress.phase,
					current: progress.current,
					total: progress.total,
				});
			};
			const init = await runtime.initialize({ forceRebuild, progressCallback });
			if (!init.bootstrapped) {
				const warmSync = await runtime.sync({});
				this.#send({
					type: "progress",
					id,
					workerId: wId,
					attempt,
					phase: "warm-sync",
					current: warmSync.filesChecked,
					total: warmSync.filesChecked,
				});
			}

			await progressWrites;
			runtime.close();
			runtime = null;
			await markReady(location, wId, attempt);
			this.#send({
				type: "done",
				id,
				workerId: wId,
				attempt,
				filesIndexed: init.filesIndexed,
				filesChecked: init.filesChecked,
				durationMs: init.durationMs,
			});
			await runAutoPrune(location, { protectedKeys: [location.identity.key] });
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			await progressWrites.catch(() => {});
			await markFailed(location, wId, attempt, error).catch(() => {});
			this.#send({ type: "error", id, workerId: wId, attempt, error, forceRebuild: true });
		} finally {
			try {
				runtime?.close();
			} catch {
				/* already torn down */
			}
		}
	}

	#send(message: CodeGraphWorkerOutbound): void {
		try {
			this.#transport.send(message);
		} catch {
			// Parent vanished — nothing to do.
		}
	}
}
