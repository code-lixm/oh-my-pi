/**
 * Integration tests for CheckpointMetadataStore + CheckpointGc.
 *
 * Covers:
 * - WAL metadata persistence across reopen
 * - Create / list order & filters (two workspaces, session filter)
 * - Pin/unpin patch
 * - Restore plan lifecycle across reopen
 * - Redo edge persistence across reopen
 * - Transaction state filtering across reopen
 * - GC: pinned / guard / redo / active_transaction checkpoints are retained;
 *   orphaned automatic checkpoints are deleted and manifestObjectIds returned
 * - Concurrent open of the same DB file then writes do not corrupt the store
 */

import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	CheckpointMetadataStore,
	WorkspaceCheckpointRecord,
} from "@oh-my-pi/pi-coding-agent/workspace-checkpoints";
import {
	createCheckpointGc,
	createCheckpointMetadataStore,
	workspaceIdForRoot,
} from "@oh-my-pi/pi-coding-agent/workspace-checkpoints";
import type { CheckpointGc } from "@oh-my-pi/pi-coding-agent/workspace-checkpoints/gc";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Minimal manifest object ID for tests. */
function mobjid(label: string): string {
	return `cas:${label}`;
}

// ─── store factory ───────────────────────────────────────────────────────────

function makeStore(storageDir: string): CheckpointMetadataStore {
	return createCheckpointMetadataStore({ storageDir });
}

// ─── test harness ─────────────────────────────────────────────────────────────

interface Harness {
	store: CheckpointMetadataStore;
	gc: CheckpointGc;
	root: string;
	storageDir: string;
	wsA: string;
	wsB: string;
}

const activeHarnesses: Harness[] = [];

async function openHarness(): Promise<Harness> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ws-cp-"));
	const storageDir = path.join(root, "checkpoints");
	const wsA = path.join(root, "workspace-a");
	const wsB = path.join(root, "workspace-b");
	await fs.mkdir(wsA, { recursive: true });
	await fs.mkdir(wsB, { recursive: true });
	const store = makeStore(storageDir);
	await store.init();
	// Use real clock for GC so created_at comparisons work correctly.
	const gc = createCheckpointGc(store, () => Date.now());
	const harness: Harness = { store, gc, root, storageDir, wsA, wsB };
	activeHarnesses.push(harness);
	return harness;
}

afterEach(async () => {
	while (activeHarnesses.length > 0) {
		const h = activeHarnesses.pop()!;
		h.store.close();
		await fs.rm(h.root, { recursive: true, force: true });
	}
});

// ─── createCheckpoint shortcut ─────────────────────────────────────────────────

async function createCp(
	store: CheckpointMetadataStore,
	ws: string,
	reason: WorkspaceCheckpointRecord["reason"] = "turn",
	manifestObjectId?: string,
): Promise<WorkspaceCheckpointRecord> {
	return store.createCheckpoint({
		rootPath: ws,
		reason,
		manifestObjectId: manifestObjectId ?? mobjid(`cp-${reason}-${Date.now()}`),
	});
}

// ─── SQL age helpers ─────────────────────────────────────────────────────────
//
// The store uses `new Date().toISOString()` for `created_at`.  Tests that need an
// "old" checkpoint backdate it via direct SQL so the GC's age cutoff
// (Date.now() - 24h) correctly marks it as eligible.

function storeDbPath(store: CheckpointMetadataStore): string {
	const sqliteStore = store as CheckpointMetadataStore & { dbPath: string };
	return sqliteStore.dbPath;
}

function setCheckpointCreatedAt(store: CheckpointMetadataStore, checkpointId: string, createdAt: string): void {
	const db = new Database(storeDbPath(store));
	db.prepare("UPDATE checkpoints SET created_at = ? WHERE id = ?").run(createdAt, checkpointId);
	db.close();
}

/** Backdate all checkpoints in a workspace to 25h ago via SQL. */
function ageRecentCheckpoints(store: CheckpointMetadataStore, ws: string, _count: number): void {
	const db = new Database(storeDbPath(store));
	const oldMs = Date.now() - 25 * 60 * 60 * 1000 - 1;
	const oldIso = new Date(oldMs).toISOString();
	db.prepare("UPDATE checkpoints SET created_at = ? WHERE root_path = ?").run(oldIso, ws);
	db.close();

	void _count;
}

// ─── WAL metadata persistence ─────────────────────────────────────────────────

test("WAL mode is set on the DB and data survives close+reopen", async () => {
	const harness = await openHarness();
	const { storageDir, wsA } = harness;

	const cp = await createCp(harness.store, wsA, "manual");
	await harness.store.putWorkspaceState({
		rootPath: wsA,
		undoHeadCheckpointId: cp.id,
		restoreSequence: 1,
	});
	harness.store.close();

	const store2 = makeStore(storageDir);
	await store2.init();
	const cps = await store2.listCheckpoints({ rootPath: wsA });
	const workspaces = await store2.listWorkspaces();

	expect(cps).toHaveLength(1);
	expect(cps[0]!.reason).toBe("manual");
	expect(workspaces).toHaveLength(1);
	expect(workspaces[0]!.undoHeadCheckpointId).toBe(cp.id);

	store2.close();
});

test("WAL file is present after writes", async () => {
	const harness = await openHarness();
	const { storageDir, wsA } = harness;

	await createCp(harness.store, wsA, "turn");
	harness.store.close();

	const walPath = `${path.join(storageDir, "metadata.db")}-wal`;
	const exists = await Bun.file(walPath).exists();
	expect(exists).toBe(true);
});

// ─── create + list order & filtering ─────────────────────────────────────────

