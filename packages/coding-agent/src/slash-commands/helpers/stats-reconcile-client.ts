import {
	STATS_RECONCILE_WORKER_ARG,
	type StatsReconcileWorkerRequest,
	type StatsReconcileWorkerResponse,
} from "@oh-my-pi/omp-stats/reconcile-worker";
import {
	createWorkerHandle,
	createWorkerSubprocess,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	type SpawnedSubprocess,
	smokeTestWorker,
	type WorkerHandle,
	workerEnvFromParent,
} from "../../subprocess/worker-client";
import { safeSend } from "../../utils/ipc";

const RECONCILE_TIMEOUT_MS = 10 * 60 * 1000;

type StatsReconcileWorkerHandle = WorkerHandle<StatsReconcileWorkerRequest, StatsReconcileWorkerResponse>;

export function createStatsReconcileSubprocess(): SpawnedSubprocess<StatsReconcileWorkerResponse> {
	return createWorkerSubprocess<StatsReconcileWorkerResponse>({
		spawnCommand: resolveWorkerSpawnCmd(STATS_RECONCILE_WORKER_ARG),
		env: workerEnvFromParent(),
		exitLabel: "stats reconcile worker",
		unref: false,
	});
}

function spawnStatsReconcileWorker(): StatsReconcileWorkerHandle {
	const spawned = createStatsReconcileSubprocess();
	return createWorkerHandle<StatsReconcileWorkerRequest, StatsReconcileWorkerResponse>(spawned, message =>
		safeSend(spawned.proc, message, "stats-reconcile"),
	);
}

export async function reconcileStatsInSubprocess(): Promise<{ processed: number; files: number }> {
	const worker = spawnStatsReconcileWorker();
	const requestId = crypto.randomUUID();
	const { promise, resolve, reject } = Promise.withResolvers<{ processed: number; files: number }>();
	const timeout = setTimeout(() => reject(new Error("Stats reconciliation timed out.")), RECONCILE_TIMEOUT_MS);
	const unsubscribeMessage = worker.onMessage(message => {
		if (message.id !== requestId) return;
		if (message.type === "result") {
			resolve({ processed: message.processed, files: message.files });
			return;
		}
		if (message.type === "error") reject(new Error(message.error));
	});
	const unsubscribeError = worker.onError(reject);
	try {
		worker.send({ type: "sync", id: requestId });
		return await promise;
	} finally {
		clearTimeout(timeout);
		unsubscribeMessage();
		unsubscribeError();
		await worker.terminate();
	}
}

export async function smokeTestStatsReconcileWorker(): Promise<void> {
	await smokeTestWorker(spawnStatsReconcileWorker(), "stats reconcile worker", SMOKE_TEST_TIMEOUT_MS);
}
