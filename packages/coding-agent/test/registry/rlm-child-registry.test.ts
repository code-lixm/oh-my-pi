import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../../src/async/job-manager";
import { RLM_JOB_TYPE } from "../../src/async/rlm-job-policy";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { RlmChildRegistry } from "../../src/registry/rlm-child-registry";
import type { AgentSession } from "../../src/session/agent-session";

const tempRoots: string[] = [];
beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
});

async function freshRegistry(): Promise<{ registry: RlmChildRegistry; artifactsDir: string }> {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "rlm-registry-test-"));
	tempRoots.push(base);
	const artifactsDir = path.join(base, "artifacts");
	await fs.mkdir(artifactsDir, { recursive: true });
	const registry = await RlmChildRegistry.open({
		parentAgentId: "Main",
		parentSessionFile: path.join(base, "session.jsonl"),
		artifactsDir,
		isJobLive: () => false,
	});
	return { registry, artifactsDir };
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("RlmChildRegistry", () => {
	it("admits a child with a durable queued record and a pre-created session dir", async () => {
		const { registry, artifactsDir } = await freshRegistry();
		const admitted = await registry.admit({
			rlmChildId: "child-1",
			name: "worker",
			model: "provider/model",
			taskDepth: 1,
			maxDepth: 1,
		});
		expect(admitted.rlm_child_id).toBe("child-1");
		expect(admitted.run_status).toBe("queued");
		expect(admitted.session_dir).toBe(path.join(artifactsDir, "rlm", "child-1"));
		expect(await Bun.file(path.join(admitted.session_dir, ".keep")).exists()).toBe(true);

		const entries = registry.snapshotEntries();
		expect(entries).toHaveLength(1);
		// `queued` projects to the three-state public `running` status.
		expect(entries[0]!.status).toBe("running");
	});

	it("rejects duplicate child ids and names within the same parent", async () => {
		const { registry } = await freshRegistry();
		await registry.admit({ rlmChildId: "child-1", name: "worker", model: "m", taskDepth: 1, maxDepth: 1 });
		await expect(
			registry.admit({ rlmChildId: "child-1", name: "other", model: "m", taskDepth: 1, maxDepth: 1 }),
		).rejects.toThrow(/already reserved/);
		await expect(
			registry.admit({ rlmChildId: "child-2", name: "worker", model: "m", taskDepth: 1, maxDepth: 1 }),
		).rejects.toThrow(/already in use/);
	});

	it("walks queued → running → completed and drops deleted children from listing", async () => {
		const { registry } = await freshRegistry();
		await registry.admit({ rlmChildId: "child-1", name: "worker", model: "m", taskDepth: 1, maxDepth: 1 });
		await registry.markRunning("child-1", { sessionId: "sess-1", sessionFile: "/tmp/child.jsonl" });
		expect(registry.snapshotEntries()[0]!.status).toBe("running");
		await registry.markSettled("child-1", { status: "completed" });
		expect(registry.snapshotEntries()[0]!.status).toBe("completed");

		const deletion = await registry.deleteDirectChild("child-1", "test cleanup");
		expect(deletion).toEqual({ rlm_child_id: "child-1", name: "worker", deleted: true });
		expect(registry.snapshotEntries()).toHaveLength(0);
	});

	it("rehydrates final snapshots for multiple children after sequential mutations", async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "rlm-registry-rehydrate-"));
		tempRoots.push(base);
		const artifactsDir = path.join(base, "artifacts");
		const parent = {
			parentAgentId: "Main",
			parentSessionFile: path.join(base, "session.jsonl"),
			artifactsDir,
			isJobLive: () => false,
		};
		const first = await RlmChildRegistry.open(parent);
		await first.admit({ rlmChildId: "child-1", name: "completed-worker", model: "m", taskDepth: 1, maxDepth: 1 });
		await first.markSettled("child-1", { status: "completed" });
		await first.admit({ rlmChildId: "child-2", name: "failed-worker", model: "m", taskDepth: 1, maxDepth: 1 });
		await first.markSettled("child-2", { status: "failed", error: "boom" });

		const reopened = await RlmChildRegistry.open(parent);
		const hydrated = await reopened.list();
		expect(hydrated).toHaveLength(2);
		expect(hydrated).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ rlm_child_id: "child-1", name: "completed-worker", run_status: "completed" }),
				expect.objectContaining({
					rlm_child_id: "child-2",
					name: "failed-worker",
					run_status: "failed",
					error: "boom",
				}),
			]),
		);
	});

	it("rehydrates only children backed by readable transcripts and removes unreadable parked refs", async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "rlm-registry-readable-rehydrate-"));
		tempRoots.push(base);
		const artifactsDir = path.join(base, "artifacts");
		const parentAgentId = "rehydrate-parent";
		const readableSessionFile = path.join(base, "readable-child.jsonl");
		const unreadableSessionFile = path.join(base, "empty-child.jsonl");
		await fs.writeFile(readableSessionFile, '{"type":"message"}\n');
		await fs.writeFile(unreadableSessionFile, "");

		const agentRegistry = AgentRegistry.global();
		const rehydratedIds: string[] = [];
		const registry = await RlmChildRegistry.open({
			parentAgentId,
			parentSessionFile: path.join(base, "parent.jsonl"),
			artifactsDir,
			isJobLive: () => false,
			agentRegistry,
			rehydrateChild: async child => {
				rehydratedIds.push(child.rlm_child_id);
				agentRegistry.registerIfAvailable(
					{
						id: child.rlm_child_id,
						displayName: child.name,
						kind: "sub",
						parentId: parentAgentId,
						status: "parked",
						session: null,
						sessionFile: child.session_file,
					},
					null,
				);
			},
		});
		const readable = await registry.admit({
			rlmChildId: "readable-child",
			name: "readable",
			model: "provider/model",
			taskDepth: 1,
			maxDepth: 2,
		});
		await registry.markRunning(readable.rlm_child_id, { sessionFile: readableSessionFile });
		await registry.markSettled(readable.rlm_child_id, { status: "completed" });
		const unreadable = await registry.admit({
			rlmChildId: "empty-child",
			name: "empty",
			model: "provider/model",
			taskDepth: 1,
			maxDepth: 2,
		});
		await registry.markRunning(unreadable.rlm_child_id, { sessionFile: unreadableSessionFile });
		await registry.markSettled(unreadable.rlm_child_id, { status: "completed" });
		agentRegistry.register({
			id: unreadable.rlm_child_id,
			displayName: unreadable.name,
			kind: "sub",
			parentId: parentAgentId,
			status: "parked",
			session: null,
			sessionFile: unreadableSessionFile,
		});

		await registry.rehydrate({ retryTerminalNotices: false });

		expect(rehydratedIds).toEqual([readable.rlm_child_id]);
		expect(agentRegistry.get(readable.rlm_child_id)).toMatchObject({
			status: "parked",
			session: null,
			sessionFile: readableSessionFile,
		});
		expect(agentRegistry.get(unreadable.rlm_child_id)).toBeUndefined();
	});

	it("cancels queued and running direct jobs on parent disposal, releases refs, keeps settled rows, and stops notice retries", async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "rlm-registry-parent-dispose-"));
		tempRoots.push(base);
		const parentAgentId = "disposing-parent";
		const artifactsDir = path.join(base, "artifacts");
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		const agentRegistry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		const registry = await RlmChildRegistry.open({
			parentAgentId,
			parentSessionFile: path.join(base, "parent.jsonl"),
			artifactsDir,
			isJobLive: jobId => manager.getJob(jobId)?.status === "running",
			cancelJob: (jobId, ownerId) => manager.cancel(jobId, { ownerId }),
			agentRegistry,
			lifecycle,
		});
		const waitForAbort = (signal: AbortSignal) =>
			new Promise<string>(resolve => {
				if (signal.aborted) {
					resolve("cancelled");
					return;
				}
				signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
			});
		const queuedJobId = manager.register(
			RLM_JOB_TYPE,
			"queued direct child",
			async ({ signal }) => await waitForAbort(signal),
			{ id: "queued-direct-job", ownerId: parentAgentId, queued: true },
		);
		const runningJobId = manager.register(
			RLM_JOB_TYPE,
			"running direct child",
			async ({ signal }) => await waitForAbort(signal),
			{ id: "running-direct-job", ownerId: parentAgentId },
		);
		const settledJobId = manager.register(RLM_JOB_TYPE, "settled direct child", async () => "settled", {
			id: "settled-direct-job",
			ownerId: parentAgentId,
		});

		try {
			await registry.admit({
				rlmChildId: "queued-child",
				name: "queued-child",
				model: "provider/model",
				jobId: queuedJobId,
				taskDepth: 1,
				maxDepth: 2,
			});
			await registry.admit({
				rlmChildId: "running-child",
				name: "running-child",
				model: "provider/model",
				jobId: runningJobId,
				taskDepth: 1,
				maxDepth: 2,
			});
			await registry.markRunning("running-child", {
				sessionId: "running-session",
				sessionFile: path.join(base, "running-child.jsonl"),
			});
			await registry.admit({
				rlmChildId: "settled-child",
				name: "settled-child",
				model: "provider/model",
				jobId: settledJobId,
				taskDepth: 1,
				maxDepth: 2,
			});
			await registry.markRunning("settled-child", {
				sessionId: "settled-session",
				sessionFile: path.join(base, "settled-child.jsonl"),
			});
			await manager.getJob(settledJobId)?.promise;
			await registry.markSettled("settled-child", { status: "completed" });

			let liveRefDisposed = false;
			const liveSession = {
				sessionManager: { getSessionId: () => "running-session" },
				dispose: async () => {
					liveRefDisposed = true;
				},
			} as unknown as AgentSession;
			agentRegistry.register({
				id: "running-child",
				displayName: "running-child",
				kind: "sub",
				parentId: parentAgentId,
				status: "running",
				session: liveSession,
				sessionFile: path.join(base, "running-child.jsonl"),
			});
			agentRegistry.register({
				id: "queued-child",
				displayName: "queued-child",
				kind: "sub",
				parentId: parentAgentId,
				status: "parked",
				session: null,
				sessionFile: path.join(base, "queued-child.jsonl"),
			});
			const retriedNotices: string[] = [];
			registry.setPendingTerminalNoticeRetry(async child => {
				retriedNotices.push(child.rlm_child_id);
			});

			await registry.disposeDirectChildren("parent shutdown");
			await manager.waitForAll();

			expect(manager.getJob(queuedJobId)?.status).toBe("cancelled");
			expect(manager.getJob(runningJobId)?.status).toBe("cancelled");
			expect(manager.getJob(settledJobId)?.status).toBe("completed");
			expect(liveRefDisposed).toBe(true);
			expect(agentRegistry.get("running-child")).toBeUndefined();
			expect(agentRegistry.get("queued-child")).toBeUndefined();

			const reopened = await RlmChildRegistry.open({
				parentAgentId,
				parentSessionFile: path.join(base, "parent.jsonl"),
				artifactsDir,
				isJobLive: () => false,
			});
			expect(await reopened.list()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ rlm_child_id: "queued-child", run_status: "cancelled" }),
					expect.objectContaining({ rlm_child_id: "running-child", run_status: "cancelled" }),
					expect.objectContaining({ rlm_child_id: "settled-child", run_status: "completed" }),
				]),
			);
			await registry.retryPendingTerminalNotices();
			expect(retriedNotices).toEqual([]);
		} finally {
			manager.cancelAll();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 100 });
		}
	});
});
