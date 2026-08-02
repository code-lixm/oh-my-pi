import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as SessionSelector from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createResumeContext(opts: { flushFails?: boolean; sourceCwd?: string } = {}) {
	const sourceCwd = opts.sourceCwd ?? "/tmp/source-project";
	const state = { cwd: sourceCwd };
	const switchSession = vi.fn(async () => true);
	const applyCwdChange = vi.fn(async () => {});
	const editor = {};
	let selector: SessionSelector.SessionSelectorComponent | undefined;
	const hide = vi.fn();
	const setFocus = vi.fn();
	const flush = vi.fn(async () => {
		if (opts.flushFails) throw new Error("disk full");
	});
	const attachLiveTopLevelRuntime = vi.fn(async () => undefined);
	const prepareSessionSwitch = vi.fn();
	const resetObserverRegistry = vi.fn();
	const ctx = {
		session: { switchSession },
		sessionManager: { getCwd: () => state.cwd, getSessionDir: () => "/tmp" },
		settings: { flush },
		prepareSessionSwitch,
		resetObserverRegistry,
		clearTransientSessionUi: vi.fn(),
		applyCwdChange,
		updateEditorBorderColor: vi.fn(),
		renderInitialMessages: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		showStatus: vi.fn(),
		showError: vi.fn(),
		statusLine: { invalidate: vi.fn(), resetActiveTime: vi.fn() },
		ui: {
			requestRender: vi.fn(),
			setFocus,
			terminal: { rows: 24 },
			showOverlay: vi.fn((component: unknown) => {
				selector = component as SessionSelector.SessionSelectorComponent;
				return { hide, setHidden: vi.fn(), isHidden: () => false };
			}),
		},
		editor,
		editorContainer: { children: [editor], clear: vi.fn(), addChild: vi.fn() },
		attachLiveTopLevelRuntime,
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		attachLiveTopLevelRuntime,
		switchSession,
		prepareSessionSwitch,
		resetObserverRegistry,
		applyCwdChange,
		state,
		editor,
		hide,
		setFocus,
		flush,
		getSelector: () => selector,
	};
}