test("listCheckpoints returns newest-first for workspace A (wsB checkpoints absent)", async () => {
	const harness = await openHarness();
	const { store, wsA, wsB } = harness;

	const cp1 = await createCp(store, wsA, "turn");
	const cp2 = await createCp(store, wsA, "user_bash");
	await createCp(store, wsB, "turn");

	setCheckpointCreatedAt(store, cp1.id, new Date(Date.now() - 2_000).toISOString());
	setCheckpointCreatedAt(store, cp2.id, new Date(Date.now() - 1_000).toISOString());

	const list = await store.listCheckpoints({ rootPath: wsA });
	expect(list).toHaveLength(2);
	expect(list[0]!.id).toBe(cp2.id);
	expect(list[1]!.id).toBe(cp1.id);
});

test("listCheckpoints sessionId filter returns only matching checkpoints", async () => {
	const harness = await openHarness();
	const { store, wsA } = harness;

	const cp1 = await store.createCheckpoint({
		rootPath: wsA,
		reason: "turn",
		sessionId: "session-alpha",
		manifestObjectId: mobjid("cp1"),
	});
	const cp2 = await store.createCheckpoint({
		rootPath: wsA,
		reason: "turn",
		sessionId: "session-alpha",
		manifestObjectId: mobjid("cp2"),
	});
	const cp3 = await store.createCheckpoint({
		rootPath: wsA,
		reason: "turn",
		sessionId: "session-beta",
		manifestObjectId: mobjid("cp3"),
	});

	const listAlpha = await store.listCheckpoints({ sessionId: "session-alpha" });
	const listBeta = await store.listCheckpoints({ sessionId: "session-beta" });

	expect(listAlpha).toHaveLength(2);
	expect([cp1.id, cp2.id].sort()).toEqual(listAlpha.map((c: WorkspaceCheckpointRecord) => c.id).sort());
	expect(listBeta).toHaveLength(1);
	expect(listBeta[0]!.id).toBe(cp3.id);
});

test("listCheckpoints reason filter works", async () => {
	const harness = await openHarness();
	const { store, wsA } = harness;

	await createCp(store, wsA, "turn");
	await createCp(store, wsA, "user_bash");
	await createCp(store, wsA, "manual");
	await createCp(store, wsA, "manual");

	const manual = await store.listCheckpoints({ reason: "manual" });
	const turn = await store.listCheckpoints({ reason: "turn" });

	expect(manual).toHaveLength(2);
	expect(manual.every((c: WorkspaceCheckpointRecord) => c.reason === "manual")).toBe(true);
	expect(turn).toHaveLength(1);
	expect(turn[0]!.reason).toBe("turn");
});

test("listCheckpoints pinnedOnly returns only pinned checkpoints", async () => {
	const harness = await openHarness();
	const { store, wsA } = harness;

	const cp1 = await createCp(store, wsA, "turn");
	await createCp(store, wsA, "turn");
	await createCp(store, wsA, "turn");
	await store.pinCheckpoint(cp1.id, true);

	const pinned = await store.listCheckpoints({ pinnedOnly: true });
	expect(pinned).toHaveLength(1);
	expect(pinned[0]!.id).toBe(cp1.id);
});

test("listCheckpoints automaticOnly excludes pinned and labeled checkpoints", async () => {
	const harness = await openHarness();
	const { store, wsA } = harness;

	const auto1 = await createCp(store, wsA, "turn");
	const auto2 = await createCp(store, wsA, "turn");
	const pinned = await createCp(store, wsA, "turn");
	const labeled = await createCp(store, wsA, "turn");

	await store.pinCheckpoint(pinned.id, true);
	await store.updateCheckpoint(labeled.id, { label: "my snapshot" });

	const list = await store.listCheckpoints({ automaticOnly: true });
	const ids = list.map((c: WorkspaceCheckpointRecord) => c.id);

	expect(ids).toContain(auto1.id);
	expect(ids).toContain(auto2.id);
	expect(ids).not.toContain(pinned.id);
	expect(ids).not.toContain(labeled.id);
});

test("listCheckpoints with limit returns at most N checkpoints", async () => {
	const harness = await openHarness();
	const { store, wsA } = harness;

	for (let i = 0; i < 10; i++) await createCp(store, wsA, "turn");

	const list = await store.listCheckpoints({ rootPath: wsA, limit: 3 });
	expect(list).toHaveLength(3);
});

// ─── pin patch ────────────────────────────────────────────────────────────────

test("pinCheckpoint sets pinned=true and persists across reopen", async () => {
	const harness = await openHarness();
	const { store, storageDir, wsA } = harness;

	const cp = await createCp(store, wsA, "turn");
	expect(cp.pinned).toBe(false);

	const updated = await store.pinCheckpoint(cp.id, true);
	expect(updated.pinned).toBe(true);

	store.close();

	const store2 = makeStore(storageDir);
	await store2.init();
	const reloaded = await store2.getCheckpoint(cp.id);
	expect(reloaded?.pinned).toBe(true);

	store2.close();
});

test("pinCheckpoint false unpins and persists across reopen", async () => {
	const harness = await openHarness();
	const { store, storageDir, wsA } = harness;

	const cp = await createCp(store, wsA, "turn");
	await store.pinCheckpoint(cp.id, true);
	await store.pinCheckpoint(cp.id, false);

	store.close();

	const store2 = makeStore(storageDir);
	await store2.init();
	const reloaded = await store2.getCheckpoint(cp.id);
	expect(reloaded?.pinned).toBe(false);

	store2.close();
});

test("updateCheckpoint with label patch persists across reopen", async () => {
	const harness = await openHarness();
	const { store, storageDir, wsA } = harness;

	const cp = await createCp(store, wsA, "turn");
	const patched = await store.updateCheckpoint(cp.id, {
		label: "exploratory run",
	});
	expect(patched.label).toBe("exploratory run");

	store.close();

	const store2 = makeStore(storageDir);
	await store2.init();
	const reloaded = await store2.getCheckpoint(cp.id);
	expect(reloaded?.label).toBe("exploratory run");

	store2.close();
});

