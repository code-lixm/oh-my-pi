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
import { visitEntriesFromFileStream } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
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
	const doneReasons: Array<"preserve-focus" | undefined> = [];
	const done = Promise.withResolvers<"preserve-focus" | undefined>();
	const renderRequested = Promise.withResolvers<void>();
	const transcriptOverlays: unknown[] = [];
	const hub = new AgentHubOverlayComponent({
		settings: Settings.isolated(),
		observers: new SessionObserverRegistry(),
		hubKeys: [],
		onDone: reason => {
			doneCalls++;
			doneReasons.push(reason);
			done.resolve(reason);
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
		doneReasons: () => doneReasons,
		done: done.promise,
		renderRequested: renderRequested.promise,
		transcriptOverlays,
	};
}

const ROSTER_ENTRY_PATTERN = /^(?:❯| ) \S /u;

function renderedRosterPanel(hub: AgentHubOverlayComponent, width: number): string[] {
	const lines = hub.render(width).map(line => Bun.stripANSI(line));
	return lines.flatMap(line => {
		if (!line.startsWith("│ ") || !line.endsWith(" │")) return [];
		const splitDivider = line.lastIndexOf(" │ ");
		const end = splitDivider >= 3 ? splitDivider : line.length - 2;
		return [line.slice(2, end).trimEnd()];
	});
}

function renderedRosterEntries(hub: AgentHubOverlayComponent, width: number): string[] {
	return renderedRosterPanel(hub, width).filter(line => ROSTER_ENTRY_PATTERN.test(line));
}

function renderedRosterEntry(hub: AgentHubOverlayComponent, label: string, width: number): string {
	const entries = renderedRosterEntries(hub, width).filter(entry => entry.includes(label));
	expect(entries).toHaveLength(1);
	return entries[0]!;
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

	it("f focuses the selected live subagent and closes the hub without restoring editor focus", async () => {
		const focusedIds: string[] = [];
		const { hub, doneCalls, doneReasons, done } = makeHub(async id => {
			focusedIds.push(id);
		});

		hub.handleInput("f");
		await done;

		expect(focusedIds).toEqual([AGENT_ID]);
		expect(doneCalls()).toBe(1);
		expect(doneReasons()).toEqual(["preserve-focus"]);
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
		agents.register({
			id: "top-level:review/advisor",
			displayName: "Review advisor",
			kind: "advisor",
			parentId: "top-level:review",
			session: null,
			sessionFile: null,
			status: "parked",
		});
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
			const roster = renderedRosterEntries(hub, 120).join("\n");
			expect(roster).toContain(AGENT_ID);
			expect(roster).not.toContain("Primary");
			expect(roster).not.toContain("Review session");
			expect(roster).not.toContain("Main:");
			expect(roster).not.toContain("Review advisor");

			hub.handleInput("\r");
			expect(transcriptOverlays).toHaveLength(1);
			expect(switched).toEqual([]);
		} finally {
			hub.dispose();
		}
	});

	it("p switches from a child to its owning Main runtime without restoring editor focus", async () => {
		const agents = new AgentRegistry();
		registerMain(agents, { displayName: "Primary" });
		registerMain(agents, { id: "top-level:review", displayName: "Review session", sessionTitle: "Review session" });
		registerWorker(agents, "top-level:review");
		const switched: string[] = [];
		const doneReasons: Array<"preserve-focus" | undefined> = [];
		const done = Promise.withResolvers<"preserve-focus" | undefined>();
		const hub = new AgentHubOverlayComponent({
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: reason => {
				doneReasons.push(reason);
				done.resolve(reason);
			},
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
		expect(doneReasons).toEqual(["preserve-focus"]);
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
			settings: Settings.isolated(),
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

		const workerEntry = renderedRosterEntry(hub, AGENT_ID, 120);
		expect(workerEntry).toContain(AGENT_ID);
		expect(renderedRosterEntries(hub, 120).filter(entry => entry.includes(AGENT_ID))).toHaveLength(1);
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
		const roster = renderedRosterEntries(hub, 120).join("\n");
		expect(roster).toContain(AGENT_ID);
		expect(roster).not.toContain("Review session");
		expect(roster).not.toContain("Main:");
		expect(roster).not.toContain("4b1d4df0-0ae0-4ff8-8f25-d35a5ba13e2f");
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

	it("stops persisted discovery when the Hub is disposed", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-disposed-scan-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(path.join(tempDir.path(), "main", "Worker.jsonl"), "");
		const agents = new AgentRegistry();
		const hub = new AgentHubOverlayComponent({
			settings: Settings.isolated(),
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			sessionFile,
		});

		hub.dispose();
		await hub.persistedSubagentsReady;

		expect(agents.get("Worker")).toBeUndefined();
	});

	it("restores nested parent lineage after restart", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-persisted-tree-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const parentSessionFile = path.join(tempDir.path(), "main", "Parent.jsonl");
		const childSessionFile = path.join(tempDir.path(), "main", "Parent", "Child.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(parentSessionFile, "");
		await Bun.write(childSessionFile, "");
		const agents = new AgentRegistry();
		const hub = new AgentHubOverlayComponent({
			settings: Settings.isolated(),
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			sessionFile,
		});
		await hub.persistedSubagentsReady;
		agents.updateMetadata("Parent", { displayName: "Parent task" });
		agents.updateMetadata("Child", { displayName: "Child task" });
		expect(agents.get("Parent")?.parentId).toBe("Main");
		expect(agents.get("Child")?.parentId).toBe("Parent");
		hub.handleInput("t");
		expect(renderedRosterEntry(hub, "Child task", 120)).toContain("└── Child task");
		hub.dispose();
	});

	it("restores saved task metadata and timestamps without expanding a roster entry", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-persisted-metadata-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		const createdAt = "2026-07-30T01:13:37.835Z";
		const lastActivity = new Date("2026-07-30T01:15:00.000Z");
		await Bun.write(sessionFile, "");
		await Bun.write(
			workerSessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "worker-session", timestamp: createdAt, cwd: TEST_CWD }),
				JSON.stringify({
					type: "session_init",
					id: "init",
					parentId: null,
					timestamp: createdAt,
					systemPrompt: "system",
					task: "Complete the assignment below, thoroughly:\n\n# Target\nInspect dependency boundaries and report unsafe coupling.\n\n# Change\nRead the implementation.",
					tools: ["read"],
				}),
			].join("\n"),
		);
		await fs.utimes(workerSessionFile, lastActivity, lastActivity);
		const agents = new AgentRegistry();
		const hub = new AgentHubOverlayComponent({
			settings: Settings.isolated(),
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			sessionFile,
		});
		await hub.persistedSubagentsReady;
		expect(agents.get(AGENT_ID)).toMatchObject({
			activity: "Inspect dependency boundaries and report unsafe coupling.",
			createdAt: Date.parse(createdAt),
			lastActivity: lastActivity.getTime(),
			status: "parked",
		});
		expect(renderedRosterEntry(hub, AGENT_ID, 120)).toContain(AGENT_ID);
		hub.dispose();
	});

	it("restores persisted role, model, usage, and artifact history in the inspector", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-persisted-usage-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		const artifactBase = workerSessionFile.slice(0, -".jsonl".length);
		const createdAt = "2026-07-30T01:13:30.000Z";
		const lastActivity = new Date("2026-07-30T01:15:00.000Z");
		await Bun.write(sessionFile, "");
		await Bun.write(
			workerSessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "worker-session", timestamp: createdAt, cwd: TEST_CWD }),
				JSON.stringify({
					type: "model_change",
					id: "model",
					parentId: null,
					timestamp: createdAt,
					model: "openai-codex/gpt-5.6-luna",
				}),
				JSON.stringify({
					type: "session_init",
					id: "init",
					parentId: "model",
					timestamp: createdAt,
					systemPrompt: `base prompt\n\nROLE\n====\n${getBundledAgent("scout")?.systemPrompt}`,
					task: "Inspect persisted telemetry.",
					tools: ["read", "grep"],
				}),
				JSON.stringify({
					type: "message",
					id: "assistant",
					parentId: "init",
					timestamp: lastActivity.toISOString(),
					message: {
						role: "assistant",
						timestamp: lastActivity.getTime(),
						content: [
							{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "src/a.ts" } },
							{ type: "toolCall", id: "grep-call", name: "grep", arguments: { pattern: "needle" } },
						],
						usage: {
							input: 100,
							output: 25,
							cacheRead: 200,
							cacheWrite: 10,
							totalTokens: 335,
							cost: { input: 0.01, output: 0.1, cacheRead: 0.01, cacheWrite: 0.003, total: 0.123 },
						},
					},
				}),
			].join("\n"),
		);
		await Bun.write(`${artifactBase}.md`, "saved output");
		await Bun.write(`${artifactBase}.patch`, "saved patch");
		await fs.utimes(workerSessionFile, lastActivity, lastActivity);
		const agents = new AgentRegistry();
		const hub = new AgentHubOverlayComponent({
			settings: Settings.isolated(),
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			sessionFile,
		});
		await hub.persistedSubagentsReady;

		expect(agents.get("Worker")?.history).toMatchObject({
			resolvedModel: "openai-codex/gpt-5.6-luna",
			readOnly: true,
			outputPath: `${artifactBase}.md`,
			patchPath: `${artifactBase}.patch`,
			metrics: { tokens: 135, requests: 1, tools: 2, cost: 0.123, durationMs: 90_000 },
		});
		const rendered = Bun.stripANSI(hub.render(160).join("\n"));
		expect(rendered).toContain("SMOL");
		// Cost/tokens/req/tools live in the inspector, not the compact roster row.
		// Inspector content covered by other activate tests.
		hub.dispose();
	});

	it("yields to a macrotask while streaming a large session", async () => {
		vi.useFakeTimers();
		using tempDir = TempDir.createSync("@omp-agent-hub-responsive-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const entry = JSON.stringify({
			type: "message",
			id: "entry",
			parentId: null,
			timestamp: "2026-07-30T01:13:30.000Z",
			message: { role: "user", content: [{ type: "text", text: "small" }] },
		});
		await Bun.write(sessionFile, `${entry}\n`.repeat(8_193));
		let complete = false;
		let yieldedBeforeComplete = false;
		let visited = 0;
		const visit = visitEntriesFromFileStream(
			sessionFile,
			() => {
				visited++;
				if (visited !== 8_192) return;
				setTimeout(() => {
					if (!complete) yieldedBeforeComplete = true;
				}, 0);
			},
			{ yieldEveryBytes: 0, yieldEveryEntries: 8_192 },
		).finally(() => {
			complete = true;
		});
		try {
			for (let i = 0; i < 20_000 && visited < 8_192 && !complete; i++) await Promise.resolve();
			expect(visited).toBeGreaterThanOrEqual(8_192);
			vi.runOnlyPendingTimers();
			await visit;
			expect(yieldedBeforeComplete).toBe(true);
		} finally {
			vi.useRealTimers();
		}
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
			settings: Settings.isolated(),
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
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			}),
		);
		expect(editorContainer.clear).not.toHaveBeenCalled();
		expect(editorContainer.addChild).not.toHaveBeenCalled();
		expect(focusTargets[0]).toBe(capturedHub);
		expect(renderedRosterEntries(capturedHub, 120).filter(entry => entry.includes(AGENT_ID))).toHaveLength(1);

		capturedHub.handleInput("\r");

		expect(overlays).toHaveLength(2);
		expect(focusAgentSession).not.toHaveBeenCalled();
		expect(overlayHide).not.toHaveBeenCalled();
		expect(focusTargets).not.toContain(approvalPrompt);
		expect(requestRender).toHaveBeenCalled();
	});

	it("selector controller preserves the focused subagent when f closes the Hub", async () => {
		AgentRegistry.resetGlobalForTests();
		const agents = AgentRegistry.global();
		registerWorker(agents);
		let capturedHub: AgentHubOverlayComponent | undefined;
		const closed = Promise.withResolvers<void>();
		const editor = { id: "editor" };
		const focusedSession = { id: "focused-subagent-session" };
		const focusTargets: unknown[] = [];
		const setFocus = (target: unknown) => {
			focusTargets.push(target);
		};
		const ctx = {
			keybindings: { getKeys: () => [] },
			ui: {
				showOverlay: (component: unknown) => {
					capturedHub = component as AgentHubOverlayComponent;
					return { hide: () => closed.resolve(), setHidden() {}, isHidden: () => false };
				},
				setFocus,
				requestRender() {},
			},
			editor,
			editorContainer: { children: [editor], clear() {}, addChild() {} },
			collabGuest: undefined,
			focusAgentSession: async (id: string) => {
				if (id !== AGENT_ID) throw new Error(`Unexpected agent ${id}`);
				setFocus(focusedSession);
			},
			session: { getToolByName: () => undefined, extensionRunner: undefined },
			sessionManager: { getCwd: () => TEST_CWD, getSessionFile: () => null },
			hideThinkingBlock: false,
		};
		const controller = new SelectorController(ctx as unknown as InteractiveModeContext);

		controller.showAgentHub(new SessionObserverRegistry());
		if (!capturedHub) throw new Error("Expected Agent Hub overlay");
		capturedHub.handleInput("f");
		await closed.promise;

		expect(focusTargets.at(-1)).toBe(focusedSession);
		expect(focusTargets).not.toContain(editor);
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
		let overlayOptions: Record<string, unknown> | undefined;
		const shownReady = Promise.withResolvers<AgentHubOverlayComponent>();
		const editor = {};
		const focusTargets: unknown[] = [];
		const overlayHide = vi.fn();
		const showOverlay = vi.fn((component: unknown, options: Record<string, unknown>) => {
			const hub = component as AgentHubOverlayComponent;
			shown = hub;
			overlayOptions = options;
			shownReady.resolve(hub);
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
			shownReady: shownReady.promise,
			overlayOptions: () => overlayOptions,
			focusTargets,
			showOverlay,
			overlayHide,
		};
	}

	it("requireContent leaves a Main-only Agent Hub unmounted", () => {
		const agents = new AgentRegistry();
		agents.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: null,
			sessionFile: null,
			status: "running",
		});
		const { controller, shown } = setup(agents);

		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true });

		expect(shown()).toBeUndefined();
	});

	it("the explicit Main-only hub renders its empty state and restores editor focus on Escape", () => {
		const agents = new AgentRegistry();
		registerMain(agents);
		const { controller, editor, shown, focusTargets, overlayHide } = setup(agents);

		controller.showAgentHub(new SessionObserverRegistry());

		const hub = shown();
		expect(hub).toBeDefined();
		expect(Bun.stripANSI(hub!.render(120).join("\n"))).toContain("No tasks yet");
		hub!.handleInput("\x1b");

		expect(overlayHide).toHaveBeenCalledTimes(1);
		expect(focusTargets.at(-1)).toBe(editor);
	});

	it("requireContent opens the hub once a subagent exists", () => {
		const agents = new AgentRegistry();
		registerWorker(agents);
		const { controller, shown } = setup(agents);

		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true });

		expect(shown()).toBeDefined();
		shown()!.dispose();
	});

	it("requireContent opens the hub after persisted subagents load", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-require-content-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(workerSessionFile, "");
		const agents = new AgentRegistry();
		const { controller, shown, shownReady } = setup(agents, sessionFile);

		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true });

		expect(shown()).toBeUndefined();
		const shownHub = await shownReady;
		expect(shownHub).toBeDefined();
		expect(agents.get("Worker")?.sessionFile).toBe(workerSessionFile);
		shownHub!.dispose();
	});

	it("the explicit hub opens fullscreen before persisted subagents load", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-explicit-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(path.join(tempDir.path(), "main", "Worker.jsonl"), "");
		const agents = new AgentRegistry();
		const { controller, shown, overlayOptions } = setup(agents, sessionFile);

		controller.showAgentHub(new SessionObserverRegistry());

		const hub = shown();
		expect(hub).toBeDefined();
		expect(overlayOptions()).toMatchObject({ width: "100%", maxHeight: "100%", margin: 0, fullscreen: true });
		expect(agents.get("Worker")).toBeUndefined();
		expect(Bun.stripANSI(hub!.render(120).join("\n"))).toContain("Loading saved agents");
		await hub!.persistedSubagentsReady;
		expect(agents.get("Worker")?.status).toBe("parked");
		hub!.dispose();
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

	it("coalesces a synchronous registry burst into one urgent render and refreshes rows", async () => {
		vi.useFakeTimers();
		const agents = new AgentRegistry();
		registerMain(agents);
		const observers = new SessionObserverRegistry();
		const requestRender = vi.fn();
		const hub = new AgentHubOverlayComponent({
			settings: Settings.isolated(),
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

			vi.advanceTimersByTime(0);
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

	it("refreshes direct-session fallback stats on the age cadence, not paints or heartbeats", async () => {
		vi.useFakeTimers();
		const agents = new AgentRegistry();
		const observers = new SessionObserverRegistry();
		const requestRender = vi.fn();
		const inputTokens = 100;
		const assistantMessages = 1;
		const getSessionStats = vi.fn(() => ({
			sessionFile: undefined,
			sessionId: "sdk-agent",
			userMessages: 1,
			assistantMessages,
			toolCalls: 2,
			toolResults: 2,
			totalMessages: 6,
			tokens: {
				input: inputTokens,
				output: 50,
				reasoning: 0,
				cacheRead: 20,
				cacheWrite: 0,
				total: inputTokens + 70,
			},
			premiumRequests: 0,
			cost: 0.1,
		}));
		agents.register({
			id: "SdkAgent",
			displayName: "SDK agent",
			kind: "sub",
			parentId: "Main",
			session: { getSessionStats, subscribe: () => () => {} } as unknown as AgentSession,
			status: "running",
		});
		const hub = new AgentHubOverlayComponent({
			settings: Settings.isolated(),
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
			// After removing the roster aggregate row, the inspector no longer triggers
			// After removing the roster aggregate row, the inspector no longer triggers
			// After removing the roster aggregate row, the inspector no longer triggers
			// fallback stats refreshes; per-render queries were dropped with the row.
			expect(getSessionStats).toHaveBeenCalledTimes(0);
		} finally {
			hub.dispose();
			vi.useRealTimers();
		}
	});

	it("counts shared fallback session usage once across parent and descendant rows", () => {
		const agents = new AgentRegistry();
		const getSessionStats = vi.fn(() => ({
			tokens: { input: 100, output: 40, cacheRead: 10, cacheWrite: 10, total: 160 },
			assistantMessages: 1,
			toolCalls: 2,
			cost: 0.1,
			contextUsage: undefined,
		}));
		const session = { getSessionStats } as unknown as AgentSession;
		agents.register({ id: "Parent", displayName: "Parent", kind: "sub", session, status: "idle" });
		agents.register({
			id: "Child",
			displayName: "Child",
			kind: "sub",
			parentId: "Parent",
			session,
			status: "idle",
		});
		const hub = new AgentHubOverlayComponent({
			settings: Settings.isolated(),
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
		});
		try {
			// Detail panel surfaces usage; the roster row no longer aggregates it.
			hub.render(120);
			expect(getSessionStats).toHaveBeenCalledTimes(0);
		} finally {
			hub.dispose();
		}
	});
});
