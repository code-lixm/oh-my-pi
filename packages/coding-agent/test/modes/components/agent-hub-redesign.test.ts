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
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { AgentTranscriptViewer } from "@oh-my-pi/pi-coding-agent/modes/components/agent-transcript-viewer";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-coding-agent/modes/components/chat-transcript-builder";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	type AgentKind,
	AgentRegistry,
	type AgentStatus,
	MAIN_AGENT_ID,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION, type SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task/types";
import { Text, type TUI } from "@oh-my-pi/pi-tui";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../../src/i18n/settings-locale";

const MAIN_LABEL = "INTERNAL_MAIN_SHOULD_NOT_RENDER";
const RUNNING = "RUNNING_HUB_AGENT";
const RUNNING_LABEL = "Build";
const WAITING = "WAITING_HUB_AGENT";
const WAITING_LABEL = "Review";
const COMPLETED = "COMPLETED_PARKED_HUB_AGENT";
const COMPLETED_LABEL = "Archive";
const ADVISOR = "ADVISOR_HUB_AGENT";
const ADVISOR_LABEL = "Advisor";
const METADATA_AGENT = "FIXED_COLUMN_METADATA_AGENT";
const METADATA_LABEL = "指标";
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

const ROSTER_ENTRY_PATTERN = /^(?:❯| ) \S /u;

function renderedRosterPanel(hub: AgentHubOverlayComponent, width = 120): string[] {
	const lines = hub.render(width).map(line => Bun.stripANSI(line));
	return lines.flatMap(line => {
		if (!line.startsWith("│ ") || !line.endsWith(" │")) return [];
		return [line.slice(2, -2).trimEnd()];
	});
}

/** Terminal cell offset of a visible rendered field, not its UTF-16 index. */
function terminalCellBefore(line: string, text: string): number {
	const visible = Bun.stripANSI(line);
	const index = visible.indexOf(text);
	if (index < 0) throw new Error(`Expected ${JSON.stringify(text)} in rendered line`);
	return Bun.stringWidth(visible.slice(0, index));
}

function renderedRosterEntries(hub: AgentHubOverlayComponent, width = 120): string[] {
	return renderedRosterPanel(hub, width).filter(line => ROSTER_ENTRY_PATTERN.test(line));
}

