import { afterEach, describe, expect, it } from "bun:test";
import {
	type Api,
	type AssistantMessage,
	clearCustomApis,
	type Model,
	type ModelSpec,
	registerCustomApi,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const API = "thinking-summary-visibility";
const MAIN_MODEL_ID = "thinking-visibility-main";
const SUBAGENT_MODEL_ID = "thinking-visibility-subagent";

type CapturedRequest = {
	modelId: string;
	hideThinkingSummary: boolean | undefined;
};

type Harness = {
	settings: Settings;
	main: AgentSession;
	subagent: AgentSession;
	requests: CapturedRequest[];
};

let tempDir: TempDir | undefined;
let authStorage: AuthStorage | undefined;
const sessions: AgentSession[] = [];

function responseFor(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "provider response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function thinkingModel(id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: API,
		provider: "ollama",
		baseUrl: "http://127.0.0.1:11434",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

async function createHarness(initialSettings: { hideThinkingBlock: boolean; omitThinking: boolean }): Promise<Harness> {
	AgentRegistry.resetGlobalForTests();
	tempDir = TempDir.createSync("@pi-thinking-summary-visibility-");
	authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const requests: CapturedRequest[] = [];

	registerCustomApi(API, (model, _context, options) => {
		requests.push({ modelId: model.id, hideThinkingSummary: options?.hideThinkingSummary });
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			const message = responseFor(model);
			stream.push({ type: "text_delta", contentIndex: 0, delta: "provider response", partial: message });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	});

	const settings = Settings.isolated({
		"compaction.enabled": false,
		hideThinkingBlock: initialSettings.hideThinkingBlock,
		omitThinking: initialSettings.omitThinking,
	});
	const baseOptions = {
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		authStorage,
		modelRegistry,
		settings,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	};
	const { session: main } = await createAgentSession({
		...baseOptions,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		model: thinkingModel(MAIN_MODEL_ID),
		agentId: "Main",
	});
	sessions.push(main);
	const { session: subagent } = await createAgentSession({
		...baseOptions,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		model: thinkingModel(SUBAGENT_MODEL_ID),
		agentId: "ThinkingVisibilitySubagent",
		taskDepth: 1,
	});
	sessions.push(subagent);

	return { settings, main, subagent, requests };
}

async function requestSummaryOption(
	session: AgentSession,
	modelId: string,
	prompt: string,
	requests: CapturedRequest[],
): Promise<boolean | undefined> {
	const requestCount = requests.length;
	await session.sendUserMessage(prompt);
	await session.waitForIdle();
	const matching = requests.slice(requestCount).filter(request => request.modelId === modelId);
	if (matching.length === 0) throw new Error(`Expected a provider request from ${modelId}`);
	return matching[matching.length - 1]?.hideThinkingSummary;
}

function settingsContext(
	session: AgentSession,
	settings: Settings,
	hideThinkingBlock: boolean,
): InteractiveModeContext {
	return {
		session,
		settings,
		hideThinkingBlock,
		effectiveHideThinkingBlock: hideThinkingBlock,
		proseOnlyThinking: false,
		chatContainer: { children: [] },
		ui: { resetDisplay: () => {} },
	} as unknown as InteractiveModeContext;
}

afterEach(async () => {
	for (const session of sessions.splice(0).reverse()) {
		await session.dispose();
	}
	AsyncJobManager.resetForTests();
	AgentRegistry.resetGlobalForTests();
	clearCustomApis();
	authStorage?.close();
	authStorage = undefined;
	tempDir?.removeSync();
	tempDir = undefined;
});

describe("thinking summary visibility policy", () => {
	it("requests summaries for initially visible Main and subagent sessions despite provider omission", async () => {
		const { main, subagent, requests } = await createHarness({ hideThinkingBlock: false, omitThinking: true });

		expect(await requestSummaryOption(main, MAIN_MODEL_ID, "main initial visibility", requests)).toBe(false);
		expect(await requestSummaryOption(subagent, SUBAGENT_MODEL_ID, "subagent initial visibility", requests)).toBe(
			false,
		);
	});

	it("applies live omission and visibility changes to Main and every registered subagent", async () => {
		const { settings, main, subagent, requests } = await createHarness({
			hideThinkingBlock: true,
			omitThinking: false,
		});
		const ctx = settingsContext(main, settings, true);
		const controller = new SelectorController(ctx);

		settings.set("omitThinking", true);
		controller.handleSettingChange("omitThinking", true);
		expect(await requestSummaryOption(main, MAIN_MODEL_ID, "main hidden omission", requests)).toBe(true);
		expect(await requestSummaryOption(subagent, SUBAGENT_MODEL_ID, "subagent hidden omission", requests)).toBe(true);

		settings.set("hideThinkingBlock", false);
		controller.handleSettingChange("hideThinkingBlock", false);
		expect(await requestSummaryOption(main, MAIN_MODEL_ID, "main visible override", requests)).toBe(false);
		expect(await requestSummaryOption(subagent, SUBAGENT_MODEL_ID, "subagent visible override", requests)).toBe(
			false,
		);
	});
});
