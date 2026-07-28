/**
 * Worker-entry — runs inside the CLI re-entered through the
 * `__omp_worker_codegraph_index` argv selector. Wires `parentPort` to the
 * typed `CodeGraphWorkerTransport` and starts the worker core.
 *
 *   - When the CLI host pre-buffered messages (`installWorkerInbox` in the
 *     dispatch sync prefix), we `consumeWorkerInbox` so the parent's
 *     `index` request survives the pre-flush.
 *   - When the module is loaded directly (tests / SDK embedding), no
 *     pre-buffering happened and this module's own top-level listener wins
 *     the flush synchronously.
 *
 * The entry does not call `worker.unref()` — the parent owns the worker
 * thread's lifecycle. The worker thread itself exits after a single
 * `index` request finishes so it doesn't keep Bun alive.
 */
import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox, isWorkerHostSelector } from "@oh-my-pi/pi-utils/worker-host";
import { CodeGraphWorkerCore } from "./worker";
import type { CodeGraphWorkerInbound, CodeGraphWorkerOutbound, CodeGraphWorkerTransport } from "./worker-protocol";

export { CODEGRAPH_WORKER_ARG } from "./worker-protocol";

export function startCodeGraphWorker(): void {
	if (!parentPort) {
		throw new Error("codegraph worker-entry: missing parentPort");
	}
	const port = parentPort;
	const inbox = consumeWorkerInbox();
	const transport: CodeGraphWorkerTransport = {
		send(message: CodeGraphWorkerOutbound) {
			port.postMessage(message);
		},
		onMessage(handler: (message: CodeGraphWorkerInbound) => void) {
			if (inbox) return inbox.bind(message => handler(message as CodeGraphWorkerInbound));
			const listener = (message: unknown): void => handler(message as CodeGraphWorkerInbound);
			port.on("message", listener);
			return () => port.off("message", listener);
		},
		close() {
			port.close();
		},
	};
	new CodeGraphWorkerCore(transport).start();
}

if (!Bun.isMainThread && !process.argv.some(isWorkerHostSelector) && import.meta.path === Bun.main) {
	startCodeGraphWorker();
}