function hubRow(hub: AgentHubOverlayComponent, label: string, width = 160): string {
	const entries = renderedRosterEntries(hub, width).filter(entry => entry.includes(label));
	if (entries.length !== 1) throw new Error(`Expected one Hub row for ${label}, found ${entries.length}`);
	return entries[0]!;
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
	{
		id,
		label,
		kind,
		status,
		sessionFile,
		terminalStatus,
		activity,
	}: {
		id: string;
		label: string;
		kind: AgentKind;
		status: AgentStatus;
		sessionFile: string | null;
		terminalStatus?: "completed" | "failed" | "aborted";
		activity?: string;
	},
): void {
	registry.register({
		id,
		displayName: label,
		kind,
		parentId: MAIN_AGENT_ID,
		session: status === "parked" || status === "aborted" ? null : fakeSession(),
		sessionFile,
		status,
		...(terminalStatus ? { terminalStatus } : {}),
		...(activity ? { activity } : {}),
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

function writeToolTranscript(
	dir: string,
	id: string,
	options: {
		toolName: string;
		arguments: Record<string, unknown>;
		resultText: string;
		customMessage?: { customType: string; content: string };
	},
): string {
	const callId = `${id}-tool-call`;
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const entries: object[] = [
		{
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id,
			timestamp: TRANSCRIPT_TIMESTAMP,
			cwd: "/tmp",
		},
		{
			type: "message",
			id: `${id}-tool-call-entry`,
			parentId: null,
			timestamp: TRANSCRIPT_TIMESTAMP,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: callId, name: options.toolName, arguments: options.arguments }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test-model",
				usage,
				stopReason: "toolUse",
				timestamp: 0,
			},
		},
		{
			type: "message",
			id: `${id}-tool-result-entry`,
			parentId: `${id}-tool-call-entry`,
			timestamp: TRANSCRIPT_TIMESTAMP,
			message: {
				role: "toolResult",
				toolCallId: callId,
				toolName: options.toolName,
				content: [{ type: "text", text: options.resultText }],
				isError: false,
				timestamp: 1,
			},
		},
	];
	if (options.customMessage) {
		entries.push({
			type: "message",
			id: `${id}-custom-entry`,
			parentId: null,
			timestamp: TRANSCRIPT_TIMESTAMP,
			message: {
				role: "custom",
				customType: options.customMessage.customType,
				content: options.customMessage.content,
				display: true,
				attribution: "agent",
				timestamp: 2,
			},
		});
	}
	const file = path.join(dir, `${id}.jsonl`);
	fs.writeFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
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
		registerParticipant(registry, {
			id: ADVISOR,
			label: ADVISOR_LABEL,
			kind: "advisor",
			status: "parked",
			sessionFile: null,
		});
		registerParticipant(registry, {
			id: COMPLETED,
			label: COMPLETED_LABEL,
			kind: "sub",
			status: "parked",
			sessionFile: null,
		});
		const hub = makeHub({ registry });

		try {
			await hub.persistedSubagentsReady;
			const roster = renderedRosterEntries(hub).join("\n");

			expect(roster).toContain(COMPLETED_LABEL);
			expect(roster).not.toContain(MAIN_LABEL);
			expect(roster).not.toContain(ADVISOR_LABEL);
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
		registerParticipant(registry, {
			id: COMPLETED,
			label: COMPLETED_LABEL,
			kind: "sub",
			status: "parked",
			sessionFile: null,
		});
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: COMPLETED,
				kind: "subagent",
				label: COMPLETED_LABEL,
				status: "completed",
				lastUpdate: completedAtMs,
				progress: completedProgress(COMPLETED, startedAtMs, durationMs),
			},
		]);
		const hub = makeHub({ registry, observers });

		try {
			await hub.persistedSubagentsReady;
			const first = hubRow(hub, COMPLETED_LABEL);
			setSystemTime(completedAtMs + 7_200_000);
			const later = hubRow(hub, COMPLETED_LABEL);

			expect(first).toContain("1h2m");
			expect(later).toContain("1h2m");
		} finally {
			hub.dispose();
		}
	});

	it("keeps Status, Duration, Model, and Detail columns cell-aligned for a CJK label as task metadata changes", async () => {
		vi.useFakeTimers();
		const startedAtMs = new Date(2025, 0, 2, 3, 4, 5).getTime();
		setSystemTime(startedAtMs);
		const registry = new AgentRegistry();
		registerMain(registry);
		registerParticipant(registry, {
			id: METADATA_AGENT,
			label: METADATA_LABEL,
			kind: "sub",
			status: "running",
			sessionFile: null,
		});
		const observers = new SessionObserverRegistry();
		let progress: AgentProgress = {
			...completedProgress(METADATA_AGENT, startedAtMs, 3_723_000),
			status: "running" as const,
			completedAtMs: undefined,
			resolvedModel: "provider/short-model",
			lastIntent: "Initial column detail",
		};
		vi.spyOn(observers, "getSessions").mockImplementation(() => [
			{
				id: METADATA_AGENT,
				kind: "subagent",
				label: METADATA_LABEL,
				status: "active",
				lastUpdate: Date.now(),
				progress,
			},
		]);
		const hub = makeHub({ registry, observers });
		const positions = (
			rendered: readonly string[],
			values: { status: string; duration: string; model: string; detail: string },
		) => {
			const columns = rendered.find(line =>
				["Status", "Duration", "Model", "Detail"].every(column => line.includes(column)),
			);
			const row = rendered.find(line => line.includes(METADATA_LABEL));
			if (!columns || !row) throw new Error("Expected fixed metadata header and agent row");
			return {
				header: {
					status: terminalCellBefore(columns, "Status"),
					duration: terminalCellBefore(columns, "Duration"),
					model: terminalCellBefore(columns, "Model"),
					detail: terminalCellBefore(columns, "Detail"),
				},
				row: {
					status: terminalCellBefore(row, values.status),
					duration: terminalCellBefore(row, values.duration),
					model: terminalCellBefore(row, values.model),
					detail: terminalCellBefore(row, values.detail),
				},
			};
		};

		try {
			await hub.persistedSubagentsReady;
			setSystemTime(startedAtMs + 3_723_000);
			const first = positions(renderedRosterPanel(hub, 160), {
				status: "Running",
				duration: "1h2m",
				model: "short-model",
				detail: "Running: Initial column detail",
			});
			expect(first.header.status).toBeGreaterThan(0);
			expect(first.header.duration).toBeGreaterThan(first.header.status);
			expect(first.header.model).toBeGreaterThan(first.header.duration);
			expect(first.header.detail).toBeGreaterThan(first.header.model);
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
			const later = positions(renderedRosterPanel(hub, 160), {
				status: "Waiting for user",
				duration: "4d3h",
				model: "intentionally",
				detail: "Waiting for user input",
			});
			expect(later.header).toEqual(first.header);
			expect(later.row).toEqual(later.header);
		} finally {
			hub.dispose();
		}
	});

	it("keeps fixed roster metadata columns aligned when a long agent label is clipped", async () => {
		vi.useFakeTimers();
		const startedAtMs = new Date(2025, 0, 2, 3, 4, 5).getTime();
		const id = "LONG_ROSTER_LABEL_FIXED_COLUMNS";
		const label = "Long roster label that must remain bounded before METADATA_TAIL";
		setSystemTime(startedAtMs);
		const registry = new AgentRegistry();
		registerMain(registry);
		registerParticipant(registry, { id, label, kind: "sub", status: "running", sessionFile: null });
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id,
				kind: "subagent",
				label,
				status: "active",
				lastUpdate: startedAtMs,
				progress: {
					...completedProgress(id, startedAtMs, 3_723_000),
					status: "running" as const,
					completedAtMs: undefined,
					resolvedModel: "provider/short-model",
				},
			},
		]);
		const hub = makeHub({ registry, observers });

		try {
			await hub.persistedSubagentsReady;
			setSystemTime(startedAtMs + 3_723_000);
			const roster = renderedRosterPanel(hub, 160);
			const header = roster.find(line =>
				["Status", "Duration", "Model", "Detail"].every(column => line.includes(column)),
			);
			const row = roster.find(line => line.includes("Long roster label"));
			if (!header || !row) throw new Error("Expected fixed metadata header and long-label agent row");

			expect(row).not.toContain("METADATA_TAIL");
			expect(terminalCellBefore(row, "Running")).toBe(terminalCellBefore(header, "Status"));
			expect(terminalCellBefore(row, "1h2m")).toBe(terminalCellBefore(header, "Duration"));
			expect(terminalCellBefore(row, "short-model")).toBe(terminalCellBefore(header, "Model"));
			expect(row).toContain("Running");
		} finally {
			hub.dispose();
		}
	});

	it("omits status-word activity candidates from roster title details", async () => {
		const startedAtMs = new Date(2025, 0, 2, 3, 4, 5).getTime();
		const registry = new AgentRegistry();
		registerMain(registry);
		const activityLabel = { id: "ACTIVITY_LABEL_STATUS_WORD", label: "Activity label source" };
		const currentTool = { id: "CURRENT_TOOL_STATUS_WORD", label: "Current tool source" };
		const lastIntent = { id: "LAST_INTENT_STATUS_WORD", label: "Last intent source" };
		const storedActivity = { id: "STORED_ACTIVITY_STATUS_WORD", label: "Stored activity source" };
		for (const agent of [activityLabel, currentTool, lastIntent, storedActivity]) {
			registerParticipant(registry, {
				...agent,
				kind: "sub",
				status: "running",
				sessionFile: null,
				...(agent === lastIntent ? { activity: "REF_AFTER_READ" } : {}),
				...(agent === storedActivity ? { activity: "Idle" } : {}),
			});
		}
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: activityLabel.id,
				kind: "subagent",
				label: activityLabel.label,
				status: "active",
				lastUpdate: startedAtMs,
				progress: {
					...completedProgress(activityLabel.id, startedAtMs, 0),
					status: "running" as const,
					completedAtMs: undefined,
					activity: {
						phase: "tool",
						label: "Idle",
						phaseStartedAtMs: startedAtMs,
						lastActivityAtMs: startedAtMs,
					},
					currentTool: "WORK_AFTER_IDLE",
				},
			},
			{
				id: currentTool.id,
				kind: "subagent",
				label: currentTool.label,
				status: "active",
				lastUpdate: startedAtMs,
				progress: {
					...completedProgress(currentTool.id, startedAtMs, 0),
					status: "running" as const,
					completedAtMs: undefined,
					currentTool: "yield",
					lastIntent: "INTENT_AFTER_YIELD",
				},
			},
			{
				id: lastIntent.id,
				kind: "subagent",
				label: lastIntent.label,
				status: "active",
				lastUpdate: startedAtMs,
				progress: {
					...completedProgress(lastIntent.id, startedAtMs, 0),
					status: "running" as const,
					completedAtMs: undefined,
					lastIntent: "read",
				},
			},
			{
				id: storedActivity.id,
				kind: "subagent",
				label: storedActivity.label,
				status: "active",
				lastUpdate: startedAtMs,
				progress: {
					...completedProgress(storedActivity.id, startedAtMs, 0),
					status: "running" as const,
					completedAtMs: undefined,
				},
			},
		]);
		const hub = makeHub({ registry, observers });

		try {
			await hub.persistedSubagentsReady;
			for (const { label, expectedDetail, hiddenDetail } of [
				{ label: activityLabel.label, expectedDetail: "WORK_AFTER_IDLE", hiddenDetail: "Idle" },
				{ label: currentTool.label, expectedDetail: "INTENT_AFTER_YIELD", hiddenDetail: "yield" },
				{ label: lastIntent.label, expectedDetail: "REF_AFTER_READ", hiddenDetail: "read" },
				{ label: storedActivity.label, expectedDetail: undefined, hiddenDetail: "Idle" },
			]) {
				const row = hubRow(hub, label);
				expect(row).not.toContain(hiddenDetail);
				if (expectedDetail) expect(row).toContain(expectedDetail);
			}
		} finally {
			hub.dispose();
		}
	});

	it("shows a usable no-session placeholder beneath the compact transcript header", async () => {
		const startedAtMs = new Date(2025, 0, 2, 3, 4, 5).getTime();
		const registry = new AgentRegistry();
		registerMain(registry);
		registerParticipant(registry, {
			id: COMPLETED,
			label: COMPLETED_LABEL,
			kind: "sub",
			status: "parked",
			sessionFile: null,
		});
		const observers = new SessionObserverRegistry();
		const progress: AgentProgress = {
			...completedProgress(COMPLETED, startedAtMs, 5_000),
			resolvedModel: "provider/short-model",
		};
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: COMPLETED,
				kind: "subagent",
				label: COMPLETED_LABEL,
				status: "completed",
				lastUpdate: startedAtMs + 5_000,
				progress,
			},
		]);
		const hub = makeHub({ registry, observers });
		const viewer = makeViewer({ agentId: COMPLETED, registry, observers });

		try {
			await hub.persistedSubagentsReady;
			const hubEntry = hubRow(hub, COMPLETED_LABEL);
			const lines = Bun.stripANSI(viewer.render(120).join("\n")).split("\n");
			const header = lines[1];
			if (!header) throw new Error("Expected compact transcript header");
			const body = lines.slice(2, -1).join("\n");

			expect(header).toContain("Alt+K");
			expect(header).toContain(COMPLETED_LABEL);
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
			const label = "Failure";
			registerParticipant(registry, { id, label, kind: "sub", status: lifecycleStatus, sessionFile: null });
			const observers = new SessionObserverRegistry();
			vi.spyOn(observers, "getSessions").mockReturnValue([
				{
					id,
					kind: "subagent",
					label,
					status: "failed",
					lastUpdate: startedAtMs + 5_000,
					progress: { ...completedProgress(id, startedAtMs, 5_000), status: "failed" },
				},
			]);
			const hub = makeHub({ registry, observers });
			const viewer = makeViewer({ agentId: id, registry, observers });

			try {
				await hub.persistedSubagentsReady;
				expect(hubRow(hub, label)).toContain("Failed");
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
			const label = "State";
			registerParticipant(registry, { id, label, kind: "sub", status: lifecycleStatus, sessionFile: null });
			const observers = new SessionObserverRegistry();
			const hub = makeHub({ registry, observers });
			const viewer = makeViewer({ agentId: id, registry, observers });

			try {
				await hub.persistedSubagentsReady;
				const hubEntry = hubRow(hub, label);
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
		const label = "Halted";
		registerParticipant(registry, { id, label, kind: "sub", status: "aborted", sessionFile: null });
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id,
				kind: "subagent",
				label,
				status: "completed",
				lastUpdate: startedAtMs + 5_000,
				progress: completedProgress(id, startedAtMs, 5_000),
			},
		]);
		const hub = makeHub({ registry, observers });
		const viewer = makeViewer({ agentId: id, registry, observers });

		try {
			await hub.persistedSubagentsReady;
			const hubEntry = hubRow(hub, label);
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

	it("renders terminal outcomes independently from lifecycle state and aggregates their semantic buckets", async () => {
		const registry = new AgentRegistry();
		registerMain(registry);
		const failed = { id: "FAILED_TERMINAL_ABORTED_LIFECYCLE", label: "Failure outcome" };
		const stopped = { id: "STOPPED_TERMINAL_IDLE_LIFECYCLE", label: "Stopped outcome" };
		registerParticipant(registry, {
			...failed,
			kind: "sub",
			status: "aborted",
			sessionFile: null,
			terminalStatus: "failed",
		});
		registerParticipant(registry, {
			...stopped,
			kind: "sub",
			status: "idle",
			sessionFile: null,
			terminalStatus: "aborted",
		});
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([]);
		const hub = makeHub({ registry, observers });

		try {
			await hub.persistedSubagentsReady;
			const rendered = hub.render(160);
			const plain = rendered.map(line => Bun.stripANSI(line)).join("\n");
			const failedRow = rendered.find(line => Bun.stripANSI(line).includes(failed.label));
			const stoppedRow = rendered.find(line => Bun.stripANSI(line).includes(stopped.label));
			if (!failedRow || !stoppedRow) throw new Error("Expected terminal outcome rows");

			expect(Bun.stripANSI(failedRow)).toContain("Failed");
			expect(failedRow).toContain(theme.fg("error", "Failed"));
			expect(Bun.stripANSI(stoppedRow)).toContain("Stopped");
			expect(stoppedRow).toContain(theme.fg("muted", "Stopped"));
			expect(plain).toContain("1 aborted");
			expect(plain).toContain("1 idle");
		} finally {
			hub.dispose();
		}
	});

	it("renders an unknown persisted edit call through the generic transcript fallback", () => {
		const callId = "persisted-unknown-edit";
		const input = "PERSISTED_EDIT_GENERIC_ARGUMENT";
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
			content: [{ type: "text", text: "PERSISTED_EDIT_GENERIC_RESULT" }],
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
		const builder = new ChatTranscriptBuilder({
			ui: { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI,
			cwd: process.cwd(),
			requestRender: () => {},
		});

		try {
			builder.rebuild(entries);
			const rendered = Bun.stripANSI(builder.container.render(120).join("\n"));
			expect(rendered).toContain("edit");
			expect(rendered).toContain(input);
			expect(rendered).toContain("PERSISTED_EDIT_GENERIC_RESULT");
			expect(rendered).not.toContain("Edit rejected");
			expect(rendered).not.toContain("No changes would be made");
		} finally {
			builder.dispose();
		}
	});

	it("routes fullscreen transcript callbacks to the selected live subagent", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-live-provenance-"));
		const id = "LIVE_PROVENANCE_SUBAGENT";
		const registry = new AgentRegistry();
		registerMain(registry);
		registerParticipant(registry, {
			id,
			label: "Live provenance",
			kind: "sub",
			status: "running",
			sessionFile: writeToolTranscript(dir, id, {
				toolName: "hub",
				arguments: { op: "list" },
				resultText: "SUBAGENT_EXTENSION_HUB_RESULT",
				customMessage: {
					customType: "subagent-provenance-note",
					content: "SUBAGENT_DEFAULT_CUSTOM_CONTENT",
				},
			}),
		});
		const extensionHubTool: AgentTool = {
			name: "hub",
			label: "Subagent Hub Extension",
			description: "same-name extension tool",
			parameters: { type: "object", additionalProperties: true },
			async execute() {
				return { content: [{ type: "text", text: "SUBAGENT_EXTENSION_HUB_RESULT" }] };
			},
		};
		const toolLookups: Array<[string, string]> = [];
		const provenanceLookups: Array<[string, string]> = [];
		const messageRendererLookups: Array<[string, string]> = [];
		const snapshotLookups: string[] = [];
		const clipboardLookups: string[] = [];
		let activeViewer: AgentTranscriptViewer | undefined;
		let fullscreen = false;
		const ui = {
			showOverlay(component: unknown, options: { fullscreen?: boolean }) {
				activeViewer = component as AgentTranscriptViewer;
				fullscreen = options.fullscreen === true;
				return { hide() {}, setHidden() {}, isHidden: () => false };
			},
			setFocus() {},
			requestRender() {},
			requestComponentRender() {},
		} as unknown as TUI;
		const hub = new AgentHubOverlayComponent({
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry,
			irc: new IrcBus(registry),
			activeTopLevelId: MAIN_AGENT_ID,
			ui,
			getTool: (agentId, name) => {
				toolLookups.push([agentId, name]);
				return agentId === id && name === "hub" ? extensionHubTool : undefined;
			},
			isBuiltInTool: (agentId, name) => {
				provenanceLookups.push([agentId, name]);
				return agentId === MAIN_AGENT_ID && name === "hub";
			},
			getMessageRenderer: (agentId, customType) => {
				messageRendererLookups.push([agentId, customType]);
				return () => new Text(agentId === id ? "SUBAGENT_CUSTOM_RENDERER_MARKER" : "MAIN_RENDERER_LEAK", 0, 0);
			},
			getSnapshots: agentId => {
				snapshotLookups.push(agentId);
				return undefined;
			},
			getClipboard: agentId => {
				clipboardLookups.push(agentId);
				return undefined;
			},
		});
		const viewer = (): AgentTranscriptViewer => {
			if (!activeViewer) throw new Error("Agent Hub did not open a transcript viewer");
			return activeViewer;
		};

		try {
			await hub.persistedSubagentsReady;
			hub.handleInput("\r");
			const rendered = renderViewer(viewer());
			expect(fullscreen).toBe(true);
			expect(toolLookups).toEqual([[id, "hub"]]);
			expect(provenanceLookups).toEqual([[id, "hub"]]);
			expect(messageRendererLookups).toEqual([[id, "subagent-provenance-note"]]);
			expect(snapshotLookups).toEqual([id]);
			expect(clipboardLookups).toEqual([id]);
			expect(rendered).toContain("Subagent Hub Extension");
			expect(rendered).toContain("SUBAGENT_EXTENSION_HUB_RESULT");
			expect(rendered).toContain("SUBAGENT_CUSTOM_RENDERER_MARKER");
			expect(rendered).not.toContain("MAIN_RENDERER_LEAK");
		} finally {
			hub.dispose();
			removeSyncWithRetries(dir);
		}
	});

	it("uses conservative false and undefined fallbacks for parked transcript provenance", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-parked-provenance-"));
		const id = "PARKED_PROVENANCE_SUBAGENT";
		const registry = new AgentRegistry();
		registerMain(registry);
		registerParticipant(registry, {
			id,
			label: "Parked provenance",
			kind: "sub",
			status: "parked",
			sessionFile: writeToolTranscript(dir, id, {
				toolName: "hub",
				arguments: { op: "list" },
				resultText: "PARKED_UNKNOWN_HUB_RESULT",
				customMessage: {
					customType: "parked-provenance-note",
					content: "PARKED_GENERIC_CUSTOM_CONTENT",
				},
			}),
		});
		let activeViewer: AgentTranscriptViewer | undefined;
		let fullscreen = false;
		const ui = {
			showOverlay(component: unknown, options: { fullscreen?: boolean }) {
				activeViewer = component as AgentTranscriptViewer;
				fullscreen = options.fullscreen === true;
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
			hub.handleInput("\r");
			const rendered = renderViewer(viewer());
			expect(fullscreen).toBe(true);
			expect(viewerHeader(viewer())).toContain("Status: parked");
			expect(rendered).toContain("PARKED_UNKNOWN_HUB_RESULT");
			expect(rendered).toContain("PARKED_GENERIC_CUSTOM_CONTENT");
			expect(rendered).not.toContain("PARKED_CUSTOM_RENDERER_MARKER");
		} finally {
			hub.dispose();
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
			label: ADVISOR_LABEL,
			kind: "advisor",
			status: "parked",
			sessionFile: writeTranscript(dir, ADVISOR),
		});
		setSystemTime(registeredAtMs + 1_000);
		registerParticipant(registry, {
			id: COMPLETED,
			label: COMPLETED_LABEL,
			kind: "sub",
			status: "idle",
			sessionFile: writeTranscript(dir, COMPLETED),
		});
		setSystemTime(registeredAtMs + 2_000);
		registerParticipant(registry, {
			id: WAITING,
			label: WAITING_LABEL,
			kind: "sub",
			status: "waiting",
			sessionFile: writeTranscript(dir, WAITING),
		});
		setSystemTime(registeredAtMs + 3_000);
		registerParticipant(registry, {
			id: RUNNING,
			label: RUNNING_LABEL,
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
			const fixtures = [
				{ id: RUNNING, label: RUNNING_LABEL },
				{ id: WAITING, label: WAITING_LABEL },
				{ id: ADVISOR, label: ADVISOR_LABEL },
				{ id: COMPLETED, label: COMPLETED_LABEL },
			] as const;
			const hubOrder = renderedRosterEntries(hub)
				.flatMap(entry => fixtures.filter(fixture => entry.includes(fixture.label)).map(fixture => fixture.id))
				.filter((id, index, ids) => ids.indexOf(id) === index);
			expect(hubOrder.map(id => fixtures.find(fixture => fixture.id === id)?.label)).toEqual([
				RUNNING_LABEL,
				WAITING_LABEL,
				COMPLETED_LABEL,
			]);

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
