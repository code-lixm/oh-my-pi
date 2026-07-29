/**
 * Agent Hub table actions are user-visible operations, not merely key bindings:
 * m opens a target-labelled composer and sends its body; p returns to the active
 * parent session; r restores a parked child; x removes a live child.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { getSettingsUiLocale, setSettingsUiLocale } from "../src/i18n/settings-locale";

const MAIN = "Main";
const WORKER = "Worker";

let previousLocale = getSettingsUiLocale();

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	previousLocale = getSettingsUiLocale();
	setSettingsUiLocale("en");
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	setSettingsUiLocale(previousLocale);
});

function fakeSession(
	options: { onDelivery?: (message: IrcMessage) => void; onDispose?: () => void } = {},
): AgentSession {
	return {
		subscribe: () => () => {},
		deliverIrcMessage: async (message: IrcMessage) => {
			options.onDelivery?.(message);
			return "injected" as const;
		},
		emitIrcRelayObservation: () => {},
		abort: async () => {},
		dispose: async () => {
			options.onDispose?.();
		},
	} as unknown as AgentSession;
}

function registerMain(registry: AgentRegistry): void {
	registry.register({ id: MAIN, displayName: MAIN, kind: "main", session: fakeSession(), status: "running" });
}

function registerWorker(
	registry: AgentRegistry,
	session: AgentSession | null,
	status: "running" | "idle" | "parked" = "running",
): void {
	registry.register({
		id: WORKER,
		displayName: WORKER,
		kind: "sub",
		parentId: MAIN,
		session,
		status,
	});
}

function createHub(
	registry: AgentRegistry,
	lifecycle: AgentLifecycleManager,
	irc: IrcBus,
	onDone = () => {},
): AgentHubOverlayComponent {
	return new AgentHubOverlayComponent({
		observers: new SessionObserverRegistry(),
		hubKeys: [],
		onDone,
		requestRender: () => {},
		registry,
		lifecycle,
		irc,
		activeTopLevelId: MAIN,
	});
}

function rendered(hub: AgentHubOverlayComponent): string {
	return Bun.stripANSI(hub.render(120).join("\n"));
}

function waitForStatus(registry: AgentRegistry, id: string, status: "idle"): Promise<void> {
	return new Promise(resolve => {
		const unsubscribe = registry.onChange(event => {
			if (event.type !== "status_changed" || event.ref.id !== id || event.ref.status !== status) return;
			unsubscribe();
			resolve();
		});
	});
}

function waitForRemoval(registry: AgentRegistry, id: string): Promise<void> {
	return new Promise(resolve => {
		const unsubscribe = registry.onChange(event => {
			if (event.type !== "removed" || event.ref.id !== id) return;
			unsubscribe();
			resolve();
		});
	});
}

describe("Agent Hub table actions", () => {
	it("m opens a target-labelled composer and sends its submitted message", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const irc = new IrcBus(registry, lifecycle);
		const delivered = Promise.withResolvers<IrcMessage>();
		registerMain(registry);
		registerWorker(registry, fakeSession({ onDelivery: delivered.resolve }));
		const hub = createHub(registry, lifecycle, irc);

		try {
			await hub.persistedSubagentsReady;
			hub.handleInput("m");
			expect(rendered(hub)).toContain("m → Worker:");

			for (const character of "please check the receipt") hub.handleInput(character);
			expect(rendered(hub)).toContain("please check the receipt");

			hub.handleInput("\r");
			await expect(delivered.promise).resolves.toMatchObject({
				from: MAIN,
				to: WORKER,
				body: "please check the receipt",
			});
			expect(rendered(hub)).not.toContain("m → Worker:");
		} finally {
			hub.dispose();
			await lifecycle.dispose();
		}
	});

	it("p immediately returns from a child to the active parent session", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const irc = new IrcBus(registry, lifecycle);
		const closed = Promise.withResolvers<void>();
		registerMain(registry);
		registerWorker(registry, fakeSession());
		const hub = createHub(registry, lifecycle, irc, closed.resolve);

		try {
			await hub.persistedSubagentsReady;
			hub.handleInput("p");
			await closed.promise;
		} finally {
			hub.dispose();
			await lifecycle.dispose();
		}
	});

	it("r restores a parked child into the visible idle roster", async () => {
		vi.useFakeTimers();
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const irc = new IrcBus(registry, lifecycle);
		registerMain(registry);
		registerWorker(registry, null, "parked");
		lifecycle.adopt(WORKER, { idleTtlMs: 0, revive: async () => fakeSession() });
		const hub = createHub(registry, lifecycle, irc);

		try {
			await hub.persistedSubagentsReady;
			const becameIdle = waitForStatus(registry, WORKER, "idle");
			hub.handleInput("r");
			await becameIdle;
			vi.advanceTimersByTime(100);

			expect(rendered(hub)).toContain("Worker");
			expect(rendered(hub)).toContain("idle");
		} finally {
			hub.dispose();
			await lifecycle.dispose();
		}
	});

	it("x removes a live child from the roster after its teardown completes", async () => {
		vi.useFakeTimers();
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const irc = new IrcBus(registry, lifecycle);
		registerMain(registry);
		registerWorker(registry, fakeSession(), "idle");
		lifecycle.adopt(WORKER, { idleTtlMs: 0 });
		const hub = createHub(registry, lifecycle, irc);

		try {
			await hub.persistedSubagentsReady;
			const removed = waitForRemoval(registry, WORKER);
			hub.handleInput("x");
			await removed;
			vi.advanceTimersByTime(100);

			expect(rendered(hub)).not.toContain("Worker");
		} finally {
			hub.dispose();
			await lifecycle.dispose();
		}
	});
});
