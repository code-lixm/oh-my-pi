/**
 * Regression coverage for the unified Agent Hub task list: task rows keep
 * registration order while live observer snapshots refresh localized
 * user-facing statuses, without exposing routing traffic or status sections.
 */
import { afterEach, beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";
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

function makeHub(agents: AgentRegistry, observers = new SessionObserverRegistry()) {
	return new AgentHubOverlayComponent({
		observers,
		hubKeys: [],
		onDone: () => {},
		requestRender: () => {},
		registry: agents,
		irc: new IrcBus(agents),
		focusAgent: async () => {},
	});
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

	it("keeps registered rows fixed while observer status and activity refresh", () => {
		vi.useFakeTimers();
		geometry = stubStdoutGeometry(120);
		setSettingsUiLocale("en");
		const agents = new AgentRegistry();
		const observers = new SessionObserverRegistry();
		const eventBus = new EventBus();
		observers.subscribeToEventBus(eventBus);
		const session = {} as AgentSession;

		setSystemTime(1_000);
		agents.register({ id: "first", displayName: "First observed", kind: "sub", session, status: "running" });
		setSystemTime(2_000);
		agents.register({ id: "second", displayName: "Second observed", kind: "sub", session, status: "running" });

		for (const [id, index, startedAtMs] of [
			["first", 0, 1_000],
			["second", 1, 2_000],
		] as const) {
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id,
				index,
				agent: "task",
				agentSource: "bundled",
				status: "started",
				startedAtMs,
				detached: true,
			});
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index,
				agent: "task",
				agentSource: "bundled",
				task: "",
				detached: true,
				progress: { id, status: "running" } as never,
			});
		}

		const hub = makeHub(agents, observers);
		try {
			const labels = ["First observed", "Second observed"] as const;
			expect(renderedAgentLabels(hub, labels)).toEqual([...labels]);
			const initialRows = hub.render(120).map(Bun.stripANSI);
			expect(initialRows.find(line => line.includes("First observed"))).toContain("Running");
			expect(initialRows.find(line => line.includes("Second observed"))).toContain("Running");

			setSystemTime(5_000);
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id: "first",
				index: 0,
				agent: "task",
				agentSource: "bundled",
				status: "completed",
				startedAtMs: 1_000,
				completedAtMs: 5_000,
				detached: true,
			});
			const waitingActivity = {
				phase: "waiting-user" as const,
				label: "Waiting for review",
				phaseStartedAtMs: 5_000,
				lastActivityAtMs: 5_000,
			};
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index: 1,
				agent: "task",
				agentSource: "bundled",
				task: "",
				detached: true,
				progress: { id: "second", status: "running", activity: waitingActivity } as never,
			});
			agents.setActivityState("second", waitingActivity);
			vi.advanceTimersByTime(100);

			expect(renderedAgentLabels(hub, labels)).toEqual([...labels]);
			const refreshedRows = hub.render(120).map(Bun.stripANSI);
			expect(refreshedRows.find(line => line.includes("First observed"))).toContain("Completed");
			expect(refreshedRows.find(line => line.includes("Second observed"))).toContain("Waiting for user");
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
});
