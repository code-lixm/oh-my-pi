import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveRuntime } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

async function createSession(tempDir: TempDir, name: string, modelRegistry: ModelRegistry): Promise<AgentSession> {
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	await sessionManager.setSessionFile(path.join(tempDir.path(), `${name}.jsonl`));
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
	return new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry,
	});
}

describe("InteractiveMode live top-level sessions", () => {
	let authStorage: AuthStorage;
	let tempDir: TempDir;
	let mode: InteractiveMode;
	let original: AgentSession;
	let live: AgentSession;
	let runtimeFactoryCalls: number;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-live-top-level-session-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		original = await createSession(tempDir, "original", modelRegistry);
		live = await createSession(tempDir, "live", modelRegistry);
		const runtime: InteractiveRuntime = { session: live, setToolUIContext: () => {} };
		runtimeFactoryCalls = 0;
		mode = new InteractiveMode(original, "test", undefined, undefined, undefined, undefined, undefined, async () => {
			runtimeFactoryCalls++;
			return runtime;
		});
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.stop();
		await live?.dispose();
		await original?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("keeps a streaming session alive when /new foregrounds a separate runtime", async () => {
		Object.defineProperty(original, "isStreaming", { configurable: true, get: () => true });
		const abort = vi.spyOn(original, "abort");
		const reset = vi.spyOn(original, "newSession");
		const dispose = vi.spyOn(original, "dispose");

		await mode.handleClearCommand();

		expect(mode.session).toBe(live);
		expect(abort).not.toHaveBeenCalled();
		expect(reset).not.toHaveBeenCalled();
		expect(dispose).not.toHaveBeenCalled();
	});

	it("reattaches a live session without aborting it or cold-switching its transcript", async () => {
		await mode.handleClearCommand();
		const resumedAbort = vi.spyOn(original, "abort");
		const foregroundAbort = vi.spyOn(live, "abort");
		const resumedSwitchSession = vi.spyOn(original, "switchSession");
		const foregroundSwitchSession = vi.spyOn(live, "switchSession");

		await mode.handleResumeSession(original.sessionManager.getSessionFile()!);

		expect(mode.session).toBe(original);
		expect(resumedAbort).not.toHaveBeenCalled();
		expect(foregroundAbort).not.toHaveBeenCalled();
		expect(resumedSwitchSession).not.toHaveBeenCalled();
		expect(foregroundSwitchSession).not.toHaveBeenCalled();
	});

	it("resolves a relative path to its existing live runtime without cold-switching", async () => {
		await mode.handleClearCommand();
		const originalPath = original.sessionManager.getSessionFile();
		if (!originalPath) throw new Error("Expected persisted original session path");
		const originalSwitchSession = vi.spyOn(original, "switchSession");
		const liveSwitchSession = vi.spyOn(live, "switchSession");
		const prepareSessionSwitch = vi.spyOn(mode, "prepareSessionSwitch");

		await mode.handleResumeSession(path.relative(process.cwd(), originalPath));

		expect(mode.session).toBe(original);
		expect(originalSwitchSession).not.toHaveBeenCalled();
		expect(liveSwitchSession).not.toHaveBeenCalled();
		expect(prepareSessionSwitch).toHaveBeenCalledTimes(1);
	});

	it("cold-restores a previously indexed path after the active runtime switches to a third on-disk session", async () => {
		const originalPath = original.sessionManager.getSessionFile();
		const thirdPath = SessionManager.create(tempDir.path(), tempDir.path()).getSessionFile();
		if (!originalPath || !thirdPath) throw new Error("Expected persisted session paths");
		const switchSession = vi.spyOn(original, "switchSession");

		await mode.handleResumeSession(thirdPath);
		expect(original.sessionManager.getSessionFile()).toBe(thirdPath);

		await mode.handleResumeSession(originalPath);
		expect(original.sessionManager.getSessionFile()).toBe(originalPath);

		await mode.handleResumeSession(thirdPath);
		expect(original.sessionManager.getSessionFile()).toBe(thirdPath);
		expect(switchSession).toHaveBeenNthCalledWith(1, thirdPath);
		expect(switchSession).toHaveBeenNthCalledWith(2, originalPath);
		expect(switchSession).toHaveBeenNthCalledWith(3, thirdPath);
	});

	it("reattaches a background runtime after its SessionManager adopts a new session file", async () => {
		await mode.handleClearCommand();
		const adoptedPath = path.join(tempDir.path(), "background-adopted.jsonl");
		await original.sessionManager.setSessionFile(adoptedPath);
		const originalSwitchSession = vi.spyOn(original, "switchSession");
		const liveSwitchSession = vi.spyOn(live, "switchSession");
		const prepareSessionSwitch = vi.spyOn(mode, "prepareSessionSwitch");

		await mode.handleResumeSession(adoptedPath);

		expect(mode.session).toBe(original);
		expect(originalSwitchSession).not.toHaveBeenCalled();
		expect(liveSwitchSession).not.toHaveBeenCalled();
		expect(prepareSessionSwitch).toHaveBeenCalledTimes(1);
	});

	it("keeps live runtime bindings intact when resuming its current session path", async () => {
		await mode.handleClearCommand();
		const originalPath = original.sessionManager.getSessionFile();
		const livePath = live.sessionManager.getSessionFile();
		if (!originalPath || !livePath) throw new Error("Expected persisted session paths");
		const resetObservers = vi.spyOn(mode, "resetObserverRegistry");
		const prepareSessionSwitch = vi.spyOn(mode, "prepareSessionSwitch");
		const liveSwitchSession = vi.spyOn(live, "switchSession");

		await mode.handleResumeSession(livePath);

		expect(mode.session).toBe(live);
		expect(resetObservers).not.toHaveBeenCalled();
		expect(liveSwitchSession).not.toHaveBeenCalled();
		expect(prepareSessionSwitch).not.toHaveBeenCalled();

		await mode.handleResumeSession(originalPath);
		expect(mode.session).toBe(original);
		expect(prepareSessionSwitch).toHaveBeenCalledTimes(1);
	});

	it("refuses /new while a dialog owns input without replacing the foreground session", async () => {
		mode.hookSelector = {} as never;

		const result = await mode.startNewTopLevelRuntime();

		expect(result).toBe(false);
		expect(mode.session).toBe(original);
		expect(runtimeFactoryCalls).toBe(0);
	});
});
