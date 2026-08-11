import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getCliLocale, setCliLocale } from "@oh-my-pi/pi-utils/cli";
import { Settings } from "../../src/config/settings";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../src/i18n/settings-locale";
import { getPromptLocale, setPromptLocale } from "../../src/prompts/prompt-locale";
import { createRefinementController, type RefinementControllerDeps } from "../../src/refinement/controller";
import { loadHarnessState, loadRefinementHistory } from "../../src/refinement/state";
import type { HarnessScope } from "../../src/refinement/types";
import { buildSystemPrompt, projectSystemPromptToolMetadata } from "../../src/system-prompt";
import type { Tool } from "../../src/tools";
import { RefineTool } from "../../src/tools/refine-tool";

const temporaryRoots: string[] = [];
let previousPromptLocale: ReturnType<typeof getPromptLocale>;
let previousSettingsUiLocale: ReturnType<typeof getSettingsUiLocale>;
let previousCliLocale: ReturnType<typeof getCliLocale>;

async function makeTemporaryRoot(label: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-refine-tool-${label}-`));
	temporaryRoots.push(root);
	return root;
}

beforeEach(() => {
	previousPromptLocale = getPromptLocale();
	previousSettingsUiLocale = getSettingsUiLocale();
	previousCliLocale = getCliLocale();
});

afterEach(async () => {
	setPromptLocale(previousPromptLocale);
	setSettingsUiLocale(previousSettingsUiLocale);
	setCliLocale(previousCliLocale);
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function createControllerFixture(options: { agentDir: string; localArtifactsDir: string; isEnabled: () => boolean }) {
	const deps: RefinementControllerDeps = {
		agentDir: options.agentDir,
		getLocalHarnessDir: () => options.localArtifactsDir,
		getMessages: () => [],
		planWithLLM: async ({ scope }) => ({
			summary: "Persist the session-local evidence",
			rationale: "The session explicitly requested a local refinement.",
			expectedOutcome: "Only this session artifact owns the new memory.",
			edits: [
				{
					action: "create",
					kind: "memory",
					id: "session-local-memory",
					title: "Session-local memory",
					content: `Created for ${scope}.`,
				},
			],
		}),
		reviewWithLLM: async () => ({ shouldRefine: false, rationale: "not part of this explicit request" }),
		waitForIdle: async () => {},
		refreshBaseSystemPrompt: async () => {},
		appendCustomEntry: () => {},
		isEnabled: options.isEnabled,
		getAutoRefineTurns: () => 1,
		getAutoRefineCooldownMs: () => 0,
		logWarning: () => {},
	};
	return createRefinementController(deps);
}

async function renderRefineToolDefinition(root: string, tool: RefineTool): Promise<string> {
	const tools = new Map<string, Tool>([[tool.name, tool]]);
	const metadata = projectSystemPromptToolMetadata(tools, { mode: "full" });
	const { systemPrompt } = await buildSystemPrompt({
		cwd: root,
		contextFiles: [],
		skills: [],
		rules: [],
		toolNames: [tool.name],
		tools: metadata,
		workspaceTree: { rootPath: root, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		nativeTools: true,
		inlineToolDescriptors: true,
	});
	return systemPrompt.join("\n\n");
}

describe("RefineTool", () => {
	it("rejects a disabled refinement before a later enable can drain it into the scheduled queue", async () => {
		const agentDir = await makeTemporaryRoot("disabled-global");
		const localArtifactsDir = await makeTemporaryRoot("disabled-artifacts");
		let enabled = false;
		const controller = createControllerFixture({
			agentDir,
			localArtifactsDir,
			isEnabled: () => enabled,
		});
		const tool = new RefineTool(() => controller);

		const rejected = tool.execute("disabled-refine", { op: "refine", scope: "local" });
		enabled = true;
		await expect(rejected).rejects.toThrow("Continual harness refinement is disabled");
		await controller.drainScheduled();

		expect(await loadHarnessState(localArtifactsDir, "local")).toBeUndefined();
		expect(await loadHarnessState(agentDir, "global")).toBeUndefined();
	});
	it("localizes disabled, scheduled, and rollback runtime results in zh-CN and restores the locale", async () => {
		setSettingsUiLocale("zh-CN");
		try {
			const disabledTool = new RefineTool(() => undefined);
			const disabled = await disabledTool.execute("disabled-zh", { op: "refine" });
			expect(disabled.content).toEqual([{ type: "text", text: "持续 harness 优化已禁用或不可用。" }]);

			const root = await makeTemporaryRoot("runtime-zh");
			const controller = createControllerFixture({
				agentDir: root,
				localArtifactsDir: root,
				isEnabled: () => true,
			});
			const tool = new RefineTool(() => controller);

			const scheduled = await tool.execute("scheduled-zh", { op: "refine", scope: "local" });
			expect(scheduled.content).toEqual([{ type: "text", text: "持续优化已安排，将在下一个空闲边界执行。" }]);
			expect(scheduled.details?.scheduled).toBe(true);
			expect(scheduled.details?.message).toBe("持续优化已安排，将在下一个空闲边界执行。");

			const rollback = await tool.execute("rollback-zh", {
				op: "rollback",
				resultId: "zh-result",
				scope: "local",
			});
			expect(rollback.content).toEqual([
				{ type: "text", text: "持续优化 zh-result 的回滚已安排在下一个空闲边界执行。" },
			]);
			expect(rollback.details?.scheduled).toBe(true);
			expect(rollback.details?.message).toBe("持续优化 zh-result 的回滚已安排在下一个空闲边界执行。");
		} finally {
			setSettingsUiLocale(previousSettingsUiLocale);
			expect(getSettingsUiLocale()).toBe(previousSettingsUiLocale);
		}
	});

	it("renders the enabled refine definition in the displayLanguage-selected locale", async () => {
		const root = await makeTemporaryRoot("locale");
		const controller = createControllerFixture({
			agentDir: root,
			localArtifactsDir: root,
			isEnabled: () => true,
		});

		Settings.isolated({ displayLanguage: "en" });
		const englishTool = new RefineTool(() => controller);
		const englishDefinition = await renderRefineToolDefinition(root, englishTool);
		expect(englishTool.description).toContain(
			"Schedule an evidence-backed continual harness refinement for the next turn boundary.",
		);
		expect(englishDefinition).toContain(
			"Schedule an evidence-backed continual harness refinement for the next turn boundary.",
		);
		expect(englishTool.description).not.toContain("在下一次 turn 边界调度基于证据的持续 harness 细化。");

		Settings.isolated({ displayLanguage: "zh-CN" });
		const chineseTool = new RefineTool(() => controller);
		const chineseDefinition = await renderRefineToolDefinition(root, chineseTool);
		expect(chineseTool.description).toContain("在下一次 turn 边界调度基于证据的持续 harness 细化。");
		expect(chineseDefinition).toContain("在下一次 turn 边界调度基于证据的持续 harness 细化。");
		expect(chineseTool.description).not.toContain(
			"Schedule an evidence-backed continual harness refinement for the next turn boundary.",
		);
	});

	it("persists local refinement and its rollback only under the session artifact directory", async () => {
		const agentDir = await makeTemporaryRoot("global");
		const localArtifactsDir = await makeTemporaryRoot("session-artifacts");
		const controller = createControllerFixture({
			agentDir,
			localArtifactsDir,
			isEnabled: () => true,
		});
		const tool = new RefineTool(() => controller);

		await tool.execute("local-refine", { op: "refine", scope: "local" });
		await controller.drainScheduled();
		const persisted = await loadHarnessState(localArtifactsDir, "local");
		expect(persisted?.entries.memory["session-local-memory"]?.content).toBe("Created for local.");
		await expect(fs.access(path.join(agentDir, "harness", "harness-state.json"))).rejects.toThrow();

		const [initialRefinement] = await loadRefinementHistory(localArtifactsDir, "local");
		if (!initialRefinement)
			throw new Error("Expected the local refinement to be recorded in the session artifact history");
		await tool.execute("local-rollback", {
			op: "rollback",
			resultId: initialRefinement.id,
			scope: "local" as HarnessScope,
		});
		await controller.drainScheduled();

		const rolledBack = await loadHarnessState(localArtifactsDir, "local");
		const history = await loadRefinementHistory(localArtifactsDir, "local");
		expect(rolledBack?.entries.memory["session-local-memory"]).toBeUndefined();
		expect(history).toHaveLength(2);
		expect(history[1]?.rollbackOf).toBe(initialRefinement.id);
		await expect(fs.access(path.join(agentDir, "harness", "harness-state.json"))).rejects.toThrow();
	});
});
