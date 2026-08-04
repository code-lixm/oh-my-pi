/**
 * Agent Hub activation contract: Enter opens the selected non-Main subagent
 * transcript; `f` is the explicit live-focus action. Failures keep the hub
 * open and surface a notice.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getSettingsUiLocale, setSettingsUiLocale } from "../src/i18n/settings-locale";

const AGENT_ID = "Worker";
const TEST_CWD = path.resolve("agent-hub-cwd");
const initialLocale = getSettingsUiLocale();

function registerMain(
	agents: AgentRegistry,
	{
		id = "Main",
		displayName = id,
		sessionTitle,
		sessionFile = null,
	}: {
		id?: string;
		displayName?: string;
		sessionTitle?: string;
		sessionFile?: string | null;
	} = {},
) {
	return agents.register({
		id,
		displayName,
		kind: "main",
		sessionTitle,
		session: { subscribe: () => () => {} } as unknown as AgentSession,
		sessionFile,
		status: "idle",
	});
}

function registerWorker(agents: AgentRegistry, parentId = "Main") {
	if (parentId === "Main" && !agents.get("Main")) registerMain(agents);
	return agents.register({
		id: AGENT_ID,
		displayName: AGENT_ID,
		kind: "sub",
		parentId,
		session: { subscribe: () => () => {} } as unknown as AgentSession,
		sessionFile: null,
		status: "running",
	});
}

function makeHub(focusAgent: (id: string) => Promise<void>) {
	const agents = new AgentRegistry();
	registerWorker(agents);
	let doneCalls = 0;
	const done = Promise.withResolvers<void>();
	const renderRequested = Promise.withResolvers<void>();
	const transcriptOverlays: unknown[] = [];
	const hub = new AgentHubOverlayComponent({
		observers: new SessionObserverRegistry(),
		hubKeys: [],
		onDone: () => {
			doneCalls++;
			done.resolve();
		},
		requestRender: () => renderRequested.resolve(),
		registry: agents,
		irc: new IrcBus(agents),
		focusAgent,
		ui: {
			showOverlay: (component: unknown) => {
				transcriptOverlays.push(component);
				return { hide() {}, setHidden() {}, isHidden: () => false };
			},
			setFocus() {},
		} as never,
	});
	return {
		agents,
		hub,
		doneCalls: () => doneCalls,
		done: done.promise,
		renderRequested: renderRequested.promise,
		transcriptOverlays,
	};
}

describe("Agent hub Enter activation", () => {
	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		setSettingsUiLocale("en");
	});

	afterEach(() => {
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
		setSettingsUiLocale(initialLocale);
	});

	it("Enter opens the selected subagent transcript without focusing or closing the hub", () => {
		const focusAgent = vi.fn(async () => {});
		const { hub, doneCalls, transcriptOverlays } = makeHub(focusAgent);

		hub.handleInput("\r");

		expect(transcriptOverlays).toHaveLength(1);
		expect(focusAgent).not.toHaveBeenCalled();
		expect(doneCalls()).toBe(0);
		hub.dispose();
	});

	it("f focuses the selected live subagent and closes the hub", async () => {
		const focusedIds: string[] = [];
		const { hub, doneCalls, done } = makeHub(async id => {
			focusedIds.push(id);
		});

		hub.handleInput("f");
		await done;

		expect(focusedIds).toEqual([AGENT_ID]);
		expect(doneCalls()).toBe(1);
		hub.dispose();
	});

	it("a focus failure keeps the hub open and shows the error as a notice", async () => {
		const message = 'Agent "X" is aborted and cannot be revived';
		const { hub, doneCalls, renderRequested } = makeHub(() => Promise.reject(new Error(message)));

		hub.handleInput("f");
		await renderRequested;

		expect(doneCalls()).toBe(0);
		const rendered = Bun.stripANSI(hub.render(120).join("\n"));
		expect(rendered).toContain(message);
		hub.dispose();
	});

	it("hides Main runtimes and Enter opens the remaining subagent transcript", () => {
		const agents = new AgentRegistry();
		registerMain(agents, { displayName: "Primary" });
		registerMain(agents, { id: "top-level:review", displayName: "Review session", sessionTitle: "Review session" });
		registerWorker(agents, "top-level:review");
		const switched: string[] = [];
		const transcriptOverlays: unknown[] = [];
		const hub = new AgentHubOverlayComponent({
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			activeTopLevelId: "Main",
			switchTopLevel: async id => {
				switched.push(id);
			},
			ui: {
				showOverlay: (component: unknown) => {
					transcriptOverlays.push(component);
					return { hide() {}, setHidden() {}, isHidden: () => false };
				},
				setFocus() {},
			} as never,
		});

		try {
			const rendered = Bun.stripANSI(hub.render(120).join("\n"));
			expect(rendered).toContain(AGENT_ID);
			expect(rendered).not.toContain("Primary");
			expect(rendered).not.toContain("Review session");
			expect(rendered).not.toContain("Main:");

			hub.handleInput("\r");
			expect(transcriptOverlays).toHaveLength(1);
			expect(switched).toEqual([]);
		} finally {
			hub.dispose();
		}
	});

	it("p switches from a child to its owning Main runtime", async () => {
		const agents = new AgentRegistry();
		registerMain(agents, { displayName: "Primary" });
		registerMain(agents, { id: "top-level:review", displayName: "Review session", sessionTitle: "Review session" });
		registerWorker(agents, "top-level:review");
		const switched: string[] = [];
		const done = Promise.withResolvers<void>();
		const hub = new AgentHubOverlayComponent({
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => done.resolve(),
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			activeTopLevelId: "Main",
			switchTopLevel: async id => {
				switched.push(id);
			},
			focusAgent: async () => {},
		});

		hub.handleInput("j");
		hub.handleInput("p");
		await done.promise;

		expect(switched).toEqual(["top-level:review"]);
		hub.dispose();
	});

	it("lists persisted subagent session files after restart", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-persisted-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(workerSessionFile, "");
		const agents = new AgentRegistry();
		registerMain(agents, { sessionFile });
		const hub = new AgentHubOverlayComponent({
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
			sessionFile,
		});
		await hub.persistedSubagentsReady;

		const rendered = Bun.stripANSI(hub.render(120).join("\n"));
		expect(rendered).toContain("Worker");
		expect(rendered).toContain("parked");
		expect(agents.get("Worker")?.sessionFile).toBe(workerSessionFile);
		hub.dispose();
	});

	it("restores a persisted child from the uniquely matched background session without rendering its Main", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-secondary-persisted-");
		const primarySessionFile = path.join(tempDir.path(), "main.jsonl");
		const secondarySessionFile = path.join(tempDir.path(), "review.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "review", "Worker.jsonl");
		await Bun.write(primarySessionFile, "");
		await Bun.write(secondarySessionFile, "");
		await fs.mkdir(path.dirname(workerSessionFile), { recursive: true });
		await Bun.write(workerSessionFile, "");
		const agents = new AgentRegistry();
		registerMain(agents, { displayName: "Primary session", sessionFile: primarySessionFile });
		registerMain(agents, {
			id: "top-level:review",
			displayName: "4b1d4df0-0ae0-4ff8-8f25-d35a5ba13e2f",
			sessionTitle: "Review session",
			sessionFile: secondarySessionFile,
		});
		const hub = new AgentHubOverlayComponent({
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
			activeTopLevelId: "Main",
			sessionFile: secondarySessionFile,
		});
		await hub.persistedSubagentsReady;

		expect(agents.get("Worker")).toMatchObject({
			parentId: "top-level:review",
			sessionFile: workerSessionFile,
			status: "parked",
		});
		const rendered = Bun.stripANSI(hub.render(120).join("\n"));
		expect(rendered).toContain("Worker");
		expect(rendered).not.toContain("Review session");
		expect(rendered).not.toContain("Main:");
		expect(rendered).not.toContain("4b1d4df0-0ae0-4ff8-8f25-d35a5ba13e2f");
		hub.dispose();
	});

	it("does not restore a child under Main when a populated registry has no matching active session", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-unmatched-persisted-");
		const sessionFile = path.join(tempDir.path(), "detached.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "detached", "Worker.jsonl");
		await Bun.write(sessionFile, "");
		await fs.mkdir(path.dirname(workerSessionFile), { recursive: true });
		await Bun.write(workerSessionFile, "");
		const agents = new AgentRegistry();
		registerMain(agents, {
			id: "top-level:other",
			displayName: "Other session",
			sessionFile: path.join(tempDir.path(), "other.jsonl"),
		});
		const hub = new AgentHubOverlayComponent({
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
			sessionFile,
		});
		await hub.persistedSubagentsReady;

		expect(agents.get("Worker")).toBeUndefined();
		hub.dispose();
	});
	it("does not generically revive active or tombstoned Vibe children copied by a post-exit fork", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-vibe-fork-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendModeChange("vibe");
		const parentSessionId = manager.getSessionId();
		for (const id of ["ActiveVibe", "KilledVibe"]) {
			manager.appendCustomEntry("vibe-session-lifecycle", {
				version: 1,
				action: "spawn",
				id,
				ownerId: "Main",
				parentSessionId,
				cli: "fast",
				agent: "sonic",
				childSessionFile: `${id}.jsonl`,
				createdAt: Date.now(),
			});
		}
		manager.appendCustomEntry("vibe-session-lifecycle", {
			version: 1,
			action: "tombstone",
			id: "KilledVibe",
			ownerId: "Main",
			parentSessionId,
			reason: "mode-exit",
		});
		manager.appendModeChange("none");
		await manager.ensureOnDisk();
		await manager.flush();
		const sourceSessionFile = manager.getSessionFile();
		if (!sourceSessionFile) throw new Error("Expected source session file");
		const sourceArtifacts = sourceSessionFile.slice(0, -6);
		await fs.mkdir(sourceArtifacts, { recursive: true });
		for (const id of ["ActiveVibe", "KilledVibe", "OrdinaryTask"]) {
			await fs.writeFile(path.join(sourceArtifacts, `${id}.jsonl`), "persisted child");
		}
		const fork = await manager.fork();
		if (!fork) throw new Error("Expected persisted fork");
		await fs.cp(sourceArtifacts, fork.newSessionFile.slice(0, -6), { recursive: true });
		await manager.close();

		const agents = new AgentRegistry();
		registerMain(agents, { sessionFile: fork.newSessionFile });
		const hub = new AgentHubOverlayComponent({
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
			sessionFile: fork.newSessionFile,
		});
		await hub.persistedSubagentsReady;

		expect(agents.get("ActiveVibe")).toBeUndefined();
		expect(agents.get("KilledVibe")).toBeUndefined();
		expect(agents.get("OrdinaryTask")?.status).toBe("parked");
		hub.dispose();
	});

	it("selector controller opens Agent Hub fullscreen and Enter inspects a subagent without focusing it", () => {
		AgentRegistry.resetGlobalForTests();
		const agents = AgentRegistry.global();
		registerWorker(agents);

		const approvalPrompt = { id: "approval-prompt" };
		let capturedHub: AgentHubOverlayComponent | undefined;
		const overlayHide = vi.fn();
		const overlays: unknown[] = [];
		const focusTargets: unknown[] = [];
		const requestRender = vi.fn();
		const focusAgentSession = vi.fn(async () => {});
		const showOverlay = vi.fn((component: unknown) => {
			overlays.push(component);
			capturedHub ??= component as AgentHubOverlayComponent;
			return { hide: overlayHide, setHidden: vi.fn(), isHidden: () => false };
		});
		const editorContainer = {
			children: [approvalPrompt],
			clear: vi.fn(),
			addChild: vi.fn(),
		};
		const ctx = {
			keybindings: { getKeys: () => [] },
			ui: {
				showOverlay,
				setFocus: (target: unknown) => {
					focusTargets.push(target);
				},
				requestRender,
			},
			editor: { id: "editor" },
			editorContainer,
			collabGuest: undefined,
			focusAgentSession,
			session: { getToolByName: () => undefined, extensionRunner: undefined },
			sessionManager: { getCwd: () => TEST_CWD, getSessionFile: () => null },
			hideThinkingBlock: false,
		};
		const controller = new SelectorController(ctx as unknown as InteractiveModeContext);

		controller.showAgentHub(new SessionObserverRegistry());

		if (!capturedHub) throw new Error("Expected Agent Hub overlay");
		expect(showOverlay).toHaveBeenCalledWith(
			capturedHub,
			expect.objectContaining({
				anchor: "top-left",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			}),
		);
		expect(editorContainer.clear).not.toHaveBeenCalled();
		expect(editorContainer.addChild).not.toHaveBeenCalled();
		expect(focusTargets[0]).toBe(capturedHub);
		const tableLines = Bun.stripANSI(capturedHub.render(120).join("\n")).split("\n");
		const columnHeader = tableLines.find(line =>
			["Agent", "Status", "Duration", "Model", "Last update"].every(column => line.includes(column)),
		);
		expect(columnHeader).toBeDefined();
		expect(tableLines.filter(line => line.includes(AGENT_ID))).toHaveLength(1);

		capturedHub.handleInput("\r");

		expect(overlays).toHaveLength(2);
		expect(focusAgentSession).not.toHaveBeenCalled();
		expect(overlayHide).not.toHaveBeenCalled();
		expect(focusTargets.at(-1)).not.toBe(approvalPrompt);
		expect(requestRender).toHaveBeenCalled();
	});

	it("propagates an explicit mouse-tracking choice through the Hub and its transcript overlay", () => {
		for (const mouseTracking of [false, true]) {
			AgentRegistry.resetGlobalForTests();
			const agents = AgentRegistry.global();
			registerWorker(agents);
			const overlays: Array<{ component: unknown; options: { mouseTracking?: boolean } }> = [];
			const ctx = {
				keybindings: { getKeys: () => [] },
				settings: { get: (key: string) => (key === "tui.mouseInput" ? mouseTracking : undefined) },
				ui: {
					showOverlay: (component: unknown, options: { mouseTracking?: boolean }) => {
						overlays.push({ component, options });
						return { hide() {}, setHidden() {}, isHidden: () => false };
					},
					setFocus() {},
					requestRender() {},
				},
				editor: { id: "editor" },
				editorContainer: { children: [], clear() {}, addChild() {} },
				collabGuest: undefined,
				focusAgentSession: async () => {},
				session: { getToolByName: () => undefined, extensionRunner: undefined },
				sessionManager: { getCwd: () => TEST_CWD, getSessionFile: () => null },
				hideThinkingBlock: false,
			};
			const controller = new SelectorController(ctx as unknown as InteractiveModeContext);

			controller.showAgentHub(new SessionObserverRegistry());
			const hub = overlays[0]?.component as AgentHubOverlayComponent | undefined;
			expect(hub).toBeDefined();
			expect(overlays[0]?.options.mouseTracking).toBe(mouseTracking);

			hub?.handleInput("\r");
			expect(overlays).toHaveLength(2);
			expect(overlays[1]?.options.mouseTracking).toBe(mouseTracking);
			hub?.dispose();
		}
	});

	it("selector controller hides the fullscreen hub and restores the visible owner on Escape", () => {
		const agents = new AgentRegistry();
		registerWorker(agents);
		const approvalPrompt = { id: "approval-prompt" };
		let capturedHub: AgentHubOverlayComponent | undefined;
		const overlayHide = vi.fn();
		const focusTargets: unknown[] = [];
		const requestRender = vi.fn();
		const editorContainer = {
			children: [approvalPrompt],
			clear: vi.fn(),
			addChild: vi.fn(),
		};
		const ctx = {
			keybindings: { getKeys: () => [] },
			ui: {
				showOverlay: vi.fn((component: unknown) => {
					capturedHub = component as AgentHubOverlayComponent;
					return { hide: overlayHide, setHidden: vi.fn(), isHidden: () => false };
				}),
				setFocus: (target: unknown) => {
					focusTargets.push(target);
				},
				requestRender,
			},
			editor: { id: "editor" },
			editorContainer,
			collabGuest: { agentRegistry: agents, hubRemote: undefined },
			focusAgentSession: async () => {},
			session: { getToolByName: () => undefined, extensionRunner: undefined },
			sessionManager: { getCwd: () => TEST_CWD, getSessionFile: () => null },
			hideThinkingBlock: false,
		};
		const controller = new SelectorController(ctx as unknown as InteractiveModeContext);

		controller.showAgentHub(new SessionObserverRegistry());
		if (!capturedHub) throw new Error("Expected Agent Hub overlay");
		const rendersBeforeClose = requestRender.mock.calls.length;

		capturedHub.handleInput("\x1b");

		expect(overlayHide).toHaveBeenCalledTimes(1);
		expect(focusTargets.at(-1)).toBe(approvalPrompt);
		expect(requestRender.mock.calls.length).toBeGreaterThan(rendersBeforeClose);
		expect(editorContainer.clear).not.toHaveBeenCalled();
		expect(editorContainer.addChild).not.toHaveBeenCalled();
	});
});

describe("Agent hub overlay mounting and close tap", () => {
	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	function setup(agents: AgentRegistry, sessionFile: string | null = null) {
		let shown: AgentHubOverlayComponent | undefined;
		const editor = {};
		const focusTargets: unknown[] = [];
		const overlayHide = vi.fn();
		const showOverlay = vi.fn((component: unknown) => {
			shown = component as AgentHubOverlayComponent;
			return { hide: overlayHide, setHidden: vi.fn(), isHidden: () => false };
		});
		const ctx = {
			keybindings: { getKeys: () => [] },
			ui: {
				showOverlay,
				setFocus: (target: unknown) => {
					focusTargets.push(target);
				},
				requestRender: () => {},
			},
			editor,
			editorContainer: {
				children: [editor],
				clear: vi.fn(),
				addChild: vi.fn(),
			},
			collabGuest: { agentRegistry: agents, hubRemote: undefined },
			focusAgentSession: async () => {},
			session: { getToolByName: () => undefined, extensionRunner: undefined },
			sessionManager: { getCwd: () => TEST_CWD, getSessionFile: () => sessionFile },
			hideThinkingBlock: false,
		};
		const controller = new SelectorController(ctx as unknown as InteractiveModeContext);
		return {
			controller,
			editor,
			shown: () => shown,
			focusTargets,
			showOverlay,
			overlayHide,
		};
	}

	it("mounts a Main-only Agent Hub fullscreen, renders its empty state, and restores focus on Escape", () => {
		const agents = new AgentRegistry();
		registerMain(agents);
		const { controller, editor, shown, focusTargets, showOverlay, overlayHide } = setup(agents);

		controller.showAgentHub(new SessionObserverRegistry());

		const hub = shown();
		if (!hub) throw new Error("Expected Agent Hub overlay");
		expect(showOverlay).toHaveBeenCalledWith(
			hub,
			expect.objectContaining({
				anchor: "top-left",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			}),
		);
		expect(focusTargets).toEqual([hub]);
		expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("No tasks yet");

		hub.handleInput("\x1b");
		expect(overlayHide).toHaveBeenCalledTimes(1);
		expect(focusTargets.at(-1)).toBe(editor);
	});

	it("armCloseTap lets a single ← dismiss the hub the opening ←← raised", () => {
		const agents = new AgentRegistry();
		registerMain(agents);
		const { controller, editor, shown, focusTargets } = setup(agents);

		controller.showAgentHub(new SessionObserverRegistry(), { armCloseTap: true });

		const hub = shown();
		expect(hub).toBeDefined();
		expect(focusTargets.at(-1)).toBe(hub);

		// One ← — the editor's detector consumed the ←← that opened the hub — now
		// closes it, returning focus to the editor. Without armCloseTap this ← only
		// primes the hub's fresh detector and the user stays trapped.
		hub!.handleInput("\x1b[D");

		expect(focusTargets.at(-1)).toBe(editor);
	});
});

describe("Agent hub data refresh coalescing", () => {
	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		IrcBus.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("coalesces a synchronous registry burst into one render and refreshes rows", async () => {
		vi.useFakeTimers();
		const agents = new AgentRegistry();
		registerMain(agents);
		const observers = new SessionObserverRegistry();
		const requestRender = vi.fn();
		const hub = new AgentHubOverlayComponent({
			observers,
			hubKeys: [],
			onDone: () => {},
			requestRender,
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
		});

		try {
			await hub.persistedSubagentsReady;
			requestRender.mockClear();

			for (const id of ["BurstA", "BurstB", "BurstC"]) {
				agents.register({
					id,
					displayName: id,
					kind: "sub",
					parentId: "Main",
					session: { subscribe: () => () => {} } as unknown as AgentSession,
					sessionFile: null,
					status: "running",
				});
			}

			expect(requestRender).not.toHaveBeenCalled();
			expect(Bun.stripANSI(hub.render(120).join("\n"))).not.toContain("BurstA");

			vi.advanceTimersByTime(99);
			expect(requestRender).not.toHaveBeenCalled();

			vi.advanceTimersByTime(1);
			expect(requestRender).toHaveBeenCalledTimes(1);

			const rendered = Bun.stripANSI(hub.render(120).join("\n"));
			expect(rendered).toContain("BurstA");
			expect(rendered).toContain("BurstB");
			expect(rendered).toContain("BurstC");
		} finally {
			hub.dispose();
			vi.useRealTimers();
		}
	});
});
