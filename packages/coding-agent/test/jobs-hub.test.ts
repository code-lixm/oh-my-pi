import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { type AsyncJob, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { JobsHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/jobs-hub";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task/types";
import { getSettingsUiLocale, setSettingsUiLocale } from "../src/i18n/settings-locale";

let localeBeforeTest = getSettingsUiLocale();

type InputListener = (data: string) => { consume: boolean } | undefined;

function renderHub(hub: JobsHubOverlayComponent): string {
	return Bun.stripANSI(hub.render(120).join("\n"));
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function workerProgress(): AgentProgress {
	return {
		index: 0,
		id: "Worker",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "TASK_FALLBACK_WORK_MARKER",
		assignment: "TASK_ASSIGNMENT_MARKER",
		lastIntent: "TASK_WORK_MARKER",
		currentTool: "read",
		currentToolArgs: "jobs-hub-fixture.ts",
		recentTools: [],
		recentOutput: [],
		toolCount: 2,
		requests: 3,
		tokens: 144,
		cost: 0.0123,
		durationMs: 4_000,
		resolvedModel: "provider/TASK_MODEL_MARKER",
	};
}

function makeJobsGestureHarness(options?: { focusedAgentId?: string }): {
	editor: CustomEditor;
	opened: Array<{ requireContent?: boolean } | undefined>;
	inputListeners: InputListener[];
} {
	const editor = new CustomEditor(getEditorTheme());
	const opened: Array<{ requireContent?: boolean } | undefined> = [];
	const inputListeners: InputListener[] = [];
	const ctx = {
		editor,
		ui: {
			addInputListener(listener: InputListener) {
				inputListeners.push(listener);
			},
			addStartListener() {},
			getFocused: () => editor,
			requestRender() {},
			resetDisplay() {},
			terminal: { write() {}, refreshAppearance() {} },
		},
		session: {
			subscribe: () => () => {},
			extensionRunner: undefined,
		},
		focusedAgentId: options?.focusedAgentId,
		keybindings: {
			getKeys: () => [],
			matches: () => false,
		},
		showJobsHub(options?: { requireContent?: boolean }) {
			opened.push(options);
		},
	} as unknown as InteractiveModeContext;

	new InputController(ctx).setupKeyHandlers();
	return { editor, opened, inputListeners };
}

beforeEach(async () => {
	localeBeforeTest = getSettingsUiLocale();
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	setSettingsUiLocale("en");
	await initTheme(false);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	setSystemTime();
	resetSettingsForTest();
	setSettingsUiLocale(localeBeforeTest);
});

describe("AsyncJobManager Jobs Hub snapshots", () => {
	it("retains the latest live progress and freezes the terminal timestamp", async () => {
		vi.useFakeTimers();
		setSystemTime(1_000);
		const release = Promise.withResolvers<string>();
		const progressReported = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });

		try {
			const jobId = manager.register("bash", "tailing command", async ({ reportProgress }) => {
				await reportProgress("first line\nLIVE_PROGRESS_TAIL_MARKER");
				progressReported.resolve();
				return await release.promise;
			});
			await progressReported.promise;

			expect(manager.getJob(jobId)).toMatchObject({
				status: "running",
				latestProgressText: "first line\nLIVE_PROGRESS_TAIL_MARKER",
				lastProgressAt: 1_000,
			});

			setSystemTime(6_000);
			release.resolve("completed output");
			await manager.getJob(jobId)?.promise;
			expect(manager.getJob(jobId)).toMatchObject({ status: "completed", endedAt: 6_000 });

			setSystemTime(60_000);
			expect(manager.getJob(jobId)?.endedAt).toBe(6_000);
		} finally {
			await manager.dispose({ timeoutMs: 0 });
		}
	});
});

describe("Jobs Hub overlay", () => {
	it("renders task work and model beside the bash live tail, freezes terminal duration, and navigates details", async () => {
		vi.useFakeTimers();
		const stdoutRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => 16 });
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const bashRelease = Promise.withResolvers<string>();
		const bashProgressReported = Promise.withResolvers<void>();
		const taskRelease = Promise.withResolvers<string>();
		const taskProgressReported = Promise.withResolvers<void>();
		const liveTail = [
			"BASH_DETAIL_FIRST_MARKER",
			...Array.from({ length: 24 }, (_, index) => `BASH_SCROLL_LINE_${index}`),
			"BASH_LIVE_TAIL_MARKER",
		].join("\n");
		let hub: JobsHubOverlayComponent | undefined;

		try {
			setSystemTime(1_000);
			const bashId = manager.register("bash", "BASH_LABEL_MARKER", async ({ reportProgress }) => {
				await reportProgress(liveTail);
				bashProgressReported.resolve();
				return await bashRelease.promise;
			});
			await bashProgressReported.promise;
			expect(manager.getJob(bashId)?.latestProgressText).toBe(liveTail);

			setSystemTime(2_000);
			const taskId = manager.register(
				"task",
				"TASK_LABEL_MARKER",
				async ({ reportProgress }) => {
					await reportProgress("task is running", { progress: [workerProgress()] });
					taskProgressReported.resolve();
					return await taskRelease.promise;
				},
				{ agentId: "Worker", ownerId: "Main" },
			);
			await taskProgressReported.promise;
			setSystemTime(6_000);
			taskRelease.resolve("TASK_RESULT_MARKER");
			await manager.getJob(taskId)?.promise;

			hub = new JobsHubOverlayComponent({ manager, onDone() {}, requestRender() {} });
			setSystemTime(10_000);
			const firstList = renderHub(hub);
			expect(firstList).toContain("BASH_LIVE_TAIL_MARKER");
			expect(firstList).toContain("TASK_WORK_MARKER");
			expect(firstList).toContain("TASK_MODEL_MARKER");
			const taskLine = firstList.split("\n").find(line => line.includes("TASK_LABEL_MARKER"));
			if (!taskLine) throw new Error("Expected completed task row");
			expect(taskLine).toContain("00:00:04");

			setSystemTime(3_600_000);
			const laterTaskLine = renderHub(hub)
				.split("\n")
				.find(line => line.includes("TASK_LABEL_MARKER"));
			expect(laterTaskLine).toBe(taskLine);

			hub.handleInput("\r");
			expect(renderHub(hub)).toContain("Live output tail");
			expect(renderHub(hub)).toContain("BASH_DETAIL_FIRST_MARKER");
			hub.handleInput("j");
			expect(renderHub(hub)).not.toContain("BASH_DETAIL_FIRST_MARKER");
			hub.handleInput("k");
			expect(renderHub(hub)).toContain("BASH_DETAIL_FIRST_MARKER");

			hub.handleInput("\x1b");
			hub.handleInput("j");
			hub.handleInput("\r");
			const taskDetail = renderHub(hub);
			expect(taskDetail).toContain("TASK_ASSIGNMENT_MARKER");
			expect(taskDetail).toContain("TASK_MODEL_MARKER");
			expect(taskDetail).toContain("TASK_RESULT_MARKER");
		} finally {
			try {
				hub?.dispose();
				bashRelease.resolve("cleanup");
				await manager.waitForAll();
				await manager.dispose({ timeoutMs: 0 });
			} finally {
				if (stdoutRowsDescriptor) {
					Object.defineProperty(process.stdout, "rows", stdoutRowsDescriptor);
				} else {
					Reflect.deleteProperty(process.stdout, "rows");
				}
			}
		}
	});

	it("shows a task registration description before any progress snapshot exists", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		manager.register(
			"task",
			"TASK_DESCRIPTION_LABEL_MARKER",
			async ({ signal }) =>
				await new Promise<string>(resolve => {
					if (signal.aborted) return resolve("cancelled");
					signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
				}),
			{ description: "TASK_DESCRIPTION_WITHOUT_PROGRESS_MARKER" },
		);
		const hub = new JobsHubOverlayComponent({ manager, onDone() {}, requestRender() {} });

		try {
			const list = renderHub(hub);
			expect(list).toContain("TASK_DESCRIPTION_LABEL_MARKER");
			expect(list).toContain("TASK_DESCRIPTION_WITHOUT_PROGRESS_MARKER");

			hub.handleInput("\r");
			const detail = renderHub(hub);
			expect(detail).toContain("Job Details");
			expect(detail).toContain("Work");
			expect(detail).toContain("TASK_DESCRIPTION_WITHOUT_PROGRESS_MARKER");
		} finally {
			hub.dispose();
			manager.cancelAll();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 0 });
		}
	});
	it("returns from details before closing, focuses the linked agent, and cancels the selected running job", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const focusedAgentIds: string[] = [];
		const cancellationRequests: AsyncJob[] = [];
		let closeCount = 0;
		const hub = new JobsHubOverlayComponent({
			manager,
			onDone() {
				closeCount++;
			},
			requestRender() {},
			async focusAgent(id) {
				focusedAgentIds.push(id);
			},
			async cancelJob(job) {
				cancellationRequests.push(job);
				return manager.cancel(job.id);
			},
		});

		try {
			const jobId = manager.register(
				"task",
				"linked running work",
				async ({ signal }) =>
					await new Promise<string>(resolve => {
						if (signal.aborted) return resolve("cancelled");
						signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
					}),
				{ agentId: "LinkedAgent", ownerId: "Main" },
			);

			renderHub(hub);

			hub.handleInput("\r");
			expect(renderHub(hub)).toContain("Job Details");
			hub.handleInput("\x1b");
			expect(closeCount).toBe(0);
			expect(renderHub(hub)).toContain("Jobs Hub");

			hub.handleInput("f");
			await flushMicrotasks();
			expect(focusedAgentIds).toEqual(["LinkedAgent"]);

			hub.handleInput("x");
			await flushMicrotasks();
			expect(cancellationRequests.map(job => job.id)).toEqual([jobId]);
			expect(manager.getJob(jobId)?.status).toBe("cancelled");
			expect(renderHub(hub)).toContain("Cancellation requested.");

			hub.handleInput("\x1b");
			expect(closeCount).toBe(1);
		} finally {
			hub.dispose();
			manager.cancelAll();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 0 });
		}
	});
});

