import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGateCommand } from "../../src/autonomous/gate-runner";

const temporaryRoots: string[] = [];
const activeGateRuns = new Set<{ abortController: AbortController; completion: Promise<unknown> }>();
const descendantProbes: DescendantProbe[] = [];

async function makeTemporaryRoot(label: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-gate-runner-${label}-`));
	temporaryRoots.push(root);
	return root;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// `kill(pid, 0)` also succeeds for a zombie. The gate's process tree has
// already terminated in that state; `ps` distinguishes it from a descendant
// that is still executing and therefore leaked.
function isProcessAlive(pid: number): boolean {
	const result = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
	const state = result.stdout.toString().trim();
	return result.exitCode === 0 && state.length > 0 && !state.startsWith("Z");
}

async function waitForCondition(
	predicate: () => boolean | Promise<boolean>,
	label: string,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

async function terminateDescendant(pid: number): Promise<void> {
	if (!isProcessAlive(pid)) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if (isProcessAlive(pid)) throw error;
	}
	await waitForCondition(() => !isProcessAlive(pid), `descendant ${pid} cleanup`);
}

async function pathExists(filePath: string): Promise<boolean> {
	return fs
		.access(filePath)
		.then(() => true)
		.catch(() => false);
}

async function readDescendantPid(probe: DescendantProbe): Promise<number | undefined> {
	try {
		const pid = Number.parseInt((await fs.readFile(probe.pidPath, "utf8")).trim(), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

function startTrackedGate(command: string, cwd: string, options: { timeoutMs: number; maxOutputChars: number }) {
	const abortController = new AbortController();
	const resultPromise = runGateCommand(command, cwd, { ...options, signal: abortController.signal });
	const trackedRun = { abortController, completion: resultPromise };
	activeGateRuns.add(trackedRun);
	void resultPromise
		.finally(() => {
			activeGateRuns.delete(trackedRun);
		})
		.catch(() => {});
	return { abortController, resultPromise };
}

interface DescendantProbe {
	command: string;
	markerPath: string;
	pidPath: string;
}

async function makeDescendantProbe(root: string): Promise<DescendantProbe> {
	const pidPath = path.join(root, "descendant.pid");
	const markerPath = path.join(root, "descendant-ready");
	const scriptPath = path.join(root, "descendant.sh");
	await fs.writeFile(
		scriptPath,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$$" > ${shellQuote(pidPath)}`,
			`: > ${shellQuote(markerPath)}`,
			"exec sleep 60",
			"",
		].join("\n"),
	);
	const probe = {
		command: `/bin/sh ${shellQuote(scriptPath)} & wait`,
		markerPath,
		pidPath,
	};
	descendantProbes.push(probe);
	return probe;
}

async function waitForDescendant(probe: DescendantProbe): Promise<number> {
	await waitForCondition(() => pathExists(probe.markerPath), "descendant readiness marker");
	const pid = await readDescendantPid(probe);
	if (pid === undefined) throw new Error(`invalid descendant PID in ${probe.pidPath}`);
	return pid;
}

afterEach(async () => {
	const runsToCleanUp = [...activeGateRuns];
	for (const run of runsToCleanUp) run.abortController.abort(new Error("gate-runner test cleanup"));
	await Promise.allSettled(runsToCleanUp.map(run => run.completion));
	activeGateRuns.clear();

	const descendantPids = (await Promise.all(descendantProbes.splice(0).map(readDescendantPid))).filter(
		(pid): pid is number => pid !== undefined,
	);
	const cleanupResults = await Promise.allSettled(descendantPids.map(terminateDescendant));
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	const cleanupFailure = cleanupResults.find(result => result.status === "rejected");
	if (cleanupFailure?.status === "rejected") throw cleanupFailure.reason;
});

describe("runGateCommand process-tree termination", () => {
	it.skipIf(process.platform === "win32")(
		"times out the shell and its ready descendant instead of leaving the child alive",
		async () => {
			const root = await makeTemporaryRoot("timeout");
			const probe = await makeDescendantProbe(root);
			const { resultPromise } = startTrackedGate(probe.command, root, {
				timeoutMs: 250,
				maxOutputChars: 4_096,
			});
			const descendantPid = await waitForDescendant(probe);

			expect(isProcessAlive(descendantPid)).toBe(true);
			const result = await resultPromise;
			expect(result.timedOut).toBe(true);
			await waitForCondition(() => !isProcessAlive(descendantPid), "timed-out descendant termination");
			expect(isProcessAlive(descendantPid)).toBe(false);
		},
	);

	it.skipIf(process.platform === "win32")(
		"propagates external abort after terminating the shell descendant",
		async () => {
			const root = await makeTemporaryRoot("abort");
			const probe = await makeDescendantProbe(root);
			const { abortController, resultPromise } = startTrackedGate(probe.command, root, {
				timeoutMs: 30_000,
				maxOutputChars: 4_096,
			});
			const descendantPid = await waitForDescendant(probe);

			expect(isProcessAlive(descendantPid)).toBe(true);
			abortController.abort(new Error("test requested gate cancellation"));
			await expect(resultPromise).rejects.toThrow("test requested gate cancellation");
			await waitForCondition(() => !isProcessAlive(descendantPid), "aborted descendant termination");
			expect(isProcessAlive(descendantPid)).toBe(false);
		},
	);
});
