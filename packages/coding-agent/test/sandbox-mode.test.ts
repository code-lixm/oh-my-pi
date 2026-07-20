import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { applyStartupCwd } from "@oh-my-pi/pi-coding-agent/cli/startup-cwd";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions, createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { buildSystemPrompt, loadSystemPromptFiles } from "@oh-my-pi/pi-coding-agent/system-prompt";
import {
	getProjectAgentDir,
	getProjectDir,
	normalizePathForComparison,
	setProjectDir,
	TempDir,
} from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("sandbox startup contracts", () => {
	let settingsState: SettingsTestState | undefined;
	let originalCwd = process.cwd();

	beforeEach(() => {
		settingsState = beginSettingsTest();
		originalCwd = process.cwd();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	it("creates and enters the explicit sandbox cwd without rewriting session or no-* flags", async () => {
		using tempDir = TempDir.createSync("@omp-sandbox-startup-");
		const launchDir = tempDir.join("launch");
		const sandboxDir = tempDir.join("sandbox-root");
		fs.mkdirSync(launchDir, { recursive: true });
		setProjectDir(launchDir);

		const parsed = parseArgs(["--sandbox", "--cwd", sandboxDir]);
		parsed.resume = "session-123";
		parsed.continue = true;
		parsed.fork = "forked-456";
		parsed.sessionDir = tempDir.join("sessions");
		parsed.noSession = false;
		parsed.noExtensions = true;
		parsed.noSkills = false;
		parsed.noRules = true;
		parsed.noLsp = false;

		await applyStartupCwd(parsed);

		expect(fs.existsSync(sandboxDir)).toBe(true);
		expect(normalizePathForComparison(parsed.cwd ?? "")).toBe(normalizePathForComparison(sandboxDir));
		expect(normalizePathForComparison(getProjectDir())).toBe(normalizePathForComparison(sandboxDir));
		expect(normalizePathForComparison(process.cwd())).toBe(normalizePathForComparison(sandboxDir));

		expect(parsed.resume).toBe("session-123");
		expect(parsed.continue).toBe(true);
		expect(parsed.fork).toBe("forked-456");
		expect(parsed.sessionDir).toBe(tempDir.join("sessions"));
		expect(parsed.noSession).toBe(false);
		expect(parsed.noExtensions).toBe(true);
		expect(parsed.noSkills).toBe(false);
		expect(parsed.noRules).toBe(true);
		expect(parsed.noLsp).toBe(false);

		const sessionManagerParsed = parseArgs(["--sandbox", "--cwd", sandboxDir]);
		sessionManagerParsed.sessionDir = tempDir.join("sessions");
		await applyStartupCwd(sessionManagerParsed);
		const sessionManager = await createSessionManager(sessionManagerParsed, sessionManagerParsed.cwd ?? "");
		expect(sessionManager).toBeDefined();
		expect(normalizePathForComparison(sessionManager?.getCwd() ?? "")).toBe(normalizePathForComparison(sandboxDir));
	});

	it("buildSessionOptions keeps the sandbox cwd and does not inject discovery or MCP overrides", async () => {
		using tempDir = TempDir.createSync("@omp-sandbox-session-options-");
		const launchDir = tempDir.join("launch");
		const sandboxDir = tempDir.join("sandbox-root");
		const launchSystemSentinel = "SYSTEM_LAUNCH_SENTINEL: should not survive sandbox startup";
		const sandboxSystemSentinel = "SYSTEM_SANDBOX_SENTINEL: should be discovered from sandbox cwd";

		fs.mkdirSync(path.join(launchDir, ".omp"), { recursive: true });
		fs.mkdirSync(path.join(sandboxDir, ".omp"), { recursive: true });
		await Bun.write(path.join(launchDir, ".omp", "SYSTEM.md"), launchSystemSentinel);
		await Bun.write(path.join(sandboxDir, ".omp", "SYSTEM.md"), sandboxSystemSentinel);
		setProjectDir(launchDir);

		const parsed = parseArgs(["--sandbox", "--cwd", sandboxDir]);
		await applyStartupCwd(parsed);

		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		try {
			const options = await buildSessionOptions(
				parsed,
				[],
				undefined,
				new ModelRegistry(authStorage),
				Settings.isolated({}),
			);

			expect(normalizePathForComparison(options.cwd ?? "")).toBe(normalizePathForComparison(sandboxDir));
			expect(options.customSystemPrompt).toBe(sandboxSystemSentinel);
			expect(options.customSystemPrompt).not.toBe(launchSystemSentinel);
			expect("disableProjectDiscovery" in options).toBe(false);
			expect("enableMCP" in options).toBe(false);
		} finally {
			authStorage.close();
		}
	});

	it("loads sandbox project settings after startup chdir instead of launch cwd settings", async () => {
		using tempDir = TempDir.createSync("@omp-sandbox-settings-");
		const agentDir = tempDir.join("agent");
		const launchDir = tempDir.join("launch");
		const sandboxDir = tempDir.join("sandbox-root");

		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(launchDir), { recursive: true });
		fs.mkdirSync(getProjectAgentDir(sandboxDir), { recursive: true });

		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ display: { showTokenUsage: false } }, null, 2),
		);
		await Bun.write(
			path.join(getProjectAgentDir(launchDir), "settings.json"),
			JSON.stringify({ display: { showTokenUsage: false } }),
		);
		await Bun.write(
			path.join(getProjectAgentDir(sandboxDir), "settings.json"),
			JSON.stringify({ display: { showTokenUsage: true } }),
		);

		setProjectDir(launchDir);
		const parsed = parseArgs(["--sandbox", "--cwd", sandboxDir]);
		await applyStartupCwd(parsed);

		const settings = await Settings.loadReadOnly({ agentDir });
		expect(settings.get("display.showTokenUsage")).toBe(true);
	});

	it("loads sandbox SYSTEM.md, AGENTS.md, and workspace context instead of pre-startup cwd sentinels", async () => {
		using tempDir = TempDir.createSync("@omp-sandbox-prompt-loading-");
		const launchDir = tempDir.join("launch");
		const sandboxDir = tempDir.join("sandbox-root");
		const launchSystemSentinel = "SYSTEM_LAUNCH_SENTINEL: launch cwd must stay out of sandbox prompt discovery";
		const sandboxSystemSentinel = "SYSTEM_SANDBOX_SENTINEL: sandbox cwd must load like a normal project root";
		const launchAgentsSentinel = "AGENTS_LAUNCH_SENTINEL: should not appear after sandbox startup";
		const sandboxAgentsSentinel = "AGENTS_SANDBOX_SENTINEL: sandbox AGENTS should load normally";
		const launchWorkspaceFile = "launch-only.ts";
		const sandboxWorkspaceFile = "workspace-visible.ts";

		fs.mkdirSync(path.join(launchDir, ".omp"), { recursive: true });
		fs.mkdirSync(path.join(launchDir, ".agents"), { recursive: true });
		fs.mkdirSync(path.join(sandboxDir, ".omp"), { recursive: true });
		fs.mkdirSync(path.join(sandboxDir, ".agents"), { recursive: true });
		await Bun.write(path.join(launchDir, ".omp", "SYSTEM.md"), launchSystemSentinel);
		await Bun.write(path.join(sandboxDir, ".omp", "SYSTEM.md"), sandboxSystemSentinel);
		await Bun.write(path.join(launchDir, ".agents", "AGENTS.md"), launchAgentsSentinel);
		await Bun.write(path.join(sandboxDir, ".agents", "AGENTS.md"), sandboxAgentsSentinel);
		await Bun.write(path.join(launchDir, launchWorkspaceFile), "export const launchOnly = true;\n");
		await Bun.write(path.join(sandboxDir, sandboxWorkspaceFile), "export const sandboxVisible = true;\n");

		setProjectDir(launchDir);
		const parsed = parseArgs(["--sandbox", "--cwd", sandboxDir]);
		await applyStartupCwd(parsed);

		await expect(loadSystemPromptFiles({ cwd: getProjectDir() })).resolves.toBe(sandboxSystemSentinel);

		const promptText = (
			await buildSystemPrompt({
				cwd: getProjectDir(),
				includeWorkspaceTree: true,
				rules: [],
			})
		).systemPrompt.join("\n");

		expect(promptText).toContain(sandboxAgentsSentinel);
		expect(promptText).toContain(sandboxWorkspaceFile);
		expect(promptText).not.toContain(launchSystemSentinel);
		expect(promptText).not.toContain(launchAgentsSentinel);
		expect(promptText).not.toContain(launchWorkspaceFile);
	});
});
