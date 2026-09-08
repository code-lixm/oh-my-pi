/**
 * Contracts for the session-bound cron surface (tool, hub, CLI, store).
 *
 * - `CronTool` creates jobs through the SessionScheduleRuntime, so every job is
 *   bound to the CURRENT session (sidecar in its artifacts dir) — its lifecycle
 *   is the session's lifecycle. Disabled scheduling rejects synchronously.
 * - Legacy sidecars carrying removed `heartbeat` sources load without corruption
 *   and retire those jobs; cron jobs in the same file survive.
 * - Terminal jobs past the retention window are garbage-collected on load so run
 *   history cannot grow a sidecar without bound.
 * - `CronHubOverlayComponent` renders the session's job list with lifecycle
 *   framing, routes pause/cancel/run-now through the injected deps, and gates
 *   run-now on the active status.
 * - `omp cron`'s collector reads sidecars across sessions, tolerates corrupt
 *   files, and emits machine-readable rows.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { collectCronRows, discoverCronSidecars, parseCronSidecar } from "../src/cli/cron-cli";
import { CronHubOverlayComponent } from "../src/modes/components/cron-hub";
import { initTheme } from "../src/modes/theme/theme";
import { SessionScheduleRuntime } from "../src/scheduling/runtime";
import { JsonScheduleStore } from "../src/scheduling/store";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { CronTool, formatCronJobSummary } from "../src/tools/cron-tool";

function stripAnsi(text: string): string {
	return Bun.stripANSI(text);
}

beforeAll(async () => {
	await initTheme();
});

function hubLines(hub: CronHubOverlayComponent, width = 120): string[] {
	return hub.render(width).map(line => stripAnsi(line));
}

async function flushAsync(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise(resolve => setTimeout(resolve, 0));
}

describe("CronTool session-bound scheduling", () => {
	using tempDir = TempDir.createSync("@pi-cron-tool-");

	function makeRuntime(now = () => new Date("2026-09-05T12:00:00.000Z")) {
		const manager = SessionManager.create(path.join(tempDir.path(), "project"), path.join(tempDir.path()));
		const session = { sessionManager: manager } as unknown as AgentSession;
		const runtime = new SessionScheduleRuntime(session, { now });
		return { manager, runtime };
	}

	async function disposeRuntime(runtime: SessionScheduleRuntime): Promise<void> {
		runtime.dispose();
	}

	it("adds a job bound to the current session and lists it", async () => {
		const { manager, runtime } = makeRuntime();
		await runtime.ready();
		const tool = new CronTool(
			() => runtime,
			() => true,
		);
		try {
			const result = await tool.execute("call-1", {
				op: "add",
				schedule: "every 10m",
				prompt: "check the deploy queue",
				label: "deploy-watch",
				deliveryMode: "steer",
			});
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("deploy-watch");
			expect(text).toContain("every 10m");

			const jobs = await runtime.list({ includeInactive: true, source: "cron" });
			expect(jobs).toHaveLength(1);
			expect(jobs[0]?.prompt).toBe("check the deploy queue");
			expect(jobs[0]?.deliveryMode).toBe("steer");
			// Session-bound: the job lives in the session's artifacts sidecar.
			const sidecar = await fs.readFile(path.join(manager.getArtifactsDir(), "scheduled-jobs.json"), "utf8");
			expect(sidecar).toContain("check the deploy queue");
		} finally {
			await disposeRuntime(runtime);
		}
	});

	it("rejects synchronously while scheduling is disabled", async () => {
		const { runtime } = makeRuntime();
		await runtime.ready();
		const tool = new CronTool(
			() => runtime,
			() => false,
		);
		try {
			const result = await tool.execute("call-1", { op: "add", schedule: "in 1h", prompt: "noop" });
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text.toLowerCase()).toContain("unavailable");
		} finally {
			await disposeRuntime(runtime);
		}
	});

	it("pauses, resumes, and cancels through the runtime", async () => {
		const { runtime } = makeRuntime();
		await runtime.ready();
		const tool = new CronTool(
			() => runtime,
			() => true,
		);
		try {
			const added = await tool.execute("call-1", { op: "add", schedule: "every 1h", prompt: "ping" });
			const addedText = added.content[0]?.type === "text" ? added.content[0].text : "";
			const jobId = added.details?.job?.id as string;
			expect(jobId).toBeTruthy();

			const paused = await tool.execute("call-2", { op: "pause", jobId });
			expect(paused.details?.job?.status).toBe("paused");
			// Paused jobs drop their next run time.
			expect(addedText).toBeTruthy();

			const resumed = await tool.execute("call-3", { op: "resume", jobId });
			expect(resumed.details?.job?.status).toBe("active");

			const cancelled = await tool.execute("call-4", { op: "cancel", jobId });
			expect(cancelled.details?.job?.status).toBe("cancelled");

			const listed = await tool.execute("call-5", { op: "list" });
			const listText = listed.content[0]?.type === "text" ? listed.content[0].text : "";
			expect(listText).toContain("cancelled");
		} finally {
			await disposeRuntime(runtime);
		}
	});

	it("formats a confirmation summary with schedule and lifecycle framing", () => {
		const summary = formatCronJobSummary({
			id: "job-1",
			source: "cron",
			status: "active",
			deliveryMode: "steer",
			sessionId: "s",
			sessionFile: "/s.jsonl",
			cwd: "/c",
			prompt: "check queue",
			schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
			createdAt: "2026-09-05T00:00:00.000Z",
			updatedAt: "2026-09-05T00:00:00.000Z",
			nextRunAt: "2026-09-05T12:05:00.000Z",
			runCount: 2,
		});
		expect(summary).toContain("every 5m");
		expect(summary).toContain("steer");
		expect(summary).toContain("check queue");
	});
});

describe("Schedule sidecar legacy pruning and GC", () => {
	it("retires legacy heartbeat jobs on load without corrupting cron jobs in the same file", async () => {
		using tempDir = TempDir.createSync("@pi-cron-legacy-");
		const sidecar = path.join(tempDir.path(), "scheduled-jobs.json");
		const cronJob = {
			id: "cron-1",
			source: "cron",
			status: "active",
			sessionId: "sess",
			sessionFile: "/tmp/sess.jsonl",
			cwd: "/tmp",
			prompt: "keep me",
			schedule: { kind: "interval", expression: "every 10m", intervalMs: 600_000 },
			createdAt: "2026-09-01T00:00:00.000Z",
			updatedAt: "2026-09-01T00:00:00.000Z",
			nextRunAt: "2026-09-01T01:00:00.000Z",
			runCount: 0,
		};
		const legacyHeartbeat = {
			...cronJob,
			id: "hb-1",
			source: "heartbeat",
			status: "cancelled",
			prompt: "legacy heartbeat",
		};
		await fs.writeFile(sidecar, JSON.stringify({ version: 1, jobs: [cronJob, legacyHeartbeat], dispatches: [] }));
		const store = new JsonScheduleStore({ filePath: sidecar });
		const state = await store.load();
		expect(state.jobs.map(job => job.id)).toEqual(["cron-1"]);
		// The prune is persisted on the next mutation: reload sees only cron.
		await fs.writeFile(sidecar, JSON.stringify({ version: 1, jobs: [cronJob, legacyHeartbeat], dispatches: [] }));
		const store2 = new JsonScheduleStore({ filePath: sidecar });
		expect((await store2.load()).jobs.map(job => job.id)).toEqual(["cron-1"]);
	});

	it("garbage-collects terminal jobs past the retention window", async () => {
		using tempDir = TempDir.createSync("@pi-cron-gc-");
		const sidecar = path.join(tempDir.path(), "scheduled-jobs.json");
		const now = new Date("2026-09-05T12:00:00.000Z");
		const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString();
		const fresh = new Date(now.getTime() - 1_000).toISOString();
		const cancelledOld = {
			id: "old-cancelled",
			source: "cron",
			status: "cancelled",
			sessionId: "sess",
			sessionFile: "/s.jsonl",
			cwd: "/c",
			prompt: "old",
			schedule: { kind: "interval", expression: "every 1h", intervalMs: 3_600_000 },
			createdAt: old,
			updatedAt: old,
			runCount: 3,
		};
		const completedFresh = {
			id: "fresh-completed",
			source: "cron",
			status: "completed",
			sessionId: "sess",
			sessionFile: "/s.jsonl",
			cwd: "/c",
			prompt: "fresh",
			schedule: { kind: "once", expression: "in 10m" },
			createdAt: fresh,
			updatedAt: fresh,
			runCount: 1,
		};
		await fs.writeFile(sidecar, JSON.stringify({ version: 1, jobs: [cancelledOld, completedFresh], dispatches: [] }));
		const store = new JsonScheduleStore({ filePath: sidecar, now: () => now });
		const state = await store.load();
		expect(state.jobs.map(job => job.id)).toEqual(["fresh-completed"]);
	});
});

describe("CronHubOverlayComponent", () => {
	const NOW = Date.parse("2026-09-05T12:00:00.000Z");

	function makeJob(overrides: Partial<Parameters<typeof makeJobFixture>[0]> = {}) {
		return makeJobFixture(overrides);
	}

	function makeJobFixture({
		id = "job-1",
		status = "active",
		expression = "every 10m",
		nextRunAt = new Date(NOW + 600_000).toISOString(),
		runCount = 3,
	}: {
		id?: string;
		status?: "active" | "paused" | "cancelled" | "completed" | "failed";
		expression?: string;
		nextRunAt?: string;
		runCount?: number;
	}) {
		return {
			id,
			source: "cron" as const,
			status,
			deliveryMode: "follow_up" as const,
			sessionId: "sess",
			sessionFile: "/s.jsonl",
			cwd: "/c",
			prompt: "check the queue",
			schedule: { kind: "interval" as const, expression, intervalMs: 600_000 },
			createdAt: "2026-09-05T00:00:00.000Z",
			updatedAt: "2026-09-05T00:00:00.000Z",
			nextRunAt,
			runCount,
		};
	}

	interface HubHarness {
		hub: CronHubOverlayComponent;
		managed: Array<{ id: string; action: string }>;
		runNow: string[];
		done: () => void;
		readonly doneCalled: boolean;
		setJobs: (jobs: ReturnType<typeof makeJobFixture>[]) => void;
	}

	function makeHub(initialJobs: ReturnType<typeof makeJobFixture>[]): HubHarness {
		const jobs = [...initialJobs];
		const managed: Array<{ id: string; action: string }> = [];
		const runNow: string[] = [];
		let doneCalled = false;
		const harness: HubHarness = {
			managed,
			runNow,
			done: () => {
				doneCalled = true;
			},
			get doneCalled() {
				return doneCalled;
			},
			setJobs(next) {
				jobs.length = 0;
				jobs.push(...next);
			},
			hub: undefined as unknown as CronHubOverlayComponent,
		};
		harness.hub = new CronHubOverlayComponent({
			listJobs: async () => jobs,
			manageJob: async (id, action) => {
				managed.push({ id, action });
				return undefined;
			},
			runNow: async job => {
				runNow.push(job.id);
			},
			onDone: harness.done,
			requestRender: () => {},
		});
		return harness;
	}

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("renders the lifecycle-framed list with rows and empty state", async () => {
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		const { hub } = makeHub([makeJob(), makeJob({ id: "job-2", status: "paused", runCount: 0 })]);
		await flushAsync();
		const lines = hubLines(hub);
		const joined = lines.join("\n");
		expect(joined).toContain("Cron Jobs — this session's lifecycle");
		expect(joined).toContain("check the queue");
		expect(joined).toContain("every 10m");
		expect(joined).toContain("in 10m");

		const empty = makeHub([]);
		await flushAsync();
		const emptyLines = empty.hubLinesJoined ?? stripAnsi(empty.hub.render(120).join("\n"));
		expect(emptyLines).toContain("No scheduled prompts for this session.");
		expect(emptyLines).toContain("/cron add");
	});

	it("renders the detail view with prompt and delivery", async () => {
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		const { hub } = makeHub([makeJob()]);
		await flushAsync();
		hub.handleInput("\r");
		const joined = hubLines(hub).join("\n");
		expect(joined).toContain("Cron Job");
		expect(joined).toContain("check the queue");
		expect(joined).toContain("follow_up");
	});

	it("routes pause/resume, cancel, and run-now through the deps", async () => {
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		const harness = makeHub([makeJob(), makeJob({ id: "job-2", status: "paused" })]);
		await flushAsync();

		harness.hub.handleInput("p"); // active -> pause
		await flushAsync();
		expect(harness.managed.at(-1)).toEqual({ id: "job-1", action: "pause" });

		harness.hub.handleInput("j");
		harness.hub.handleInput("p"); // paused -> resume
		await flushAsync();
		expect(harness.managed.at(-1)).toEqual({ id: "job-2", action: "resume" });

		harness.hub.handleInput("x");
		await flushAsync();
		expect(harness.managed.at(-1)).toEqual({ id: "job-2", action: "cancel" });

		harness.hub.handleInput("k");
		harness.hub.handleInput("k");
		harness.hub.handleInput("r"); // back on job-1 (active) -> run now
		await flushAsync();
		expect(harness.runNow).toEqual(["job-1"]);

		harness.hub.handleInput("x");
		harness.hub.handleInput("\x1b"); // escape closes
		expect(harness.doneCalled).toBe(true);
	});

	it("refuses run-now on non-active jobs", async () => {
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		const harness = makeHub([makeJob({ id: "job-2", status: "cancelled" })]);
		await flushAsync();
		harness.hub.handleInput("r");
		await flushAsync();
		expect(harness.runNow).toEqual([]);
		const joined = hubLines(harness.hub).join("\n");
		expect(joined).toContain("Only active jobs");
	});
});

describe("omp cron CLI collector", () => {
	it("discovers sidecars across project/session dirs and parses job rows", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cron-cli-"));
		try {
			const sidecarDir = path.join(root, "sessions", "proj-a", "20260905_session");
			await fs.mkdir(sidecarDir, { recursive: true });
			await fs.writeFile(
				path.join(sidecarDir, "scheduled-jobs.json"),
				JSON.stringify({
					version: 1,
					jobs: [
						{
							id: "11111111-2222-3333-4444-555555555555",
							source: "cron",
							status: "active",
							prompt: "watch the build",
							schedule: { kind: "cron", expression: "0 9 * * 1-5" },
							nextRunAt: "2026-09-06T09:00:00.000Z",
							runCount: 4,
							updatedAt: "2026-09-05T00:00:00.000Z",
						},
					],
					dispatches: [],
				}),
			);
			const sidecars = await discoverCronSidecars(root);
			expect(sidecars).toHaveLength(1);
			const text = await fs.readFile(sidecars[0]!, "utf8");
			const rows = parseCronSidecar(sidecars[0]!, text);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				project: "proj-a",
				status: "active",
				schedule: "0 9 * * 1-5",
				runCount: 4,
			});

			// Corrupt sidecars are tolerated as empty.
			const corruptDir = path.join(root, "sessions", "proj-b", "sess");
			await fs.mkdir(corruptDir, { recursive: true });
			await fs.writeFile(path.join(corruptDir, "scheduled-jobs.json"), "{ not json");
			const rowsAfterCorrupt = await collectCronRows(root);
			expect(rowsAfterCorrupt).toHaveLength(1);

			// JSON output is machine-readable.
			const allRows = await collectCronRows(root);
			expect(JSON.stringify(allRows)).toContain("watch the build");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
