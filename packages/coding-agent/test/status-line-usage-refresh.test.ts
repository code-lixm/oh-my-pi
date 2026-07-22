import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function makeSession(fetchUsageReports: (signal?: AbortSignal) => Promise<unknown>): AgentSession {
	const messages: unknown[] = [];
	return {
		fetchUsageReports,
		messages,
		state: { messages, model: { contextWindow: 200_000 } },
		model: { contextWindow: 200_000 },
		isStreaming: false,
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
			getSessionName: () => "test",
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		getContextUsage: () => undefined,
		contextUsageRevision: 0,
	} as unknown as AgentSession;
}

function usageReport(percent: number): unknown[] {
	return [
		{
			provider: "anthropic",
			fetchedAt: Date.now(),
			metadata: { orgId: "org" },
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h" },
					window: { id: "5h", label: "5h", durationMs: 5 * 3_600_000, resetsAt: Date.now() + 60_000 },
					amount: { unit: "percent", usedFraction: percent / 100 },
				},
			],
		},
	];
}

function modelScopedUsageReport(): unknown[] {
	return [
		{
			provider: "openai-proxy",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "openai-proxy:sol:5h",
					label: "5h",
					scope: { provider: "openai-proxy", modelId: "gpt-5.6-sol", windowId: "5h" },
					window: { id: "5h", label: "5h", durationMs: 5 * 3_600_000, resetsAt: Date.now() + 60_000 },
					amount: { unit: "percent", usedFraction: 0.21 },
				},
				{
					id: "openai-proxy:luna:5h",
					label: "5h",
					scope: { provider: "openai-proxy", modelId: "gpt-5.6-luna", windowId: "5h" },
					window: { id: "5h", label: "5h", durationMs: 5 * 3_600_000, resetsAt: Date.now() + 60_000 },
					amount: { unit: "percent", usedFraction: 0.73 },
				},
				{
					id: "openai-proxy:shared:monthly",
					label: "Monthly",
					scope: { provider: "openai-proxy", windowId: "monthly" },
					window: { id: "monthly", label: "Monthly", durationMs: 30 * 86_400_000, resetsAt: Date.now() + 60_000 },
					amount: { unit: "percent", usedFraction: 0.12 },
				},
			],
		},
	];
}

function plain(text: string): string {
	return stripVTControlCharacters(text);
}

