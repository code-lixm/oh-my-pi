/**
 * Wire protocol for the CodeGraph index worker. Worker-thread based:
 *
 *   parent (agent process) ─── parentPort ─── worker (this CLI re-entry)
 *
 * The worker dispatches off `__omp_worker_codegraph_index` argv; once running
 * it installs `parentPort.on("message", ...)` synchronously (via
 * `installWorkerInbox` so it survives the pre-flush) and treats each
 * `request` as a single full pipeline run for a given `indexKey`.
 *
 * The protocol is intentionally tiny — the worker holds the slot open for
 * the duration of one bootstrap + warm full sync, then exits. The parent
 * observes the exit through `Worker.on("close", …)`.
 */
import type { CodeGraphIndexLocation } from "./location";

export const CODEGRAPH_WORKER_ARG = "__omp_worker_codegraph_index";

/** Inbound — parent → worker. */
export type CodeGraphWorkerRequest = {
	type: "index";
	id: string;
	/** Already-resolved index location — the worker trusts the parent's path resolution. */
	location: CodeGraphIndexLocation;
	/** Force rebuild even when the slot looks warm (used after an interrupted run). */
	forceRebuild?: boolean;
};

/** Outbound — worker → parent. */
export type CodeGraphWorkerResponse =
	| {
			type: "ready";
			id: string;
			workerId: string;
			attempt: number;
	  }
	| {
			type: "progress";
			id: string;
			workerId: string;
			attempt: number;
			phase: string;
			current: number;
			total: number;
	  }
	| {
			type: "done";
			id: string;
			workerId: string;
			attempt: number;
			filesIndexed: number;
			filesChecked: number;
			durationMs: number;
	  }
	| {
			type: "error";
			id: string;
			workerId: string;
			attempt: number;
			error: string;
			forceRebuild?: boolean;
	  };

export type CodeGraphWorkerInbound = CodeGraphWorkerRequest;
export type CodeGraphWorkerOutbound = CodeGraphWorkerResponse;

export interface CodeGraphWorkerTransport {
	send(message: CodeGraphWorkerOutbound): void;
	onMessage(handler: (message: CodeGraphWorkerInbound) => void): () => void;
	close(): void;
}
