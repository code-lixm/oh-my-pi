import { syncAllSessions } from "./aggregator";

export const STATS_RECONCILE_WORKER_ARG = "__omp_worker_stats_reconcile";

export type StatsReconcileWorkerRequest = { type: "sync" | "ping"; id: string };

export type StatsReconcileWorkerResponse =
	| { type: "result"; id: string; processed: number; files: number }
	| { type: "pong"; id: string }
	| { type: "error"; id: string; error: string };

interface StatsReconcileWorkerPort {
	send(message: StatsReconcileWorkerResponse): void;
	onMessage(handler: (message: StatsReconcileWorkerRequest) => void): () => void;
}

/**
 * Runs cold full-directory reconciliation in a child process. Parsing remains
 * serial so macOS avoids the Bun worker-thread crash path, while the TUI stays
 * responsive because its isolate never reads or parses the JSONL workload.
 */
export function startStatsReconcileWorker(port: StatsReconcileWorkerPort): void {
	port.onMessage(request => {
		if (request.type === "ping") {
			port.send({ type: "pong", id: request.id });
			return;
		}
		void syncAllSessions({ workers: 1 }).then(
			({ processed, files }) => port.send({ type: "result", id: request.id, processed, files }),
			error =>
				port.send({
					type: "error",
					id: request.id,
					error: error instanceof Error ? (error.stack ?? error.message) : String(error),
				}),
		);
	});
}
