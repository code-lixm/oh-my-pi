import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CodexResetFireworksEvent } from "@oh-my-pi/pi-coding-agent/modes/components/codex-reset-fireworks";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const USAGE_REFRESH_INTERVAL_MS = 2 * 60_000;

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

interface CodexUsageState {
	sevenDayPercent: number;
	sevenDayResetAt: number;
	savedResets?: number;
	omitFetchedAt?: boolean;
	tier?: string;
	plan?: string;
}

function codexUsageReport(
	state: CodexUsageState,
	accountId = "account-1",
	email = "codex@example.com",
	orgId?: string,
): unknown[] {
	return [
		{
			provider: "openai-codex",
			...(state.omitFetchedAt ? {} : { fetchedAt: Date.now() }),
			metadata: {
				accountId,
				email,
				...(orgId ? { orgId } : {}),
				...(state.plan ? { planType: state.plan } : {}),
			},
			...(state.savedResets === undefined ? {} : { resetCredits: { availableCount: state.savedResets } }),
			limits: [
				{
					id: "openai-codex:secondary",
					label: "Codex 7 Day",
					scope: {
						provider: "openai-codex",
						accountId,
						windowId: "7d",
						...(state.tier ? { tier: state.tier } : {}),
					},
					window: {
						id: "7d",
						label: "7d",
						resetsAt: state.sevenDayResetAt,
					},
					amount: { unit: "percent", usedFraction: state.sevenDayPercent / 100 },
				},
			],
		},
	];
}

function makeCodexSession(
	fetchUsageReports: (signal?: AbortSignal) => Promise<unknown>,
	resolveActiveIdentity: () => { accountId: string; email?: string; orgId?: string } = () => ({
		accountId: "account-1",
		email: "codex@example.com",
	}),
): AgentSession {
	const session = makeSession(fetchUsageReports) as unknown as Record<string, unknown>;
	session.sessionId = "session-1";
	session.state = {
		messages: [],
		model: { contextWindow: 200_000, provider: "openai-codex" },
	};
	session.model = { contextWindow: 200_000, provider: "openai-codex" };
	session.modelRegistry = {
		authStorage: {
			getOAuthAccountIdentity: resolveActiveIdentity,
			getGeneration: () => 0,
		},
	};
	return session as unknown as AgentSession;
}

