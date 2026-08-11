import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRefinementController, type RefinementControllerDeps } from "../../src/refinement/controller";
import { applyRefinementProposal } from "../../src/refinement/refinement";
import {
	appendRefinementHistory,
	createHarnessState,
	loadHarnessState,
	loadRefinementHistory,
	saveHarnessState,
} from "../../src/refinement/state";
import type { HarnessEntry, HarnessState, RefinementResult } from "../../src/refinement/types";

const cleanupRoots: string[] = [];

async function makeRoot(label: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-controller-${label}-`));
	cleanupRoots.push(root);
	return root;
}

/** Poll for a fire-and-forget side effect to land; fails loudly on timeout. */
async function waitForSignal(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(1);
	}
}

afterEach(async () => {
	await Promise.all(cleanupRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function fixtureEntry(id: string, kind: HarnessEntry["kind"], title: string, content: string): HarnessEntry {
	return { id, kind, title, content, version: 1, created_at: 1, updated_at: 1, scope: "global" };
}

interface CallLog {
	waitForIdle: number;
	refresh: number;
	appended: Array<{ type: string; data: unknown }>;
	planned: Array<{ scope: string; instructions?: string; state: HarnessState }>;
	reviewed: Array<{ reason: string; turnsSinceLastReview: number }>;
	warnings: string[];
}

function makeDeps(overrides: Partial<RefinementControllerDeps> = {}): {
	deps: RefinementControllerDeps;
	calls: CallLog;
	agentDir: string;
	localDir: string | undefined;
} {
	const agentDir = "";
	const localDir: string | undefined = undefined;
	const calls: CallLog = { waitForIdle: 0, refresh: 0, appended: [], planned: [], reviewed: [], warnings: [] };
	const deps: RefinementControllerDeps = {
		agentDir,
		getLocalHarnessDir: () => localDir,
		getMessages: () => [],
		planWithLLM: async ({ state, instructions, scope }) => {
			calls.planned.push({ scope, instructions, state });
			return { summary: "summary", rationale: "rationale", expectedOutcome: "expected", edits: [] };
		},
		reviewWithLLM: async ({ reason, turnsSinceLastReview }) => {
			calls.reviewed.push({ reason, turnsSinceLastReview });
			return { shouldRefine: false, rationale: "no evidence" };
		},
		waitForIdle: async () => {
			calls.waitForIdle++;
		},
		refreshBaseSystemPrompt: async () => {
			calls.refresh++;
		},
		appendCustomEntry: (type, data) => {
			calls.appended.push({ type, data });
		},
		isEnabled: () => true,
		getAutoRefineTurns: () => 25,
		getAutoRefineCooldownMs: () => 1000,
		logWarning: (message, error) => {
			calls.warnings.push(`${message}: ${String(error)}`);
		},
		...overrides,
	};
	return { deps, calls, agentDir, localDir };
}

async function seedGlobalEntry(agentDir: string, entry: HarnessEntry): Promise<HarnessState> {
	const state = createHarnessState();
	state.entries[entry.kind][entry.id] = entry;
	await saveHarnessState(state, path.join(agentDir, "harness", "harness-state.json"));
	return state;
}

describe("RefinementController", () => {
	test("refine() rejects while the harness is disabled", async () => {
		const { deps } = makeDeps({ isEnabled: () => false });
		const controller = createRefinementController(deps);
		await expect(controller.refine(undefined)).rejects.toThrow("disabled");
	});

	test("refine() plans, re-reads the target scope at idle, persists, and refreshes the prompt", async () => {
		const agentDir = await makeRoot("refine-plan");
		const original = fixtureEntry("plan-memory", "memory", "Original", "Original instruction.");
		await seedGlobalEntry(agentDir, original);

		const { deps, calls } = makeDeps({
			agentDir,
			planWithLLM: async ({ state }) => {
				expect(state.entries.memory["plan-memory"]).toBeDefined();
				return {
					summary: "Update memory",
					rationale: "evidence",
					expectedOutcome: "memory updated",
					edits: [
						{
							action: "update",
							kind: "memory",
							id: "plan-memory",
							title: "Updated",
							content: "Updated instruction.",
						},
					],
				};
			},
		});
		const controller = createRefinementController(deps);
		await controller.refine(undefined, { scope: "global" });

		expect(calls.waitForIdle).toBeGreaterThanOrEqual(1);
		expect(calls.refresh).toBe(1);
		expect(calls.appended.some(entry => entry.type === "omp.refinement")).toBe(true);

		const persisted = await loadHarnessState(agentDir, "global");
		expect(persisted?.entries.memory["plan-memory"]?.title).toBe("Updated");
		const history = await loadRefinementHistory(agentDir, "global");
		expect(history).toHaveLength(1);
		expect(history[0]?.appliedEdits[0]?.applied).toBe(true);
	});

	test("refine() with an empty proposal skips idle wait and prompt refresh", async () => {
		const agentDir = await makeRoot("refine-empty");
		await seedGlobalEntry(agentDir, fixtureEntry("keep", "memory", "Keep", "Keep me."));
		const { deps, calls } = makeDeps({
			agentDir,
			planWithLLM: async () => ({ summary: "No-op", rationale: "", expectedOutcome: "", edits: [] }),
		});
		const controller = createRefinementController(deps);
		await controller.refine(undefined, { scope: "global" });

		expect(calls.waitForIdle).toBe(0);
		expect(calls.refresh).toBe(0);
		expect(calls.appended).toHaveLength(0);
	});

	test("rollback() without a scope finds the target in local then global history", async () => {
		const agentDir = await makeRoot("rollback-scope");
		const original = fixtureEntry("rb-prompt", "prompt", "Original", "Original prompt.");
		const baseline = await seedGlobalEntry(agentDir, original);

		const target = applyRefinementProposal(
			baseline,
			{
				summary: "Change prompt",
				rationale: "evidence",
				expectedOutcome: "prompt changed",
				edits: [
					{
						action: "update",
						kind: "prompt",
						id: "rb-prompt",
						title: "Changed",
						content: "Changed prompt.",
						marker: "changed",
					},
				],
			},
			{ id: "rb-target", scope: "global" },
		);
		target.harnessStatePath = path.join(agentDir, "harness", "harness-state.json");
		await appendRefinementHistory(target, "global", agentDir);

		const { deps, calls } = makeDeps({ agentDir });
		const controller = createRefinementController(deps);
		await controller.rollback(undefined, "rb-target");

		const restored = await loadHarnessState(agentDir, "global");
		const restoredPrompt = restored?.entries.prompt["rb-prompt"];
		expect(restoredPrompt?.title).toBe("Original");
		expect(restoredPrompt?.content).toBe("Original prompt.");
		expect(restoredPrompt?.marker).toBeUndefined();
		const history = await loadRefinementHistory(agentDir, "global");
		expect(history).toHaveLength(2);
		expect(history[1]?.rollbackOf).toBe("rb-target");
		expect(calls.refresh).toBe(1);
	});

	test("rollback() rejects when no matching refinement exists", async () => {
		const agentDir = await makeRoot("rollback-missing");
		const { deps } = makeDeps({ agentDir });
		const controller = createRefinementController(deps);
		await expect(controller.rollback(undefined, "does-not-exist")).rejects.toThrow("was not found");
	});

	test("onTurnEnd reviews at the configured threshold and skips refinement when the review says no", async () => {
		const agentDir = await makeRoot("autoreview");
		const { deps, calls } = makeDeps({
			agentDir,
			getAutoRefineTurns: () => 2,
			getAutoRefineCooldownMs: () => 0,
			reviewWithLLM: async ({ reason, turnsSinceLastReview }) => {
				calls.reviewed.push({ reason, turnsSinceLastReview });
				return { shouldRefine: false, rationale: "nothing to change" };
			},
		});
		const controller = createRefinementController(deps);
		await controller.onTurnEnd(undefined);
		await controller.onTurnEnd(undefined);
		// onTurnEnd schedules the review fire-and-forget; wait for the real
		// recorded signal instead of guessing a duration.
		await waitForSignal(() => calls.reviewed.length === 1, "automatic review");
		expect(calls.reviewed[0]?.turnsSinceLastReview).toBe(2);
		expect(calls.planned).toHaveLength(0);
		expect(calls.refresh).toBe(0);
	});

	test("onTurnEnd runs a refinement when the automatic review approves", async () => {
		const agentDir = await makeRoot("autoreview-approve");
		const localDir = await makeRoot("autoreview-approve-local");
		await seedGlobalEntry(agentDir, fixtureEntry("auto-memory", "memory", "Old", "Old text."));
		const { deps, calls } = makeDeps({
			agentDir,
			getLocalHarnessDir: () => localDir,
			getAutoRefineTurns: () => 1,
			getAutoRefineCooldownMs: () => 0,
			reviewWithLLM: async ({ reason, turnsSinceLastReview }) => {
				calls.reviewed.push({ reason, turnsSinceLastReview });
				return { shouldRefine: true, rationale: "change it", instructions: "update" };
			},
			planWithLLM: async ({ scope, instructions, state }) => {
				calls.planned.push({ scope, instructions, state });
				expect(scope).toBe("local");
				expect(instructions).toBe("update");
				return {
					summary: "Auto update",
					rationale: "evidence",
					expectedOutcome: "updated",
					edits: [
						{
							action: "update",
							kind: "memory",
							id: "auto-memory",
							title: "New",
							content: "New text.",
						},
					],
				};
			},
		});
		const controller = createRefinementController(deps);
		await controller.onTurnEnd(undefined);
		await waitForSignal(() => calls.reviewed.length === 1, "automatic review");
		await waitForSignal(() => calls.planned.length === 1, "automatic refinement");
		await waitForSignal(() => calls.refresh === 1, "prompt refresh after persistence");
	});

	test("onCompaction() resets the turn gate and reviews immediately on the new trajectory", async () => {
		const agentDir = await makeRoot("oncompaction");
		const { deps, calls } = makeDeps({
			agentDir,
			getAutoRefineTurns: () => 100,
			getAutoRefineCooldownMs: () => 0,
			reviewWithLLM: async ({ reason, turnsSinceLastReview }) => {
				calls.reviewed.push({ reason, turnsSinceLastReview });
				return { shouldRefine: false, rationale: "nothing to change" };
			},
		});
		const controller = createRefinementController(deps);

		// A normal turn below the gate threshold returns synchronously without reviewing.
		await controller.onTurnEnd(undefined);
		expect(calls.reviewed).toHaveLength(0);

		// Compaction resets the counter and runs the gate check immediately.
		await controller.onCompaction();
		await waitForSignal(() => calls.reviewed.length === 1, "review after compaction");
		expect(calls.reviewed[0]?.reason).toContain("compaction");
		expect(calls.reviewed[0]?.turnsSinceLastReview).toBe(0);
	});

	test("local harness state is isolated per session artifact directory", async () => {
		const agentDirA = await makeRoot("iso-a");
		const localDirA = await makeRoot("iso-a-local");
		const agentDirB = await makeRoot("iso-b");
		const localDirB = await makeRoot("iso-b-local");

		const a = makeDeps({
			agentDir: agentDirA,
			getLocalHarnessDir: () => localDirA,
			planWithLLM: async () => ({
				summary: "Create A memory",
				rationale: "evidence",
				expectedOutcome: "A memory exists",
				edits: [
					{
						action: "create",
						kind: "memory",
						id: "iso-memory",
						title: "A",
						content: "Only session A sees this.",
					},
				],
			}),
		});
		const controllerA = createRefinementController(a.deps);
		await controllerA.refine(undefined, { scope: "local" });

		// Session B, a separate artifact directory, must not observe A's local entry.
		const b = makeDeps({ agentDir: agentDirB, getLocalHarnessDir: () => localDirB });
		const controllerB = createRefinementController(b.deps);
		const stateB = await controllerB.getState();
		expect(stateB.entries.memory["iso-memory"]).toBeUndefined();
		await expect(fs.access(path.join(localDirB, "harness-state.json"))).rejects.toThrow();

		// Session A itself still reads its own entry.
		const stateA = await controllerA.getState();
		expect(stateA.entries.memory["iso-memory"]?.content).toBe("Only session A sees this.");
	});

	test("local refinement rejects when the session has no artifact directory; global stays usable", async () => {
		const agentDir = await makeRoot("no-local");
		const { deps } = makeDeps({ agentDir });
		const controller = createRefinementController(deps);
		await expect(controller.refine(undefined, { scope: "local" })).rejects.toThrow("no artifact directory");

		// The same controller can still refine the global scope.
		const globalDeps = makeDeps({
			agentDir,
			planWithLLM: async () => ({ summary: "No-op", rationale: "", expectedOutcome: "", edits: [] }),
		});
		await expect(
			createRefinementController(globalDeps.deps).refine(undefined, { scope: "global" }),
		).resolves.toBeUndefined();
	});

	test("getState() merges global and local entries, prefixing colliding ids with local:", async () => {
		const agentDir = await makeRoot("merge");
		const localDir = await makeRoot("merge-local");
		const globalState = createHarnessState();
		globalState.entries.memory.shared = fixtureEntry("shared", "memory", "Global", "Global text.");
		await saveHarnessState(globalState, path.join(agentDir, "harness", "harness-state.json"));
		const localState = createHarnessState();
		localState.entries.memory.shared = fixtureEntry("shared", "memory", "Local", "Local text.");
		await saveHarnessState(localState, path.join(localDir, "harness-state.json"));

		const { deps } = makeDeps({ agentDir, getLocalHarnessDir: () => localDir });
		const controller = createRefinementController(deps);
		const merged = await controller.getState();

		expect(merged.entries.memory.shared?.content).toBe("Global text.");
		expect(merged.entries.memory["local:shared"]?.content).toBe("Local text.");
	});

	test("persisted results are real JSONL on disk with a resolvable state path", async () => {
		const agentDir = await makeRoot("disk");
		const original = fixtureEntry("disk-memory", "memory", "Original", "Original.");
		await seedGlobalEntry(agentDir, original);
		const { deps, calls } = makeDeps({
			agentDir,
			planWithLLM: async () => ({
				summary: "Update",
				rationale: "evidence",
				expectedOutcome: "updated",
				edits: [
					{
						action: "update",
						kind: "memory",
						id: "disk-memory",
						title: "Updated",
						content: "Updated.",
					},
				],
			}),
		});
		const controller = createRefinementController(deps);
		await controller.refine(undefined, { scope: "global" });

		const historyPath = path.join(agentDir, "harness", "refinements.jsonl");
		const raw = await fs.readFile(historyPath, "utf8");
		const lines = raw
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as RefinementResult);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.harnessStatePath).toContain("harness-state.json");
		expect(
			await fs
				.access(lines[0]!.harnessStatePath)
				.then(() => true)
				.catch(() => false),
		).toBe(true);
		expect(calls.appended[0]?.type).toBe("omp.refinement");
	});
});
