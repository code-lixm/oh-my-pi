/**
 * Regression coverage for the unified Agent Hub task list: rows use the shared
 * stable navigation order. Status groups come first; creation time and agent
 * identity make ordering repeatable while activity heartbeats only update display.
 */
import { afterEach, beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { type AgentHubDeps, AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import {
	type ObservableSession,
	SessionObserverRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { TUI } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { getSettingsUiLocale, setSettingsUiLocale } from "../src/i18n/settings-locale";

interface GeometryStub {
	setRows(n: number): void;
	restore(): void;
}

function stubStdoutGeometry(cols: number): GeometryStub {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	let rows = 24;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
		else Object.defineProperty(process.stdout, key, { configurable: true, value: undefined, writable: true });
	};
	return {
		setRows(n: number) {
			rows = n;
		},
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function makeHub(agents: AgentRegistry, overrides: Partial<AgentHubDeps> = {}) {
	return new AgentHubOverlayComponent({
		settings: Settings.isolated(),
		observers: new SessionObserverRegistry(),
		hubKeys: [],
		onDone: () => {},
		requestRender: () => {},
		registry: agents,
		irc: new IrcBus(agents),
		focusAgent: async () => {},
		...overrides,
	});
}

interface ParsedRosterCell {
	raw: string;
	text: string;
	selected: boolean;
}

interface RenderedAgentRow extends ParsedRosterCell {
	label: string;
	line: number;
}

const ROSTER_ROW_PATTERN = /^(❯| ) \S+ /u;
const TREE_PREFIX_PATTERN = /^(?:… )?(?:(?:│| ) {3})*(?:├── |└── )/u;

/**
 * Parse one flat Agent Hub roster row without depending on theme escape
 * sequences. Requiring the row cursor and status glyph excludes the roster
 * summary and footer chrome.
 */
function parseRosterCell(raw: string): ParsedRosterCell | undefined {
	const frame = Bun.stripANSI(raw);
	if (!frame.startsWith("│ ") || !frame.endsWith(" │")) return undefined;
	const text = frame.slice(2, -2).trimEnd();
	const match = ROSTER_ROW_PATTERN.exec(text);
	if (!match) return undefined;
	return { raw, text, selected: match[1] === "❯" };
}

/** Resolve an entry exclusively through its caller-facing display label. */
function displayLabelInRosterCell(cell: string, labels: readonly string[]): string | undefined {
	const match = ROSTER_ROW_PATTERN.exec(cell);
	if (!match) return undefined;
	const entry = cell.slice(match[0].length);
	const branch = TREE_PREFIX_PATTERN.exec(entry)?.[0] ?? "";
	const display = entry.slice(branch.length);
	const markers = [...labels].sort((left, right) => right.length - left.length);
	return markers.find(label => {
		if (!display.startsWith(label)) return false;
		const next = display.at(label.length);
		return next === undefined || /[\s…]/u.test(next);
	});
}

/**
 * Find physical flat-roster rows by caller-facing display label, never by a
 * clipped internal session id. The cursor/status prefix excludes summary and
 * footer chrome from the result.
 */
function renderedAgentRows(hub: AgentHubOverlayComponent, labels: readonly string[], width = 120): RenderedAgentRow[] {
	const rows: RenderedAgentRow[] = [];
	for (const [line, raw] of hub.render(width).entries()) {
		const cell = parseRosterCell(raw);
		if (!cell) continue;
		const label = displayLabelInRosterCell(cell.text, labels);
		if (label) rows.push({ ...cell, label, line });
	}
	return rows;
}

function renderedAgentLabels(hub: AgentHubOverlayComponent, labels: readonly string[], width = 120): string[] {
	return renderedAgentRows(hub, labels, width).map(row => row.label);
}

function selectedAgentLabel(hub: AgentHubOverlayComponent, labels: readonly string[], width = 120): string | undefined {
	return renderedAgentRows(hub, labels, width).find(row => row.selected)?.label;
}

function renderedRosterEntry(hub: AgentHubOverlayComponent, label: string, width: number): string {
	const row = renderedAgentRows(hub, [label], width)[0];
	expect(row).toBeDefined();
	return row!.text;
}

function renderedRosterHeaderLineRaw(hub: AgentHubOverlayComponent, label: string, width: number): string {
	const row = renderedAgentRows(hub, [label], width)[0];
	if (!row) throw new Error(`No rendered roster header for ${label}`);
	return row.raw;
}

function stubObservedSessions(observers: SessionObserverRegistry, snapshots: readonly ObservableSession[]): void {
	const snapshotsById = new Map<string, ObservableSession>();
	for (const snapshot of snapshots) snapshotsById.set(snapshot.id, snapshot);
	vi.spyOn(observers, "getSession").mockImplementation(id => snapshotsById.get(id));
}

function leftClick(row1Based: number): string {
	return `\x1b[<0;4;${row1Based}M`;
}

function wheel(direction: "up" | "down"): string {
	return `\x1b[<${direction === "down" ? 65 : 64};4;4M`;
}

describe("Agent hub row ordering", () => {
	let geometry: GeometryStub | undefined;
	let previousLocale: string;

	beforeAll(async () => {
		await initTheme();
		previousLocale = getSettingsUiLocale();
	});

	afterEach(() => {
		vi.useRealTimers();
		setSystemTime();
		vi.restoreAllMocks();
		geometry?.restore();
		geometry = undefined;
		AgentRegistry.resetGlobalForTests();
		setSettingsUiLocale(previousLocale);
	});

	it("renders a useful empty state before any task agents exist", () => {
		geometry = stubStdoutGeometry(120);
		const hub = makeHub(new AgentRegistry());

		try {
			const rendered = Bun.stripANSI(hub.render(120).join("\n"));
			expect(rendered).toContain("No tasks yet");
			expect(rendered).toContain("no subagents yet — task spawns appear here");
		} finally {
			hub.dispose();
		}
	});

	it("orders rows by lifecycle group, newest creation, then stable identity", () => {
		vi.useFakeTimers();
		geometry = stubStdoutGeometry(120);
		setSettingsUiLocale("en");
		const agents = new AgentRegistry();
		const observers = new SessionObserverRegistry();
		const session = {} as AgentSession;
		const register = (
			id: string,
			displayName: string,
			status: "running" | "waiting" | "idle" | "aborted",
			createdAt: number,
		) => {
			setSystemTime(createdAt);
			return agents.register({ id, displayName, kind: "sub", session, status });
		};
		const sameCreatedAt = 30;

		register("run-older", "Running older", "running", 10);
		register("run-newer", "Running newer", "running", 20);
		register("run-tie-zulu", "Running tie Zulu", "running", sameCreatedAt);
		register("run-tie-alpha", "Running tie Alpha", "running", sameCreatedAt);
		const missingZulu = register("run-missing-zulu", "Running missing Zulu", "running", 40);
		const missingAlpha = register("run-missing-alpha", "Running missing Alpha", "running", 40);
		register("waiting", "Waiting worker", "waiting", 100);
		register("pending", "Queued worker", "running", 200);
		register("failed", "Failed worker", "running", 300);
		register("completed", "Completed worker", "idle", 400);
		register("aborted", "Aborted worker", "aborted", 500);
		Reflect.deleteProperty(missingZulu, "createdAt");
		Reflect.deleteProperty(missingAlpha, "createdAt");

		const snapshots: ObservableSession[] = [
			{
				id: "pending",
				kind: "subagent",
				label: "Queued worker",
				status: "active",
				lastUpdate: 200,
				progress: { status: "pending" } as never,
			},
			{
				id: "failed",
				kind: "subagent",
				label: "Failed worker",
				status: "failed",
				lastUpdate: 300,
				progress: { status: "failed" } as never,
			},
			{
				id: "completed",
				kind: "subagent",
				label: "Completed worker",
				status: "completed",
				lastUpdate: 400,
				progress: { status: "completed" } as never,
			},
		];
		vi.spyOn(observers, "getSession").mockImplementation(id => snapshots.find(snapshot => snapshot.id === id));

		const hub = makeHub(agents, { observers });
		try {
			expect(
				renderedAgentLabels(hub, [
					"Running older",
					"Running newer",
					"Running tie Zulu",
					"Running tie Alpha",
					"Running missing Zulu",
					"Running missing Alpha",
					"Waiting worker",
					"Queued worker",
					"Failed worker",
					"Completed worker",
					"Aborted worker",
				]),
			).toEqual([
				"Running tie Alpha",
				"Running tie Zulu",
				"Running newer",
				"Running older",
				"Running missing Alpha",
				"Running missing Zulu",
				"Queued worker",
				"Waiting worker",
				"Failed worker",
				"Aborted worker",
				"Completed worker",
			]);
			expect(Bun.stripANSI(hub.render(120).join("\n"))).not.toContain("undefined");
		} finally {
			hub.dispose();
		}
	});

	it("does not reorder rows when a running agent heartbeats", () => {
		vi.useFakeTimers();
		geometry = stubStdoutGeometry(120);
		setSettingsUiLocale("en");
		const agents = new AgentRegistry();
		const session = {} as AgentSession;

		setSystemTime(1_000);
		agents.register({ id: "oldest", displayName: "Oldest", kind: "sub", session, status: "running" });
		setSystemTime(2_000);
		agents.register({ id: "heartbeat", displayName: "Heartbeat", kind: "sub", session, status: "running" });
		setSystemTime(3_000);
		agents.register({ id: "newest", displayName: "Newest", kind: "sub", session, status: "running" });

		const hub = makeHub(agents);
		try {
			const labels = ["Oldest", "Heartbeat", "Newest"];
			const expectedOrder = ["Newest", "Heartbeat", "Oldest"];
			expect(renderedAgentLabels(hub, labels)).toEqual(expectedOrder);

			setSystemTime(10_000);
			agents.setActivityState("heartbeat", {
				phase: "tool",
				label: "Applying patch",
				phaseStartedAtMs: 10_000,
				lastActivityAtMs: 10_000,
			});
			vi.advanceTimersByTime(100);

			expect(renderedAgentLabels(hub, labels)).toEqual(expectedOrder);
		} finally {
			hub.dispose();
		}
	});

	it("keeps the selected agent when a refresh changes its row position", async () => {
		vi.useFakeTimers();
		geometry = stubStdoutGeometry(120);
		setSettingsUiLocale("en");
		const agents = new AgentRegistry();
		const session = {} as AgentSession;
		const focused: string[] = [];
		const done = vi.fn();
		const finished = Promise.withResolvers<void>();

		setSystemTime(1_000);
		agents.register({ id: "oldest", displayName: "Oldest", kind: "sub", session, status: "running" });
		setSystemTime(2_000);
		agents.register({ id: "selected", displayName: "Selected", kind: "sub", session, status: "running" });
		setSystemTime(3_000);
		agents.register({ id: "newest", displayName: "Newest", kind: "sub", session, status: "running" });

		const hub = makeHub(agents, {
			onDone: reason => {
				done(reason);
				finished.resolve();
			},
			focusAgent: async id => {
				focused.push(id);
			},
		});
		try {
			const labels = ["Oldest", "Selected", "Newest"];
			expect(renderedAgentLabels(hub, labels)).toEqual(["Newest", "Selected", "Oldest"]);
			hub.handleInput("j");

			agents.setStatus("newest", "waiting");
			vi.advanceTimersByTime(100);
			expect(renderedAgentLabels(hub, labels)).toEqual(["Selected", "Oldest", "Newest"]);

			hub.handleInput("f");
			await finished.promise;
			expect(focused).toEqual(["selected"]);
			expect(done).toHaveBeenCalledWith("preserve-focus");
		} finally {
			hub.dispose();
		}
	});

	it("bounds observer lookups and entry rendering to the viewport on large rosters", () => {
		geometry = stubStdoutGeometry(120);
		geometry.setRows(12);
		const agents = new AgentRegistry();
		const labels: string[] = [];
		for (let i = 0; i < 10_000; i++) {
			const suffix = i.toString().padStart(5, "0");
			const label = `Viewport agent ${suffix}`;
			labels.push(label);
			agents.register({
				id: `internal-agent-${suffix}`,
				displayName: label,
				kind: "sub",
				session: null,
				status: "parked",
			});
		}

		const observers = new SessionObserverRegistry();
		const getSessions = vi.spyOn(observers, "getSessions");
		const getSession = vi.spyOn(observers, "getSession");
		const hub = makeHub(agents, { observers });

		try {
			getSessions.mockClear();
			getSession.mockClear();
			const visibleLabels = renderedAgentLabels(hub, labels);
			expect(visibleLabels).toHaveLength(4);
			expect(getSessions).not.toHaveBeenCalled();
			expect(getSession.mock.calls.length).toBeLessThanOrEqual(8);
			expect(getSession.mock.calls.length).toBeGreaterThan(0);

			for (const label of visibleLabels) expect(renderedRosterEntry(hub, label, 120)).toContain("parked");
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toMatch(/… \d+ more/);

			getSessions.mockClear();
			getSession.mockClear();
			hub.handleInput("j");
			const afterMove = renderedAgentRows(hub, labels);
			expect(afterMove).toHaveLength(4);
			expect(afterMove.find(row => row.selected)?.label).not.toBe(visibleLabels[0]);
			expect(afterMove.map(row => row.label)).toContain(visibleLabels[0]!);
			expect(getSessions).not.toHaveBeenCalled();
			expect(getSession.mock.calls.length).toBeLessThanOrEqual(8);
		} finally {
			hub.dispose();
		}
	});

	it("sanitizes compact roster content without rendering task details as extra rows", () => {
		geometry = stubStdoutGeometry(80);
		const agents = new AgentRegistry();
		agents.register({
			id: "RevAgentStream",
			displayName: "CONTROL_MARKER\x1b[2J\treview terminal safety\u0007\n- check wrapping\r- check leaks",
			kind: "sub",
			session: {} as AgentSession,
		});

		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSession").mockReturnValue({
			id: "RevAgentStream",
			kind: "subagent",
			label: "Subagent",
			status: "active",
			description: "Complete the assignment below, thoroughly:\n- check performance\n- check leaks",
			lastUpdate: Date.now(),
			progress: {
				currentTool: "bash",
				currentToolArgs: "\x1b[2Jdangerous args",
			} as never,
		});

		const hub = makeHub(agents, { observers });
		try {
			const output = hub.render(80).join("\n");
			for (const line of output.split("\n")) {
				const cleanLine = Bun.stripANSI(line);
				expect(cleanLine).not.toMatch(/[\t\r\n]/u);
				expect(visibleWidth(line)).toBeLessThanOrEqual(80);
			}
			expect(output).not.toContain("\x1b[2J");
			expect(output).not.toContain("\t");
			expect(output).not.toContain("\u0007");
			const roster = Bun.stripANSI(output);
			expect(roster).toContain("CONTROL_MARKER");
			expect(roster).not.toContain("Complete the assignment below");
			expect(hub.render(80).filter(parseRosterCell)).toHaveLength(1);
		} finally {
			hub.dispose();
		}
	});

	it("renders one compact flat task row per agent", async () => {
		geometry = stubStdoutGeometry(160);
		setSettingsUiLocale("en");
		const agents = new AgentRegistry();
		const observers = new SessionObserverRegistry();
		const endpoint = {
			deliverIrcMessage: async () => "injected" as const,
			emitIrcRelayObservation: () => {},
		} as unknown as AgentSession;
		const registerTask = (id: string, displayName: string) =>
			agents.register({ id, displayName, kind: "sub", session: endpoint, status: "running" });
		const longTask = "LONG_TASK_DETAIL_MARKER detail detail detail detail detail detail detail detail";
		agents.register({ id: "Main", displayName: "Main", kind: "main", session: endpoint, status: "running" });
		agents.register({
			id: "Main/advisor",
			displayName: "ADVISOR_LEAK_MARKER",
			kind: "advisor",
			session: endpoint,
			status: "running",
		});
		registerTask("pending", "Alpha");
		registerTask("queued", "Bravo");
		agents.setActivity("queued", "Queued");
		registerTask("running", "Charlie");
		registerTask("waiting", "Delta");
		registerTask("completed", "Echo");
		registerTask("failed", "Foxtrot");
		registerTask("aborted", "Golf");
		const snapshots: ObservableSession[] = [
			{
				id: "pending",
				kind: "subagent",
				label: "Alpha",
				status: "active",
				lastUpdate: 1,
				progress: { status: "pending" } as never,
			},
			{
				id: "queued",
				kind: "subagent",
				label: "Bravo",
				status: "active",
				lastUpdate: 2,
				progress: {
					status: "running",
					activity: {
						phase: "queued",
						label: "Queued",
						phaseStartedAtMs: 2,
						lastActivityAtMs: 2,
					},
				} as never,
			},
			{
				id: "running",
				kind: "subagent",
				label: "Charlie",
				status: "active",
				description: longTask,
				lastUpdate: 3,
				progress: { status: "running" } as never,
			},
			{
				id: "waiting",
				kind: "subagent",
				label: "Delta",
				status: "active",
				lastUpdate: 4,
				progress: {
					status: "running",
					activity: {
						phase: "waiting-user",
						label: "Waiting for user",
						phaseStartedAtMs: 4,
						lastActivityAtMs: 4,
					},
				} as never,
			},
			{
				id: "completed",
				kind: "subagent",
				label: "Echo",
				status: "completed",
				lastUpdate: 5,
				progress: { status: "completed" } as never,
			},
			{
				id: "failed",
				kind: "subagent",
				label: "Foxtrot",
				status: "failed",
				lastUpdate: 6,
				progress: { status: "failed" } as never,
			},
			{
				id: "aborted",
				kind: "subagent",
				label: "Golf",
				status: "aborted",
				lastUpdate: 7,
				progress: { status: "aborted" } as never,
			},
		];
		vi.spyOn(observers, "getSession").mockImplementation(id => snapshots.find(snapshot => snapshot.id === id));
		const irc = new IrcBus(agents);
		const hub = makeHub(agents, { observers, irc });

		try {
			await irc.send({ from: "running", to: "Main", body: "IRC_DELIVERY_LEAK_MARKER" });
			const taskLabels = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"];
			const rosterRows = renderedAgentRows(hub, taskLabels, 160);
			expect(rosterRows).toHaveLength(taskLabels.length);
			expect(rosterRows.map(row => row.label).sort()).toEqual([...taskLabels].sort());
			for (const label of taskLabels) expect(rosterRows.filter(row => row.label === label)).toHaveLength(1);

			const english = Bun.stripANSI(hub.render(160).join("\n"));
			expect(english).not.toContain("ADVISOR_LEAK_MARKER");
			expect(english).not.toContain("IRC_DELIVERY_LEAK_MARKER");
			expect(renderedRosterEntry(hub, "Bravo", 160)).toContain("Queued");
			const runningEntry = renderedRosterEntry(hub, "Charlie", 160);
			expect(runningEntry).not.toContain("LONG_TASK_DETAIL_MARKER");
			expect(rosterRows.filter(row => row.label === "Charlie")).toHaveLength(1);

			const selectedIndex = rosterRows.findIndex(row => row.selected);
			const runningIndex = rosterRows.findIndex(row => row.label === "Charlie");
			for (let index = selectedIndex; index < runningIndex; index++) hub.handleInput("j");
			for (let index = selectedIndex; index > runningIndex; index--) hub.handleInput("k");
			expect(Bun.stripANSI(hub.render(160).join("\n"))).not.toContain("LONG_TASK_DETAIL_MARKER");
			expect(Bun.stripANSI(hub.render(160).join("\n"))).not.toContain("┬");

			setSettingsUiLocale("zh-CN");
			expect(renderedRosterEntry(hub, "Alpha", 160)).toContain("未开始");
			expect(renderedRosterEntry(hub, "Bravo", 160)).toContain("排队中");
			expect(renderedRosterEntry(hub, "Charlie", 160)).toContain("运行中");
			expect(renderedRosterEntry(hub, "Delta", 160)).toContain("等待用户");
			expect(renderedRosterEntry(hub, "Echo", 160)).toContain("已完成");
			expect(renderedRosterEntry(hub, "Foxtrot", 160)).toContain("失败");
			expect(renderedRosterEntry(hub, "Golf", 160)).toContain("已停止");
		} finally {
			hub.dispose();
		}
	});
	it("fits the fullscreen table to short terminals without scanning the roster", () => {
		geometry = stubStdoutGeometry(80);
		geometry.setRows(10);
		const agents = new AgentRegistry();
		for (let i = 0; i < 50; i++) {
			agents.register({
				id: `Agent${i}`,
				displayName: `Agent ${i}`,
				kind: "sub",
				session: {} as AgentSession,
			});
		}

		const observers = new SessionObserverRegistry();
		const getSessions = vi.spyOn(observers, "getSessions");
		const getSession = vi.spyOn(observers, "getSession");
		const hub = makeHub(agents, { observers });

		try {
			getSessions.mockClear();
			getSession.mockClear();
			const lines = hub.render(80);
			expect(lines).toHaveLength(10);
			expect(getSessions).not.toHaveBeenCalled();
			expect(getSession.mock.calls.length).toBeLessThan(agents.list().length);
			expect(Bun.stripANSI(lines.join("\n"))).toContain("…");
		} finally {
			hub.dispose();
		}
	});
	it("uses whole-row mouse selection while f performs the explicit live focus action", async () => {
		vi.useFakeTimers();
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000);
		agents.register({ id: "mouse-alpha", displayName: "Mouse Alpha", kind: "sub", session: {} as AgentSession });
		setSystemTime(2_000);
		agents.register({ id: "mouse-beta", displayName: "Mouse Beta", kind: "sub", session: {} as AgentSession });
		setSystemTime(3_000);
		agents.register({ id: "mouse-gamma", displayName: "Mouse Gamma", kind: "sub", session: {} as AgentSession });

		const focused: string[] = [];
		const done = vi.fn();
		const finished = Promise.withResolvers<void>();
		const hub = makeHub(agents, {
			onDone: reason => {
				done(reason);
				finished.resolve();
			},
			focusAgent: async id => {
				focused.push(id);
			},
		});

		try {
			const labels = ["Mouse Alpha", "Mouse Beta", "Mouse Gamma"];
			expect(selectedAgentLabel(hub, labels)).toBe("Mouse Gamma");
			hub.handleInput(wheel("down"));
			expect(selectedAgentLabel(hub, labels)).toBe("Mouse Beta");

			const alphaRow = renderedAgentRows(hub, ["Mouse Alpha"], 120)[0];
			expect(alphaRow).toBeDefined();
			const alphaLine = alphaRow!.line;
			hub.handleInput(`\x1b[<0;110;${alphaLine + 1}M`);
			expect(selectedAgentLabel(hub, labels)).toBe("Mouse Alpha");
			expect(focused).toEqual([]);
			hub.handleInput(leftClick(alphaLine + 1));
			expect(selectedAgentLabel(hub, labels)).toBe("Mouse Alpha");
			expect(focused).toEqual([]);

			hub.handleInput("f");
			await finished.promise;
			expect(focused).toEqual(["mouse-alpha"]);
			expect(done).toHaveBeenCalledWith("preserve-focus");
		} finally {
			hub.dispose();
		}
	});

	it("flags a fallback badge for observer-only rows with no live session", () => {
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		// A collab guest / observer-only row carries no live AgentSession, so the
		// badge must come from the executor-reported progress instead.
		agents.register({
			id: "observer-only-guest",
			displayName: "Guest reviewer",
			kind: "sub",
			session: null,
			status: "running",
		});

		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSession").mockReturnValue({
			id: "observer-only-guest",
			kind: "subagent",
			label: "Subagent",
			status: "active",
			lastUpdate: Date.now(),
			progress: {
				resolvedModel: "openai/gpt-4o",
				resolvedModelIsFallback: true,
			} as never,
		});

		const hub = makeHub(agents, { observers });

		try {
			for (const width of [60, 120]) {
				geometry?.restore();
				geometry = stubStdoutGeometry(width);
				const lines = hub.render(width);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				const entry = renderedRosterEntry(hub, "Guest reviewer", width);
				expect(entry).toContain("Guest reviewer");
				expect(entry).toContain("Running");
			}
			expect(renderedRosterEntry(hub, "Guest reviewer", 120)).toContain("fallback → openai/gpt-4o");
		} finally {
			hub.dispose();
		}
	});

	it("flags a fallback badge for a live row whose fallback armed no session retry state", () => {
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		// Live session with a resolved model but no `retryFallbackModel` — the
		// Fireworks Fast → base degrade emits `retry_fallback_applied` without
		// arming `#activeRetryFallback`, so the badge must fall back to the
		// executor-reported progress flag.
		const session = { model: { id: "kimi-k2" }, retryFallbackModel: undefined } as unknown as AgentSession;
		agents.register({ id: "fast-agent-internal", displayName: "Fast Agent", kind: "sub", session });

		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSession").mockReturnValue({
			id: "fast-agent-internal",
			kind: "subagent",
			label: "Subagent",
			status: "active",
			lastUpdate: Date.now(),
			progress: {
				resolvedModel: "fireworks/kimi-k2",
				resolvedModelIsFallback: true,
			} as never,
		});

		const hub = makeHub(agents, { observers });

		try {
			expect(renderedRosterEntry(hub, "Fast Agent", 120)).toContain("Fast Agent");
			expect(renderedRosterEntry(hub, "Fast Agent", 120)).toContain("fallback → fireworks/kimi…");
		} finally {
			hub.dispose();
		}
	});

	it("renders task-only rows without Main or advisor labels", () => {
		vi.useFakeTimers();
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		agents.register({
			id: "Main",
			displayName: "PRIMARY_MAIN_LEAK_MARKER",
			kind: "main",
			sessionTitle: "PRIMARY_WORKSPACE_LEAK_MARKER",
			session: {} as AgentSession,
			status: "idle",
		});
		agents.register({
			id: "top-level:review",
			displayName: "REVIEW_MAIN_LEAK_MARKER",
			kind: "main",
			sessionTitle: "REVIEW_WORKSPACE_LEAK_MARKER",
			session: {} as AgentSession,
			status: "idle",
		});
		agents.register({
			id: "ADVISOR_ROW_LEAK_MARKER",
			displayName: "ADVISOR_LABEL_LEAK_MARKER",
			kind: "advisor",
			session: {} as AgentSession,
			status: "idle",
		});
		setSystemTime(1_000);
		agents.register({
			id: "PrimaryWorker",
			displayName: "Primary worker",
			kind: "sub",
			parentId: "Main",
			session: {} as AgentSession,
			status: "idle",
		});
		setSystemTime(2_000);
		agents.register({
			id: "ReviewWorker",
			displayName: "Review worker",
			kind: "sub",
			parentId: "top-level:review",
			session: {} as AgentSession,
			status: "idle",
		});
		const hub = makeHub(agents, { activeTopLevelId: "Main" });

		try {
			expect(renderedAgentLabels(hub, ["Primary worker", "Review worker"])).toEqual([
				"Review worker",
				"Primary worker",
			]);
			const rendered = Bun.stripANSI(hub.render(120).join("\n"));
			for (const hidden of [
				"PRIMARY_MAIN_LEAK_MARKER",
				"PRIMARY_WORKSPACE_LEAK_MARKER",
				"REVIEW_MAIN_LEAK_MARKER",
				"REVIEW_WORKSPACE_LEAK_MARKER",
				"ADVISOR_ROW_LEAK_MARKER",
				"ADVISOR_LABEL_LEAK_MARKER",
			]) {
				expect(rendered).not.toContain(hidden);
			}
		} finally {
			hub.dispose();
		}
	});

	it("retains the live thinking level unless progress has an explicit suffix", () => {
		geometry = stubStdoutGeometry(140);
		const agents = new AgentRegistry();
		const inheritedSession = { thinkingLevel: ThinkingLevel.High } as unknown as AgentSession;
		const explicitSession = { thinkingLevel: ThinkingLevel.High } as unknown as AgentSession;
		agents.register({
			id: "inherited-level-internal",
			displayName: "Inherited level",
			kind: "sub",
			session: inheritedSession,
		});
		agents.register({
			id: "explicit-level-internal",
			displayName: "Explicit level",
			kind: "sub",
			session: explicitSession,
		});
		const observers = new SessionObserverRegistry();
		const snapshots: ObservableSession[] = [
			{
				id: "inherited-level-internal",
				kind: "subagent",
				label: "Inherited level",
				status: "active",
				lastUpdate: Date.now(),
				progress: { resolvedModel: "openai/gpt-5.4" } as never,
			},
			{
				id: "explicit-level-internal",
				kind: "subagent",
				label: "Explicit level",
				status: "active",
				lastUpdate: Date.now(),
				progress: { resolvedModel: "openai/gpt-5.4:low" } as never,
			},
		];
		stubObservedSessions(observers, snapshots);
		const hub = makeHub(agents, { observers });

		try {
			const inherited = renderedRosterEntry(hub, "Inherited level", 140);
			expect(inherited).toContain("gpt-5.4");
			expect(inherited).toContain(theme.thinking.high);

			const explicit = renderedRosterEntry(hub, "Explicit level", 140);
			expect(explicit).toContain("gpt-5.4");
			expect(explicit).toContain(theme.thinking.low);
			expect(explicit).not.toContain(theme.thinking.high);
		} finally {
			hub.dispose();
		}
	});

	it("renders aggregate usage in flat rows without surfacing inspector-only history", () => {
		geometry = stubStdoutGeometry(140);
		geometry.setRows(28);
		const agents = new AgentRegistry();
		agents.register({
			id: "reviewer-internal",
			displayName: "Security Reviewer",
			kind: "sub",
			parentId: "Main",
			session: null,
			history: {
				outputPath: "/tmp/Reviewer.md",
				patchPath: "/tmp/Reviewer.patch",
				branchName: "omp/task/Reviewer",
			},
		});
		const observers = new SessionObserverRegistry();
		const snapshots: ObservableSession[] = [
			{
				id: "reviewer-internal",
				kind: "subagent",
				label: "Security Reviewer",
				description: "Review the session lifecycle and produce actionable findings",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					id: "reviewer-internal",
					index: 0,
					agent: "reviewer",
					agentSource: "bundled",
					status: "running",
					task: "Review the session lifecycle",
					currentTool: "read",
					currentToolArgs: "src/session/agent-session.ts",
					recentTools: [],
					recentOutput: [],
					toolCount: 27,
					requests: 12,
					tokens: 18_400,
					contextTokens: 31_000,
					contextWindow: 128_000,
					cost: 0.2134,
					durationMs: 134_000,
					resolvedModel: "openai/gpt-5.4:high",
				} as never,
			},
		];
		stubObservedSessions(observers, snapshots);
		const hub = makeHub(agents, { observers });

		try {
			const rendered = Bun.stripANSI(hub.render(140).join("\n"));
			expect(rendered).toContain("1 running");
			expect(rendered).toContain("$0.213 · 2m14s active agent time · 12 req · 27 tools · 18K tok");
			const row = renderedRosterEntry(hub, "Security Reviewer", 140);
			expect(row).toContain("Security Reviewer");
			expect(row).not.toContain("read");
			expect(row).toContain("Running");
			expect(row).toContain("2m14s active");
			expect(row).toContain("gpt-5.4");
			expect(row).not.toContain("Review the session lifecycle");
			for (const hiddenDetail of [
				"src/session/agent-session.ts",
				"31K/128K 24%",
				"/tmp/Reviewer.md",
				"/tmp/Reviewer.patch",
				"omp/task/Reviewer",
			]) {
				expect(rendered).not.toContain(hiddenDetail);
			}
		} finally {
			hub.dispose();
		}
	});
	it("shows measured usage in aggregate and bounded roster duration cells", () => {
		geometry = stubStdoutGeometry(160);
		geometry.setRows(32);
		const agents = new AgentRegistry();
		agents.register({
			id: "running-metrics-internal",
			displayName: "Running metrics",
			kind: "sub",
			session: null,
			status: "running",
		});
		agents.register({
			id: "completed-metrics-internal",
			displayName: "Completed metrics",
			kind: "sub",
			session: null,
			status: "idle",
		});
		agents.register({
			id: "historical-metrics-internal",
			displayName: "Historical metrics",
			kind: "sub",
			session: null,
			status: "parked",
			activity: "Restored task",
		});
		const observers = new SessionObserverRegistry();
		const snapshots: ObservableSession[] = [
			{
				id: "running-metrics-internal",
				kind: "subagent",
				label: "Running metrics",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					id: "running-metrics-internal",
					index: 0,
					agent: "worker",
					agentSource: "bundled",
					status: "running",
					task: "Run checks",
					recentTools: [],
					recentOutput: [],
					toolCount: 4,
					requests: 3,
					tokens: 1_200,
					cost: 0.1234,
					durationMs: 6_500,
				} as never,
			},
			{
				id: "completed-metrics-internal",
				kind: "subagent",
				label: "Completed metrics",
				status: "completed",
				lastUpdate: Date.now(),
				progress: {
					id: "completed-metrics-internal",
					index: 1,
					agent: "worker",
					agentSource: "bundled",
					status: "completed",
					task: "Finish checks",
					recentTools: [],
					recentOutput: [],
					toolCount: 8,
					requests: 5,
					tokens: 2_500,
					cost: 0.4567,
					durationMs: 125_000,
				} as never,
			},
		];
		stubObservedSessions(observers, snapshots);
		const hub = makeHub(agents, { observers });

		try {
			const frame = hub.render(160).map(line => Bun.stripANSI(line));
			const rendered = frame.join("\n");
			expect(rendered).toContain("2/3 measured");
			expect(rendered).toContain("2/2 timed");
			expect(rendered).toContain("$0.580");
			expect(rendered).toContain("3.7K tok");
			expect(rendered).toContain("8 req");
			expect(rendered).toContain("12 tools");
			expect(rendered).toContain("2m11s active agent time");
			const reportingLine = frame.findIndex(line => line.includes("2/2 timed") && line.includes("2/3 measured"));
			const firstRosterLine = frame.findIndex(line => line.includes("Running metrics"));
			expect(reportingLine).toBeGreaterThanOrEqual(0);
			expect(firstRosterLine).toBeGreaterThan(reportingLine);
			const footer = frame.at(-2) ?? "";
			expect(footer).toContain("j/k:select");
			expect(footer).not.toContain("measured");
			expect(footer).not.toContain("timed");
			expect(footer).not.toContain("$0.580");
			const running = renderedRosterEntry(hub, "Running metrics", 160);
			expect(running).toContain("6.5s active");
			expect(running).not.toContain("Run checks");
			expect(running).not.toContain("$0.123");
			const completed = renderedRosterEntry(hub, "Completed metrics", 160);
			expect(completed).toContain("2m5s active");
			expect(completed).not.toContain("$0.457");
			const historical = renderedRosterEntry(hub, "Historical metrics", 160);
			expect(historical).toContain("Restored task");
			expect(historical).not.toContain("$0.000");
			expect(rendered).not.toContain("$0.123 · 6.5s active · 3 req · 4 tools · 1.2K tok");
			expect(rendered).not.toContain("$0.457 · 2m5s active · 5 req · 8 tools · 2.5K tok");
		} finally {
			hub.dispose();
		}
	});
	it("treats incomplete and non-finite progress usage as unknown", () => {
		geometry = stubStdoutGeometry(160);
		const agents = new AgentRegistry();
		const getSessionStats = vi.fn(() => ({
			sessionFile: undefined,
			sessionId: "incomplete",
			userMessages: 1,
			assistantMessages: 9,
			toolCalls: 4,
			toolResults: 4,
			totalMessages: 18,
			tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 150 },
			premiumRequests: 0,
			cost: 0.25,
		}));
		agents.register({
			id: "incomplete-telemetry-internal",
			displayName: "Incomplete telemetry",
			kind: "sub",
			session: { getSessionStats } as unknown as AgentSession,
		});
		agents.register({
			id: "non-finite-telemetry-internal",
			displayName: "Non-finite telemetry",
			kind: "sub",
			session: null,
		});
		const observers = new SessionObserverRegistry();
		const snapshots: ObservableSession[] = [
			{
				id: "incomplete-telemetry-internal",
				kind: "subagent",
				label: "Incomplete telemetry",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					tokens: 100,
					toolCount: 2,
					cost: 0.1,
					durationMs: 1_000,
				} as never,
			},
			{
				id: "non-finite-telemetry-internal",
				kind: "subagent",
				label: "Non-finite telemetry",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					tokens: Number.NaN,
					requests: 2,
					toolCount: 2,
					cost: 0.1,
					durationMs: 1_000,
				} as never,
			},
		];
		stubObservedSessions(observers, snapshots);
		const hub = makeHub(agents, { observers });

		try {
			const rendered = Bun.stripANSI(hub.render(160).join("\n"));
			expect(rendered).toContain("Usage —");
			expect(rendered).toContain("0/2 measured");
			for (const label of ["Incomplete telemetry", "Non-finite telemetry"]) {
				expect(renderedRosterEntry(hub, label, 160)).toContain(label);
			}
			expect(rendered).not.toContain("$0.000");
			expect(getSessionStats).not.toHaveBeenCalled();
		} finally {
			hub.dispose();
		}
	});
	it("shows configured role text in the fixed model column but not for an explicit selector", () => {
		geometry = stubStdoutGeometry(160);
		const agents = new AgentRegistry();
		agents.register({ id: "role-agent-internal", displayName: "Role Agent", kind: "sub", session: null });
		agents.register({ id: "explicit-agent-internal", displayName: "Explicit Agent", kind: "sub", session: null });
		const observers = new SessionObserverRegistry();
		const snapshots: ObservableSession[] = [
			{
				id: "role-agent-internal",
				kind: "subagent",
				label: "Role Agent",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					id: "role-agent-internal",
					index: 0,
					agent: "worker",
					agentSource: "bundled",
					status: "running",
					task: "Run with the configured role",
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 1,
					tokens: 10,
					cost: 0,
					durationMs: 100,
					modelRole: "rapid",
					resolvedModel: "openai/gpt-4o",
				} as never,
			},
			{
				id: "explicit-agent-internal",
				kind: "subagent",
				label: "Explicit Agent",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					id: "explicit-agent-internal",
					index: 1,
					agent: "worker",
					agentSource: "bundled",
					status: "running",
					task: "Run with an explicit selector",
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 1,
					tokens: 10,
					cost: 0,
					durationMs: 100,
					resolvedModel: "openai/gpt-4o",
				} as never,
			},
		];
		stubObservedSessions(observers, snapshots);
		const hub = makeHub(agents, {
			observers,
			settings: Settings.isolated({
				modelRoles: { rapid: "openai/gpt-4o" },
				modelTags: { rapid: { name: "Quick", color: "warning" } },
			}),
		});

		try {
			const rendered = Bun.stripANSI(hub.render(160).join("\n"));
			expect(rendered).toContain("Status");
			expect(rendered).toContain("Duration");
			expect(rendered).toContain("Model");
			expect(rendered).toContain("Last up…");
			const role = renderedRosterEntry(hub, "Role Agent", 160);
			expect(role).toContain("Quick");
			expect(role).toContain("gpt-4o");
			expect(role.indexOf("Quick")).toBeLessThan(role.indexOf("gpt-4o"));
			const explicit = renderedRosterEntry(hub, "Explicit Agent", 160);
			expect(explicit).toContain("gpt-4o");
			expect(explicit).not.toContain("Quick");
			for (const line of hub.render(160)) expect(visibleWidth(line)).toBeLessThanOrEqual(160);
		} finally {
			hub.dispose();
		}
	});
	it("switches between inline Flat and By parent projections with selection preserved", () => {
		vi.useFakeTimers();
		geometry = stubStdoutGeometry(120);
		setSettingsUiLocale("en");
		const agents = new AgentRegistry();
		setSystemTime(1_000);
		agents.register({
			id: "parent-internal",
			displayName: "Parent task",
			kind: "sub",
			parentId: "Main",
			session: null,
		});
		setSystemTime(2_000);
		agents.register({
			id: "peer-internal",
			displayName: "Peer task",
			kind: "sub",
			parentId: "Main",
			session: null,
		});
		setSystemTime(3_000);
		agents.register({
			id: "child-internal",
			displayName: "Child task",
			kind: "sub",
			parentId: "parent-internal",
			session: null,
		});
		const hub = makeHub(agents);
		const labels = ["Parent task", "Peer task", "Child task"];

		try {
			expect(renderedAgentLabels(hub, labels)).toEqual(["Child task", "Peer task", "Parent task"]);
			expect(selectedAgentLabel(hub, labels)).toBe("Child task");
			const flat = Bun.stripANSI(hub.render(120).join("\n"));
			expect(flat).toContain("Flat");
			expect(flat).toContain("By parent");

			hub.setHoverIndex(0);
			expect(renderedRosterHeaderLineRaw(hub, "Child task", 120)).toContain(theme.getBgAnsi("selectedBg"));
			hub.handleInput("t");
			const byParentLabels = renderedAgentLabels(hub, labels);
			expect(byParentLabels).toEqual(["Parent task", "Child task", "Peer task"]);
			expect(selectedAgentLabel(hub, labels)).toBe("Child task");
			const byParent = Bun.stripANSI(hub.render(120).join("\n"));
			expect(byParent).toContain("Flat");
			expect(byParent).toContain("By parent");
			expect(byParentLabels.indexOf("Parent task")).toBeLessThan(byParentLabels.indexOf("Child task"));
			expect(renderedRosterHeaderLineRaw(hub, "Parent task", 120)).not.toContain(theme.getBgAnsi("selectedBg"));
			expect(renderedRosterHeaderLineRaw(hub, "Child task", 120)).toContain(theme.getBgAnsi("selectedBg"));

			hub.handleInput("t");
			expect(renderedAgentLabels(hub, labels)).toEqual(["Child task", "Peer task", "Parent task"]);
			expect(selectedAgentLabel(hub, labels)).toBe("Child task");
		} finally {
			hub.dispose();
			vi.useRealTimers();
			setSystemTime();
		}
	});

	it("renders parent lineage with bash-style tree connectors", () => {
		geometry = stubStdoutGeometry(120);
		geometry.setRows(32);
		const agents = new AgentRegistry();
		agents.register({
			id: "parent-tree-internal",
			displayName: "Parent task",
			kind: "sub",
			parentId: "Main",
			session: null,
		});
		agents.register({
			id: "first-tree-internal",
			displayName: "First task",
			kind: "sub",
			parentId: "parent-tree-internal",
			session: null,
		});
		agents.register({
			id: "grandchild-tree-internal",
			displayName: "Grandchild task",
			kind: "sub",
			parentId: "first-tree-internal",
			session: null,
		});
		agents.register({
			id: "last-tree-internal",
			displayName: "Last task",
			kind: "sub",
			parentId: "parent-tree-internal",
			session: null,
		});
		const hub = makeHub(agents);

		try {
			hub.handleInput("t");
			expect(Bun.stripANSI(renderedRosterHeaderLineRaw(hub, "First task", 120))).toContain("├── First task");
			expect(Bun.stripANSI(renderedRosterHeaderLineRaw(hub, "Grandchild task", 120))).toContain(
				"│   └── Grandchild task",
			);
			expect(Bun.stripANSI(renderedRosterHeaderLineRaw(hub, "Last task", 120))).toContain("└── Last task");
		} finally {
			hub.dispose();
		}
	});

	it("keeps cyclic parent links renderable in tree mode", () => {
		const agents = new AgentRegistry();
		agents.register({
			id: "cycle-a-internal",
			displayName: "Cycle Alpha",
			kind: "sub",
			parentId: "cycle-b-internal",
			session: null,
		});
		agents.register({
			id: "cycle-b-internal",
			displayName: "Cycle Beta",
			kind: "sub",
			parentId: "cycle-a-internal",
			session: null,
		});
		const hub = makeHub(agents);

		try {
			hub.handleInput("t");
			const rendered = Bun.stripANSI(hub.render(120).join("\n"));
			expect(rendered).toContain("Cycle Alpha");
			expect(rendered).toContain("Cycle Beta");
		} finally {
			hub.dispose();
		}
	});

	it("keeps narrow roster rows compact and opens the selected transcript fullscreen", () => {
		geometry = stubStdoutGeometry(80);
		geometry.setRows(16);
		const agents = new AgentRegistry();
		agents.register({ id: "NarrowAgent", displayName: "Narrow Agent", kind: "sub", session: {} as AgentSession });
		const observers = new SessionObserverRegistry();
		stubObservedSessions(observers, [
			{
				id: "NarrowAgent",
				kind: "subagent",
				label: "Narrow Agent",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					id: "NarrowAgent",
					status: "running",
					task: "Inspect responsive behavior",
					recentTools: [],
					recentOutput: [],
					toolCount: 3,
					requests: 2,
					tokens: 900,
					cost: 0,
					durationMs: 2_000,
				} as never,
			},
		]);
		let fullscreen = false;
		const focused: unknown[] = [];
		const ui = {
			showOverlay(_component: unknown, options: { fullscreen?: boolean }) {
				fullscreen = options.fullscreen === true;
				return { hide() {}, setHidden() {}, isHidden: () => false };
			},
			setFocus(component: unknown) {
				focused.push(component);
			},
			requestRender() {},
			requestComponentRender() {},
			terminal: { rows: 16 },
		} as unknown as TUI;
		const hub = makeHub(agents, { observers, ui });

		try {
			const roster = Bun.stripANSI(hub.render(80).join("\n"));
			const rows = renderedAgentRows(hub, ["Narrow Agent"], 80);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.text).not.toContain("Inspect responsive behavior");
			expect(roster).not.toContain("┬");
			for (const line of hub.render(80)) expect(visibleWidth(line)).toBeLessThanOrEqual(80);

			hub.handleInput("\r");
			expect(fullscreen).toBe(true);
			expect(focused).toHaveLength(1);
		} finally {
			hub.dispose();
		}
	});
});