describe("SelectorController Jobs Hub mounting", () => {
	it("gates an empty gesture and mounts retained work as a fullscreen overlay", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		let shown: JobsHubOverlayComponent | undefined;
		const overlayOptions: unknown[] = [];
		const focusTargets: unknown[] = [];
		const visiblePrompt = { id: "visible-prompt" };
		const editor = { id: "editor" };
		const editorContainer = { children: [visiblePrompt], clear: vi.fn(), addChild: vi.fn() };
		const ctx = {
			editor,
			editorContainer,
			ui: {
				showOverlay(component: unknown, options: unknown) {
					shown = component as JobsHubOverlayComponent;
					overlayOptions.push(options);
					return { hide() {}, setHidden() {}, isHidden: () => false };
				},
				setFocus(target: unknown) {
					focusTargets.push(target);
				},
				requestRender() {},
			},
			session: { asyncJobManager: manager },
			showWarning() {},
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		try {
			controller.showJobsHub({ requireContent: true });
			expect(overlayOptions).toEqual([]);

			manager.register(
				"bash",
				"retained work",
				async ({ signal }) =>
					await new Promise<string>(resolve => {
						if (signal.aborted) return resolve("cancelled");
						signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
					}),
			);
			controller.showJobsHub({ requireContent: true });

			if (!shown) throw new Error("Expected Jobs Hub overlay");
			const hub = shown;
			expect(overlayOptions).toHaveLength(1);
			expect(overlayOptions[0]).toEqual(
				expect.objectContaining({
					anchor: "top-left",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
					fullscreen: true,
				}),
			);
			expect(focusTargets).toEqual([hub]);
			expect(editorContainer.clear).not.toHaveBeenCalled();
			expect(editorContainer.addChild).not.toHaveBeenCalled();
			hub.handleInput("\x1b");
			expect(focusTargets.at(-1)).toBe(visiblePrompt);
			expect(focusTargets.at(-1)).not.toBe(editor);
		} finally {
			shown?.dispose();
			manager.cancelAll();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 0 });
		}
	});
});