describe("SelectorController.handleResumeSession preflight flush", () => {
	it("aborts resume and returns false when flush fails, leaving session untouched", async () => {
		const { ctx, switchSession, applyCwdChange } = createResumeContext({ flushFails: true });
		const controller = new SelectorController(ctx);

		const result = await controller.handleResumeSession("/tmp/some-session.jsonl");

		expect(result).toBe(false);
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
		expect(ctx.clearTransientSessionUi).not.toHaveBeenCalled();
		expect(switchSession).not.toHaveBeenCalled();
		expect(applyCwdChange).not.toHaveBeenCalled();
		expect(ctx.showStatus).not.toHaveBeenCalled();
	});

	it("proceeds and returns true when flush succeeds", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-preflight-"));
		try {
			const { ctx, attachLiveTopLevelRuntime, switchSession, applyCwdChange, state } = createResumeContext({
				sourceCwd: tmpDir,
			});
			const targetCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-target-"));
			switchSession.mockImplementation(async () => {
				state.cwd = targetCwd;
				return true;
			});
			const controller = new SelectorController(ctx);

			const result = await controller.handleResumeSession("/tmp/some-session.jsonl");

			expect(result).toBe(true);
			expect(ctx.settings.flush).toHaveBeenCalled();
			expect(attachLiveTopLevelRuntime).toHaveBeenCalledWith("/tmp/some-session.jsonl");
			expect(ctx.clearTransientSessionUi).toHaveBeenCalled();
			expect(switchSession).toHaveBeenCalledWith("/tmp/some-session.jsonl");
			expect(applyCwdChange).toHaveBeenCalledWith(targetCwd);
			expect(ctx.showError).not.toHaveBeenCalled();
			expect(ctx.showStatus).toHaveBeenCalled();

			await fs.rm(targetCwd, { recursive: true, force: true });
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("leaves transition UI intact when a cold switch declines", async () => {
		const { ctx, switchSession, prepareSessionSwitch, resetObserverRegistry } = createResumeContext();
		switchSession.mockResolvedValue(false);
		const controller = new SelectorController(ctx);

		const result = await controller.handleResumeSession("/tmp/declined-session.jsonl");

		expect(result).toBe(false);
		expect(prepareSessionSwitch).not.toHaveBeenCalled();
		expect(resetObserverRegistry).not.toHaveBeenCalled();
		expect(ctx.clearTransientSessionUi).not.toHaveBeenCalled();
		expect(ctx.renderInitialMessages).not.toHaveBeenCalled();
		expect(ctx.showStatus).not.toHaveBeenCalled();
		expect(ctx.ui.requestRender).not.toHaveBeenCalled();
	});

	it("prepares and resets only after a successful cold switch completes", async () => {
		const { ctx, attachLiveTopLevelRuntime, switchSession, prepareSessionSwitch, resetObserverRegistry } =
			createResumeContext();
		const attachGate = Promise.withResolvers<void>();
		const switchStarted = Promise.withResolvers<void>();
		const switchGate = Promise.withResolvers<boolean>();
		const order: string[] = [];
		attachLiveTopLevelRuntime.mockImplementation(async () => {
			await attachGate.promise;
			return undefined;
		});
		switchSession.mockImplementation(async () => {
			order.push("switch:start");
			switchStarted.resolve();
			const switched = await switchGate.promise;
			order.push("switch:complete");
			return switched;
		});
		prepareSessionSwitch.mockImplementation(() => order.push("prepare"));
		resetObserverRegistry.mockImplementation(() => order.push("reset"));
		const controller = new SelectorController(ctx);

		const resume = controller.handleResumeSession("/tmp/gated-session.jsonl");
		attachGate.resolve();
		await switchStarted.promise;
		expect(prepareSessionSwitch).not.toHaveBeenCalled();
		expect(resetObserverRegistry).not.toHaveBeenCalled();

		switchGate.resolve(true);
		expect(await resume).toBe(true);
		expect(order).toEqual(["switch:start", "switch:complete", "prepare", "reset"]);
	});

	it("skips flush when settingsFlushed option is true", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-preflight-skip-"));
		try {
			const { ctx, switchSession, state } = createResumeContext({ sourceCwd: tmpDir });
			const targetCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-target-skip-"));
			switchSession.mockImplementation(async () => {
				state.cwd = targetCwd;
				return true;
			});
			const controller = new SelectorController(ctx);

			const result = await controller.handleResumeSession("/tmp/some-session.jsonl", { settingsFlushed: true });

			expect(result).toBe(true);
			expect(ctx.settings.flush).not.toHaveBeenCalled();
			expect(switchSession).toHaveBeenCalled();
			await fs.rm(targetCwd, { recursive: true, force: true });
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("keeps the selector open and unlocked for retry when the settings flush fails", async () => {
		const session: SessionInfo = {
			path: "/tmp/canceled-picker-resume.jsonl",
			id: "canceled-picker-resume",
			cwd: "/tmp",
			title: "Canceled picker resume",
			created: new Date("2026-01-01T00:00:00Z"),
			modified: new Date("2026-01-02T00:00:00Z"),
			messageCount: 1,
			size: 1,
			firstMessage: "first",
			allMessagesText: "first",
		};
		vi.spyOn(SessionManager, "list").mockResolvedValue([session]);
		const OriginalSelector = SessionSelector.SessionSelectorComponent;
		const selectionPromises: Promise<void>[] = [];
		vi.spyOn(SessionSelector, "SessionSelectorComponent").mockImplementation(
			((
				sessions: SessionInfo[],
				onSelect: (session: SessionInfo) => void,
				onCancel: () => void,
				onExit: () => void,
				options: SessionSelector.SessionSelectorOptions,
			) =>
				new OriginalSelector(
					sessions,
					selected => {
						selectionPromises.push(onSelect(selected) as unknown as Promise<void>);
					},
					onCancel,
					onExit,
					options,
				)) as never,
		);
		const { ctx, switchSession, editor, hide, setFocus, flush, getSelector } = createResumeContext();
		flush.mockRejectedValueOnce(new Error("disk full"));
		const controller = new SelectorController(ctx);
		await controller.showSessionSelector();
		const selector = getSelector();
		expect(selector).toBeDefined();

		selector!.handleInput("\n");
		expect(selectionPromises).toHaveLength(1);
		await selectionPromises[0];

		expect(hide).not.toHaveBeenCalled();
		expect(setFocus).not.toHaveBeenCalledWith(editor);
		expect(switchSession).not.toHaveBeenCalled();

		selector!.handleInput("\n");
		expect(selectionPromises).toHaveLength(2);
		await selectionPromises[1];
		expect(switchSession).toHaveBeenCalledTimes(1);
		expect(hide).toHaveBeenCalledTimes(1);
	});

	it("closes the selector and restores editor focus when switching rejects after preflight", async () => {
		const session: SessionInfo = {
			path: "/tmp/rejected-resume.jsonl",
			id: "rejected-resume",
			cwd: "/tmp",
			title: "Rejected resume",
			created: new Date("2026-01-01T00:00:00Z"),
			modified: new Date("2026-01-02T00:00:00Z"),
			messageCount: 1,
			size: 1,
			firstMessage: "first",
			allMessagesText: "first",
		};
		vi.spyOn(SessionManager, "list").mockResolvedValue([session]);
		const OriginalSelector = SessionSelector.SessionSelectorComponent;
		let selectionPromise: Promise<void> | undefined;
		vi.spyOn(SessionSelector, "SessionSelectorComponent").mockImplementation(
			((
				sessions: SessionInfo[],
				onSelect: (session: SessionInfo) => void,
				onCancel: () => void,
				onExit: () => void,
				options: SessionSelector.SessionSelectorOptions,
			) =>
				new OriginalSelector(
					sessions,
					selected => {
						selectionPromise = onSelect(selected) as unknown as Promise<void>;
					},
					onCancel,
					onExit,
					options,
				)) as never,
		);
		const { ctx, switchSession, editor, hide, setFocus, getSelector } = createResumeContext();
		const switchError = new Error("switch failed");
		switchSession.mockRejectedValue(switchError);
		const controller = new SelectorController(ctx);
		await controller.showSessionSelector();
		const selector = getSelector();
		expect(selector).toBeDefined();

		selector!.handleInput("\n");
		expect(selectionPromise).toBeDefined();
		await selectionPromise;

		expect(ctx.showError).toHaveBeenCalledWith("switch failed");
		expect(ctx.settings.flush).toHaveBeenCalledTimes(1);
		expect(switchSession).toHaveBeenCalledWith(session.path);
		expect(hide).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenLastCalledWith(editor);
	});
});
