import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getCliLocale, setCliLocale } from "@oh-my-pi/pi-utils/cli";
import type { AutonomousRuntimeState } from "../../src/autonomous/types";
import { parseArgs } from "../../src/cli/args";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../src/i18n/settings-locale";
import { buildSessionOptions } from "../../src/main";
import { getPromptLocale, setPromptLocale } from "../../src/prompts/prompt-locale";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

interface SessionFixture {
	tempDir: TempDir;
	authStorage: AuthStorage;
	session: AgentSession;
}

const fixtures: SessionFixture[] = [];
let previousPromptLocale: ReturnType<typeof getPromptLocale>;
let previousSettingsUiLocale: ReturnType<typeof getSettingsUiLocale>;
let previousCliLocale: ReturnType<typeof getCliLocale>;

beforeEach(() => {
	previousPromptLocale = getPromptLocale();
	previousSettingsUiLocale = getSettingsUiLocale();
	previousCliLocale = getCliLocale();
});

afterEach(async () => {
	let cleanupFailure: unknown;
	for (const fixture of fixtures.splice(0).reverse()) {
		try {
			await fixture.session.dispose();
		} catch (error) {
			cleanupFailure ??= error;
		}
		try {
			fixture.authStorage.close();
		} catch (error) {
			cleanupFailure ??= error;
		}
		try {
			await fixture.tempDir.remove();
		} catch (error) {
			cleanupFailure ??= error;
		}
	}
	setPromptLocale(previousPromptLocale);
	setSettingsUiLocale(previousSettingsUiLocale);
	setCliLocale(previousCliLocale);
	if (cleanupFailure !== undefined) throw cleanupFailure;
});

function durableState(overrides: Partial<AutonomousRuntimeState> = {}): AutonomousRuntimeState {
	return {
		enabled: true,
		goalActive: false,
		continuationsUsed: 2,
		turnsUsed: 3,
		tokensUsed: 37,
		startedAt: 1_000,
		limits: {
			maxContinuations: 6,
			maxTurns: 61,
			maxTokens: 610,
			timeoutMs: 61_000,
		},
		continuationPrompt: "Preserve this durable continuation contract.",
		gates: {
			commands: ["durable gate"],
			maxRetries: 7,
			timeoutMs: 7_000,
		},
		gateAttempts: { "durable gate": 2 },
		lastGateFailure: {
			command: "durable gate",
			attempt: 2,
			exitText: "exited 17",
			output: "durable failure",
		},
		lastGateFailureSnapshot: {
			status: " M durable.txt\0",
			diff: "durable diff",
			untrackedHash: "durable hash",
		},
		...overrides,
	};
}

async function createResumedSession(
	rawArgs: readonly string[],
	state: AutonomousRuntimeState,
): Promise<SessionFixture> {
	const tempDir = TempDir.createSync("@omp-autonomous-resume-");
	const workspace = tempDir.join("workspace");
	const agentDir = tempDir.join("agent");
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	let session: AgentSession | undefined;
	try {
		await fs.mkdir(workspace, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled Anthropic test model");

		const sessionManager = SessionManager.inMemory(workspace);
		sessionManager.appendCustomEntry("omp.autonomous-state", state);
		const settings = Settings.isolated({
			"async.enabled": false,
			"marketplace.autoUpdate": "off",
			"schedule.enabled": false,
			"heartbeat.enabled": false,
			"autonomous.enabled": false,
			"autonomous.maxContinuations": 8,
			"autonomous.maxTurns": 800,
			"autonomous.maxTokens": 8_000,
			"autonomous.timeoutMs": 800_000,
			"autonomous.gate.commands": ["settings gate"],
			"autonomous.gate.maxRetries": 80,
			"autonomous.gate.timeoutMs": 80_000,
		});
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const cliOptions = await buildSessionOptions(
			parseArgs(["--cwd", workspace, ...rawArgs]),
			[],
			sessionManager,
			modelRegistry,
			settings,
		);
		const result = await createAgentSession({
			...cliOptions,
			cwd: workspace,
			agentDir,
			authStorage,
			modelRegistry,
			model,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
			rules: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: workspace, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			enableMCP: false,
			enableLsp: false,
		});
		session = result.session;
		const fixture = { tempDir, authStorage, session: result.session };
		fixtures.push(fixture);
		return fixture;
	} catch (error) {
		try {
			await session?.dispose();
		} finally {
			try {
				authStorage.close();
			} finally {
				await tempDir.remove();
			}
		}
		throw error;
	}
}

function autonomousRuntimeState(fixture: SessionFixture): AutonomousRuntimeState {
	const controller = fixture.session.getAutonomousController();
	if (!controller) throw new Error("Expected main session to own an autonomous controller");
	return controller.state;
}

describe("resumed autonomous session configuration", () => {
	it.each([
		{ label: "--continue", resumeArgs: ["--continue"] },
		{ label: "--resume", resumeArgs: ["--resume"] },
	])("overlays only explicit autonomous CLI fields for $label", async ({ resumeArgs }) => {
		const state = durableState({ enabled: false });
		const fixture = await createResumedSession(
			[
				...resumeArgs,
				"--autonomous",
				"--autonomous-max-turns",
				"17",
				"--autonomous-max-tokens",
				"170",
				"--autonomous-gate",
				"cli gate one",
				"--autonomous-gate",
				"cli gate two",
			],
			state,
		);

		expect(autonomousRuntimeState(fixture)).toEqual({
			...state,
			enabled: true,
			limits: { ...state.limits, maxTurns: 17, maxTokens: 170 },
			gates: { ...state.gates, commands: ["cli gate one", "cli gate two"] },
		});
	});

	it.each([
		{ label: "--continue", resumeArgs: ["--continue"] },
		{ label: "--resume", resumeArgs: ["--resume"] },
	])(
		"keeps every observable durable autonomous field when $label has no autonomous CLI flag",
		async ({ resumeArgs }) => {
			const state = durableState();
			const fixture = await createResumedSession(resumeArgs, state);

			expect(autonomousRuntimeState(fixture)).toEqual(state);
		},
	);
});