// ─── restore plan cross-reopen ────────────────────────────────────────────────

test("createRestorePlan persists and is retrievable after reopen", async () => {
	const harness = await openHarness();
	const { store, storageDir, wsA } = harness;

	const cp = await createCp(store, wsA, "turn");
	const plan = await store.createRestorePlan({
		checkpointId: cp.id,
		rootPath: wsA,
		scope: "code",
		strategy: "preserve",
		operations: [{ path: "src/main.ts", kind: "update", objectId: "obj1" }],
		conflicts: [],
	});

	expect(plan.id).toBeTruthy();
	expect(plan.checkpointId).toBe(cp.id);
	expect(plan.scope).toBe("code");

	store.close();

	const store2 = makeStore(storageDir);
	await store2.init();
	const reloaded = await store2.getRestorePlan(plan.id);
	expect(reloaded).not.toBeNull();
	expect(reloaded!.id).toBe(plan.id);
	expect(reloaded!.operations).toHaveLength(1);
	expect(reloaded!.operations[0]!.path).toBe("src/main.ts");

	store2.close();
});

test("updateRestorePlan status transition persists after reopen", async () => {
	const harness = await openHarness();
	const { store, storageDir, wsA } = harness;

	const cp = await createCp(store, wsA, "turn");
	const plan = await store.createRestorePlan({
		checkpointId: cp.id,
		rootPath: wsA,
		scope: "all",
		strategy: "exact",
		operations: [],
		conflicts: [],
	});

	await store.updateRestorePlan(plan.id, { status: "applied" });
	store.close();

	const store2 = makeStore(storageDir);
	await store2.init();
	const reloaded = await store2.getRestorePlan(plan.id);
	expect(reloaded?.status).toBe("applied");

	store2.close();
});

test("listRestorePlans filter by checkpointId and status", async () => {
	const harness = await openHarness();
	const { store, wsA } = harness;

	const cp1 = await createCp(store, wsA, "turn");
	const cp2 = await createCp(store, wsA, "turn");

	const plan1 = await store.createRestorePlan({
		checkpointId: cp1.id,
		rootPath: wsA,
		scope: "code",
		strategy: "preserve",
		operations: [],
		conflicts: [],
	});
	const plan2 = await store.createRestorePlan({
		checkpointId: cp2.id,
		rootPath: wsA,
		scope: "code",
		strategy: "preserve",
		operations: [],
		conflicts: [],
	});
	await store.updateRestorePlan(plan1.id, { status: "applied" });

	const byCp1 = await store.listRestorePlans({ checkpointId: cp1.id });
	const pending = await store.listRestorePlans({ status: "pending" });

	expect(byCp1).toHaveLength(1);
	expect(byCp1[0]!.id).toBe(plan1.id);
	expect(pending.map((p: { id: string }) => p.id).sort()).toEqual([plan2.id].sort());
});

// ─── redo edge cross-reopen ───────────────────────────────────────────────────

test("setRedoEdge + getRedoEdge persist across reopen", async () => {
	const harness = await openHarness();
	const { store, storageDir, wsA } = harness;

	const cpA = await createCp(store, wsA, "turn");
	const cpB = await createCp(store, wsA, "turn");

	await store.setRedoEdge({
		rootPath: wsA,
		targetCheckpointId: cpB.id,
		sourceCheckpointId: cpA.id,
		planId: null,
		createdAt: new Date().toISOString(),
	});

	store.close();

	const store2 = makeStore(storageDir);
	await store2.init();
	const edge = await store2.getRedoEdge(wsA);
	expect(edge).not.toBeNull();
	expect(edge!.targetCheckpointId).toBe(cpB.id);
	expect(edge!.sourceCheckpointId).toBe(cpA.id);

	store2.close();
});

test("clearRedoEdge removes the edge", async () => {
	const harness = await openHarness();
	const { store, storageDir, wsA } = harness;

	const cp = await createCp(store, wsA, "turn");
	await store.setRedoEdge({
		rootPath: wsA,
		targetCheckpointId: cp.id,
		sourceCheckpointId: null,
		planId: null,
		createdAt: new Date().toISOString(),
	});

	await store.clearRedoEdge(wsA);
	store.close();

	const store2 = makeStore(storageDir);
	await store2.init();
	const edge = await store2.getRedoEdge(wsA);
	expect(edge).toBeNull();

	store2.close();
});

// ─── transaction state filtering across reopen ─────────────────────────────────

test("recordTransactionStart creates open transaction and listIncompleteTransactions returns it", async () => {
	const harness = await openHarness();
	const { store, storageDir, wsA } = harness;

	const cp = await createCp(store, wsA, "turn");
	const tx = await store.recordTransactionStart({
		rootPath: wsA,
		checkpointId: cp.id,
		guardCheckpointId: cp.id,
	});

	expect(tx.state).toBe("open");
	expect(tx.checkpointId).toBe(cp.id);

	const incomplete = await store.listIncompleteTransactions(wsA);
	expect(incomplete).toHaveLength(1);
	expect(incomplete[0]!.id).toBe(tx.id);

	store.close();

	const store2 = makeStore(storageDir);
	await store2.init();
	const incomplete2 = await store2.listIncompleteTransactions(wsA);
	expect(incomplete2).toHaveLength(1);
	expect(incomplete2[0]!.state).toBe("open");

	store2.close();
});

