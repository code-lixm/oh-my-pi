/**
 * Regression coverage for the unified Agent Hub task list: rows use the shared
 * stable navigation order. Status groups come first; creation time and agent
 * identity make ordering repeatable while activity heartbeats only update display.
 */
import { afterEach, beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import {
	type ObservableSession,
	SessionObserverRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	type AgentProgress,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
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

function makeHub(
	agents: AgentRegistry,
	observers = new SessionObserverRegistry(),
	focusAgent: (id: string) => Promise<void> = async () => {},
) {
	return new AgentHubOverlayComponent({
		observers,
		hubKeys: [],
		onDone: () => {},
		requestRender: () => {},
		registry: agents,
		irc: new IrcBus(agents),
		focusAgent,
	});
}

function lifecyclePayload(id: string, status: SubagentLifecyclePayload["status"]): SubagentLifecyclePayload {
	return { id, index: 0, agent: "task", agentSource: "bundled", status };
}

function progressPayload(id: string, status: AgentProgress["status"]): SubagentProgressPayload {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		task: "Refresh timing",
		progress: {
			index: 0,
			id,
			agent: "task",
			agentSource: "bundled",
			status,
			task: "Refresh timing",
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		},
	};
}

function renderedAgentLabels(hub: AgentHubOverlayComponent, knownLabels: readonly string[]): string[] {
	// Sort assertions only need the relative order of the fixture labels. Do not
	// bind them to incidental cursor or status-glyph columns in the row chrome.
	const labels: string[] = [];
	for (const raw of hub.render(120)) {
		const label = knownLabels.find(candidate => Bun.stripANSI(raw).includes(candidate));
		if (label) labels.push(label);
	}
	return labels;
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

		register("run-older", "Running older", "running", 10);
		register("run-newer", "Running newer", "running", 20);
		register("run-tie-zulu", "Running tie Zulu", "running", 30);
		register("run-tie-alpha", "Running tie Alpha", "running", 30);
		const missingZulu = register("run-missing-zulu", "Running missing Zulu", "running", 40);
		const missingAlpha = register("run-missing-alpha", "Running missing Alpha", "running", 40);
		register("waiting", "Waiting worker", "waiting", 100);
		register("pending", "Queued worker", "running", 200);
		register("failed", "Failed worker", "running", 300);
		register("completed", "Completed worker", "idle", 400);
		register("aborted", "Aborted worker", "aborted", 500);
		// Historical rows can lack a valid persisted creation time; identity is the
		// deterministic fallback for that boundary.
		Reflect.deleteProperty(missingZulu, "createdAt");
		Reflect.deleteProperty(missingAlpha, "createdAt");

		vi.spyOn(observers, "getSessions").mockReturnValue([
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
		]);

		const hub = makeHub(agents, observers);
		try {
			const labels = [
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
			] as const;

			expect(renderedAgentLabels(hub, labels)).toEqual([
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
			const labels = ["Oldest", "Heartbeat", "Newest"] as const;
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

	it("keeps the selected agent when a refresh changes its row position", () => {
		vi.useFakeTimers();
		geometry = stubStdoutGeometry(120);
		setSettingsUiLocale("en");
		const agents = new AgentRegistry();
		const session = {} as AgentSession;
		const focused: string[] = [];

		setSystemTime(1_000);
		agents.register({ id: "oldest", displayName: "Oldest", kind: "sub", session, status: "running" });
		setSystemTime(2_000);
		agents.register({ id: "selected", displayName: "Selected", kind: "sub", session, status: "running" });
		setSystemTime(3_000);
		agents.register({ id: "newest", displayName: "Newest", kind: "sub", session, status: "running" });

		const hub = makeHub(agents, undefined, id => {
			focused.push(id);
			return Promise.resolve();
		});
		try {
			const labels = ["Oldest", "Selected", "Newest"] as const;
			expect(renderedAgentLabels(hub, labels)).toEqual(["Newest", "Selected", "Oldest"]);
			hub.handleInput("j");

			agents.setStatus("newest", "waiting");
			vi.advanceTimersByTime(100);
			expect(renderedAgentLabels(hub, labels)).toEqual(["Selected", "Oldest", "Newest"]);

			hub.handleInput("f");
			expect(focused).toEqual(["selected"]);
		} finally {
			hub.dispose();
		}
	});

	it("strips untrusted terminal controls and bounds hub rows", () => {
		geometry = stubStdoutGeometry(80);
		const agents = new AgentRegistry();
		const sessionA = {} as AgentSession;
		agents.register({
			id: "RevAgentStream",
			displayName: "CONTROL_MARKER\x1b[2J\treview terminal safety\n- check wrapping\r- check leaks",
			kind: "sub",
			session: sessionA,
		});

		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: "RevAgentStream",
				kind: "subagent",
				label: "Subagent",
				status: "active",
				lastUpdate: Date.now(),
			},
		]);

		const hub = new AgentHubOverlayComponent({
			observers,
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
		});

		try {
			const lines = hub.render(80);
			const rawOutput = lines.join("\n");
			expect(rawOutput).not.toContain("\x1b[2J");
			expect(rawOutput).not.toContain("\t");
			expect(Bun.stripANSI(rawOutput)).toContain("CONTROL_MARKER");
			for (const line of lines) {
				const cleanLine = Bun.stripANSI(line);
				expect(cleanLine).not.toMatch(/[\t\r\n]/u);
				expect(visibleWidth(line)).toBeLessThanOrEqual(78);
			}
		} finally {
			hub.dispose();
		}
	});

	it("renders one Chinese task list with lifecycle projections and no internal traffic", async () => {
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
		registerTask("running", "Charlie");
		registerTask("waiting", "Delta");
		registerTask("completed", "Echo");
		registerTask("failed", "Foxtrot");
		registerTask("aborted", "Golf");
		vi.spyOn(observers, "getSessions").mockReturnValue([
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
						label: "Queued by scheduler",
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
		]);
		const irc = new IrcBus(agents);
		const hub = new AgentHubOverlayComponent({
			observers,
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc,
			focusAgent: async () => {},
		});

		try {
			await irc.send({ from: "running", to: "Main", body: "IRC_DELIVERY_LEAK_MARKER" });
			const english = hub.render(160).map(Bun.stripANSI).join("\n");
			expect(english).not.toMatch(
				/^\s*(?:Active(?: agents| tasks)?|Queued|Pending|Running|Waiting for user|Not started|Completed|Failed|Stopped)(?:\s*\(\d+\))?\s*$/mu,
			);
			for (const hiddenDetail of [
				"ADVISOR_LEAK_MARKER",
				"IRC_DELIVERY_LEAK_MARKER",
				"Delivered to Main",
				"m message",
			]) {
				expect(english).not.toContain(hiddenDetail);
			}

			setSettingsUiLocale("zh-CN");
			const chineseLines = hub.render(160).map(Bun.stripANSI);
			const rowFor = (label: string) => chineseLines.find(line => line.includes(label));
			expect(rowFor("Alpha")).toContain("未开始");
			expect(rowFor("Bravo")).toContain("未开始");
			expect(rowFor("Charlie")).toContain("运行中");
			expect(rowFor("Delta")).toContain("等待用户");
			expect(rowFor("Echo")).toContain("已完成");
			expect(rowFor("Foxtrot")).toContain("失败");
			expect(rowFor("Golf")).toContain("已停止");
			const chinese = chineseLines.join("\n");
			expect(chinese).not.toContain("pending");
			expect(chinese).not.toContain("queued");
		} finally {
			hub.dispose();
		}
	});

	it("flags a fallback badge for observer-only rows with no live session", () => {
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		// A collab guest / observer-only row carries no live AgentSession, so the
		// badge must come from the executor-reported progress instead.
		agents.register({ id: "GuestAgent", displayName: "Guest", kind: "sub", session: null, status: "running" });

		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: "GuestAgent",
				kind: "subagent",
				label: "Subagent",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					resolvedModel: "openai/gpt-4o",
					resolvedModelIsFallback: true,
				} as never,
			},
		]);

		const hub = new AgentHubOverlayComponent({
			observers,
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
		});

		try {
			for (const width of [60, 120]) {
				geometry?.restore();
				geometry = stubStdoutGeometry(width);
				const lines = hub.render(width);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width - 2);
				const rendered = Bun.stripANSI(lines.join("\n"));
				expect(rendered).toContain("Guest");
				expect(rendered).toContain("Running");
				expect(rendered).toContain("fallback → openai/gpt-4o");
			}
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
		agents.register({ id: "FastAgent", displayName: "Fast Agent", kind: "sub", session });

		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: "FastAgent",
				kind: "subagent",
				label: "Subagent",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					resolvedModel: "fireworks/kimi-k2",
					resolvedModelIsFallback: true,
				} as never,
			},
		]);

		const hub = new AgentHubOverlayComponent({
			observers,
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
		});

		try {
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("fallback → fireworks/kimi-k2");
		} finally {
			hub.dispose();
		}
	});

	it("flattens non-Main agents without rendering owning Main labels or groups", () => {
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		agents.register({
			id: "Main",
			displayName: "Primary registry identity",
			kind: "main",
			sessionTitle: "Primary workspace",
			session: {} as AgentSession,
			status: "idle",
		});
		agents.register({
			id: "top-level:review",
			displayName: "Review registry identity",
			kind: "main",
			sessionTitle: "Review workspace",
			session: {} as AgentSession,
			status: "idle",
		});
		agents.register({
			id: "Primary worker",
			displayName: "Primary worker",
			kind: "sub",
			parentId: "Main",
			session: {} as AgentSession,
			status: "idle",
		});
		agents.register({
			id: "Review worker",
			displayName: "Review worker",
			kind: "sub",
			parentId: "top-level:review",
			session: {} as AgentSession,
			status: "idle",
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
		});

		try {
			const rendered = Bun.stripANSI(hub.render(120).join("\n"));
			expect(rendered).toContain("Agent Hub");
			expect(rendered).toContain("Primary worker");
			expect(rendered).toContain("Review worker");
			expect(rendered).not.toContain("Primary registry identity");
			expect(rendered).not.toContain("Review registry identity");
			expect(rendered).not.toContain("Primary workspace");
			expect(rendered).not.toContain("Review workspace");
			expect(rendered).not.toContain("Main:");
			expect(rendered).not.toContain("Subagents");
		} finally {
			hub.dispose();
		}
	});

	it("hides UUID-only Main and subagent labels behind generic names", () => {
		geometry = stubStdoutGeometry(120);
		const uuid = "4b1d4df0-0ae0-4ff8-8f25-d35a5ba13e2f";
		const agents = new AgentRegistry();
		agents.register({
			id: "Main",
			displayName: "Primary workspace",
			kind: "main",
			session: {} as AgentSession,
			status: "idle",
		});
		agents.register({
			id: `top-level:${uuid}`,
			displayName: uuid,
			kind: "main",
			session: {} as AgentSession,
			status: "idle",
		});
		agents.register({
			id: "uuid-labelled child",
			displayName: uuid,
			kind: "sub",
			parentId: `top-level:${uuid}`,
			session: {} as AgentSession,
			status: "idle",
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
		});

		try {
			const rendered = Bun.stripANSI(hub.render(120).join("\n"));
			expect(rendered).not.toContain(uuid);
			expect(rendered).toMatch(/\bSubagent\b/u);
		} finally {
			hub.dispose();
		}
	});

	it("refreshes registry, lifecycle, and reset changes urgently while coalescing progress", () => {
		vi.useFakeTimers();
		geometry = stubStdoutGeometry(120);
		setSettingsUiLocale("en");
		const agents = new AgentRegistry();
		const observers = new SessionObserverRegistry();
		const eventBus = new EventBus();
		const requestRender = vi.fn();
		const id = "refresh-timing";
		observers.subscribeToEventBus(eventBus);
		const hub = new AgentHubOverlayComponent({
			observers,
			hubKeys: [],
			onDone: () => {},
			requestRender,
			registry: agents,
			irc: new IrcBus(agents),
			remote: { chat: () => {}, kill: () => {}, revive: () => {}, readTranscript: async () => null },
			focusAgent: async () => {},
		});

		try {
			agents.register({
				id,
				displayName: "Refresh timing worker",
				kind: "sub",
				session: {} as AgentSession,
				status: "running",
			});
			expect(requestRender).not.toHaveBeenCalled();
			vi.advanceTimersByTime(0);
			expect(requestRender).toHaveBeenCalledTimes(1);
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("Refresh timing worker");

			requestRender.mockClear();
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecyclePayload(id, "failed"));
			expect(requestRender).not.toHaveBeenCalled();
			vi.advanceTimersByTime(0);
			expect(requestRender).toHaveBeenCalledTimes(1);
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("Failed");

			requestRender.mockClear();
			observers.resetSessions();
			vi.advanceTimersByTime(0);
			expect(requestRender).toHaveBeenCalledTimes(1);
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("Running");

			requestRender.mockClear();
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload(id, "running"));
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload(id, "running"));
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload(id, "failed"));
			expect(requestRender).not.toHaveBeenCalled();
			vi.advanceTimersByTime(99);
			expect(requestRender).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(requestRender).toHaveBeenCalledTimes(1);
			expect(observers.getSessions()).toMatchObject([{ id, status: "failed", progress: { status: "failed" } }]);
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("Failed");
		} finally {
			hub.dispose();
			observers.dispose();
		}
	});

	it("takes one fresh observer snapshot for each large-table render", () => {
		geometry = stubStdoutGeometry(120);
		geometry.setRows(200);
		setSettingsUiLocale("en");
		const agents = new AgentRegistry();
		const ids = Array.from({ length: 100 }, (_, index) => `render-${String(index).padStart(3, "0")}`);
		const snapshots: ObservableSession[] = ids.map((id, index) => ({
			id,
			kind: "subagent",
			label: `Worker ${String(index).padStart(3, "0")}`,
			status: index === 99 ? "failed" : "active",
			lastUpdate: index,
		}));
		for (const [index, id] of ids.entries()) {
			agents.register({
				id,
				displayName: `Worker ${String(index).padStart(3, "0")}`,
				kind: "sub",
				session: {} as AgentSession,
				status: "running",
			});
		}
		const observers = new SessionObserverRegistry();
		const getSessions = vi.spyOn(observers, "getSessions").mockImplementation(() => snapshots);
		const hub = new AgentHubOverlayComponent({
			observers,
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			remote: { chat: () => {}, kill: () => {}, revive: () => {}, readTranscript: async () => null },
			focusAgent: async () => {},
		});

		try {
			getSessions.mockClear();
			const initial = hub.render(120).map(Bun.stripANSI);
			expect(getSessions).toHaveBeenCalledTimes(1);
			expect(initial.find(line => line.includes("Worker 000"))).toContain("Running");
			expect(initial.find(line => line.includes("Worker 099"))).toContain("Failed");

			snapshots[0] = { ...snapshots[0]!, status: "failed" };
			const refreshed = hub.render(120).map(Bun.stripANSI);
			expect(getSessions).toHaveBeenCalledTimes(2);
			expect(refreshed.find(line => line.includes("Worker 000"))).toContain("Failed");
		} finally {
			hub.dispose();
			observers.dispose();
		}
	});
});
