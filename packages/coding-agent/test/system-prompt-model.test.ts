import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { usesCodexTaskPrompt } from "@oh-my-pi/pi-coding-agent/task/prompt-policy";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { getPromptLocale, type PromptLocale, setPromptLocale } from "../src/prompts/prompt-locale";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

const MODEL_GUIDANCE = {
	codex: {
		englishHeading: "# Codex Model Guidance",
		englishSemantic: "After compaction, continue retained work; NEVER redo completed work.",
		chineseHeading: "# Codex 模型指导",
		chineseSemantic: "compaction 后继续已保留的工作；NEVER 重做已完成工作。",
	},
	claude: {
		englishHeading: "# Claude Model Guidance",
		englishSemantic: "Parallelize only independent work with explicit boundaries.",
		chineseHeading: "# Claude 模型指导",
		chineseSemantic: "仅并行执行边界明确且彼此独立的工作。",
	},
} as const;

async function expectPromptDateFromStartupTimezone(options: {
	tempDir: string;
	tempHomeDir: string;
	timeZone: string;
	now: string;
	expectedDate: string;
	rejectedDate: string;
}): Promise<void> {
	const scenarioPath = path.join(options.tempDir, "prompt-date-timezone.test.ts");
	const resultPath = path.join(options.tempDir, "prompt-date-timezone-result.txt");
	await Bun.write(
		scenarioPath,
		`import { expect, it, setSystemTime } from "bun:test";
import { buildSystemPrompt } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/system-prompt.ts"))};

it("renders the prompt date in the startup timezone", async () => {
	setSystemTime(new Date(process.env.OMP_TEST_NOW!));
	try {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: process.cwd(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: {
				rootPath: process.cwd(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			activeRepoContext: null,
		});
		const rendered = systemPrompt.join("\\n\\n");
		await Bun.write(process.env.OMP_TEST_RESULT!, rendered);
		expect(rendered).toContain(\`Today is \${process.env.OMP_EXPECTED_DATE}\`);
		expect(rendered).not.toContain(\`Today is \${process.env.OMP_REJECTED_DATE}\`);
	} finally {
		setSystemTime();
	}
});
`,
	);
	const child = Bun.spawn([process.execPath, "test", scenarioPath], {
		cwd: options.tempDir,
		env: {
			...process.env,
			HOME: options.tempHomeDir,
			TZ: options.timeZone,
			OMP_TEST_NOW: options.now,
			OMP_EXPECTED_DATE: options.expectedDate,
			OMP_REJECTED_DATE: options.rejectedDate,
			OMP_TEST_RESULT: resultPath,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, `timezone child output: ${stderr || stdout || "(none)"}`).toBe(0);
	const rendered = await Bun.file(resultPath).text();
	expect(rendered).toContain(`Today is ${options.expectedDate}`);
	expect(rendered).not.toContain(`Today is ${options.rejectedDate}`);
}

describe("system prompt model identifier", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;
	let previousPromptLocale: PromptLocale;

	beforeEach(() => {
		previousPromptLocale = getPromptLocale();
		setPromptLocale("en");
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-model-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-model-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(() => {
		setPromptLocale(previousPromptLocale);
		cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome }))();
	});

	async function renderSystemPrompt(options: {
		model?: string;
		customPrompt?: string;
		includeModelInPrompt?: boolean;
	}): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			activeRepoContext: null,
			includeModelInPrompt: options.includeModelInPrompt ?? false,
			model: options.model,
			customPrompt: options.customPrompt,
		});
		return systemPrompt.join("\n\n");
	}

	it("renders the model identifier into the workstation block when provided", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			model: "anthropic/claude-opus-4",
		});

		expect(systemPrompt.join("\n\n")).toContain("Model: anthropic/claude-opus-4");
	});

	it("renders the prompt date from the startup local timezone rather than UTC", async () => {
		await expectPromptDateFromStartupTimezone({
			tempDir,
			tempHomeDir,
			timeZone: "America/Los_Angeles",
			now: "2026-07-01T03:15:00Z",
			expectedDate: "2026-06-30",
			rejectedDate: "2026-07-01",
		});
	});

	it("omits the model line when no model is provided", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});

		expect(systemPrompt.join("\n\n")).not.toContain("Model:");
	});

	it("routes representative model identifiers to only their matching guidance overlay", async () => {
		const cases = [
			{ name: "Codex provider/id", model: "openai-codex/gpt-5.6-terra", family: "codex" },
			{ name: "Codex variant", model: "gpt-5.6-codex", family: "codex" },
			{ name: "Pre-5.6 Codex variant", model: "gpt-5.4-codex", family: "codex" },
			{ name: "bare Claude", model: "claude-opus-4-8", family: "claude" },
			{ name: "provider-qualified Claude", model: "anthropic/claude-opus-4.8", family: "claude" },
			{ name: "OpenRouter Claude", model: "openrouter/anthropic/claude-opus-4-8", family: "claude" },
			{
				name: "Bedrock Claude",
				model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
				family: "claude",
			},
			{ name: "SAP Claude", model: "anthropic--claude-4.8-opus", family: "claude" },
		] as const;

		for (const testCase of cases) {
			const rendered = await renderSystemPrompt({ model: testCase.model });
			const selected = MODEL_GUIDANCE[testCase.family];
			const other = MODEL_GUIDANCE[testCase.family === "codex" ? "claude" : "codex"];

			expect(rendered, testCase.name).toContain(selected.englishHeading);
			expect(rendered, testCase.name).toContain(selected.englishSemantic);
			expect(rendered, testCase.name).not.toContain(other.englishHeading);
		}

		const unknown = await renderSystemPrompt({ model: "some-unknown-model" });
		expect(unknown).not.toContain(MODEL_GUIDANCE.codex.englishHeading);
		expect(unknown).not.toContain(MODEL_GUIDANCE.claude.englishHeading);
	});

	it("lets customPrompt replace the default prompt without appending model guidance", async () => {
		const customPrompt = "CUSTOM OPERATOR CONTRACT: preserve the caller's exact policy.";
		const rendered = await renderSystemPrompt({
			model: "openai-codex/gpt-5.6-terra",
			customPrompt,
		});

		expect(rendered).toContain(customPrompt);
		expect(rendered).not.toContain("You are a helpful assistant the team trusts");
		expect(rendered).not.toContain(MODEL_GUIDANCE.codex.englishHeading);
		expect(rendered).not.toContain(MODEL_GUIDANCE.claude.englishHeading);
	});

	it("renders each model guidance overlay in the active prompt locale", async () => {
		const cases = [
			{ model: "openai-codex/gpt-5.6-terra", family: "codex" },
			{ model: "anthropic/claude-opus-4.8", family: "claude" },
		] as const;

		for (const testCase of cases) {
			const guidance = MODEL_GUIDANCE[testCase.family];
			setPromptLocale("en");
			const english = await renderSystemPrompt({ model: testCase.model });
			setPromptLocale("zh-CN");
			const chinese = await renderSystemPrompt({ model: testCase.model });

			expect(english).toContain(guidance.englishHeading);
			expect(english).toContain(guidance.englishSemantic);
			expect(english).not.toContain(guidance.chineseHeading);
			expect(chinese).toContain(guidance.chineseHeading);
			expect(chinese).toContain(guidance.chineseSemantic);
			expect(chinese).not.toContain(guidance.englishHeading);
		}
	});
});