test("markTransactionStatus to committed removes from incomplete list", async () => {
	const harness = await openHarness();
	const { store, storageDir, wsA } = harness;

	const cp = await createCp(store, wsA, "turn");
	const tx = await store.recordTransactionStart({
		rootPath: wsA,
		checkpointId: cp.id,
	});

	await store.markTransactionStatus(tx.id, "committed");
	store.close();

	const store2 = makeStore(storageDir);
	await store2.init();
	const incomplete = await store2.listIncompleteTransactions(wsA);
	expect(incomplete).toHaveLength(0);

	const txReloaded = await store2.getTransaction(tx.id);
	expect(txReloaded?.state).toBe("committed");
	expect(txReloaded?.completedAt).not.toBeNull();

	store2.close();
});

test("markTransactionStatus to rolled_back removes from incomplete list", async () => {
	const harness = await openHarness();
	const { store, storageDir, wsA } = harness;

	const cp = await createCp(store, wsA, "turn");
	const tx = await store.recordTransactionStart({
		rootPath: wsA,
		checkpointId: cp.id,
	});

	await store.markTransactionStatus(tx.id, "rolled_back");
	store.close();

	const store2 = makeStore(storageDir);
	await store2.init();
	const incomplete = await store2.listIncompleteTransactions(wsA);
	expect(incomplete).toHaveLength(0);

	const txReloaded = await store2.getTransaction(tx.id);
	expect(txReloaded?.state).toBe("rolled_back");

	store2.close();
});

test("listTransactions with state filter returns only matching transactions", async () => {
	const harness = await openHarness();
	const { store, wsA } = harness;

	await createCp(store, wsA, "turn");
	await createCp(store, wsA, "turn");
	await createCp(store, wsA, "turn");

	const tx1 = await store.recordTransactionStart({ rootPath: wsA });
	const tx2 = await store.recordTransactionStart({ rootPath: wsA });
	await store.recordTransactionStart({ rootPath: wsA }); // stays open

	await store.markTransactionStatus(tx1.id, "committed");
	await store.markTransactionStatus(tx2.id, "rolled_back");

	const open = await store.listTransactions({ state: "open" });
	const committed = await store.listTransactions({ state: "committed" });
	const rolledBack = await store.listTransactions({ state: "rolled_back" });

	expect(open).toHaveLength(1);
	expect(committed).toHaveLength(1);
	expect(rolledBack).toHaveLength(1);
});

// ─── GC — pinned / guard / redo / active_transaction retain checkpoints ────────

test("GC plan: pinned checkpoint is NOT in removedCheckpointIds", async () => {
	const harness = await openHarness();
	const { store, gc, wsA } = harness;

	const pinned = await createCp(store, wsA, "turn");
	await createCp(store, wsA, "turn");
	await store.pinCheckpoint(pinned.id, true);
	ageRecentCheckpoints(store, wsA, 2);

	const result = await gc.plan({ rootPath: wsA });
	expect(result.removedCheckpointIds).not.toContain(pinned.id);
});

test("GC plan: named checkpoint (label set) is NOT in removedCheckpointIds", async () => {
	const harness = await openHarness();
	const { store, gc, wsA } = harness;

	const named = await createCp(store, wsA, "turn");
	await createCp(store, wsA, "turn");
	await store.updateCheckpoint(named.id, { label: "keep me" });
	ageRecentCheckpoints(store, wsA, 2);

	const result = await gc.plan({ rootPath: wsA });
	expect(result.removedCheckpointIds).not.toContain(named.id);
});

test("GC plan: checkpoint guarded by an open transaction is NOT removed", async () => {
	const harness = await openHarness();
	const { store, gc, wsA } = harness;

	const guard = await createCp(store, wsA, "restore_guard");
	await createCp(store, wsA, "turn");

	await store.recordTransactionStart({
		rootPath: wsA,
		guardCheckpointId: guard.id,
		checkpointId: guard.id,
	});
	ageRecentCheckpoints(store, wsA, 2);

	const result = await gc.plan({ rootPath: wsA });
	expect(result.removedCheckpointIds).not.toContain(guard.id);
});

test("GC plan: checkpoint at redo edge target is NOT removed", async () => {
	const harness = await openHarness();
	const { store, gc, wsA } = harness;

	const redoTarget = await createCp(store, wsA, "turn");
	await createCp(store, wsA, "turn");

	await store.setRedoEdge({
		rootPath: wsA,
		targetCheckpointId: redoTarget.id,
		sourceCheckpointId: null,
		planId: null,
		createdAt: new Date().toISOString(),
	});
	ageRecentCheckpoints(store, wsA, 2);

	const result = await gc.plan({ rootPath: wsA });
	expect(result.removedCheckpointIds).not.toContain(redoTarget.id);
});

test("GC plan: checkpoint at workspace pointer undo head is NOT removed", async () => {
	const harness = await openHarness();
	const { store, gc, wsA } = harness;

	const cp = await createCp(store, wsA, "turn");
	await store.putWorkspaceState({
		rootPath: wsA,
		undoHeadCheckpointId: cp.id,
	});
	ageRecentCheckpoints(store, wsA, 1);

	const result = await gc.plan({ rootPath: wsA });
	expect(result.removedCheckpointIds).not.toContain(cp.id);
});