describe("InputController Jobs Hub gesture", () => {
	it("opens only for a human-paced empty-editor double right tap", () => {
		vi.useFakeTimers();
		const cases = [
			{ name: "deliberate double tap", timestamps: [1_000, 1_200], expectedOpen: true },
			{ name: "terminal arrow burst", timestamps: [2_000, 2_000, 2_000, 2_000], expectedOpen: false },
			{ name: "too-fast second tap", timestamps: [3_000, 3_010], expectedOpen: false },
		] as const;

		for (const testCase of cases) {
			const { editor, opened } = makeJobsGestureHarness();
			for (const timestamp of testCase.timestamps) {
				setSystemTime(timestamp);
				editor.handleInput("\x1b[C");
			}
			expect(opened, testCase.name).toEqual(testCase.expectedOpen ? [{ requireContent: true }] : []);
		}
	});

	it("captures a deliberate double right tap from a focused subagent view", () => {
		vi.useFakeTimers();
		const { inputListeners, opened } = makeJobsGestureHarness({ focusedAgentId: "Worker" });

		for (const timestamp of [5_000, 5_200]) {
			setSystemTime(timestamp);
			let consumed = false;
			for (const listener of inputListeners) {
				if (listener("\x1b[C")?.consume) {
					consumed = true;
					break;
				}
			}
			expect(consumed).toBe(true);
		}

		expect(opened).toEqual([{ requireContent: true }]);
	});
});