describe("AgentSession model-change prompt refresh", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-model-session-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	function pickTwoModels(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		const second = all.find(m => m.provider !== first.provider || m.id !== first.id);
		if (!first || !second) throw new Error("Expected at least two distinct models in the registry");
		return [first, second];
	}

	function pickTwoModelsWithSameGuidanceFamily(): [Model, Model] {
		const first = modelRegistry.find("openai-codex", "gpt-5.4");
		const second = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!first || !second) throw new Error("Expected two non-guidance Codex models in the registry");
		return [first, second];
	}

	function pickModelsAcrossTaskPolicies(): [Model, Model] {
		const all = modelRegistry.getAll();
		const defaultPolicy = all.find(model => !usesCodexTaskPrompt(model.id));
		const codexPolicy = all.find(model => usesCodexTaskPrompt(model.id));
		if (!defaultPolicy || !codexPolicy) throw new Error("Expected default-policy and GPT-5.6 models");
		return [defaultPolicy, codexPolicy];
	}

	function pickModelsAcrossGuidanceFamilies(): [Model, Model, Model] {
		const none = modelRegistry.find("openai-codex", "gpt-5.5");
		const claude = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		const codex = modelRegistry.find("openai-codex", "gpt-5.6-sol");
		if (!none || !claude || !codex) {
			throw new Error("Expected none, Claude, and Codex guidance models in the registry");
		}
		return [none, claude, codex];
	}

	function newSession(
		model: Model,
		settings: Settings,
		rebuild: () => Promise<{ systemPrompt: string[] }>,
	): AgentSession {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			rebuildSystemPrompt: async () => rebuild(),
		});
		return created;
	}

	it("rebuilds the prompt with the new model when includeModelInPrompt is enabled", async () => {
		const [modelA, modelB] = pickTwoModels();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(modelA, Settings.isolated({ "compaction.enabled": false }), async () => {
			rebuildCount++;
			const active = session?.model;
			return { systemPrompt: [`model:${active ? `${active.provider}/${active.id}` : ""}`] };
		});

		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual([`model:${modelB.provider}/${modelB.id}`]);

		// Re-selecting the same model leaves the rendered model unchanged → no rebuild.
		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
	});

	it("does not rebuild a hidden-model prompt when the model guidance family stays the same", async () => {
		const [modelA, modelB] = pickTwoModelsWithSameGuidanceFamily();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false }),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["unchanged"] };
			},
		);

		await session.setModel(modelB);
		expect(rebuildCount).toBe(0);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);
	});

	it("rebuilds a hidden-model prompt when the task policy changes", async () => {
		const [modelA, modelB] = pickModelsAcrossTaskPolicies();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false }),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["policy changed"] };
			},
		);

		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual(["policy changed"]);
	});

	it("rebuilds a hidden-model prompt for every transition across none, Claude, and Codex guidance", async () => {
		const [none, claude, codex] = pickModelsAcrossGuidanceFamilies();
		for (const model of [none, claude, codex]) {
			authStorage.setRuntimeApiKey(model.provider, `key-${model.provider}`);
		}

		const rebuiltFor: string[] = [];
		session = newSession(
			none,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false }),
			async () => {
				const active = session?.model;
				const identifier = active ? `${active.provider}/${active.id}` : "";
				rebuiltFor.push(identifier);
				return { systemPrompt: [`guidance:${identifier}`] };
			},
		);

		await session.setModel(claude);
		await session.setModel(codex);
		await session.setModel(none);

		expect(rebuiltFor).toEqual([
			`${claude.provider}/${claude.id}`,
			`${codex.provider}/${codex.id}`,
			`${none.provider}/${none.id}`,
		]);
		expect(session.agent.state.systemPrompt).toEqual([`guidance:${none.provider}/${none.id}`]);
	});
});
