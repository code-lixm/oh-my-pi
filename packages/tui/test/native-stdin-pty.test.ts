import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { type PtyRunResult, PtySession } from "@oh-my-pi/pi-natives";

const PTY_CHILD_TIMEOUT_MS = 6_000;
const CHILD_STARTUP_TIMEOUT_MS = 2_000;
const REPORT_TIMEOUT_MS = 2_000;
const IDLE_BOUNDARY_MS = 100;
const CLEANUP_TIMEOUT_MS = 1_000;
const TEST_TIMEOUT_MS = 8_000;
const REPORT_PREFIX = "\u001eomp-native-stdin:";
const REPORT_SUFFIX = "\u001f";
const INPUT_BATCHES = [
	{ name: "Unicode", text: "π界", events: ["π", "界"] },
	{ name: "Backspace", text: "\x7f", events: ["\x7f"] },
	{ name: "Delete", text: "\x1b[3~", events: ["\x1b[3~"] },
	{ name: "following Unicode", text: "終", events: ["終"] },
] as const;

type ChildReport =
	| { type: "ready"; nativeInputActive: true }
	| { type: "input"; batch: number; text: string; events: readonly string[] }
	| { type: "failure"; message: string };

type ReportWaiter = {
	predicate: (report: ChildReport) => boolean;
	resolve: (report: ChildReport) => void;
	reject: (error: Error) => void;
};

function isChildReport(value: unknown): value is ChildReport {
	if (!value || typeof value !== "object") return false;
	const report = value as Record<string, unknown>;
	if (report.type === "ready") return report.nativeInputActive === true;
	if (report.type === "input") {
		return (
			typeof report.batch === "number" &&
			typeof report.text === "string" &&
			Array.isArray(report.events) &&
			report.events.every(event => typeof event === "string")
		);
	}
	return report.type === "failure" && typeof report.message === "string";
}

class ChildReportStream {
	#buffer = "";
	#transcript = "";
	#reports: ChildReport[] = [];
	#waiters = new Set<ReportWaiter>();
	#failure: Error | undefined;

	get transcript(): string {
		return this.#transcript || "<no PTY output>";
	}

