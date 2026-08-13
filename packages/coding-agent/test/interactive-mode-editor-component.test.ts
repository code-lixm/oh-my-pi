import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

class TestModalEditor extends CustomEditor {}

describe("InteractiveMode.setEditorComponent", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-editor-component-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("replaces the editor and rebinds interactive handlers", () => {
		mode.editor.setText("draft prompt");
		const previousEditor = mode.editor;
		const refreshSpy = vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();

		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));

		expect(mode.editor).toBeInstanceOf(TestModalEditor);
		expect(mode.editor).not.toBe(previousEditor);
		expect(mode.editor.getText()).toBe("draft prompt");
		expect(mode.editor.onSubmit).toBeDefined();
		expect(mode.editor.onEscape).toBeDefined();
		expect(refreshSpy).toHaveBeenCalled();
	});

	it("passes an explicit mouse-tracking choice to the focused-agent fullscreen overlay", () => {
		for (const mouseTracking of [false, true]) {
			session.settings.set("tui.mouseInput", mouseTracking);
			let capturedOptions: { mouseTracking?: boolean } | undefined;
			const showOverlay = vi.spyOn(mode.ui, "showOverlay").mockImplementation((_component, options) => {
				capturedOptions = options;
				return { hide: vi.fn() } as never;
			});

			mode.showFocusedAgentView("Worker");

			expect(capturedOptions?.mouseTracking).toBe(mouseTracking);
			mode.hideFocusedAgentView();
			showOverlay.mockRestore();
		}
	});

	it("binds initial and replacement editors to tui.mouseInput", () => {
		session.settings.set("tui.mouseInput", false);
		expect(mode.editor.mouseTracking).toBe(false);

		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
		expect(mode.editor.mouseTracking).toBe(false);

		session.settings.set("tui.mouseInput", true);
		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
		expect(mode.editor.mouseTracking).toBe(true);
	});

	it("keeps session history selection-first regardless of tui.mouseInput", () => {
		for (const mouseTracking of [false, true]) {
			session.settings.set("tui.mouseInput", mouseTracking);
			let capturedOptions: { fullscreen?: boolean; mouseTracking?: boolean } | undefined;
			const showOverlay = vi.spyOn(mode.ui, "showOverlay").mockImplementation((_component, options) => {
				capturedOptions = options;
				return { hide: vi.fn() } as never;
			});

			try {
				mode.showSessionHistory();
				expect(capturedOptions).toMatchObject({ fullscreen: true, mouseTracking: false });
			} finally {
				showOverlay.mockRestore();
			}
		}
	});
});