test("GC plan retains session-scoped workspace pointers and redo edges", async () => {
	const harness = await openHarness();
	const { store, gc, wsA } = harness;
	const alphaHead = await store.createCheckpoint({
		rootPath: wsA,
		reason: "turn",
		sessionId: "alpha",
		manifestObjectId: mobjid("alpha-session-pointer"),
		advanceLastCheckpoint: false,
	});
	const betaRedoTarget = await store.createCheckpoint({
		rootPath: wsA,
		reason: "turn",
		sessionId: "beta",
		manifestObjectId: mobjid("beta-session-redo"),
		advanceLastCheckpoint: false,
	});
	await store.putWorkspaceState({
		rootPath: wsA,
		sessionId: "alpha",
		undoHeadCheckpointId: alphaHead.id,
		lastCheckpointId: alphaHead.id,
	});
	await store.setRedoEdge({
		rootPath: wsA,
		sessionId: "beta",
		targetCheckpointId: betaRedoTarget.id,
		sourceCheckpointId: null,
		planId: null,
		createdAt: new Date().toISOString(),
	});
	ageRecentCheckpoints(store, wsA, 2);

	let result = await gc.plan({ rootPath: wsA });
	expect(result.removedCheckpointIds).not.toContain(alphaHead.id);
	expect(result.removedCheckpointIds).not.toContain(betaRedoTarget.id);

	await store.deleteWorkspaceState(wsA, "alpha");
	await store.clearRedoEdge(wsA, "beta");
	result = await gc.plan({ rootPath: wsA });
	expect(result.removedCheckpointIds).toContain(alphaHead.id);
	expect(result.removedCheckpointIds).toContain(betaRedoTarget.id);
});

test("GC run: old orphaned automatic checkpoint is deleted and manifestObjectId returned", async () => {
	const harness = await openHarness();
	const { store, gc, wsA } = harness;

	const orphan = await createCp(store, wsA, "turn", mobjid("to-be-gc"));
	await createCp(store, wsA, "turn", mobjid("new-head"));
	setCheckpointCreatedAt(store, orphan.id, new Date(Date.now() - 25 * 60 * 60 * 1000 - 1).toISOString());

	const result = await gc.run({ rootPath: wsA });

	expect(result.removedCheckpointIds).toContain(orphan.id);
	expect(result.releasedObjectIds).toContain(mobjid("to-be-gc"));
	expect(result.keptCheckpointIds).not.toContain(orphan.id);

	const reloaded = await store.getCheckpoint(orphan.id);
	expect(reloaded).toBeNull();
});

test("GC run: pinned checkpoint survives run", async () => {
	const harness = await openHarness();
	const { store, gc, wsA } = harness;

	const pinned = await createCp(store, wsA, "turn", mobjid("pinned-cp"));
	await store.pinCheckpoint(pinned.id, true);
	ageRecentCheckpoints(store, wsA, 1);

	const result = await gc.run({ rootPath: wsA });

	expect(result.removedCheckpointIds).not.toContain(pinned.id);

	const reloaded = await store.getCheckpoint(pinned.id);
	expect(reloaded).not.toBeNull();
});

test("GC plan: multiple protections stack (pinned + redo_edge + active_tx)", async () => {
	const harness = await openHarness();
	const { store, gc, wsA } = harness;

	const cp = await createCp(store, wsA, "turn", mobjid("multi-protected"));
	await store.pinCheckpoint(cp.id, true);
	await store.setRedoEdge({
		rootPath: wsA,
		targetCheckpointId: cp.id,
		sourceCheckpointId: null,
		planId: null,
		createdAt: new Date().toISOString(),
	});
	await store.recordTransactionStart({
		rootPath: wsA,
		guardCheckpointId: cp.id,
		checkpointId: cp.id,
	});
	ageRecentCheckpoints(store, wsA, 1);

	const result = await gc.plan({ rootPath: wsA });
	expect(result.removedCheckpointIds).not.toContain(cp.id);

	const reloaded = await store.getCheckpoint(cp.id);
	expect(reloaded).not.toBeNull();
});

test("GC plan: recent checkpoint (within minKeepMs) is kept even if orphaned", async () => {
	const harness = await openHarness();
	const { store, gc, wsA } = harness;

	// Fresh checkpoint — created_at is Date.now(), cutoff is Date.now() - 24h
	const recent = await createCp(store, wsA, "turn", mobjid("recent-orphan"));

	const result = await gc.plan({
		rootPath: wsA,
		minKeepMs: 24 * 60 * 60 * 1000,
	});

	// created_at (≈ now) > cutoff (now - 24h) → kept
	expect(result.keptCheckpointIds).toContain(recent.id);
	expect(result.removedCheckpointIds).not.toContain(recent.id);
});

test("GC plan: minKeepMs=0 removes old orphaned checkpoints", async () => {
	const harness = await openHarness();
	const { store, gc, wsA } = harness;

	const orphan = await createCp(store, wsA, "turn", mobjid("old-min0"));
	await createCp(store, wsA, "turn", mobjid("min0-head"));
	setCheckpointCreatedAt(store, orphan.id, new Date(Date.now() - 25 * 60 * 60 * 1000 - 1).toISOString());

	const result = await gc.plan({ rootPath: wsA, minKeepMs: 0 });

	expect(result.removedCheckpointIds).toContain(orphan.id);
});

test("GC plan: maxDelete limits removedCheckpointIds to N", async () => {
	const harness = await openHarness();
	const { store, gc, wsA } = harness;

	for (let i = 0; i < 5; i++) {
		await createCp(store, wsA, "turn", mobjid(`orphan-${i}`));
	}
	ageRecentCheckpoints(store, wsA, 5);

	const result = await gc.plan({ rootPath: wsA, maxDelete: 2 });

	expect(result.removedCheckpointIds).toHaveLength(2);
});

test("GC plan: releasedObjectIds dedupes duplicate manifestObjectIds", async () => {
	const harness = await openHarness();
	const { store, gc, wsA } = harness;

	const sameOid = mobjid("shared-oid");
	const cp1 = await createCp(store, wsA, "turn", sameOid);
	const cp2 = await createCp(store, wsA, "turn", sameOid);
	const cp3 = await createCp(store, wsA, "turn", mobjid("unique"));
	await createCp(store, wsA, "turn", mobjid("head"));
	const oldIso = new Date(Date.now() - 25 * 60 * 60 * 1000 - 1).toISOString();
	setCheckpointCreatedAt(store, cp1.id, oldIso);
	setCheckpointCreatedAt(store, cp2.id, oldIso);
	setCheckpointCreatedAt(store, cp3.id, oldIso);

	const result = await gc.plan({ rootPath: wsA });

	const sharedCount = result.releasedObjectIds.filter((id: string) => id === sameOid).length;
	expect(sharedCount).toBe(1);
	expect(result.releasedObjectIds).toHaveLength(2);
});

