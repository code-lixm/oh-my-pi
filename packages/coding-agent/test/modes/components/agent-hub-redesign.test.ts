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
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { AgentTranscriptViewer } from "@oh-my-pi/pi-coding-agent/modes/components/agent-transcript-viewer";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	type AgentKind,
	AgentRegistry,
	type AgentStatus,
	MAIN_AGENT_ID,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
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

function renderViewer(viewer: AgentTranscriptViewer): string {
	return Bun.stripANSI(viewer.render(88).join("\n"));
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
	it("keeps Main internal while retaining advisor and completed parked Hub rows", async () => {
		const registry = new AgentRegistry();
		registerMain(registry);
		registerParticipant(registry, { id: ADVISOR, kind: "advisor", status: "parked", sessionFile: null });
		registerParticipant(registry, { id: COMPLETED, kind: "sub", status: "parked", sessionFile: null });
		const hub = makeHub({ registry });

		try {
			await hub.persistedSubagentsReady;
			const rendered = renderHub(hub);
			const trimmedLines = rendered.split("\n").map(line => line.trim());

			expect(rendered).not.toContain(MAIN_LABEL);
			expect(rendered).not.toContain("Main:");
			expect(trimmedLines).not.toContain("Main");
			expect(trimmedLines).not.toContain("Subagents");
			expect(rendered).toContain(ADVISOR);
			expect(rendered).toContain("read-only");
			expect(rendered).toContain(COMPLETED);
			expect(rendered).toContain("parked");
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

	it("keeps wide metadata columns fixed when status, duration, and model text change", async () => {
		vi.useFakeTimers();
		const startedAtMs = new Date(2025, 0, 2, 3, 4, 5).getTime();
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
				status: progress.status === "running" ? "active" : "completed",
				lastUpdate: Date.now(),
				progress,
			},
		]);
		const hub = makeHub({ registry, observers });
		const positions = (rendered: string, status: string, duration: string, modelPrefix: string) => {
			const lines = rendered.split("\n");
			const columns = lines.find(
				line => line.includes("Status") && line.includes("Duration") && line.includes("Model"),
			);
			const row = lines.find(line => line.includes(METADATA_AGENT));
			if (!columns || !row) throw new Error("Expected fixed metadata header and agent row");
			return {
				header: {
					status: columns.indexOf("Status"),
					progress: columns.indexOf("Progress"),
					duration: columns.indexOf("Duration"),
					model: columns.indexOf("Model"),
				},
				row: {
					status: row.indexOf(status),
					progress: row.indexOf("["),
					duration: row.indexOf(duration),
					model: row.indexOf(modelPrefix),
				},
			};
		};

		try {
			await hub.persistedSubagentsReady;
			setSystemTime(startedAtMs + 3_723_000);
			const first = positions(renderHub(hub), "running", "1h2m", "short-model");
			expect(first.row).toEqual(first.header);

			progress = {
				...completedProgress(METADATA_AGENT, startedAtMs, 359_999_000),
				resolvedModel: "provider/intentionally-much-longer-model-identifier",
			};
			registry.setStatus(METADATA_AGENT, "parked");
			const later = positions(renderHub(hub), "parked", "4d3h", "intentionally");
			expect(later.row).toEqual(later.header);
			expect(later.row).toEqual(first.row);
		} finally {
			hub.dispose();
		}
	});

	it("shows a terminal dynamic summary alongside its actual result and report state, never a final-summary surrogate", () => {
		const startedAtMs = new Date(2025, 0, 2, 3, 4, 5).getTime();
		const registry = new AgentRegistry();
		registerMain(registry);
		registerParticipant(registry, { id: COMPLETED, kind: "sub", status: "parked", sessionFile: null });
		const observers = new SessionObserverRegistry();
		const progress: AgentProgress = {
			...completedProgress(COMPLETED, startedAtMs, 5_000),
			activity: {
				phase: "streaming",
				label: "Streaming response",
				detail: "DYNAMIC_SUMMARY_MARKER",
				phaseStartedAtMs: startedAtMs,
				lastActivityAtMs: startedAtMs + 1_000,
			},
			resultText: "ACTUAL_TASK_RESULT_MARKER",
			deliveryStatus: "dead-letter",
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
		const viewer = new AgentTranscriptViewer({
			agentId: COMPLETED,
			registry,
			observers,
			ui: { requestRender() {}, requestComponentRender() {} } as unknown as TUI,
			cwd: "/tmp",
			expandKeys: ["ctrl+o"],
			hubKeys: [],
			requestRender: () => {},
			onClose: () => {},
			onHubClose: () => {},
		});

		try {
			const rendered = renderViewer(viewer);

			expect(rendered).toContain("Dynamic summary:");
			expect(rendered).toContain("DYNAMIC_SUMMARY_MARKER");
			expect(rendered).toContain("Task result:");
			expect(rendered).toContain("ACTUAL_TASK_RESULT_MARKER");
			expect(rendered).toContain("Report status:");
			expect(rendered).toContain("Main unavailable");
			expect(rendered).not.toContain("Final summary");
		} finally {
			viewer.dispose();
		}
	});

	it("cycles every Hub-visible status group with Alt+J/K while j/k scrolls the current transcript", async () => {
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
			const allIds = [RUNNING, WAITING, ADVISOR, COMPLETED] as const;
			const roster = renderHub(hub);
			const hubOrder = roster
				.split("\n")
				.flatMap(line => allIds.filter(id => line.includes(id)))
				.filter((id, index, ids) => ids.indexOf(id) === index);

			expect(hubOrder).toEqual([RUNNING, WAITING, COMPLETED, ADVISOR]);
			for (const [heading, id] of [
				["Running tasks (1)", RUNNING],
				["Needs attention (1)", WAITING],
				["Recently completed (1)", COMPLETED],
				["read-only (1)", ADVISOR],
			] as const) {
				expect(roster.indexOf(heading)).toBeGreaterThanOrEqual(0);
				expect(roster.indexOf(heading)).toBeLessThan(roster.indexOf(id));
			}
			expect(roster).not.toContain("Subagents");

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
