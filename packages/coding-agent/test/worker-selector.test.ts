import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { runCli } from "../src/cli";
import { CODEGRAPH_WORKER_ARG, type CodeGraphWorkerOutbound } from "../src/codegraph/worker-protocol";
import * as computerWorkerEntry from "../src/tools/computer/worker-entry";

const WORKER_RESPONSE_TIMEOUT_MS = 10_000;

async function sendInvalidMessageToCliHostedCodeGraphWorker(): Promise<CodeGraphWorkerOutbound> {
	const worker = new Worker(new URL("../src/cli.ts", import.meta.url).href, {
		type: "module",
		argv: [CODEGRAPH_WORKER_ARG],
	});
	const response = Promise.withResolvers<CodeGraphWorkerOutbound>();
	let receivedResponse = false;
	const timeout = setTimeout(() => {
		response.reject(new Error("CodeGraph CLI worker did not respond before timeout"));
	}, WORKER_RESPONSE_TIMEOUT_MS);

	worker.addEventListener(
		"message",
		event => {
			receivedResponse = true;
			response.resolve(event.data as CodeGraphWorkerOutbound);
		},
		{ once: true },
	);
	worker.addEventListener("error", event => response.reject(event.error ?? new Error(event.message)), { once: true });
	worker.addEventListener(
		"close",
		() => {
			if (!receivedResponse) response.reject(new Error("CodeGraph CLI worker exited before responding"));
		},
		{ once: true },
	);
	worker.postMessage({ type: "unsupported" });

	try {
		return await response.promise;
	} finally {
		clearTimeout(timeout);
		worker.terminate();
	}
}

// The worker-host re-entry seam dispatches any `__omp_worker_*` selector to
// `runWorkerEntrypoint`. An unrecognized selector must fail loudly rather than
// exit 0 with empty output, so a stale/mistyped selector cannot look healthy to
// a parent process or install smoke path (issue #5712).
describe("worker selector dispatch", () => {
	beforeEach(() => {
		process.exitCode = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = 0;
	});

	it("fails with a nonzero exit and stderr error on an unknown selector", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await runCli(["__omp_worker_does_not_exist"]);

		expect(process.exitCode).toBe(1);
		expect(stderr).toHaveBeenCalledWith("Error: unknown worker selector: __omp_worker_does_not_exist\n");
	});

	it("leaves normal root flags untouched", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await runCli(["--version"]);

		expect(process.exitCode).toBe(0);
		expect(stdout).toHaveBeenCalled();
		expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("unknown worker selector"));
	});
});

describe("CodeGraph worker entry", () => {
	it(
		"dispatches through the CLI host selector and responds through the CodeGraph protocol",
		async () => {
			const response = await sendInvalidMessageToCliHostedCodeGraphWorker();

			expect(response).toMatchObject({
				type: "error",
				id: "unknown",
				attempt: 1,
				error: "unknown message type",
			});
			expect(response.workerId).toMatch(/^codegraph-worker-/);
		},
		WORKER_RESPONSE_TIMEOUT_MS + 5_000,
	);
});

describe("computer worker entry", () => {
	it("is side-effect-free to import outside a worker and exposes a named start function", () => {
		// Importing on the main thread (no parentPort) must not start the worker
		// core; the CLI host and bundled hosts call the exported hook explicitly.
		expect(computerWorkerEntry.startComputerWorker).toBeFunction();
	});
});