test("GC plan: listGcRoots returns all active retention reasons", async () => {
	const harness = await openHarness();
	const { store, wsA } = harness;

	const cp1 = await createCp(store, wsA, "turn");
	const cp2 = await createCp(store, wsA, "turn");
	const cp3 = await createCp(store, wsA, "turn");
	const cp4 = await createCp(store, wsA, "turn");

	await store.pinCheckpoint(cp1.id, true);
	await store.updateCheckpoint(cp2.id, { label: "named" });
	await store.setRedoEdge({
		rootPath: wsA,
		targetCheckpointId: cp3.id,
		sourceCheckpointId: null,
		planId: null,
		createdAt: new Date().toISOString(),
	});
	await store.recordTransactionStart({
		rootPath: wsA,
		guardCheckpointId: cp4.id,
	});

	const roots = await store.listGcRoots(wsA);
	const rootMap = new Map<string, string[]>();
	for (const r of roots) {
		rootMap.set(r.checkpointId, r.reasons);
	}

	expect(rootMap.get(cp1.id)?.includes("pinned")).toBe(true);
	expect(rootMap.get(cp2.id)?.includes("named")).toBe(true);
	expect(rootMap.get(cp3.id)?.includes("redo_edge")).toBe(true);
	expect(rootMap.get(cp4.id)?.includes("active_transaction")).toBe(true);
});

test("GC: after committing a transaction, its guard checkpoint becomes eligible for GC", async () => {
	const harness = await openHarness();
	const { store, gc, wsA } = harness;

	const guard = await createCp(store, wsA, "restore_guard", mobjid("guard-cp"));
	await createCp(store, wsA, "turn", mobjid("orphan-cp"));
	ageRecentCheckpoints(store, wsA, 2);

	const tx = await store.recordTransactionStart({
		rootPath: wsA,
		guardCheckpointId: guard.id,
		checkpointId: guard.id,
	});

	let result = await gc.plan({ rootPath: wsA });
	expect(result.removedCheckpointIds).not.toContain(guard.id);

	await store.markTransactionStatus(tx.id, "committed");
	result = await gc.plan({ rootPath: wsA });
	expect(result.removedCheckpointIds).toContain(guard.id);
});

test("GC: after clearing the redo edge, the target checkpoint becomes eligible", async () => {
	const harness = await openHarness();
	const { store, gc, wsA } = harness;

	const redoTarget = await createCp(store, wsA, "turn", mobjid("redo-target"));
	await createCp(store, wsA, "turn", mobjid("orphan"));
	ageRecentCheckpoints(store, wsA, 2);

	await store.setRedoEdge({
		rootPath: wsA,
		targetCheckpointId: redoTarget.id,
		sourceCheckpointId: null,
		planId: null,
		createdAt: new Date().toISOString(),
	});

	let result = await gc.plan({ rootPath: wsA });
	expect(result.removedCheckpointIds).not.toContain(redoTarget.id);

	await store.clearRedoEdge(wsA);
	result = await gc.plan({ rootPath: wsA });
	expect(result.removedCheckpointIds).toContain(redoTarget.id);
});

test("GC plan: scope defaults to all workspaces when rootPath is omitted", async () => {
	const harness = await openHarness();
	const { store, gc, wsA, wsB } = harness;

	const cpA = await createCp(store, wsA, "turn", mobjid("orphan-a"));
	const cpB = await createCp(store, wsB, "turn", mobjid("orphan-b"));
	await createCp(store, wsA, "turn", mobjid("head-a"));
	await createCp(store, wsB, "turn", mobjid("head-b"));
	const oldIso = new Date(Date.now() - 25 * 60 * 60 * 1000 - 1).toISOString();
	setCheckpointCreatedAt(store, cpA.id, oldIso);
	setCheckpointCreatedAt(store, cpB.id, oldIso);

	const result = await gc.plan({});

	expect(result.removedCheckpointIds).toContain(cpA.id);
	expect(result.removedCheckpointIds).toContain(cpB.id);
});

test("GC run: repeated runs are idempotent (no error on already-deleted checkpoint)", async () => {
	const harness = await openHarness();
	const { store, gc, wsA } = harness;

	const orphan = await createCp(store, wsA, "turn", mobjid("idempotent"));
	await createCp(store, wsA, "turn", mobjid("idempotent-head"));
	setCheckpointCreatedAt(store, orphan.id, new Date(Date.now() - 25 * 60 * 60 * 1000 - 1).toISOString());

	const r1 = await gc.run({ rootPath: wsA });
	expect(r1.removedCheckpointIds).toContain(orphan.id);

	const r2 = await gc.run({ rootPath: wsA });
	expect(r2.removedCheckpointIds).not.toContain(orphan.id);
	expect(r2.removedCheckpointIds).toHaveLength(0);
});

test("GC plan: non-automatic checkpoint (reason=manual) is NOT a GC candidate even when old", async () => {
	const harness = await openHarness();
	const { store, gc, wsA } = harness;

	const manual = await store.createCheckpoint({
		rootPath: wsA,
		reason: "manual",
		manifestObjectId: mobjid("manual-cp"),
	});
	ageRecentCheckpoints(store, wsA, 1);

	const result = await gc.plan({ rootPath: wsA });

	// manual is not in automaticOnly candidates, so it never appears as removed
	expect(result.removedCheckpointIds).not.toContain(manual.id);
	expect(result.keptCheckpointIds).toContain(manual.id);
});

