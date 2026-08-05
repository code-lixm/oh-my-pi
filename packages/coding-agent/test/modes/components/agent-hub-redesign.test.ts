/**
 * Agent Hub redesign regressions.
 *
 * These exercise the rendered overlay and the fullscreen viewer as a user does:
 * Main is internal-only, terminal task timing is immutable, and only Alt+J/K
 * changes the viewed agent while j/k stays with transcript scrolling.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InMemorySnapshotStore } from "@oh-my-pi/hashline";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { AgentTranscriptViewer } from "@oh-my-pi/pi-coding-agent/modes/components/agent-transcript-viewer";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-coding-agent/modes/components/chat-transcript-builder";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	type AgentKind,
	AgentRegistry,
	type AgentStatus,
	MAIN_AGENT_ID,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION, type SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task/types";
import type { TUI } from "@oh-my-pi/pi-tui";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../../src/i18n/settings-locale";

const MAIN_LABEL = "INTERNAL_MAIN_SHOULD_NOT_RENDER";
const RUNNING = "RUNNING_HUB_AGENT";
const WAITING = "WAITING_HUB_AGENT";
const COMPLETED = "COMPLETED_PARKED_HUB_AGENT";
const ADVISOR = "ADVISOR_HUB_AGENT";
const METADATA_AGENT = "FIXED_COLUMN_METADATA_AGENT";
const TRANSCRIPT_TIMESTAMP = "2025-01-02T03:04:05.000Z";

let previousLocale = getSettingsUiLocale();
let stdoutRowsDescriptor: PropertyDescriptor | undefined;
let terminalRows = 32;

function fakeSession(): AgentSession {
	return { subscribe: () => () => {} } as unknown as AgentSession;
}

function makeHub(options: {
	registry: AgentRegistry;
	observers?: SessionObserverRegistry;
	ui?: TUI;
}): AgentHubOverlayComponent {
	return new AgentHubOverlayComponent({
		observers: options.observers ?? new SessionObserverRegistry(),
		hubKeys: [],
		onDone: () => {},
		requestRender: () => {},
		registry: options.registry,
		irc: new IrcBus(options.registry),
		activeTopLevelId: MAIN_AGENT_ID,
		...(options.ui ? { ui: options.ui } : {}),
	});
}

function renderHub(hub: AgentHubOverlayComponent): string {
	return Bun.stripANSI(hub.render(120).join("\n"));
}

function hubRow(hub: AgentHubOverlayComponent, id: string): string {
	const row = renderHub(hub)
		.split("\n")
		.find(line => line.includes(id));
	if (!row) throw new Error(`Expected Hub row for ${id}`);
	return row;
}

function makeViewer(options: {
	agentId: string;
	registry: AgentRegistry;
	observers?: SessionObserverRegistry;
}): AgentTranscriptViewer {
	return new AgentTranscriptViewer({
		agentId: options.agentId,
		registry: options.registry,
		observers: options.observers,
		ui: { requestRender() {}, requestComponentRender() {} } as unknown as TUI,
		cwd: "/tmp",
		expandKeys: ["ctrl+o"],
		hubKeys: [],
		requestRender: () => {},
		onClose: () => {},
		onHubClose: () => {},
	});
}

function renderViewer(viewer: AgentTranscriptViewer): string {
	return Bun.stripANSI(viewer.render(88).join("\n"));
}

function viewerHeader(viewer: AgentTranscriptViewer): string {
	const header = renderViewer(viewer).split("\n")[1];
	if (!header) throw new Error("Expected compact transcript header");
	return header;
}

function registerMain(registry: AgentRegistry): void {
	registry.register({
		id: MAIN_AGENT_ID,
		displayName: MAIN_LABEL,
		kind: "main",
		session: fakeSession(),
		status: "running",
	});
}

function registerParticipant(
	registry: AgentRegistry,
	{ id, kind, status, sessionFile }: { id: string; kind: AgentKind; status: AgentStatus; sessionFile: string | null },
): void {
	registry.register({
		id,
		displayName: id,
		kind,
		parentId: MAIN_AGENT_ID,
		session: status === "parked" || status === "aborted" ? null : fakeSession(),
		sessionFile,
		status,
	});
}

function writeTranscript(dir: string, id: string): string {
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const entries: string[] = [
		JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id,
			timestamp: TRANSCRIPT_TIMESTAMP,
			cwd: "/tmp",
		}),
		JSON.stringify({
			type: "message",
			id: `${id}-top`,
			parentId: null,
			timestamp: TRANSCRIPT_TIMESTAMP,
			message: {
				role: "user",
				synthetic: true,
				attribution: "agent",
				content: `### ${id}__TOP`,
				timestamp: 0,
			},
		}),
	];
	for (let index = 0; index < 64; index++) {
		entries.push(
			JSON.stringify({
				type: "message",
				id: `${id}-message-${index}`,
				parentId: null,
				timestamp: TRANSCRIPT_TIMESTAMP,
				message: {
					role: "assistant",
					content: [{ type: "text", text: index === 63 ? `${id}__BOTTOM` : `${id} detail ${index}` }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test-model",
					usage,
					stopReason: "stop",
					timestamp: index,
				},
			}),
		);
	}
	const file = path.join(dir, `${id}.jsonl`);
	fs.writeFileSync(file, `${entries.join("\n")}\n`);
	return file;
}

function completedProgress(id: string, startedAtMs: number, durationMs: number): AgentProgress {
	return {
		index: 0,
		id,
		agent: "test-agent",
		agentSource: "bundled",
		status: "completed",
		startedAtMs,
		completedAtMs: startedAtMs + durationMs,
		task: "Render a completed task",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs,
	};
}

beforeEach(async () => {
	previousLocale = getSettingsUiLocale();
	setSettingsUiLocale("en");
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);

	terminalRows = 32;
	stdoutRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	Object.defineProperty(process.stdout, "rows", {
		configurable: true,
		get: () => terminalRows,
		set: () => {},
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	setSystemTime();
	resetSettingsForTest();
	AgentRegistry.resetGlobalForTests();
	setSettingsUiLocale(previousLocale);
	if (stdoutRowsDescriptor) {
		Object.defineProperty(process.stdout, "rows", stdoutRowsDescriptor);
	} else {
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: undefined, writable: true });
	}
});

describe("Agent Hub redesign", () => {
	it("lists only subagent rows in the Hub", async () => {
		const registry = new AgentRegistry();
		registerMain(registry);
		registerParticipant(registry, { id: ADVISOR, kind: "advisor", status: "parked", sessionFile: null });
		registerParticipant(registry, { id: COMPLETED, kind: "sub", status: "parked", sessionFile: null });
		const hub = makeHub({ registry });

		try {
			await hub.persistedSubagentsReady;
			const rendered = renderHub(hub);

			expect(rendered).toContain(COMPLETED);
			expect(rendered).not.toContain(MAIN_LABEL);
			expect(rendered).not.toContain(ADVISOR);
		} finally {
			hub.dispose();
		}
	});

	it("keeps a terminal task's elapsed metadata frozen on later Hub renders", async () => {
		vi.useFakeTimers();
		const startedAtMs = new Date(2025, 0, 2, 3, 4, 5).getTime();
		const durationMs = 3_723_000;
		const completedAtMs = startedAtMs + durationMs;
		setSystemTime(completedAtMs + 1_000);

		const registry = new AgentRegistry();
		registerMain(registry);
		registerParticipant(registry, { id: COMPLETED, kind: "sub", status: "parked", sessionFile: null });
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: COMPLETED,
				kind: "subagent",
				label: COMPLETED,
				status: "completed",
				lastUpdate: completedAtMs,
				progress: completedProgress(COMPLETED, startedAtMs, durationMs),
			},
		]);
		const hub = makeHub({ registry, observers });

		try {
			await hub.persistedSubagentsReady;
			const first = renderHub(hub);
			setSystemTime(completedAtMs + 7_200_000);
			const later = renderHub(hub);

			expect(first).toContain("1h2m");
			expect(later).toBe(first);
		} finally {
			hub.dispose();
		}
	});

	it("keeps Status, Duration, Model, and Last update columns aligned as task metadata changes", async () => {
		vi.useFakeTimers();
		const startedAtMs = new Date(2025, 0, 2, 3, 4, 5).getTime();
		setSystemTime(startedAtMs);
		const registry = new AgentRegistry();
		registerMain(registry);
		registerParticipant(registry, { id: METADATA_AGENT, kind: "sub", status: "running", sessionFile: null });
		const observers = new SessionObserverRegistry();
		let progress: AgentProgress = {
			...completedProgress(METADATA_AGENT, startedAtMs, 3_723_000),
			status: "running" as const,
			completedAtMs: undefined,
			resolvedModel: "provider/short-model",
		};
		vi.spyOn(observers, "getSessions").mockImplementation(() => [
			{
				id: METADATA_AGENT,
				kind: "subagent",
				label: METADATA_AGENT,
				status: "active",
				lastUpdate: Date.now(),
				progress,
			},
		]);
		const hub = makeHub({ registry, observers });
		const positions = (
			rendered: string,
			values: { status: string; duration: string; model: string; lastUpdate: string },
		) => {
			const lines = rendered.split("\n");
			const columns = lines.find(line =>
				["Status", "Duration", "Model", "Last up…"].every(column => line.includes(column)),
			);
			const row = lines.find(line => line.includes(METADATA_AGENT));
			if (!columns || !row) throw new Error("Expected fixed metadata header and agent row");
			return {
				header: {
					status: columns.indexOf("Status"),
					duration: columns.indexOf("Duration"),
					model: columns.indexOf("Model"),
					lastUpdate: columns.indexOf("Last up…"),
				},
				row: {
					status: row.indexOf(values.status),
					duration: row.indexOf(values.duration),
					model: row.indexOf(values.model),
					lastUpdate: row.indexOf(values.lastUpdate),
				},
			};
		};

		try {
			await hub.persistedSubagentsReady;
			setSystemTime(startedAtMs + 3_723_000);
			const first = positions(renderHub(hub), {
				status: "Running",
				duration: "1h2m",
				model: "short-model",
				lastUpdate: "1h ago",
			});
			expect(first.header.status).toBeGreaterThan(0);
			expect(first.header.duration).toBeGreaterThan(first.header.status);
			expect(first.header.model).toBeGreaterThan(first.header.duration);
			expect(first.header.lastUpdate).toBeGreaterThan(first.header.model);
			expect(first.row).toEqual(first.header);

			progress = {
				...completedProgress(METADATA_AGENT, startedAtMs, 359_999_000),
				status: "running" as const,
				completedAtMs: undefined,
				resolvedModel: "provider/intentionally-much-longer-model-identifier",
				activity: {
					phase: "waiting-user",
					label: "Waiting for input",
					detail: "Waiting for input",
					phaseStartedAtMs: startedAtMs,
					lastActivityAtMs: startedAtMs,
				},
			};
			setSystemTime(startedAtMs + 359_999_000);
			const later = positions(renderHub(hub), {
				status: "Waiting for user",
				duration: "4d3h",
				model: "intentionally",
				lastUpdate: "4d ago",
			});
			expect(later.row).toEqual(later.header);
			expect(later.header).toEqual(first.header);
		} finally {
			hub.dispose();
		}
	});

	it("shows a usable no-session placeholder beneath the compact transcript header", async () => {
		const startedAtMs = new Date(2025, 0, 2, 3, 4, 5).getTime();
		const registry = new AgentRegistry();
		registerMain(registry);
		registerParticipant(registry, { id: COMPLETED, kind: "sub", status: "parked", sessionFile: null });
		const observers = new SessionObserverRegistry();
		const progress: AgentProgress = {
			...completedProgress(COMPLETED, startedAtMs, 5_000),
			resolvedModel: "provider/short-model",
		};
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: COMPLETED,
				kind: "subagent",
				label: COMPLETED,
				status: "completed",
				lastUpdate: startedAtMs + 5_000,
				progress,
			},
		]);
		const hub = makeHub({ registry, observers });
		const viewer = makeViewer({ agentId: COMPLETED, registry, observers });

		try {
			await hub.persistedSubagentsReady;
			const hubEntry = hubRow(hub, COMPLETED);
			const lines = Bun.stripANSI(viewer.render(120).join("\n")).split("\n");
			const header = lines[1];
			if (!header) throw new Error("Expected compact transcript header");
			const body = lines.slice(2, -1).join("\n");

			expect(header).toContain("Alt+K");
			expect(header).toContain("COMPLETED");
			expect(header).toContain("Alt+J");
			expect(header).toContain("Model: provider/short-model");
			expect(header).toContain("Duration: 5s");
			expect(header).toContain("Status: completed");
			expect(hubEntry).toContain("Completed");
			expect(body).toContain("No session file available yet.");
		} finally {
			viewer.dispose();
			hub.dispose();
		}
	});

	it("shows failed observer outcomes consistently for idle and parked agent refs", async () => {
		const startedAtMs = new Date(2025, 0, 2, 3, 4, 5).getTime();
		for (const lifecycleStatus of ["idle", "parked"] as const) {
			const id = `FAILED_${lifecycleStatus.toUpperCase()}_STATUS`;
			const registry = new AgentRegistry();
			registerMain(registry);
			registerParticipant(registry, { id, kind: "sub", status: lifecycleStatus, sessionFile: null });
			const observers = new SessionObserverRegistry();
			vi.spyOn(observers, "getSessions").mockReturnValue([
				{
					id,
					kind: "subagent",
					label: id,
					status: "failed",
					lastUpdate: startedAtMs + 5_000,
					progress: { ...completedProgress(id, startedAtMs, 5_000), status: "failed" },
				},
			]);
			const hub = makeHub({ registry, observers });
			const viewer = makeViewer({ agentId: id, registry, observers });

			try {
				await hub.persistedSubagentsReady;
				expect(hubRow(hub, id)).toContain("Failed");
				expect(viewerHeader(viewer)).toContain("Status: failed");
			} finally {
				viewer.dispose();
				hub.dispose();
			}
		}
	});

	it("keeps idle and parked lifecycle labels when no observer outcome exists", async () => {
		for (const lifecycleStatus of ["idle", "parked"] as const) {
			const id = `LIFECYCLE_${lifecycleStatus.toUpperCase()}_STATUS`;
			const registry = new AgentRegistry();
			registerMain(registry);
			registerParticipant(registry, { id, kind: "sub", status: lifecycleStatus, sessionFile: null });
			const observers = new SessionObserverRegistry();
			const hub = makeHub({ registry, observers });
			const viewer = makeViewer({ agentId: id, registry, observers });

			try {
				await hub.persistedSubagentsReady;
				const hubEntry = hubRow(hub, id);
				expect(hubEntry).toContain(lifecycleStatus);
				expect(hubEntry).not.toContain("Completed");
				expect(viewerHeader(viewer)).toContain(`Status: ${lifecycleStatus}`);
			} finally {
				viewer.dispose();
				hub.dispose();
			}
		}
	});

	it("keeps an aborted tombstone ahead of stale completed observer data", async () => {
		const id = "ABORTED_TOMBSTONE_STATUS";
		const startedAtMs = new Date(2025, 0, 2, 3, 4, 5).getTime();
		const registry = new AgentRegistry();
		registerMain(registry);
		registerParticipant(registry, { id, kind: "sub", status: "aborted", sessionFile: null });
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id,
				kind: "subagent",
				label: id,
				status: "completed",
				lastUpdate: startedAtMs + 5_000,
				progress: completedProgress(id, startedAtMs, 5_000),
			},
		]);
		const hub = makeHub({ registry, observers });
		const viewer = makeViewer({ agentId: id, registry, observers });

		try {
			await hub.persistedSubagentsReady;
			const hubEntry = hubRow(hub, id);
			expect(hubEntry).toContain("Stopped");
			expect(hubEntry).not.toContain("Completed");
			const header = viewerHeader(viewer);
			expect(header).toContain("Status: aborted");
			expect(header).not.toContain("Status: completed");
		} finally {
			viewer.dispose();
			hub.dispose();
		}
	});

	it("rebuilds a persisted hashline edit preview from the current agent snapshots", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-edit-preview-"));
		try {
			const file = path.join(dir, "persisted-edit.ts");
			const sourceText = 'export const subject = "source";\nexport const value = "before";\n';
			const driftedText = 'export const subject = "externally changed";\nexport const value = "before";\n';
			fs.writeFileSync(file, sourceText);

			const snapshots = new InMemorySnapshotStore();
			const tag = snapshots.record(file, sourceText);
			fs.writeFileSync(file, driftedText);

			const callId = "persisted-hashline-edit";
			const input = `[persisted-edit.ts#${tag}]\nPUT 2.=2:\n+export const value = "after";`;
			const usage: Usage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const assistant: AssistantMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: callId, name: "edit", arguments: { input } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test-model",
				usage,
				stopReason: "toolUse",
				timestamp: 0,
			};
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: callId,
				toolName: "edit",
				content: [{ type: "text", text: "Persisted edit completed" }],
				isError: false,
				timestamp: 1,
			};
			const entries: SessionMessageEntry[] = [
				{
					type: "message",
					id: "persisted-edit-call-entry",
					parentId: null,
					timestamp: TRANSCRIPT_TIMESTAMP,
					message: assistant,
				},
				{
					type: "message",
					id: "persisted-edit-result-entry",
					parentId: "persisted-edit-call-entry",
					timestamp: TRANSCRIPT_TIMESTAMP,
					message: toolResult,
				},
			];
			const hashlineTool = { name: "edit", label: "Edit", mode: "hashline" } as unknown as AgentTool;
			let currentStore = snapshots;
			const builder = new ChatTranscriptBuilder({
				ui: { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI,
				getTool: name => (name === "edit" ? hashlineTool : undefined),
				getSnapshots: () => currentStore,
				cwd: dir,
				requestRender: () => {},
			});

			try {
				builder.rebuild(entries);
				const first = builder.container.children.find(
					(component): component is ToolExecutionComponent => component instanceof ToolExecutionComponent,
				);
				if (!first) throw new Error("Expected the persisted edit to render as a tool execution component");
				await first.whenPreviewSettled();
				const firstRender = Bun.stripANSI(first.render(120).join("\n"));
				const firstLines = firstRender.split("\n");

				expect(firstLines.some(line => line.includes('export const value = "before";') && line.includes("-"))).toBe(
					true,
				);
				expect(firstLines.some(line => line.includes('export const value = "after";') && line.includes("+"))).toBe(
					true,
				);
				expect(firstRender).not.toContain("No changes would be made");

				currentStore = new InMemorySnapshotStore();
				builder.rebuild(entries);
				const second = builder.container.children.find(
					(component): component is ToolExecutionComponent => component instanceof ToolExecutionComponent,
				);
				if (!second) throw new Error("Expected the rebuilt edit to render as a tool execution component");
				await second.whenPreviewSettled();
				const secondRender = Bun.stripANSI(second.render(120).join("\n"));

				expect(secondRender).toContain("Edit rejected");
				expect(secondRender).toContain(`hash #${tag} is not from this session`);
				expect(secondRender).not.toContain('export const value = "after";');
			} finally {
				builder.dispose();
			}
		} finally {
			removeSyncWithRetries(dir);
		}
	});

	it("cycles only Hub-visible subagent rows with Alt+J/K while j/k scrolls", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-redesign-"));
		vi.useFakeTimers();
		const registeredAtMs = new Date(2025, 0, 2, 3, 4, 5).getTime();
		setSystemTime(registeredAtMs);
		const registry = new AgentRegistry();
		registerMain(registry);
		registerParticipant(registry, {
			id: ADVISOR,
			kind: "advisor",
			status: "parked",
			sessionFile: writeTranscript(dir, ADVISOR),
		});
		setSystemTime(registeredAtMs + 1_000);
		registerParticipant(registry, {
			id: COMPLETED,
			kind: "sub",
			status: "idle",
			sessionFile: writeTranscript(dir, COMPLETED),
		});
		setSystemTime(registeredAtMs + 2_000);
		registerParticipant(registry, {
			id: WAITING,
			kind: "sub",
			status: "waiting",
			sessionFile: writeTranscript(dir, WAITING),
		});
		setSystemTime(registeredAtMs + 3_000);
		registerParticipant(registry, {
			id: RUNNING,
			kind: "sub",
			status: "running",
			sessionFile: writeTranscript(dir, RUNNING),
		});

		let activeViewer: AgentTranscriptViewer | undefined;
		const ui = {
			showOverlay(component: unknown) {
				activeViewer = component as AgentTranscriptViewer;
				return { hide() {}, setHidden() {}, isHidden: () => false };
			},
			setFocus() {},
			requestRender() {},
			requestComponentRender() {},
		} as unknown as TUI;
		const hub = makeHub({ registry, ui });
		const viewer = (): AgentTranscriptViewer => {
			if (!activeViewer) throw new Error("Agent Hub did not open a transcript viewer");
			return activeViewer;
		};

		try {
			await hub.persistedSubagentsReady;
			terminalRows = 40;
			const fixtureIds = [RUNNING, WAITING, ADVISOR, COMPLETED] as const;
			const roster = renderHub(hub);
			const hubOrder = roster
				.split("\n")
				.flatMap(line => fixtureIds.filter(id => line.includes(id)))
				.filter((id, index, ids) => ids.indexOf(id) === index);

			expect(hubOrder).toEqual([RUNNING, WAITING, COMPLETED]);

			terminalRows = 12;
			const first = hubOrder[0]!;
			hub.openChat(first);
			const opened = renderViewer(viewer());
			expect(opened).toContain("Alt+K");
			expect(opened).toContain("Alt+J");
			viewer().handleInput("g");
			expect(renderViewer(viewer())).toContain(`${first}__TOP`);

			for (let index = 0; index < 512; index++) viewer().handleInput("j");
			const afterDown = renderViewer(viewer());
			expect(afterDown).toContain(`${first}__BOTTOM`);
			expect(afterDown).not.toContain(`${first}__TOP`);

			for (let index = 0; index < 512; index++) viewer().handleInput("k");
			expect(renderViewer(viewer())).toContain(`${first}__TOP`);

			for (let index = 1; index <= hubOrder.length; index++) {
				viewer().handleInput("\x1bj");
				viewer().handleInput("G");
				const expected = hubOrder[index % hubOrder.length]!;
				expect(renderViewer(viewer())).toContain(`${expected}__BOTTOM`);
			}

			viewer().handleInput("\x1bk");
			viewer().handleInput("G");
			expect(renderViewer(viewer())).toContain(`${hubOrder.at(-1)!}__BOTTOM`);
		} finally {
			hub.dispose();
			removeSyncWithRetries(dir);
		}
	});
});
