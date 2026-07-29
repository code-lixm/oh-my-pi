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

function renderedAgentLabels(hub: AgentHubOverlayComponent): string[] {
	// Entry first lines are ` <cursor> <status-glyph> <display label> …`; task
	// lines are indented deeper and chrome lines never carry the cursor slot.
	const labels: string[] = [];
	for (const raw of hub.render(120)) {
		const match = /^ (?:❯| ) (\S+) (\S+)/u.exec(Bun.stripANSI(raw));
		if (match) labels.push(match[2]!);
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
			expect(renderedAgentLabels(hub)).toEqual(["Gamma", "Beta", "Alpha"]);

			// Bump A's lastActivity far ahead of the others. The hub is already open,
			// so the captured order must not change.
			setSystemTime(4000);
			agents.setActivity("A", "still running");

			// Registering a new agent schedules a coalesced row refresh; the
			// existing rows must stay put once the scheduled refresh runs.
			setSystemTime(5000);
			const sessionD = {} as AgentSession;
			agents.register({ id: "D", displayName: "Delta", kind: "sub", session: sessionD });

			expect(renderedAgentLabels(hub)).toEqual(["Gamma", "Beta", "Alpha"]);
			vi.advanceTimersByTime(100);
			expect(renderedAgentLabels(hub)).toEqual(["Gamma", "Beta", "Alpha", "Delta"]);
		} finally {
			hub?.dispose();
			vi.useRealTimers();
			setSystemTime();
		}
	});

	it("truncates lines and sanitizes newlines to prevent terminal wrapping", () => {
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
				description: "Complete the assignment below, thoroughly:\n- check performance\n- check leaks",
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

		const lines = hub.render(80);
		for (const line of lines) {
			const cleanLine = Bun.stripANSI(line);
			expect(cleanLine.includes("\n")).toBe(false);
			expect(cleanLine.includes("\r")).toBe(false);
			const width = visibleWidth(line);
			expect(width).toBeLessThanOrEqual(78);
		}
		hub.dispose();
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
		agents.register({ id: "GuestAgent", displayName: "Guest Agent", kind: "sub", session: null });

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
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("fallback → openai/gpt-4o");
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

	it("groups subagents beneath their owning Main and omits an active-Main row", () => {
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
			const lines = hub.render(120).map(Bun.stripANSI);
			const rendered = lines.join("\n");
			expect(rendered).toContain("Agent Hub");
			expect(rendered).toContain("Main: Primary workspace");
			expect(rendered).toContain("Main: Review workspace");
			expect(rendered).toContain("Primary worker");
			expect(rendered).toContain("Review worker");
			const primaryGroup = lines.findIndex(line => line.includes("Main: Primary workspace"));
			const reviewGroup = lines.findIndex(line => line.includes("Main: Review workspace"));
			expect(primaryGroup).toBeLessThan(lines.findIndex(line => line.includes("Primary worker")));
			expect(reviewGroup).toBeLessThan(lines.findIndex(line => line.includes("Review worker")));
			// The active Main appears once in the header and once as the child-group label,
			// never as an independently selectable row.
			expect(lines.filter(line => line.includes("Primary workspace"))).toHaveLength(2);
		} finally {
			hub.dispose();
		}
	});

	it("renders every lifecycle state in one aligned status column", () => {
		setSettingsUiLocale("en");
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		agents.register({
			id: "Main",
			displayName: "Primary",
			kind: "main",
			session: {} as AgentSession,
			status: "idle",
		});
		const states = [
			["Runner", "running"],
			["Waiter", "waiting"],
			["Idler", "idle"],
			["Parker", "parked"],
			["Aborter", "aborted"],
		] as const;
		for (const [id, status] of states) {
			agents.register({ id, displayName: id, kind: "sub", parentId: "Main", session: {} as AgentSession, status });
		}
		const hub = makeHub(agents);

		try {
			const lines = hub.render(120).map(Bun.stripANSI);
			const statusEnds = states.map(([label, status]) => {
				const row = lines.find(line => line.includes(label));
				expect(row).toBeDefined();
				const statusAt = row!.indexOf(status);
				expect(statusAt).toBeGreaterThan(0);
				expect(row!.trimEnd()).toEndWith(status);
				expect(visibleWidth(row!)).toBeLessThanOrEqual(118);
				return visibleWidth(row!.slice(0, statusAt + status.length));
			});
			expect(new Set(statusEnds).size).toBe(1);
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