// ─── concurrent open of same DB, then write ──────────────────────────────────

test("concurrent: two stores opening the same DB file — write succeeds, data readable by both", async () => {
	const harness = await openHarness();
	const { storageDir, wsA } = harness;

	const storeA = makeStore(storageDir);
	await storeA.init();
	const storeB = makeStore(storageDir);
	await storeB.init();

	const cpA = await storeA.createCheckpoint({
		rootPath: wsA,
		reason: "turn",
		manifestObjectId: mobjid("concurrent"),
	});

	const fromA = await storeA.listCheckpoints({ rootPath: wsA });
	const fromB = await storeB.listCheckpoints({ rootPath: wsA });

	expect(fromA).toHaveLength(1);
	expect(fromA[0]!.id).toBe(cpA.id);
	expect(fromB).toHaveLength(1);
	expect(fromB[0]!.id).toBe(cpA.id);

	const cpB = await storeB.createCheckpoint({
		rootPath: wsA,
		reason: "turn",
		manifestObjectId: mobjid("concurrent-b"),
	});

	const fromA2 = await storeA.listCheckpoints({ rootPath: wsA });
	const fromB2 = await storeB.listCheckpoints({ rootPath: wsA });

	expect(fromA2).toHaveLength(2);
	expect(fromB2).toHaveLength(2);
	const allIds = [
		...fromA2.map((c: WorkspaceCheckpointRecord) => c.id),
		...fromB2.map((c: WorkspaceCheckpointRecord) => c.id),
	];
	expect(allIds).toContain(cpA.id);
	expect(allIds).toContain(cpB.id);

	storeA.close();
	storeB.close();
});

test("concurrent: concurrent writes from two stores do not corrupt the DB", async () => {
	const harness = await openHarness();
	const { storageDir, wsA } = harness;

	const storeA = makeStore(storageDir);
	await storeA.init();
	const storeB = makeStore(storageDir);
	await storeB.init();

	const [idA, idB] = await Promise.all([
		storeA
			.createCheckpoint({
				rootPath: wsA,
				reason: "turn",
				manifestObjectId: mobjid("cA"),
			})
			.then((c: WorkspaceCheckpointRecord) => c.id),
		storeB
			.createCheckpoint({
				rootPath: wsA,
				reason: "turn",
				manifestObjectId: mobjid("cB"),
			})
			.then((c: WorkspaceCheckpointRecord) => c.id),
	]);

	storeA.close();
	storeB.close();

	const storeC = makeStore(storageDir);
	await storeC.init();
	const all = await storeC.listCheckpoints({ rootPath: wsA });
	expect(all).toHaveLength(2);
	const ids = new Set(all.map((c: WorkspaceCheckpointRecord) => c.id));
	expect(ids.has(idA)).toBe(true);
	expect(ids.has(idB)).toBe(true);

	// Verify exactly 2 rows via raw SQL count.
	const rawDb = new Database(storeC.dbPath);
	const row = rawDb.prepare<{ c: number }, []>("SELECT COUNT(*) as c FROM checkpoints").get();
	rawDb.close();
	expect(row!.c).toBe(2);

	storeC.close();
});

// ─── workspace state ───────────────────────────────────────────────────────────

test("putWorkspaceState upserts and listWorkspaces returns all workspaces", async () => {
	const harness = await openHarness();
	const { store, storageDir, wsA, wsB } = harness;

	const cpA = await createCp(store, wsA, "turn");
	const cpB = await createCp(store, wsB, "turn");

	await store.putWorkspaceState({
		rootPath: wsA,
		undoHeadCheckpointId: cpA.id,
		restoreSequence: 1,
	});
	await store.putWorkspaceState({
		rootPath: wsB,
		redoHeadCheckpointId: cpB.id,
		restoreSequence: 0,
	});

	const workspaces = await store.listWorkspaces();
	expect(workspaces).toHaveLength(2);
	const byRoot = new Map<string, { undoHeadCheckpointId: string | null; redoHeadCheckpointId: string | null }>();
	for (const w of workspaces) {
		byRoot.set(w.rootPath, {
			undoHeadCheckpointId: w.undoHeadCheckpointId,
			redoHeadCheckpointId: w.redoHeadCheckpointId,
		});
	}
	expect(byRoot.get(wsA)?.undoHeadCheckpointId).toBe(cpA.id);
	expect(byRoot.get(wsB)?.redoHeadCheckpointId).toBe(cpB.id);

	store.close();

	const store2 = makeStore(storageDir);
	await store2.init();
	const reloaded = await store2.listWorkspaces();
	expect(reloaded).toHaveLength(2);

	store2.close();
});

test("deleteWorkspaceState removes workspace and cascade-deletes its checkpoints", async () => {
	const harness = await openHarness();
	const { store, wsA } = harness;

	await createCp(store, wsA, "turn");
	await createCp(store, wsA, "turn");
	await store.putWorkspaceState({ rootPath: wsA });

	await store.deleteWorkspaceState(wsA);

	const checkpoints = await store.listCheckpoints({ rootPath: wsA });
	const workspaces = await store.listWorkspaces();
	expect(checkpoints).toHaveLength(0);
	expect(workspaces).toHaveLength(0);
});

test("workspaceIdForRoot is stable and equal to the store's method", async () => {
	const harness = await openHarness();
	const { store, wsA } = harness;

	const derived = workspaceIdForRoot(wsA);
	const fromStore = store.workspaceIdForRoot(wsA);
	expect(derived).toBe(fromStore);
});