	write(chunk: string): void {
		this.#transcript = `${this.#transcript}${chunk}`.slice(-16_384);
		if (this.#failure) return;
		this.#buffer += chunk;

		while (true) {
			const start = this.#buffer.indexOf(REPORT_PREFIX);
			if (start === -1) {
				this.#buffer = this.#buffer.slice(-(REPORT_PREFIX.length - 1));
				return;
			}
			if (start > 0) this.#buffer = this.#buffer.slice(start);

			const end = this.#buffer.indexOf(REPORT_SUFFIX, REPORT_PREFIX.length);
			if (end === -1) return;

			const payload = this.#buffer.slice(REPORT_PREFIX.length, end);
			this.#buffer = this.#buffer.slice(end + REPORT_SUFFIX.length);

			let report: unknown;
			try {
				report = JSON.parse(payload);
			} catch (error) {
				this.fail(
					new Error(
						`PTY child emitted malformed report: ${error instanceof Error ? error.message : String(error)}`,
					),
				);
				return;
			}
			if (!isChildReport(report)) {
				this.fail(new Error(`PTY child emitted an invalid report: ${payload}`));
				return;
			}
			this.#publish(report);
		}
	}

	waitFor(predicate: (report: ChildReport) => boolean): Promise<ChildReport> {
		if (this.#failure) return Promise.reject(this.#failure);
		const report = this.#reports.find(predicate);
		if (report) return Promise.resolve(report);

		const deferred = Promise.withResolvers<ChildReport>();
		const waiter: ReportWaiter = {
			predicate,
			resolve: deferred.resolve,
			reject: deferred.reject,
		};
		this.#waiters.add(waiter);
		return deferred.promise.finally(() => this.#waiters.delete(waiter));
	}

	fail(error: unknown): void {
		if (this.#failure) return;
		this.#failure = error instanceof Error ? error : new Error(String(error));
		for (const waiter of this.#waiters) waiter.reject(this.#failure);
		this.#waiters.clear();
	}

	#publish(report: ChildReport): void {
		this.#reports.push(report);
		if (report.type === "failure") {
			this.fail(new Error(`PTY child reported failure: ${report.message}`));
			return;
		}
		for (const waiter of this.#waiters) {
			if (waiter.predicate(report)) waiter.resolve(report);
		}
	}
}

async function withTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	label: string,
	reports: ChildReportStream,
): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timeoutId = setTimeout(
		() =>
			timeout.reject(
				new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\nPTY transcript:\n${reports.transcript}`),
			),
		timeoutMs,
	);
	try {
		return await Promise.race([operation, timeout.promise]);
	} finally {
		clearTimeout(timeoutId);
	}
}

function childEnvironment(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined) env[name] = value;
	}

	Object.assign(env, {
		BUN_ENV: "development",
		NODE_ENV: "development",
		PI_TEST_RUNTIME: "0",
		PI_TUI_NATIVE_INPUT: "1",
		TERM: "xterm-256color",
	});
	for (const name of [
		"TMUX",
		"STY",
		"ZELLIJ",
		"HERDR_ENV",
		"CMUX_WORKSPACE_ID",
		"CMUX_SURFACE_ID",
		"CMUX_REMOTE_TRANSPORT",
	]) {
		env[name] = "";
	}
	return env;
}

function createChildScript(terminalSource: string): string {
	return `
import { ProcessTerminal } from ${JSON.stringify(terminalSource)};

const reportPrefix = ${JSON.stringify(REPORT_PREFIX)};
const reportSuffix = ${JSON.stringify(REPORT_SUFFIX)};
const batches = ${JSON.stringify(INPUT_BATCHES)};
const startupDeadline = Date.now() + ${CHILD_STARTUP_TIMEOUT_MS};
const terminal = new ProcessTerminal();
let activationTimer;
let failed = false;
let batch = 0;
let received = "";
let events = [];

function report(value) {
	// Direct PTY write, not terminal.write: the terminal output broker queues
	// reliable writes behind the native worker and only flushes them to the PTY
	// on close/kill, which would starve the parent's report protocol.
	process.stdout.write(reportPrefix + JSON.stringify(value) + reportSuffix);
}

function fail(message) {
	if (failed) return;
	failed = true;
	if (activationTimer) clearInterval(activationTimer);
	report({ type: "failure", message });
}

terminal.start(
	data => {
		if (failed) return;
		const expected = batches[batch];
		if (expected === undefined) {
			fail("received input after both expected batches");
			return;
		}
		received += data;
		events.push(data);
		if (!expected.text.startsWith(received)) {
			fail("input handler received unexpected text: " + JSON.stringify(received));
			return;
		}
		if (received === expected.text) {
			report({ type: "input", batch: batch + 1, text: received, events });
			batch++;
			received = "";
			events = [];
		}
	},
	() => {},
);

// This startup-only poll is cleared before ready. After ready, the child keeps
// no JavaScript timer; the native stdin bridge wakes ProcessTerminal per batch.
activationTimer = setInterval(() => {
	if (terminal.nativeInputActive) {
		clearInterval(activationTimer);
		activationTimer = undefined;
		report({ type: "ready", nativeInputActive: true });
		return;
	}
	if (Date.now() >= startupDeadline) fail("ProcessTerminal never activated native stdin");
}, 10);
`;
}

async function stopPtyChild(
	session: PtySession,
	run: Promise<PtyRunResult>,
	reports: ChildReportStream,
): Promise<void> {
	let killError: unknown;
	try {
		session.kill();
	} catch (error) {
		killError = error;
	}
	await withTimeout(run, CLEANUP_TIMEOUT_MS, "PTY child cleanup", reports);
	if (killError) throw killError;
}

describe("ProcessTerminal native stdin through a real PTY", () => {
	it(
		"wakes from independent idle boundaries for Unicode and editing input in exact handler order",
		async () => {
			if (process.platform !== "darwin" && process.platform !== "linux") return;

			const reports = new ChildReportStream();
			const session = new PtySession();
			const terminalSource = pathToFileURL(path.resolve(import.meta.dir, "../src/terminal.ts")).href;
			let run: Promise<PtyRunResult> | undefined;

			try {
				run = session.startArgv(
					{
						application: process.execPath,
						args: ["-e", createChildScript(terminalSource)],
						cwd: path.resolve(import.meta.dir, "../../.."),
						env: childEnvironment(),
						timeoutMs: PTY_CHILD_TIMEOUT_MS,
						cols: 100,
						rows: 30,
					},
					(error, chunk) => {
						if (error) reports.fail(error);
						else reports.write(chunk);
					},
				);
				void run.then(
					result =>
						reports.fail(
							new Error(
								`PTY child exited before completing the native input contract: ${JSON.stringify(result)}`,
							),
						),
					error => reports.fail(error),
				);

				const ready = await withTimeout(
					reports.waitFor(report => report.type === "ready"),
					REPORT_TIMEOUT_MS,
					"native stdin readiness",
					reports,
				);
				expect(ready).toEqual({ type: "ready", nativeInputActive: true });

				for (const [index, input] of INPUT_BATCHES.entries()) {
					// This parent-side delay makes the child actually quiesce. Fake timers
					// cannot advance its OS PTY or native input worker, and the child has no
					// JavaScript timer after ready that could mask the native wake.
					await Bun.sleep(IDLE_BOUNDARY_MS);
					session.write(input.text);
					const report = await withTimeout(
						reports.waitFor(candidate => candidate.type === "input" && candidate.batch === index + 1),
						REPORT_TIMEOUT_MS,
						`the ${input.name} native input batch`,
						reports,
					);
					expect(report).toEqual({
						type: "input",
						batch: index + 1,
						text: input.text,
						events: input.events,
					});
				}
			} finally {
				if (run) await stopPtyChild(session, run, reports);
			}
		},
		TEST_TIMEOUT_MS,
	);
});
