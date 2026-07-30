/**
 * Regression: the agent hub row order must be stable while the hub is open.
 *
 * The hub is sorted by lastActivity on first open, but after that keyboard
 * selection must not jump around as agents heartbeat or update activity. New
 * agents that appear while the hub is open are appended at the end.
 */
import { afterEach, beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
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

function makeHub(agents: AgentRegistry) {
	return new AgentHubOverlayComponent({
		observers: new SessionObserverRegistry(),
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

	it("freezes the initial lastActivity order while the hub is open", () => {
		vi.useFakeTimers();
		let hub: AgentHubOverlayComponent | undefined;
		try {
			geometry = stubStdoutGeometry(120);
			const agents = new AgentRegistry();
			setSystemTime(1000);
			const sessionA = {} as AgentSession;
			agents.register({ id: "A", displayName: "Alpha", kind: "sub", session: sessionA });

			setSystemTime(2000);
			const sessionB = {} as AgentSession;
			agents.register({ id: "B", displayName: "Beta", kind: "sub", session: sessionB });

			setSystemTime(3000);
			const sessionC = {} as AgentSession;
			agents.register({ id: "C", displayName: "Gamma", kind: "sub", session: sessionC });

			hub = makeHub(agents);
			expect(renderedAgentLabels(hub, ["Alpha", "Beta", "Gamma", "Delta"])).toEqual(["Gamma", "Beta", "Alpha"]);

			// Bump A's lastActivity far ahead of the others. The hub is already open,
			// so the captured order must not change.
			setSystemTime(4000);
			agents.setActivity("A", "still running");

			// Registering a new agent schedules a coalesced row refresh; the
			// existing rows must stay put once the scheduled refresh runs.
			setSystemTime(5000);
			const sessionD = {} as AgentSession;
			agents.register({ id: "D", displayName: "Delta", kind: "sub", session: sessionD });

			expect(renderedAgentLabels(hub, ["Alpha", "Beta", "Gamma", "Delta"])).toEqual(["Gamma", "Beta", "Alpha"]);
			vi.advanceTimersByTime(100);
			expect(renderedAgentLabels(hub, ["Alpha", "Beta", "Gamma", "Delta"])).toEqual([
				"Gamma",
				"Beta",
				"Alpha",
				"Delta",
			]);
		} finally {
			hub?.dispose();
			vi.useRealTimers();
			setSystemTime();
		}
	});

	it("strips untrusted terminal controls and bounds hub rows", () => {
		geometry = stubStdoutGeometry(80);
		const agents = new AgentRegistry();
		const sessionA = {} as AgentSession;
		agents.register({
			id: "RevAgentStream",
			displayName: "Agent runtime + compaction reviewer",
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
				description: "CONTROL_MARKER\x1b[2J\treview terminal safety\n- check wrapping\r- check leaks",
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

	it("switches summary status labels to zh-CN at runtime without localizing user-facing agent labels", () => {
		geometry = stubStdoutGeometry(120);
		setSettingsUiLocale("en");
		const agents = new AgentRegistry();
		for (const [id, displayName, status] of [
			["job-17", "Alpha", "running"],
			["job-18", "Beta", "idle"],
			["job-19", "Gamma", "parked"],
			["job-20", "Delta", "aborted"],
		] as const) {
			agents.register({ id, displayName, kind: "sub", session: {} as AgentSession, status });
		}

		const hub = makeHub(agents);
		try {
			const english = Bun.stripANSI(hub.render(120).join("\n"));
			expect(english).toContain("running");
			expect(english).toContain("idle");
			expect(english).toContain("parked");
			expect(english).toContain("aborted");
			expect(english).not.toContain("运行中");
			expect(english).not.toContain("空闲");
			expect(english).not.toContain("已停放");
			expect(english).not.toContain("已中止");

			setSettingsUiLocale("zh-CN");
			const chinese = Bun.stripANSI(hub.render(120).join("\n"));
			expect(chinese).toContain("运行中");
			expect(chinese).toContain("空闲");
			expect(chinese).toContain("已停放");
			expect(chinese).toContain("已中止");
			expect(chinese).not.toContain("running");
			expect(chinese).not.toContain("idle");
			expect(chinese).not.toContain("parked");
			expect(chinese).not.toContain("aborted");

			for (const label of ["Alpha", "Beta", "Gamma", "Delta"]) {
				expect(english).toContain(label);
				expect(chinese).toContain(label);
			}
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
				expect(rendered).toContain("running");
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

	it("keeps fixed wide columns and an independent narrow model row within the viewport", () => {
		vi.useFakeTimers();
		setSettingsUiLocale("en");
		geometry = stubStdoutGeometry(160);
		const agents = new AgentRegistry();
		setSystemTime(1_000);
		agents.register({
			id: "Main",
			displayName: "Primary workspace",
			kind: "main",
			session: {} as AgentSession,
			status: "idle",
		});
		const session = { model: { id: "test/model" } } as unknown as AgentSession;
		agents.register({
			id: "Telemetry Worker",
			displayName: "Telemetry Worker",
			kind: "sub",
			parentId: "Main",
			session,
			status: "running",
		});
		setSystemTime(61_000);
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: "Telemetry Worker",
				kind: "subagent",
				label: "Subagent",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					activity: {
						phase: "streaming",
						label: "Streaming response",
						detail: "Reading render contract",
						phaseStartedAtMs: 60_000,
						lastActivityAtMs: 60_000,
					},
					tokensPerSecond: 12.3,
					tokensPerSecondLive: true,
					contextTokens: 4_000,
					contextWindow: 8_000,
					toolCount: 2,
					tokens: 1_234,
					cost: 0.25,
					durationMs: 5_000,
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
			const wideLines = hub.render(160).map(Bun.stripANSI);
			const wideRendered = wideLines.join("\n");
			const columnHeader = wideLines.find(
				line => line.includes("Status") && line.includes("Duration") && line.includes("Model"),
			);
			const workerRow = wideLines.find(line => line.includes("Telemetry Worker"));
			const summaryRow = wideLines.find(line => line.includes("Dynamic summary"));

			expect(columnHeader).toBeDefined();
			expect(workerRow).toBeDefined();
			expect(summaryRow).toContain("Reading render contract");
			expect(workerRow!.indexOf("running")).toBe(columnHeader!.indexOf("Status"));
			expect(workerRow!.indexOf("[")).toBe(columnHeader!.indexOf("Progress"));
			expect(workerRow!.indexOf("00:00:05")).toBe(columnHeader!.indexOf("Duration"));
			expect(workerRow!.indexOf("test/model")).toBe(columnHeader!.indexOf("Model"));
			expect(wideRendered).not.toContain("Primary workspace");
			expect(wideRendered).not.toContain("Main:");
			expect(wideRendered).not.toContain("Subagents");

			const columnIndex = wideLines.indexOf(columnHeader!);
			const topHints = wideLines
				.slice(0, columnIndex)
				.filter(
					line =>
						line.includes("j/k select") ||
						line.includes("f focus") ||
						line.includes("m message") ||
						line.includes("x kill"),
				)
				.join("\n");
			expect(topHints).toContain("j/k select");
			expect(topHints).toContain("Enter open transcript");
			expect(topHints).toContain("f focus");
			expect(topHints).toContain("m message");
			expect(topHints).toContain("x kill");
			expect(topHints).toContain("Esc/←← close");
			expect(topHints).not.toContain("r revive");

			for (const width of [60, 80]) {
				geometry?.restore();
				geometry = stubStdoutGeometry(width);
				const narrowLines = hub.render(width).map(Bun.stripANSI);
				const narrowRendered = narrowLines.join("\n");
				for (const line of narrowLines) expect(visibleWidth(line)).toBeLessThanOrEqual(width - 2);
				const workerIndex = narrowLines.findIndex(line => line.includes("Telemetry Worker"));
				const modelIndex = narrowLines.findIndex(line => line.includes("Model") && line.includes("test/model"));
				expect(workerIndex).toBeGreaterThanOrEqual(0);
				expect(modelIndex).toBeGreaterThan(workerIndex);
				expect(narrowRendered).toContain("running");
				expect(narrowRendered).not.toContain("Primary workspace");
				expect(narrowRendered).not.toContain("Main:");
				expect(narrowRendered).not.toContain("Subagents");
			}
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