test("v1 metadata DB upgrades attributed legacy pointers and redo edges into session scope", async () => {
	const harness = await openHarness();
	const { storageDir, wsA } = harness;
	const dbPath = path.join(storageDir, "metadata.db");
	const alphaUndoId = "legacy-alpha-undo";
	const alphaRedoId = "legacy-alpha-redo";
	const updatedAt = "2026-07-29T00:00:00.000Z";
	const redoCreatedAt = "2026-07-28T00:00:00.000Z";

	harness.store.close();
	await Promise.all([
		fs.rm(dbPath, { force: true }),
		fs.rm(`${dbPath}-wal`, { force: true }),
		fs.rm(`${dbPath}-shm`, { force: true }),
	]);
	const legacyDb = new Database(dbPath);
	try {
		legacyDb.run(`
			CREATE TABLE schema_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE workspaces (
				workspace_id TEXT PRIMARY KEY,
				root_path TEXT NOT NULL UNIQUE,
				undo_head_checkpoint_id TEXT,
				redo_head_checkpoint_id TEXT,
				restore_sequence INTEGER NOT NULL DEFAULT 0,
				last_checkpoint_id TEXT,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE checkpoints (
				id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL,
				root_path TEXT NOT NULL,
				manifest_object_id TEXT NOT NULL,
				parent_id TEXT,
				session_id TEXT,
				session_entry_id TEXT,
				prompt_entry_id TEXT,
				label TEXT,
				reason TEXT NOT NULL,
				completeness TEXT NOT NULL DEFAULT 'complete',
				created_at TEXT NOT NULL,
				file_count INTEGER NOT NULL DEFAULT 0,
				total_bytes INTEGER NOT NULL DEFAULT 0,
				pinned INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE redo_edges (
				root_path TEXT PRIMARY KEY,
				target_checkpoint_id TEXT NOT NULL,
				source_checkpoint_id TEXT,
				plan_id TEXT,
				created_at TEXT NOT NULL
			);
		`);
		legacyDb.prepare("INSERT INTO schema_meta(key, value) VALUES ('version', '1')").run();
		legacyDb
			.prepare(
				`INSERT INTO workspaces (
					workspace_id, root_path, undo_head_checkpoint_id, redo_head_checkpoint_id,
					restore_sequence, last_checkpoint_id, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(workspaceIdForRoot(wsA), wsA, alphaUndoId, alphaRedoId, 7, alphaUndoId, updatedAt);
		const insertCheckpoint = legacyDb.prepare(
			`INSERT INTO checkpoints (
				id, workspace_id, root_path, manifest_object_id, parent_id, session_id,
				session_entry_id, prompt_entry_id, label, reason, completeness, created_at,
				file_count, total_bytes, pinned
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		insertCheckpoint.run(
			alphaUndoId,
			workspaceIdForRoot(wsA),
			wsA,
			mobjid("legacy-alpha-undo"),
			null,
			"alpha",
			null,
			null,
			null,
			"manual",
			"complete",
			updatedAt,
			0,
			0,
			0,
		);
		insertCheckpoint.run(
			alphaRedoId,
			workspaceIdForRoot(wsA),
			wsA,
			mobjid("legacy-alpha-redo"),
			alphaUndoId,
			"alpha",
			null,
			null,
			null,
			"restore_guard",
			"complete",
			redoCreatedAt,
			0,
			0,
			0,
		);
		legacyDb
			.prepare(
				"INSERT INTO redo_edges(root_path, target_checkpoint_id, source_checkpoint_id, plan_id, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(wsA, alphaRedoId, alphaUndoId, null, updatedAt);
	} finally {
		legacyDb.close();
	}

	const upgraded = makeStore(storageDir);
	harness.store = upgraded;
	await upgraded.init();
	const legacyState = await upgraded.getWorkspaceState(wsA);
	const sessionState = await upgraded.getWorkspaceState(wsA, "alpha");
	const legacyEdge = await upgraded.getRedoEdge(wsA);
	const sessionEdge = await upgraded.getRedoEdge(wsA, "alpha");

	expect(upgraded.schemaVersion).toBe(2);
	expect(legacyState).toMatchObject({
		sessionId: null,
		undoHeadCheckpointId: alphaUndoId,
		redoHeadCheckpointId: alphaRedoId,
		lastCheckpointId: alphaUndoId,
		restoreSequence: 7,
	});
	expect(sessionState).toMatchObject({
		sessionId: "alpha",
		undoHeadCheckpointId: alphaUndoId,
		redoHeadCheckpointId: alphaRedoId,
		lastCheckpointId: alphaUndoId,
		restoreSequence: 7,
	});
	expect(legacyEdge).toMatchObject({
		sessionId: null,
		targetCheckpointId: alphaRedoId,
		sourceCheckpointId: alphaUndoId,
	});
	expect(sessionEdge).toMatchObject({
		sessionId: "alpha",
		targetCheckpointId: alphaRedoId,
		sourceCheckpointId: alphaUndoId,
	});

	upgraded.close();
	const reopened = makeStore(storageDir);
	harness.store = reopened;
	await reopened.init();
	expect(await reopened.getWorkspaceState(wsA, "alpha")).toMatchObject({
		sessionId: "alpha",
		undoHeadCheckpointId: alphaUndoId,
		redoHeadCheckpointId: alphaRedoId,
		lastCheckpointId: alphaUndoId,
		restoreSequence: 7,
	});
	expect(await reopened.getRedoEdge(wsA, "alpha")).toMatchObject({
		sessionId: "alpha",
		targetCheckpointId: alphaRedoId,
		sourceCheckpointId: alphaUndoId,
	});
});
test("schemaVersion is 2", async () => {
	const harness = await openHarness();
	const { store } = harness;
	expect(store.schemaVersion).toBe(2);
});