describe("StatusLineComponent usage refresh", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		resetSettingsForTest();
	});

	it("does not invoke usage fetching synchronously on the render path", async () => {
		let calls = 0;
		const component = new StatusLineComponent(
			makeSession(async () => {
				calls++;
				return [];
			}),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		expect(calls).toBe(0);

		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(calls).toBe(1);
		component.dispose();
	});

	it("backs off after the startup timeout when usage fetching hangs", async () => {
		let calls = 0;
		const component = new StatusLineComponent(
			makeSession(() => {
				calls++;
				return Promise.withResolvers<unknown>().promise;
			}),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		// #usageInFlight is true → early return, no new timer
		component.refreshUsageInBackground();
		expect(calls).toBe(1);

		// After the startup timeout, the fetch signal aborts, #runUsageRefresh catches and clears #usageInFlight
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();

		// TTL expired, new timer scheduled, advanceTimersByTime(0) fires the 0ms start timer
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(calls).toBe(1); // fetch still hangs → still only 1 call

		component.dispose();
	});

	it("applies late usage reports that resolve after the startup timeout", async () => {
		const late = Promise.withResolvers<unknown>();
		const component = new StatusLineComponent(makeSession(() => late.promise));
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();

		expect(plain(component.getTopBorder(80).content)).not.toContain("5h");

		late.resolve(usageReport(42));
		await flushMicrotasks();

		expect(plain(component.getTopBorder(80).content)).toContain("5h 42%");

		component.dispose();
	});

	it("re-fetches usage immediately when the session rotates to another org under the same email", async () => {
		let calls = 0;
		let orgId = "org-team";
		const base = makeSession(async () => {
			calls++;
			return usageReport(10);
		}) as unknown as Record<string, unknown>;
		base.state = {
			messages: [],
			model: { contextWindow: 200_000, provider: "anthropic" },
		};
		base.modelRegistry = {
			authStorage: {
				getOAuthAccountIdentity: () => ({
					email: "shared@example.com",
					accountId: "account-shared",
					orgId,
				}),
				getGeneration: () => 1,
				usageRevision: 0,
			},
		};
		const component = new StatusLineComponent(base as unknown as AgentSession);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		orgId = "org-max";
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(2);

		component.dispose();
	});

	it("re-fetches usage immediately when the active model changes within the same provider", async () => {
		let calls = 0;
		const base = makeSession(async () => {
			calls++;
			return modelScopedUsageReport();
		}) as unknown as Record<string, unknown>;
		const stateModel = { contextWindow: 200_000, provider: "openai-proxy", id: "gpt-5.6-sol" };
		const sessionModel = { contextWindow: 200_000, provider: "openai-proxy", id: "gpt-5.6-sol" };
		base.state = { messages: [], model: stateModel };
		base.model = sessionModel;
		const component = new StatusLineComponent(base as unknown as AgentSession);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		const firstRender = plain(component.getTopBorder(120).content);
		expect(firstRender).toContain("openai-proxy/gpt-5.6-sol:5h 21%");
		expect(firstRender).toContain("openai-proxy:30d 12%");
		expect(firstRender).not.toContain("gpt-5.6-luna");
		expect(firstRender).not.toContain("73%");

		stateModel.id = "gpt-5.6-luna";
		sessionModel.id = "gpt-5.6-luna";
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(2);

		const secondRender = plain(component.getTopBorder(120).content);
		expect(secondRender).toContain("openai-proxy/gpt-5.6-luna:5h 73%");
		expect(secondRender).toContain("openai-proxy:30d 12%");
		expect(secondRender).not.toContain("gpt-5.6-sol");
		expect(secondRender).not.toContain("21%");

		component.dispose();
	});

	it("ignores stale reports and immediately refetches when authGeneration changes mid-flight", async () => {
		let calls = 0;
		let renderCount = 0;
		let authGen = 1;
		const first = Promise.withResolvers<unknown>();
		const second = Promise.withResolvers<unknown>();
		const base = makeSession(async () => {
			calls++;
			return calls === 1 ? await first.promise : await second.promise;
		}) as unknown as Record<string, unknown>;
		base.state = { messages: [], model: { contextWindow: 200_000, provider: "anthropic" } };
		base.modelRegistry = {
			authStorage: {
				getOAuthAccountIdentity: () => ({ orgId: "org" }),
				getGeneration: () => authGen,
				usageRevision: 0,
			},
		};
		const component = new StatusLineComponent(base as unknown as AgentSession, () => renderCount++);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		authGen = 2;
		component.refreshUsageInBackground();
		expect(calls).toBe(1);

		first.resolve(usageReport(10));
		await flushMicrotasks();
		await flushMicrotasks();

		expect(renderCount).toBe(0);
		expect(plain(component.getTopBorder(80).content)).not.toContain("5h 10%");

		// Second fetch auto-fires via the deferred timer created in the first #runUsageRefresh finally block.
		// First advance fires the original start timer; second advance fires the new timer from the finally block.
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(2);

		second.resolve(usageReport(70));
		await flushMicrotasks();
		await flushMicrotasks();

		expect(renderCount).toBe(1);
		const rendered = plain(component.getTopBorder(80).content);
		expect(rendered).toContain("5h 70%");
		expect(rendered).not.toContain("5h 10%");

		component.dispose();
	});

	it("ignores stale late reports after the startup timeout when usageRevision changes", async () => {
		let calls = 0;
		let renderCount = 0;
		let usageRev = 0;
		const first = Promise.withResolvers<unknown>();
		const second = Promise.withResolvers<unknown>();
		const base = makeSession(async () => {
			calls++;
			return calls === 1 ? await first.promise : await second.promise;
		}) as unknown as Record<string, unknown>;
		base.state = { messages: [], model: { contextWindow: 200_000, provider: "anthropic" } };
		base.modelRegistry = {
			authStorage: {
				getOAuthAccountIdentity: () => ({ orgId: "org" }),
				getGeneration: () => 1,
				get usageRevision() {
					return usageRev;
				},
			},
		};
		const component = new StatusLineComponent(base as unknown as AgentSession, () => renderCount++);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		// Startup timeout fires; signal aborts the first fetch; #observeLateUsageRefresh queues it.
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();

		usageRev = 1;
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(2);

		// Stale first (late) report resolves — must NOT update cache/render.
		first.resolve(usageReport(20));
		await flushMicrotasks();

		expect(renderCount).toBe(0);
		expect(plain(component.getTopBorder(80).content)).not.toContain("5h 20%");

		// Current second report resolves — must update cache and fire requestRender.
		second.resolve(usageReport(60));
		await flushMicrotasks();
		await flushMicrotasks();

		expect(renderCount).toBe(1);
		const rendered = plain(component.getTopBorder(80).content);
		expect(rendered).toContain("5h 60%");

		component.dispose();
	});

	it("renders no content when usage reports are empty (no-usage skip)", async () => {
		const component = new StatusLineComponent(makeSession(async () => []));
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();

		const rendered = component.getTopBorder(80);
		// Empty reports → usage segment returns { visible: false } → no content
		expect(rendered.content).toBe("");

		component.dispose();
	});
	it("arms idle refresh after the first fetch; completion schedules the next fetch at 5 minutes", async () => {
		let calls = 0;
		const first = Promise.withResolvers<unknown>();
		const component = new StatusLineComponent(
			makeSession(async () => {
				calls++;
				return first.promise;
			}),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		// First refresh fires the 0ms start timer; fetch completion schedules the 5-min idle refresh.
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		// Resolve first fetch; completion schedules the next one from usageFetchedAt.
		first.resolve(usageReport(10));
		await flushMicrotasks();
		await flushMicrotasks();
		await flushMicrotasks();

		// Advance exactly 5 min from fetch completion; the one-shot timer fires the refresh.
		vi.advanceTimersByTime(5 * 60_000);
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		// Confirm the scheduled refresh fired.
		expect(calls).toBe(2);

		// Dispose the next one-shot timer so the test runner queue can exit.
		component.dispose();
	});

	it("dispose clears the idle refresh timer; advancing 5 min after dispose must not fetch", async () => {
		let calls = 0;
		const first = Promise.withResolvers<unknown>();
		const component = new StatusLineComponent(
			makeSession(async () => {
				calls++;
				return first.promise;
			}),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		// Resolve first fetch before disposing so the next idle refresh is scheduled.
		first.resolve(usageReport(10));
		await flushMicrotasks();

		component.dispose();

		// Advancing 5 min must NOT trigger any additional fetch.
		vi.advanceTimersByTime(5 * 60_000);
		await flushMicrotasks();

		expect(calls).toBe(1);
	});

	it("removing usage from both segments via updateSettings clears the idle refresh timer", async () => {
		let calls = 0;
		const first = Promise.withResolvers<unknown>();
		const component = new StatusLineComponent(
			makeSession(async () => {
				calls++;
				return first.promise;
			}),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		// Resolve first fetch so the next idle refresh is scheduled.
		first.resolve(usageReport(10));
		await flushMicrotasks();

		// Remove usage from both sides — the idle refresh timer must be cleared.
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: [],
			separator: "powerline-thin",
		});

		vi.advanceTimersByTime(5 * 60_000);
		await flushMicrotasks();

		expect(calls).toBe(1);
	});

	it("re-arms the idle refresh timer when usage is re-enabled while cached data is still fresh", async () => {
		let calls = 0;
		const component = new StatusLineComponent(
			makeSession(async () => {
				calls++;
				return usageReport(10);
			}),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		await flushMicrotasks();
		expect(calls).toBe(1);

		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: [],
			separator: "powerline-thin",
		});
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		vi.advanceTimersByTime(5 * 60_000);
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(calls).toBe(2);
		component.dispose();
	});
});
