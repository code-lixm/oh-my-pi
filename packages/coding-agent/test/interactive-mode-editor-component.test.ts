import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { SessionHistoryViewer } from "@oh-my-pi/pi-coding-agent/modes/components/session-history-viewer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TUI } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

class TestModalEditor extends CustomEditor {}

function captureWrites(terminal: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = terminal.write.bind(terminal);
	vi.spyOn(terminal, "write").mockImplementation(data => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

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

	it("keeps native scrollback mouse-free for main editors while enabling history overlay tracking", async () => {
		session.settings.set("tui.mouseInput", true);
		const terminal = new VirtualTerminal(80, 8);
		const scheduler = new StressRenderScheduler();
		mode.ui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		mode.ui.addChild(mode.editorContainer);
		mode.ui.setFocus(mode.editor);
		const writes = captureWrites(terminal);

		try {
			mode.ui.start();
			await scheduler.drain(terminal);

			const initialWrites = writes.join("");
			expect(initialWrites).not.toContain("\x1b[?1000h");
			expect(initialWrites).not.toContain("\x1b[?1006h");

			// Extension editors replace the same normal-screen composer and must retain
			// the native scrollback contract rather than inheriting mouse input from the setting.
			writes.length = 0;
			vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
			mode.setEditorComponent((tui, editorTheme) => new TestModalEditor(tui, editorTheme));
			await scheduler.drain(terminal);

			const replacementWrites = writes.join("");
			expect(replacementWrites).not.toContain("\x1b[?1000h");
			expect(replacementWrites).not.toContain("\x1b[?1006h");

			// Application-managed fullscreen history is the intentional exception: it
			// owns the alternate screen and needs pointer input for its transcript controls.
			writes.length = 0;
			mode.showSessionHistory();
			await scheduler.drain(terminal);

			const historyWrites = writes.join("");
			expect(mode.ui.getFocused()).toBeInstanceOf(SessionHistoryViewer);
			expect(historyWrites).toContain("\x1b[?1049h");
			expect(historyWrites).toContain("\x1b[?1000h");
			expect(historyWrites).toContain("\x1b[?1006h");
		} finally {
			mode.ui.stop();
		}
	});
});