async function refreshUsage(component: StatusLineComponent, advanceMs = 0): Promise<void> {
	if (advanceMs > 0) vi.advanceTimersByTime(advanceMs);
	component.refreshUsageInBackground();
	vi.advanceTimersByTime(0);
	await flushMicrotasks();
}
function plain(text: string): string {
	return stripVTControlCharacters(text);
}
function installUsageStatusLine(component: StatusLineComponent): void {
	component.updateSettings({
		preset: "custom",
		leftSegments: ["usage"],
		rightSegments: [],
		separator: "powerline-thin",
	});
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

	it("passes and aborts the startup timeout signal for the background usage fetch", async () => {
		let signal: AbortSignal | undefined;
		const component = new StatusLineComponent(
			makeSession(nextSignal => {
				signal = nextSignal;
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

		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal?.aborted).toBe(false);

		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();

		expect(signal?.aborted).toBe(true);
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
		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();

		// The timeout records a fresh fetch attempt, so no zero-delay retry is scheduled.
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
		vi.advanceTimersByTime(2_000);
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

	it("uses configured providers in the usage cache context and renders their reports", async () => {
		let calls = 0;
		const base = makeSession(async () => {
			calls++;
			return [...modelScopedUsageReport(), ...usageReport(64)];
		}) as unknown as Record<string, unknown>;
		base.state = {
			messages: [],
			model: { contextWindow: 200_000, provider: "anthropic" },
		};
		base.model = { contextWindow: 200_000, provider: "anthropic" };
		const component = new StatusLineComponent(base as unknown as AgentSession);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
			segmentOptions: {
				usage: { providers: ["openai-proxy", "anthropic"], maxItems: 4 },
			},
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		const configuredRender = plain(component.getTopBorder(240).content);
		expect(configuredRender).toContain("openai-proxy/gpt-5.6-sol:5h 21%");
		expect(configuredRender).toContain("anthropic/org:5h 64%");

		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
			segmentOptions: {
				usage: { providers: ["anthropic"], maxItems: 4 },
			},
		});
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(2);

		const narrowedRender = plain(component.getTopBorder(240).content);
		expect(narrowedRender).toContain("anthropic/org:5h 64%");
		expect(narrowedRender).not.toContain("openai-proxy");
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
		vi.advanceTimersByTime(2_000);
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

	it("does not apply a late report after the component switches sessions", async () => {
		const late = Promise.withResolvers<unknown>();
		let renderCount = 0;
		const component = new StatusLineComponent(
			makeSession(() => late.promise),
			() => renderCount++,
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

		component.setSession(makeSession(async () => usageReport(60)));
		late.resolve(usageReport(20));
		await flushMicrotasks();

		expect(renderCount).toBe(0);
		expect(plain(component.getTopBorder(80).content)).not.toContain("5h 20%");

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(renderCount).toBe(1);
		expect(plain(component.getTopBorder(80).content)).toContain("5h 60%");
		component.dispose();
	});

	it("does not apply a late report after disposal", async () => {
		const late = Promise.withResolvers<unknown>();
		let renderCount = 0;
		const component = new StatusLineComponent(
			makeSession(() => late.promise),
			() => renderCount++,
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
		component.dispose();

		late.resolve(usageReport(42));
		await flushMicrotasks();

		expect(renderCount).toBe(0);
		expect(plain(component.getTopBorder(80).content)).not.toContain("5h 42%");
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
		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();

		const rendered = component.getTopBorder(80);
		// Empty reports → usage segment returns { visible: false } → no content
		expect(rendered.content).toBe("");

		component.dispose();
	});
	it("arms idle refresh after the first fetch; completion schedules the next fetch at 2 minutes", async () => {
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

		// First refresh fires the 0ms start timer; fetch completion schedules the 2-min idle refresh.
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		// Resolve first fetch; completion schedules the next one from usageFetchedAt.
		first.resolve(usageReport(10));
		await flushMicrotasks();
		await flushMicrotasks();
		await flushMicrotasks();

		// Advance exactly 2 min from fetch completion; the one-shot timer fires the refresh.
		vi.advanceTimersByTime(USAGE_REFRESH_INTERVAL_MS);
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		// Confirm the scheduled refresh fired.
		expect(calls).toBe(2);

		// Dispose the next one-shot timer so the test runner queue can exit.
		component.dispose();
	});

	it("does not defer the 2-minute idle refresh during repeated redraws and refresh requests", async () => {
		let calls = 0;
		const component = new StatusLineComponent(
			makeSession(async () => {
				calls++;
				return usageReport(10);
			}),
		);
		installUsageStatusLine(component);

		await refreshUsage(component);
		await flushMicrotasks();
		expect(calls).toBe(1);

		for (const advanceMs of [30_000, 30_000, 30_000]) {
			vi.advanceTimersByTime(advanceMs);
			component.getTopBorder(80);
			component.refreshUsageInBackground();
			vi.advanceTimersByTime(0);
			await flushMicrotasks();
			expect(calls).toBe(1);
		}

		vi.advanceTimersByTime(30_000);
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(calls).toBe(2);
		component.dispose();
	});

	it("dispose clears the idle refresh timer; advancing 2 min after dispose must not fetch", async () => {
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

		// Advancing 2 min must NOT trigger any additional fetch.
		vi.advanceTimersByTime(USAGE_REFRESH_INTERVAL_MS);
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

		vi.advanceTimersByTime(USAGE_REFRESH_INTERVAL_MS);
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

		vi.advanceTimersByTime(USAGE_REFRESH_INTERVAL_MS);
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(calls).toBe(2);
		component.dispose();
	});

	it("keeps reset fireworks opt-in while advancing the disabled baseline", async () => {
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 0,
		};
		const component = new StatusLineComponent(makeCodexSession(async () => codexUsageReport(state)));
		installUsageStatusLine(component);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		Settings.instance.set("tui.codexResetFireworks", false);
		await refreshUsage(component);
		state = {
			sevenDayPercent: 0,
			sevenDayResetAt,
			savedResets: 0,
		};
		await refreshUsage(component, USAGE_REFRESH_INTERVAL_MS);
		expect(events).toEqual([]);
		component.dispose();
	});

	it("emits distinct enabled events for an unscheduled weekly reset and a newly banked reset", async () => {
		Settings.instance.set("tui.codexResetFireworks", true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 0,
		};
		const component = new StatusLineComponent(makeCodexSession(async () => codexUsageReport(state)));
		installUsageStatusLine(component);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		expect(events).toEqual([]);
		state = {
			sevenDayPercent: 2,
			sevenDayResetAt,
			savedResets: 0,
		};
		await refreshUsage(component, USAGE_REFRESH_INTERVAL_MS);
		state = {
			sevenDayPercent: 25,
			sevenDayResetAt,
			savedResets: 0,
		};
		await refreshUsage(component, USAGE_REFRESH_INTERVAL_MS);
		state = {
			sevenDayPercent: 25.2,
			sevenDayResetAt,
			savedResets: 1,
		};
		await refreshUsage(component, USAGE_REFRESH_INTERVAL_MS);

		expect(events).toEqual([
			{ kind: "unscheduled-weekly-reset" },
			{ kind: "saved-reset-banked", added: 1, available: 1 },
		]);
		component.dispose();
	});

	it("compares weekly reset drops only within the same Codex quota tier", async () => {
		Settings.instance.set("tui.codexResetFireworks", true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 0,
			tier: "spark",
			plan: "pro",
		};
		const component = new StatusLineComponent(makeCodexSession(async () => codexUsageReport(state)));
		installUsageStatusLine(component);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		state = { ...state, sevenDayPercent: 2, tier: undefined };
		await refreshUsage(component, USAGE_REFRESH_INTERVAL_MS);
		expect(events).toEqual([]);

		state = { ...state, sevenDayPercent: 42, tier: "spark" };
		await refreshUsage(component, USAGE_REFRESH_INTERVAL_MS);
		state = { ...state, sevenDayPercent: 2 };
		await refreshUsage(component, USAGE_REFRESH_INTERVAL_MS);
		expect(events).toEqual([{ kind: "unscheduled-weekly-reset" }]);
		component.dispose();
	});

	it("binds each reset snapshot to the account identity used to normalize it", async () => {
		Settings.instance.set("tui.codexResetFireworks", true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		const reports = [
			...codexUsageReport(
				{
					sevenDayPercent: 18,
					sevenDayResetAt,
					savedResets: 0,
				},
				"account-a",
			),
			...codexUsageReport(
				{
					sevenDayPercent: 22,
					sevenDayResetAt,
					savedResets: 1,
				},
				"account-b",
			),
		];
		const identityLookups: string[] = [];
		const component = new StatusLineComponent(
			makeCodexSession(
				async () => reports,
				() => ({ accountId: identityLookups.shift() ?? "account-a" }),
			),
		);
		installUsageStatusLine(component);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		// The refresh starts under A, but B is active when its report is normalized.
		// A later identity lookup must not attribute B's saved reset to A.
		identityLookups.push("account-a", "account-b", "account-a");
		await refreshUsage(component, USAGE_REFRESH_INTERVAL_MS);

		expect(events).toEqual([]);
		component.dispose();
	});

	it("does not attribute a workspace sibling's saved resets to the active credential", async () => {
		Settings.instance.set("tui.codexResetFireworks", true);
		const workspaceId = "workspace-1";
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let bobSavedResets = 0;
		const component = new StatusLineComponent(
			makeCodexSession(
				async () => [
					...codexUsageReport(
						{ sevenDayPercent: 18, sevenDayResetAt, savedResets: 0 },
						workspaceId,
						"alice@example.com",
						workspaceId,
					),
					...codexUsageReport(
						{ sevenDayPercent: 22, sevenDayResetAt, savedResets: bobSavedResets },
						workspaceId,
						"bob@example.com",
						workspaceId,
					),
				],
				() => ({
					accountId: workspaceId,
					email: "alice@example.com",
					orgId: workspaceId,
				}),
			),
		);
		installUsageStatusLine(component);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		bobSavedResets = 1;
		await refreshUsage(component, USAGE_REFRESH_INTERVAL_MS);

		expect(events).toEqual([]);
		component.dispose();
	});

	it("keeps an unavailable saved-reset count unknown across refreshes", async () => {
		Settings.instance.set("tui.codexResetFireworks", true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 18,
			sevenDayResetAt,
			savedResets: 1,
		};
		const component = new StatusLineComponent(makeCodexSession(async () => codexUsageReport(state)));
		installUsageStatusLine(component);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		state = {
			sevenDayPercent: 18.1,
			sevenDayResetAt,
		};
		await refreshUsage(component, USAGE_REFRESH_INTERVAL_MS);
		state = { ...state, savedResets: 1 };
		await refreshUsage(component, USAGE_REFRESH_INTERVAL_MS);

		expect(events).toEqual([]);
		component.dispose();
	});

	it("suppresses an early weekly drop when a prior saved-reset balance becomes unavailable", async () => {
		Settings.instance.set("tui.codexResetFireworks", true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 1,
		};
		const component = new StatusLineComponent(makeCodexSession(async () => codexUsageReport(state)));
		installUsageStatusLine(component);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		state = {
			sevenDayPercent: 0,
			sevenDayResetAt,
		};
		await refreshUsage(component, USAGE_REFRESH_INTERVAL_MS);

		expect(events).toEqual([]);
		component.dispose();
	});

	it("does not infer an observation time when the provider omits fetchedAt", async () => {
		Settings.instance.set("tui.codexResetFireworks", true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 0,
		};
		const component = new StatusLineComponent(makeCodexSession(async () => codexUsageReport(state)));
		installUsageStatusLine(component);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		state = {
			sevenDayPercent: 0,
			sevenDayResetAt,
			savedResets: 0,
			omitFetchedAt: true,
		};
		await refreshUsage(component, USAGE_REFRESH_INTERVAL_MS);

		expect(events).toEqual([]);
		component.dispose();
	});

	it("discards a timed-out report after a newer refresh applies", async () => {
		Settings.instance.set("tui.codexResetFireworks", true);
		const stale = Promise.withResolvers<unknown>();
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		const current: CodexUsageState = {
			sevenDayPercent: 0,
			sevenDayResetAt,
			savedResets: 0,
		};
		let calls = 0;
		const component = new StatusLineComponent(
			makeCodexSession(async () => {
				calls++;
				return calls === 1 ? stale.promise : codexUsageReport(current);
			}),
		);
		installUsageStatusLine(component);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();
		await refreshUsage(component, USAGE_REFRESH_INTERVAL_MS);
		expect(calls).toBe(2);

		stale.resolve(
			codexUsageReport({
				sevenDayPercent: 42,
				sevenDayResetAt,
				savedResets: 1,
			}),
		);
		await flushMicrotasks();
		await refreshUsage(component, USAGE_REFRESH_INTERVAL_MS);

		expect(calls).toBe(3);
		expect(events).toEqual([]);
		component.dispose();
	});
});
