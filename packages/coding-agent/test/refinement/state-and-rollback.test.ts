import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyRefinementProposal, buildRollbackProposal } from "../../src/refinement/refinement";
import {
	createHarnessState,
	getHarnessStatePath,
	loadHarnessState,
	saveHarnessState,
} from "../../src/refinement/state";
import type { HarnessEntry, RefinementProposal } from "../../src/refinement/types";

const cleanupRoots: string[] = [];

async function makeRoot(label: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-${label}-`));
	cleanupRoots.push(root);
	return root;
}

function fixtureEntry(
	id: string,
	kind: HarnessEntry["kind"],
	title: string,
	content: string,
	version: number,
): HarnessEntry {
	return {
		id,
		kind,
		title,
		content,
		version,
		created_at: 10_000 + version,
		updated_at: 20_000 + version,
		path: `harness/${id}.md`,
		scope: "global",
		reference: { origin: "fixture", id },
		arguments: { format: "markdown", revision: version },
		metadata: { category: kind, rank: version },
		source: "refine",
		extension: { keep: `${id}-extension` },
	};
}

function logicalEntry(entry: HarnessEntry | undefined): Record<string, unknown> | undefined {
	if (!entry) return undefined;
	const { version: _version, created_at: _createdAt, updated_at: _updatedAt, ...logical } = entry;
	return logical;
}

afterEach(async () => {
	await Promise.all(cleanupRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("harness state persistence", () => {
	test("round-trips durable entries and refinement history through global storage", async () => {
		const agentDir = await makeRoot("refinement-state");
		const state = createHarnessState();
		state.schema = 7;

		const prompt = fixtureEntry("durable-prompt", "prompt", "Durable prompt", "Keep this instruction.", 4);
		const memory = fixtureEntry("durable-memory", "memory", "Durable memory", "Remember this fact.", 6);
		state.entries.prompt[prompt.id] = prompt;
		state.entries.memory[memory.id] = memory;
		state.refinements.push({
			id: "refinement-durable",
			summary: "Persist durable context",
			timestamp: 42_000,
			scope: "global",
			rollbackOf: "refinement-earlier",
		});

		const statePath = getHarnessStatePath(agentDir, "global");
		await saveHarnessState(state, statePath);

		expect(await Bun.file(statePath).exists()).toBe(true);
		const reloaded = await loadHarnessState(agentDir, "global");
		if (!reloaded) throw new Error("saved harness state was not loaded");

		expect(reloaded.schema).toBe(7);
		expect(reloaded.entries.prompt[prompt.id]).toEqual(prompt);
		expect(reloaded.entries.memory[memory.id]).toEqual(memory);
		expect(reloaded.refinements).toEqual(state.refinements);
	});
});

describe("applyRefinementProposal", () => {
	test("records create, update, and delete snapshots while changing the selected state", () => {
		const state = createHarnessState();
		state.schema = 5;
		const existingPrompt = fixtureEntry(
			"focused-prompt",
			"prompt",
			"Existing prompt",
			"Use the original instructions.",
			8,
		);
		const obsoleteSubagent = fixtureEntry(
			"obsolete-subagent",
			"subagent",
			"Obsolete subagent",
			"This agent is no longer needed.",
			3,
		);
		state.entries.prompt[existingPrompt.id] = existingPrompt;
		state.entries.subagent[obsoleteSubagent.id] = obsoleteSubagent;

		const proposal: RefinementProposal = {
			summary: "Refresh harness guidance",
			rationale: "Replace stale guidance and remove the retired subagent.",
			expectedOutcome: "The harness uses current guidance.",
			edits: [
				{
					action: "create",
					kind: "memory",
					id: "new-memory",
					title: "New memory",
					content: "Apply the new policy.",
					path: "memory/new-policy.md",
					metadata: { severity: "high" },
					priority: "high",
				},
				{
					action: "update",
					kind: "prompt",
					id: existingPrompt.id,
					title: "Current prompt",
					content: "Use the current instructions.",
					path: "prompts/current.md",
					reference: { document: "current" },
					arguments: { audience: "agents" },
					metadata: { revision: "current" },
					priority: "urgent",
				},
				{ action: "delete", kind: "subagent", id: obsoleteSubagent.id },
			],
		};

		const result = applyRefinementProposal(state, proposal, {
			id: "refinement-apply",
			scope: "global",
		});
		const created = result.appliedEdits[0]!;
		const updated = result.appliedEdits[1]!;
		const deleted = result.appliedEdits[2]!;

		expect(created.before).toBeUndefined();
		expect(created).toMatchObject({
			applied: true,
			id: "new-memory",
			after: {
				kind: "memory",
				title: "New memory",
				content: "Apply the new policy.",
				path: "memory/new-policy.md",
				scope: "global",
				metadata: { severity: "high" },
				priority: "high",
			},
		});
		expect(updated.before).toEqual(existingPrompt);
		expect(updated).toMatchObject({
			applied: true,
			id: existingPrompt.id,
			after: {
				title: "Current prompt",
				content: "Use the current instructions.",
				path: "prompts/current.md",
				scope: "global",
				reference: { document: "current" },
				arguments: { audience: "agents" },
				metadata: { revision: "current" },
				priority: "urgent",
				created_at: existingPrompt.created_at,
				version: existingPrompt.version + 1,
			},
		});
		expect(deleted.before).toEqual(obsoleteSubagent);
		expect(deleted.after).toBeUndefined();
		expect(deleted.applied).toBe(true);

		expect(state.entries.memory["new-memory"]).toMatchObject({
			title: "New memory",
			content: "Apply the new policy.",
			scope: "global",
		});
		expect(state.entries.prompt[existingPrompt.id]).toMatchObject({
			title: "Current prompt",
			content: "Use the current instructions.",
			metadata: { revision: "current" },
		});
		expect(state.entries.subagent[obsoleteSubagent.id]).toBeUndefined();
		expect(state.refinements).toHaveLength(1);
		expect(state.refinements[0]).toMatchObject({
			id: "refinement-apply",
			summary: proposal.summary,
			scope: "global",
		});
	});
});

describe("buildRollbackProposal", () => {
	test("builds an applicable inverse that restores created, updated, and deleted entries", () => {
		const state = createHarnessState();
		state.schema = 11;
		const originalPrompt = fixtureEntry(
			"rollback-prompt",
			"prompt",
			"Original rollback prompt",
			"Use the original rollback instruction.",
			9,
		);
		const originalSubagent = fixtureEntry(
			"rollback-subagent",
			"subagent",
			"Original rollback subagent",
			"Handle the original task.",
			2,
		);
		state.entries.prompt[originalPrompt.id] = originalPrompt;
		state.entries.subagent[originalSubagent.id] = originalSubagent;

		const target = applyRefinementProposal(
			state,
			{
				summary: "Change entries for rollback",
				rationale: "Exercise every inverse edit form.",
				expectedOutcome: "The changed entries can be restored.",
				edits: [
					{
						action: "create",
						kind: "memory",
						id: "rollback-memory",
						title: "Temporary memory",
						content: "This should be removed by rollback.",
						metadata: { temporary: true },
					},
					{
						action: "update",
						kind: "prompt",
						id: originalPrompt.id,
						title: "Changed rollback prompt",
						content: "Use the changed rollback instruction.",
						path: "prompts/changed-rollback.md",
						metadata: { revision: "changed" },
						marker: "changed",
					},
					{ action: "delete", kind: "subagent", id: originalSubagent.id },
				],
			},
			{ id: "refinement-target", scope: "global" },
		);

		const rollback = buildRollbackProposal(target);
		const restored = applyRefinementProposal(state, rollback, {
			id: "refinement-rollback",
			rollbackOf: target.id,
			scope: "global",
		});

		expect(restored.appliedEdits.map(edit => ({ action: edit.action, id: edit.id, applied: edit.applied }))).toEqual([
			{ action: "create", id: originalSubagent.id, applied: true },
			{ action: "update", id: originalPrompt.id, applied: true },
			{ action: "delete", id: "rollback-memory", applied: true },
		]);
		expect(state.entries.memory["rollback-memory"]).toBeUndefined();
		expect(logicalEntry(state.entries.prompt[originalPrompt.id])).toEqual(logicalEntry(originalPrompt));
		expect(logicalEntry(state.entries.subagent[originalSubagent.id])).toEqual(logicalEntry(originalSubagent));
		expect(state.refinements).toHaveLength(2);
		expect(state.refinements[1]).toMatchObject({
			id: "refinement-rollback",
			rollbackOf: target.id,
			scope: "global",
		});
	});
});
