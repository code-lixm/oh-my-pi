/**
 * Tests for the new usage-cache contracts introduced after the broker
 * migration surfaced Anthropic per-IP rate limits:
 *
 *   1. Per-credential cache stores the last successful report; failures
 *      DON'T overwrite a stale-but-good entry with null.
 *   2. With a stale-but-good entry, a failure serves the previous value
 *      (cached for a short cool-down) instead of dropping the credential
 *      from the report.
 *   3. Without a previous value (a cold failure), a failure caches `null` for
 *      the failure backoff window — a repeat poll within the window is served
 *      from cache (no refetch); the entry expires and the next poll retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type {
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProviderConfig,
	UsageReport,
} from "@oh-my-pi/pi-ai/usage";
import * as claudeUsage from "@oh-my-pi/pi-ai/usage/claude";

function anthropicReports(reports: UsageReport[] | null): UsageReport[] {
	return (reports ?? []).filter(r => r.provider === "anthropic");
}

function requireAnthropicReport(reports: UsageReport[] | null): UsageReport {
	const report = anthropicReports(reports)[0];
	if (!report) throw new Error("expected anthropic usage report");
	return report;
}

function requireLimit(report: UsageReport, id: string): UsageLimit {
	const limit = report.limits.find(candidate => candidate.id === id);
	if (!limit) throw new Error(`expected ${id} limit`);
	return limit;
}

/**
 * Force every cache entry to look stale to AuthStorage WITHOUT dropping the
 * value. The cache layer is two-tier: the store-level `expiresAtSec` controls
 * whether `getCache` returns anything at all, and the JSON payload's own
 * `expiresAt` is what AuthStorage compares against `Date.now()` to decide if
 * the entry is fresh. Mutating only the inner expiresAt simulates time
 * passing while keeping the last-good value reachable for the failure path.
 */
function expireCachePayloads(store: ObservableStore): void {
	for (const [key, entry] of store.cache) {
		try {
			const parsed = JSON.parse(entry.value);
			parsed.expiresAt = 1; // positive but already in the past (epoch ms)
			store.cache.set(key, { value: JSON.stringify(parsed), expiresAtSec: entry.expiresAtSec });
		} catch {
			// Non-JSON entries — leave alone.
		}
	}
}

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

interface ObservableStore extends AuthCredentialStore {
	cache: Map<string, CacheEntry>;
}

/**
 * Minimal in-memory `AuthCredentialStore` exposing the cache so we can
 * assert what AuthStorage writes to it during usage fetches.
 */
function makeStore(rows: StoredAuthCredential[]): ObservableStore {
	const cache = new Map<string, CacheEntry>();
	return {
		cache,
		close() {},
		listAuthCredentials() {
			return rows;
		},
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		replaceAuthCredentialsForProvider() {
			return rows;
		},
		upsertAuthCredentialForProvider() {
			return rows;
		},
		deleteAuthCredentialsForProvider() {},
		getCache(key) {
			const entry = cache.get(key);
			if (!entry) return null;
			if (entry.expiresAtSec * 1000 <= Date.now()) return null;
			return entry.value;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

function oauthRow(id: number, email: string, provider = "anthropic"): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `oat-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${id}`,
		email,
	};
	return { id, provider, credential, disabledCause: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers for runtime UsageProvider registration tests.
// `registerUsageProvider` shallow-clones the config object via spread
// `{ ...config, id: name }`; for `fetchUsage` to be captured correctly,
// the report must be baked into the provider at construction time.
// ─────────────────────────────────────────────────────────────────────────────

function makeMinimalStore(): AuthCredentialStore {
	const cache = new Map<string, CacheEntry>();
	let nextId = 1;
	let rows: StoredAuthCredential[] = [];
	return {
		close() {},
		listAuthCredentials: () => rows,
		updateAuthCredential() {},
		deleteAuthCredential(id) {
			rows = rows.filter(row => row.id !== id);
		},
		tryDisableAuthCredentialIfMatches: () => false,
		replaceAuthCredentialsForProvider(provider, credentials) {
			const stored = credentials.map((credential, index) => ({
				id: nextId + index,
				provider,
				credential,
				disabledCause: null,
			}));
			nextId += stored.length;
			rows = [...rows.filter(row => row.provider !== provider), ...stored];
			return stored;
		},
		upsertAuthCredentialForProvider(provider, credential) {
			const stored = { id: nextId, provider, credential, disabledCause: null };
			nextId += 1;
			rows = [...rows.filter(row => row.provider !== provider), stored];
			return [stored];
		},
		deleteAuthCredentialsForProvider(provider) {
			rows = rows.filter(row => row.provider !== provider);
		},
		getCache(key) {
			const entry = cache.get(key);
			if (!entry) return null;
			if (entry.expiresAtSec * 1000 <= Date.now()) return null;
			return entry.value;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

/**
 * Fake UsageProvider. Report must be passed at construction time — not assigned
 * afterwards — because `registerUsageProvider` shallow-clones the config object
 * and only the method reference captured at construction survives the clone.
 */
function makeFakeProvider(id: string, report: unknown = null) {
	const capturedReport = report as UsageReport | null;
	const calls: Array<{ params: UsageFetchParams; ctx: UsageFetchContext }> = [];
	return {
		id,
		calls,
		provider: {
			id,
			async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext) {
				calls.push({ params, ctx });
				return capturedReport;
			},
		},
	};
}

function makeReport(account: string): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "anthropic:5h",
				label: "5 Hour",
				scope: { provider: "anthropic", windowId: "5h" },
				window: { id: "5h", label: "5 Hour" },
				amount: { used: 42, limit: 100, unit: "percent" },
				status: "ok",
			},
		],
		metadata: { email: account, accountId: `account-${account}` },
	};
}

function makeTieredReport(account: string): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now() - 10_000,
		limits: [
			{
				id: "anthropic:5h",
				label: "Claude 5 Hour",
				scope: { provider: "anthropic", windowId: "5h", shared: true },
				window: { id: "5h", label: "5 Hour" },
				amount: { used: 42, limit: 100, usedFraction: 0.42, unit: "percent" },
				status: "ok",
			},
			{
				id: "anthropic:7d",
				label: "Claude 7 Day",
				scope: { provider: "anthropic", windowId: "7d", shared: true },
				window: { id: "7d", label: "7 Day" },
				amount: { used: 84, limit: 100, usedFraction: 0.84, unit: "percent" },
				status: "ok",
			},
			{
				id: "anthropic:7d:opus",
				label: "Claude 7 Day (Opus)",
				scope: { provider: "anthropic", windowId: "7d", tier: "opus" },
				window: { id: "7d", label: "7 Day" },
				amount: { used: 12, limit: 100, usedFraction: 0.12, unit: "percent" },
				status: "ok",
			},
		],
		metadata: {
			email: account,
			accountId: `account-${account}`,
			endpoint: "https://api.anthropic.com/api/oauth/usage",
		},
	};
}

function usageHeaders(fiveHour: string, sevenDay: string, sevenDayModelScoped?: string): Record<string, string> {
	return {
		"anthropic-ratelimit-unified-5h-utilization": fiveHour,
		"anthropic-ratelimit-unified-5h-reset": "1780405800",
		"anthropic-ratelimit-unified-5h-status": "allowed",
		"anthropic-ratelimit-unified-7d-utilization": sevenDay,
		"anthropic-ratelimit-unified-7d-reset": "1780531200",
		"anthropic-ratelimit-unified-7d-status": "allowed",
		...(sevenDayModelScoped === undefined
			? {}
			: {
					"anthropic-ratelimit-unified-7d_oi-utilization": sevenDayModelScoped,
					"anthropic-ratelimit-unified-7d_oi-reset": "1780617600",
					"anthropic-ratelimit-unified-7d_oi-status": "allowed",
				}),
	};
}

describe("AuthStorage usage cache: last-good failure fallback", () => {
	let store: ObservableStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		store = makeStore([oauthRow(1, "a@example.com")]);
		// Restrict the resolver to anthropic. Without this, AuthStorage enumerates
		// every default provider and — for any provider whose `supports()` accepts
		// the matching `*_API_KEY` env var present on the test host — fans out a
		// real network fetch per poll. 3 polls × N real fetches blows past the 5s
		// test budget intermittently.
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
	});

	it("caches a successful report and replays it on a second poll", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return goldReport;
		});

		const first = anthropicReports(await storage.fetchUsageReports());
		expect(first).toHaveLength(1);
		expect(calls).toBe(1);

		const second = anthropicReports(await storage.fetchUsageReports());
		expect(second).toHaveLength(1);
		// Cache hit — provider was NOT called a second time.
		expect(calls).toBe(1);
	});

	it("caches null on a cold failure for the backoff window, then retries after it expires", async () => {
		let calls = 0;
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return null;
		});

		// First poll: cold fetch fails → caches null for the backoff window.
		const first = anthropicReports(await storage.fetchUsageReports());
		expect(first).toHaveLength(0);
		expect(calls).toBe(1);

		// Second poll within the window: served from the cold-null cache — no refetch.
		const second = anthropicReports(await storage.fetchUsageReports());
		expect(calls).toBe(1);
		expect(second).toHaveLength(0);

		// Expire the backoff entry → the next poll refetches (and fails again).
		expireCachePayloads(store);
		const third = anthropicReports(await storage.fetchUsageReports());
		expect(calls).toBe(2);
		expect(third).toHaveLength(0);
	});

	it("serves last-good value through a failure cycle", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			if (calls === 1) return goldReport;
			return null;
		});

		// First poll: real fetch → cached.
		const first = anthropicReports(await storage.fetchUsageReports());
		expect(first).toHaveLength(1);
		expect(calls).toBe(1);

		// Force every cached entry to expire so the next poll refetches.
		// Bun's `bun:test` doesn't ship setSystemTime, so we manipulate the
		// observable store cache directly — equivalent to advancing time past
		// the success TTL.
		expireCachePayloads(store);

		// Second poll: cache expired → refetch → provider returns null →
		// AuthStorage falls back to last-good and the report stays populated.
		const second = anthropicReports(await storage.fetchUsageReports());
		expect(calls).toBe(2);
		expect(second).toHaveLength(1);
		// The fallback value must be the SAME report (not a synthetic empty one).
		expect(second?.[0]?.limits[0]?.amount.used).toBe(42);
	});

	it("re-attempts the failing credential after the cool-down expires", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			// Succeed on attempt 1, fail on 2, succeed on 3.
			if (calls === 2) return null;
			return goldReport;
		});

		const first = anthropicReports(await storage.fetchUsageReports());
		expect(first).toHaveLength(1);
		expect(calls).toBe(1);

		// Expire success cache → poll 2 fetches and 429s → cool-down written.
		expireCachePayloads(store);
		const second = anthropicReports(await storage.fetchUsageReports());
		expect(second).toHaveLength(1); // last-good fallback
		expect(calls).toBe(2);

		// Expire the cool-down → poll 3 refetches → success.
		expireCachePayloads(store);
		const third = anthropicReports(await storage.fetchUsageReports());
		expect(third).toHaveLength(1);
		expect(calls).toBe(3);
	});
});

describe("AuthStorage usage cache: jitter", () => {
	it("writes per-credential cache TTLs with ±25% jitter so refreshes decorrelate", async () => {
		const store = makeStore([oauthRow(1, "a@example.com"), oauthRow(2, "b@example.com")]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
		try {
			const goldA = makeReport("a@example.com");
			const goldB = makeReport("b@example.com");
			vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
				return params.credential.email === "a@example.com" ? goldA : goldB;
			});

			await storage.fetchUsageReports();

			// The store-level TTL is bumped to the 24h durable-retention floor so
			// `getStale` can recover last-good values; the freshness TTL we actually
			// jitter lives in the JSON payload. Read that, not the store TTL.
			const freshExpiries: number[] = [];
			for (const entry of store.cache.values()) {
				if (entry.value.length === 0) continue;
				const parsed = JSON.parse(entry.value);
				if (typeof parsed?.expiresAt === "number") freshExpiries.push(parsed.expiresAt);
			}
			expect(freshExpiries.length).toBeGreaterThanOrEqual(2);
			const now = Date.now();
			for (const expiry of freshExpiries) {
				const delta = expiry - now;
				expect(delta).toBeGreaterThan(3.5 * 60_000);
				expect(delta).toBeLessThan(6.5 * 60_000);
			}
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});
});

describe("AuthStorage usage cache: header ingestion", () => {
	let store: ObservableStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		store = makeStore([oauthRow(1, "a@example.com")]);
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
	});

	it("writes the same per-credential cache key that fetchUsageReports reads", async () => {
		let calls = 0;
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			throw new Error("usage endpoint should not be probed after header ingestion");
		});

		expect(await storage.getApiKey("anthropic", "s")).toBe("oat-1");
		expect(storage.ingestUsageHeaders("anthropic", usageHeaders("0.02", "0.3"), { sessionId: "s" })).toBe(true);

		const report = requireAnthropicReport(await storage.fetchUsageReports());
		expect(calls).toBe(0);
		expect(report.metadata?.source).toBe("ratelimit-headers");
		expect(report.metadata?.email).toBe("a@example.com");
		expect(report.metadata?.accountId).toBe("account-1");
		expect(requireLimit(report, "anthropic:5h").amount.used).toBe(2);
		expect(requireLimit(report, "anthropic:7d").amount.used).toBe(30);
	});

	it("merges active credential metadata into existing header cache entries", async () => {
		const start = Date.now();
		const now = vi.spyOn(Date, "now").mockReturnValue(start);
		expect(await storage.getApiKey("anthropic", "legacy-session")).toBe("oat-1");
		expect(
			storage.ingestUsageHeaders("anthropic", usageHeaders("0.02", "0.3"), { sessionId: "legacy-session" }),
		).toBe(true);

		let rewroteLegacyEntry = false;
		for (const [key, entry] of store.cache) {
			const payload = JSON.parse(entry.value) as { value?: UsageReport | null };
			if (payload.value?.metadata?.source !== "ratelimit-headers") continue;
			payload.value.metadata = { source: "ratelimit-headers" };
			store.cache.set(key, { value: JSON.stringify(payload), expiresAtSec: entry.expiresAtSec });
			rewroteLegacyEntry = true;
		}
		expect(rewroteLegacyEntry).toBe(true);

		now.mockReturnValue(start + 60_001);
		expect(
			storage.ingestUsageHeaders("anthropic", usageHeaders("0.05", "0.6"), { sessionId: "legacy-session" }),
		).toBe(true);

		const report = requireAnthropicReport(await storage.fetchUsageReports());
		expect(report.metadata?.source).toBe("ratelimit-headers");
		expect(report.metadata?.email).toBe("a@example.com");
		expect(report.metadata?.accountId).toBe("account-1");
		expect(requireLimit(report, "anthropic:5h").amount.used).toBe(5);
	});

	it("throttles repeated header ingestion for the same credential cache key", async () => {
		expect(await storage.getApiKey("anthropic", "s")).toBe("oat-1");
		expect(storage.ingestUsageHeaders("anthropic", usageHeaders("0.02", "0.3"), { sessionId: "s" })).toBe(true);
		expect(storage.ingestUsageHeaders("anthropic", usageHeaders("0.05", "0.6"), { sessionId: "s" })).toBe(false);
	});

	it("merges header umbrella windows onto the last real report and preserves tier limits", async () => {
		const realReport = makeTieredReport("a@example.com");
		let calls = 0;
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return realReport;
		});

		const initialReport = requireAnthropicReport(await storage.fetchUsageReports());
		expect(requireLimit(initialReport, "anthropic:7d:opus").amount.used).toBe(12);
		expect(calls).toBe(1);

		expect(await storage.getApiKey("anthropic", "merge-session")).toBe("oat-1");
		const beforeIngest = Date.now();
		expect(storage.ingestUsageHeaders("anthropic", usageHeaders("0.05", "0.9"), { sessionId: "merge-session" })).toBe(
			true,
		);

		const mergedReport = requireAnthropicReport(await storage.fetchUsageReports());
		expect(calls).toBe(1);
		expect(mergedReport.fetchedAt).toBeGreaterThan(realReport.fetchedAt);
		expect(mergedReport.metadata?.email).toBe("a@example.com");
		expect(mergedReport.metadata?.accountId).toBe("account-a@example.com");
		expect(mergedReport.metadata?.headersUpdatedAt).toBeGreaterThanOrEqual(beforeIngest);
		expect(requireLimit(mergedReport, "anthropic:5h").amount.used).toBe(5);
		expect(requireLimit(mergedReport, "anthropic:7d").amount.used).toBe(90);
		expect(requireLimit(mergedReport, "anthropic:7d:opus").amount.used).toBe(12);
	});
	it("replaces the cached Fable weekly row by id when broker headers carry the weekly overage bucket", async () => {
		const realReport: UsageReport = {
			provider: "anthropic",
			fetchedAt: Date.now() - 10_000,
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour" },
					amount: { used: 42, limit: 100, usedFraction: 0.42, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:7d",
					label: "Claude 7 Day",
					scope: { provider: "anthropic", windowId: "7d", shared: true },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 84, limit: 100, usedFraction: 0.84, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:7d:fable",
					label: "Claude 7 Day (Fable)",
					scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 11, limit: 100, usedFraction: 0.11, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:7d:opus",
					label: "Claude 7 Day (Opus)",
					scope: { provider: "anthropic", windowId: "7d", tier: "opus" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 12, limit: 100, usedFraction: 0.12, unit: "percent" },
					status: "ok",
				},
			],
			metadata: {
				email: "a@example.com",
				accountId: "account-a@example.com",
				endpoint: "https://api.anthropic.com/api/oauth/usage",
			},
		};
		let calls = 0;
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return realReport;
		});

		const initialReport = requireAnthropicReport(await storage.fetchUsageReports());
		expect(requireLimit(initialReport, "anthropic:7d:fable").amount.used).toBe(11);
		expect(calls).toBe(1);

		expect(await storage.getApiKey("anthropic", "fable-session")).toBe("oat-1");
		expect(
			storage.ingestUsageHeaders("anthropic", usageHeaders("0.05", "0.9", "0.61"), {
				sessionId: "fable-session",
			}),
		).toBe(true);

		const mergedReport = requireAnthropicReport(await storage.fetchUsageReports());
		expect(calls).toBe(1);
		expect(mergedReport.limits.filter(limit => limit.id === "anthropic:7d:fable")).toHaveLength(1);
		expect(requireLimit(mergedReport, "anthropic:5h").amount.used).toBe(5);
		expect(requireLimit(mergedReport, "anthropic:7d").amount.used).toBe(90);
		expect(requireLimit(mergedReport, "anthropic:7d:opus").amount.used).toBe(12);

		const fable = requireLimit(mergedReport, "anthropic:7d:fable");
		expect(fable.label).toBe("Claude 7 Day (Fable)");
		expect(fable.scope.provider).toBe("anthropic");
		expect(fable.scope.windowId).toBe("7d");
		expect(fable.scope.tier).toBe("fable");
		expect(fable.scope.shared).toBeUndefined();
		expect(fable.window?.resetsAt).toBe(1780617600 * 1000);
		expect(fable.amount.used).toBeCloseTo(61);
		expect(fable.amount.usedFraction).toBeCloseTo(0.61);
		expect(fable.amount.remainingFraction).toBeCloseTo(0.39);
	});
});

describe("AuthStorage usage cache: terminal refresh failure", () => {
	// Usage polling is non-critical: refresh failure must not disable a
	// credential whose current access token can still satisfy the probe.
	it("keeps credential and probes with current access after a definitive refresh failure", async () => {
		const row = oauthRow(1, "a@example.com");
		if (row.credential.type !== "oauth") throw new Error("expected OAuth test credential");
		row.credential.expires = Date.now() + 30_000;
		const rows = [row];
		const cache = new Map<string, CacheEntry>();
		let disableCalls = 0;
		const store: ObservableStore = {
			cache,
			close() {},
			listAuthCredentials: () => rows.filter(candidate => !candidate.disabledCause),
			updateAuthCredential() {},
			deleteAuthCredential() {},
			tryDisableAuthCredentialIfMatches() {
				disableCalls += 1;
				return true;
			},
			replaceAuthCredentialsForProvider: () => rows,
			upsertAuthCredentialForProvider: () => rows,
			deleteAuthCredentialsForProvider() {},
			getCache(key: string, options?: { includeExpired?: boolean }) {
				const entry = cache.get(key);
				if (!entry) return null;
				if (!options?.includeExpired && entry.expiresAtSec * 1000 <= Date.now()) return null;
				return entry.value;
			},
			setCache(key: string, value: string, expiresAtSec: number) {
				cache.set(key, { value, expiresAtSec });
			},
			cleanExpiredCache() {},
		};

		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			refreshOAuthCredential: async () => {
				throw new Error("OAuth refresh failed: 400 invalid_grant: refresh token revoked");
			},
		});
		await storage.reload();

		const fetchSpy = vi
			.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage")
			.mockResolvedValue(makeReport("a@example.com"));
		try {
			const reports = anthropicReports(await storage.fetchUsageReports());

			expect(reports).toHaveLength(1);
			expect(reports[0]?.metadata?.email).toBe("a@example.com");
			expect(disableCalls).toBe(0);
			expect(rows[0]?.disabledCause).toBeNull();
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(fetchSpy.mock.calls[0]?.[0].credential.accessToken).toBe("oat-1");
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});

	it("suppresses last-good fallback when an expired OAuth access token has a definitive refresh failure", async () => {
		const row = oauthRow(3, "expired@example.com");
		if (row.credential.type !== "oauth") throw new Error("expected OAuth test credential");
		row.credential.expires = Date.now() - 1000;
		const store = makeStore([row]);
		const cacheKey = "usage_cache:report:2:anthropic:default:oauth|account:account-3|email:expired@example.com";
		store.cache.set(cacheKey, {
			value: JSON.stringify({ value: makeReport("expired@example.com"), expiresAt: 1 }),
			expiresAtSec: Math.floor((Date.now() + 24 * 60 * 60_000) / 1000),
		});
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			refreshOAuthCredential: async () => {
				throw new Error("OAuth refresh failed: 400 invalid_grant: refresh token revoked");
			},
		});
		await storage.reload();
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue(null);
		try {
			expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(0);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(row.disabledCause).toBeNull();
			const cached = JSON.parse(store.cache.get(cacheKey)!.value);
			expect(cached.value).toBeNull();
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});

	it("preserves last-good fallback for transient (non-definitive) refresh failures", async () => {
		// Mirror image: a 502 from the token endpoint is transient — we keep the
		// row, fall back to the prior good report, and try again next poll.
		const row = oauthRow(2, "b@example.com");
		(row.credential as { expires: number }).expires = Date.now() - 1000;
		const rows = [row];

		const cache = new Map<string, CacheEntry>();
		const store: ObservableStore = {
			cache,
			close() {},
			listAuthCredentials: () => rows.filter(r => !r.disabledCause),
			updateAuthCredential() {},
			deleteAuthCredential() {},
			tryDisableAuthCredentialIfMatches() {
				return true;
			},
			replaceAuthCredentialsForProvider: () => rows,
			upsertAuthCredentialForProvider: () => rows,
			deleteAuthCredentialsForProvider() {},
			getCache(key: string, options?: { includeExpired?: boolean }) {
				const entry = cache.get(key);
				if (!entry) return null;
				if (!options?.includeExpired && entry.expiresAtSec * 1000 <= Date.now()) return null;
				return entry.value;
			},
			setCache(key: string, value: string, expiresAtSec: number) {
				cache.set(key, { value, expiresAtSec });
			},
			cleanExpiredCache() {},
		};

		const lastGood = makeReport("b@example.com");
		const cacheKey = "usage_cache:report:2:anthropic:default:oauth|account:account-2|email:b@example.com";
		cache.set(cacheKey, {
			value: JSON.stringify({ value: lastGood, expiresAt: 1 }),
			expiresAtSec: Math.floor((Date.now() + 24 * 60 * 60_000) / 1000),
		});

		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			refreshOAuthCredential: async () => {
				throw new Error("fetch failed: connect ECONNREFUSED 1.2.3.4:443");
			},
		});
		await storage.reload();

		// The provider probe runs with the stale credential and fails — we don't
		// need a real upstream response, just a deterministic null so the lastGood
		// path is the one being tested.
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue(null);

		try {
			const reports = anthropicReports(await storage.fetchUsageReports());
			expect(reports).toHaveLength(1);
			expect(reports[0]?.metadata?.email).toBe("b@example.com");
			expect(rows[0].disabledCause).toBeNull();
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});
});

describe("AuthStorage usage cache: org-only identity stability", () => {
	it("keeps the cache entry across a token rotation for an org-only credential", async () => {
		// Identity recovery failed at login: the credential carries neither
		// accountId nor email — only the org. The usage-cache identity must key
		// off the org instead of a token hash, or every OAuth refresh would
		// churn the cache key and fragment the usage history.
		const credential: AuthCredential = {
			type: "oauth",
			access: "oat-initial",
			refresh: "refresh-initial",
			expires: Date.now() + 3_600_000,
			orgId: "org-team-1111",
		};
		const row: StoredAuthCredential = { id: 1, provider: "anthropic", credential, disabledCause: null };
		const store = makeStore([row]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
		try {
			let calls = 0;
			vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
				calls += 1;
				return makeReport("org-only");
			});

			const first = anthropicReports(await storage.fetchUsageReports());
			expect(first).toHaveLength(1);
			expect(calls).toBe(1);
			const reportKeysBefore = [...store.cache.keys()].filter(key => key.startsWith("usage_cache:report:")).sort();
			expect(reportKeysBefore).toHaveLength(1);

			// An OAuth refresh rotates both tokens. The rotated credential must
			// resolve to the SAME cache entry — served from cache, no refetch.
			row.credential = { ...credential, access: "oat-rotated", refresh: "refresh-rotated" };
			await storage.reload();

			const second = anthropicReports(await storage.fetchUsageReports());
			expect(second).toHaveLength(1);
			expect(calls).toBe(1);
			const reportKeysAfter = [...store.cache.keys()].filter(key => key.startsWith("usage_cache:report:")).sort();
			expect(reportKeysAfter).toEqual(reportKeysBefore);
			for (const key of reportKeysAfter) {
				expect(key).toContain("org:org-team-1111");
				expect(key).not.toContain("secret:");
			}
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime UsageProvider registration (registerUsageProvider / syncUsageProviders /
// unregisterUsageProviders) + schema canonicalization.
// ─────────────────────────────────────────────────────────────────────────────

describe("AuthStorage runtime UsageProvider registration", () => {
	const directFetchContext: UsageFetchContext = {
		fetch: async () => new Response(null, { status: 204 }),
		listUsageCosts: () => [],
	};

	// ── registerUsageProvider ─────────────────────────────────────────────────

	it("registers a usage provider so usageProviderFor returns it", async () => {
		const store = makeMinimalStore();
		const authStorage = new AuthStorage(store);
		const { provider } = makeFakeProvider("my-provider");

		authStorage.registerUsageProvider("my-provider", provider, "ext-1");

		const resolved = authStorage.usageProviderFor("my-provider");
		expect(resolved).not.toBeUndefined();
		expect(resolved!.id).toBe("my-provider");
		authStorage.close();
	});

	it("registerUsageProvider replaces the layer for the same sourceId (last write wins)", async () => {
		const store = makeMinimalStore();
		const authStorage = new AuthStorage(store);
		const first = makeFakeProvider("my-provider", { provider: "my-provider", fetchedAt: 1, limits: [] });
		const second = makeFakeProvider("my-provider", { provider: "my-provider", fetchedAt: 2, limits: [] });

		authStorage.registerUsageProvider("my-provider", first.provider, "ext-1");
		authStorage.registerUsageProvider("my-provider", second.provider, "ext-1");

		const resolved = authStorage.usageProviderFor("my-provider");
		const report = await resolved!.fetchUsage(
			{ provider: "my-provider", credential: { type: "api_key", apiKey: "sk-test-key" } },
			directFetchContext,
		);

		expect(report).toEqual({ provider: "my-provider", fetchedAt: 2, limits: [] });
		expect(first.calls).toHaveLength(0);
		expect(second.calls).toHaveLength(1);
		authStorage.close();
	});

	it("multiple sourceIds stack and the latest layer handles fetches", async () => {
		const store = makeMinimalStore();
		const authStorage = new AuthStorage(store);
		const extA = makeFakeProvider("my-provider", { provider: "my-provider", fetchedAt: 11, limits: [] });
		const extB = makeFakeProvider("my-provider", { provider: "my-provider", fetchedAt: 22, limits: [] });

		authStorage.registerUsageProvider("my-provider", extA.provider, "ext-a");
		authStorage.registerUsageProvider("my-provider", extB.provider, "ext-b");

		const resolved = authStorage.usageProviderFor("my-provider");
		const report = await resolved!.fetchUsage(
			{ provider: "my-provider", credential: { type: "api_key", apiKey: "sk-test-key" } },
			directFetchContext,
		);

		expect(report).toEqual({ provider: "my-provider", fetchedAt: 22, limits: [] });
		expect(extA.calls).toHaveLength(0);
		expect(extB.calls).toHaveLength(1);
		authStorage.close();
	});

	it("re-registering a provider invalidates the resolved-provider cache", async () => {
		const store = makeMinimalStore();
		const authStorage = new AuthStorage(store);
		const first = makeFakeProvider("cached-provider", { provider: "cached-provider", fetchedAt: 1, limits: [] });
		const second = makeFakeProvider("cached-provider", { provider: "cached-provider", fetchedAt: 2, limits: [] });

		authStorage.registerUsageProvider("cached-provider", first.provider, "ext-1");
		expect(authStorage.usageProviderFor("cached-provider")).not.toBeUndefined();

		authStorage.registerUsageProvider("cached-provider", second.provider, "ext-1");
		const resolved = authStorage.usageProviderFor("cached-provider");
		const report = await resolved!.fetchUsage(
			{ provider: "cached-provider", credential: { type: "api_key", apiKey: "sk-test-key" } },
			directFetchContext,
		);

		expect(report).toEqual({ provider: "cached-provider", fetchedAt: 2, limits: [] });
		expect(first.calls).toHaveLength(0);
		expect(second.calls).toHaveLength(1);
		authStorage.close();
	});

	// ── unregisterUsageProviders ─────────────────────────────────────────────

	it("unregisterUsageProviders removes all layers for the given sourceId", async () => {
		const store = makeMinimalStore();
		const authStorage = new AuthStorage(store);
		const fakeA = makeFakeProvider("my-provider", { provider: "my-provider", fetchedAt: 10, limits: [] });
		const fakeB = makeFakeProvider("my-provider", { provider: "my-provider", fetchedAt: 20, limits: [] });

		authStorage.registerUsageProvider("my-provider", fakeA.provider, "ext-a");
		authStorage.registerUsageProvider("my-provider", fakeB.provider, "ext-b");
		authStorage.unregisterUsageProviders("ext-a");

		const resolved = authStorage.usageProviderFor("my-provider");
		const report = await resolved!.fetchUsage(
			{ provider: "my-provider", credential: { type: "api_key", apiKey: "sk-test-key" } },
			directFetchContext,
		);

		expect(report).toEqual({ provider: "my-provider", fetchedAt: 20, limits: [] });
		expect(fakeA.calls).toHaveLength(0);
		expect(fakeB.calls).toHaveLength(1);
		authStorage.close();
	});

	it("unregisterUsageProviders leaves other sourceIds untouched", async () => {
		const store = makeMinimalStore();
		const authStorage = new AuthStorage(store);
		const fake1 = makeFakeProvider("provider-1", { provider: "provider-1", fetchedAt: 1, limits: [] });
		const fake2 = makeFakeProvider("provider-2", { provider: "provider-2", fetchedAt: 2, limits: [] });

		authStorage.registerUsageProvider("provider-1", fake1.provider, "ext-x");
		authStorage.registerUsageProvider("provider-2", fake2.provider, "ext-y");
		authStorage.unregisterUsageProviders("ext-x");

		expect(authStorage.usageProviderFor("provider-1")).toBeUndefined();
		const resolved = authStorage.usageProviderFor("provider-2");
		const report = await resolved!.fetchUsage(
			{ provider: "provider-2", credential: { type: "api_key", apiKey: "sk-test-key" } },
			directFetchContext,
		);

		expect(report).toEqual({ provider: "provider-2", fetchedAt: 2, limits: [] });
		expect(fake1.calls).toHaveLength(0);
		expect(fake2.calls).toHaveLength(1);
		authStorage.close();
	});

	// ── syncUsageProviders ────────────────────────────────────────────────────

	it("syncUsageProviders replaces all runtime layers (full replacement)", async () => {
		const store = makeMinimalStore();
		const authStorage = new AuthStorage(store);
		const oldFake = makeFakeProvider("my-provider", { provider: "my-provider", fetchedAt: 1, limits: [] });
		const newFake = makeFakeProvider("my-provider", { provider: "my-provider", fetchedAt: 2, limits: [] });

		authStorage.registerUsageProvider("my-provider", oldFake.provider, "ext-old");
		authStorage.syncUsageProviders([{ name: "my-provider", config: newFake.provider, sourceId: "cli-sync" }]);

		const resolved = authStorage.usageProviderFor("my-provider");
		const report = await resolved!.fetchUsage(
			{ provider: "my-provider", credential: { type: "api_key", apiKey: "sk-test-key" } },
			directFetchContext,
		);

		expect(report).toEqual({ provider: "my-provider", fetchedAt: 2, limits: [] });
		expect(oldFake.calls).toHaveLength(0);
		expect(newFake.calls).toHaveLength(1);
		authStorage.close();
	});

	it("syncUsageProviders deduplicates by sourceId within the sync set", async () => {
		const store = makeMinimalStore();
		const authStorage = new AuthStorage(store);
		const first = makeFakeProvider("my-provider", { provider: "my-provider", fetchedAt: 100, limits: [] });
		const second = makeFakeProvider("my-provider", { provider: "my-provider", fetchedAt: 200, limits: [] });

		authStorage.syncUsageProviders([
			{ name: "my-provider", config: first.provider, sourceId: "ext-dup" },
			{ name: "my-provider", config: second.provider, sourceId: "ext-dup" },
		]);

		const resolved = authStorage.usageProviderFor("my-provider");
		const report = await resolved!.fetchUsage(
			{ provider: "my-provider", credential: { type: "api_key", apiKey: "sk-test-key" } },
			directFetchContext,
		);

		expect(report).toEqual({ provider: "my-provider", fetchedAt: 200, limits: [] });
		expect(first.calls).toHaveLength(0);
		expect(second.calls).toHaveLength(1);
		authStorage.close();
	});

	// ── schema-invalid: adapter report / limit mismatches the registered provider ──

	describe("schema-invalid: adapter report vs registered provider mismatch", () => {
		it("drops a report whose provider field does not match the registered provider", async () => {
			const store = makeMinimalStore();
			const authStorage = new AuthStorage(store);
			const fake = makeFakeProvider("registered-provider", {
				provider: "other-provider",
				fetchedAt: Date.now(),
				limits: [
					{
						id: "other:5h",
						label: "5 Hour",
						scope: { provider: "other-provider", windowId: "5h" },
						window: { id: "5h", label: "5h" },
						amount: { used: 50, limit: 100, unit: "percent" },
						status: "ok",
					},
				],
			});
			authStorage.registerUsageProvider("registered-provider", fake.provider, "ext-1");
			await authStorage.set("registered-provider", [{ type: "api_key", key: "sk-test-key" }]);

			const reports = await authStorage.fetchUsageReports({ baseUrlResolver: () => undefined });

			expect(fake.calls).toHaveLength(1);
			expect(reports).toEqual([]);
			authStorage.close();
		});

		it("drops the whole report when any limit scope.provider mismatches the registered provider", async () => {
			const store = makeMinimalStore();
			const authStorage = new AuthStorage(store);
			const fake = makeFakeProvider("registered-provider", {
				provider: "registered-provider",
				fetchedAt: Date.now(),
				limits: [
					{
						id: "registered:5h",
						label: "5 Hour",
						scope: { provider: "registered-provider", windowId: "5h" },
						window: { id: "5h", label: "5h" },
						amount: { used: 10, limit: 100, unit: "percent" },
						status: "ok",
					},
					{
						id: "other:7d",
						label: "7 Day",
						scope: { provider: "other-provider", windowId: "7d" },
						window: { id: "7d", label: "7d" },
						amount: { used: 50, limit: 100, unit: "percent" },
						status: "ok",
					},
				],
			});
			authStorage.registerUsageProvider("registered-provider", fake.provider, "ext-1");
			await authStorage.set("registered-provider", [{ type: "api_key", key: "sk-test-key" }]);

			const reports = await authStorage.fetchUsageReports({ baseUrlResolver: () => undefined });

			expect(fake.calls).toHaveLength(1);
			expect(reports).toEqual([]);
			authStorage.close();
		});
	});

	// ── schema canonicalization ─────────────────────────────────────────────

	it.each([
		["rejects missing currency", undefined],
		["rejects non-ISO currency", "foo"],
		["rejects lowercase currency", "usd"],
		["preserves CNY", "CNY"],
		["preserves USD", "USD"],
	] as const)("fetchUsageReports %s for runtime currency reports and strips raw", async (_caseName, currency) => {
		const store = makeMinimalStore();
		const authStorage = new AuthStorage(store);
		const fake = makeFakeProvider("spoofed-provider", {
			provider: "canonical-provider",
			fetchedAt: 123,
			limits: [
				{
					id: "canonical-provider:monthly",
					label: "Monthly Spend",
					scope: { provider: "canonical-provider", windowId: "monthly" },
					window: { id: "monthly", label: "30d", resetsAt: 456 },
					amount:
						currency === undefined
							? { used: 1_200_000, limit: 10_000_000, unit: "currency" }
							: { used: 1_200_000, limit: 10_000_000, unit: "currency", currency },
					status: "ok",
				},
			],
			raw: { cents: 1_200_000 },
		});
		const expectedReports: UsageReport[] =
			currency === "CNY" || currency === "USD"
				? [
						{
							provider: "canonical-provider",
							fetchedAt: 123,
							limits: [
								{
									id: "canonical-provider:monthly",
									label: "Monthly Spend",
									scope: { provider: "canonical-provider", windowId: "monthly" },
									window: { id: "monthly", label: "30d", resetsAt: 456 },
									amount: { used: 1_200_000, limit: 10_000_000, unit: "currency", currency },
									status: "ok",
								},
							],
						},
					]
				: [];

		try {
			authStorage.registerUsageProvider("canonical-provider", fake.provider, "ext-1");
			await authStorage.set("canonical-provider", [{ type: "api_key", key: "sk-test-key" }]);

			const resolved = authStorage.usageProviderFor("canonical-provider");
			const reports = await authStorage.fetchUsageReports({ baseUrlResolver: () => undefined });

			expect(resolved?.id).toBe("canonical-provider");
			expect(fake.calls).toHaveLength(1);
			expect(reports).toEqual(expectedReports);
		} finally {
			authStorage.close();
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// setConfigApiKey → runtime usage provider: config key overrides stored credentials.
// ─────────────────────────────────────────────────────────────────────────────

describe("AuthStorage setConfigApiKey overrides stored credentials for the runtime usage provider", () => {
	it("setConfigApiKey wins over stored credentials: adapter receives config key only", async () => {
		const storedRow: StoredAuthCredential = {
			id: 1,
			provider: "keyed-provider",
			credential: { type: "api_key" as const, key: "sk-stored-key-should-lose" },
			disabledCause: null,
		};
		const goodReport: UsageReport = {
			provider: "keyed-provider",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "keyed-provider:5h",
					label: "5 Hour",
					scope: { provider: "keyed-provider", windowId: "5h" },
					window: { id: "5h", label: "5h" },
					amount: { used: 1, limit: 100, unit: "percent" },
					status: "ok",
				},
			],
		};
		const store = makeStore([storedRow]);
		const authStorage = new AuthStorage(store);
		const fake = makeFakeProvider("keyed-provider", goodReport);

		authStorage.registerUsageProvider("keyed-provider", fake.provider, "ext-1");
		authStorage.setConfigApiKey("keyed-provider", "sk-config-override-wins");

		const reports = await authStorage.fetchUsageReports({ baseUrlResolver: () => undefined });
		const report = reports?.find(candidate => candidate.provider === "keyed-provider");

		expect(fake.calls).toHaveLength(1);
		const params = fake.calls[0]!.params;
		expect(params.provider).toBe("keyed-provider");
		expect(params.credential).toEqual({ type: "api_key", apiKey: "sk-config-override-wins" });
		expect(reports).toHaveLength(1);
		expect(report).toBeDefined();
		if (!report) throw new Error("expected keyed-provider usage report");
		expect(report.fetchedAt).toBe(goodReport.fetchedAt);
		expect(report.limits[0]?.amount.used).toBe(1);
		authStorage.close();
	});

	it("keeps broker-owned providers while replacing the same provider with a local resolver-backed report", async () => {
		let brokerCalls = 0;
		const brokerReports: UsageReport[] = [
			{
				provider: "custom-provider",
				fetchedAt: 10,
				limits: [
					{
						id: "custom-provider:monthly",
						label: "Monthly Spend",
						scope: { provider: "custom-provider", windowId: "monthly" },
						window: { id: "monthly", label: "Monthly" },
						amount: { used: 10, limit: 100, unit: "requests" },
						status: "ok",
					},
				],
			},
			{
				provider: "anthropic",
				fetchedAt: 20,
				limits: [
					{
						id: "anthropic:5h",
						label: "5 Hour",
						scope: { provider: "anthropic", windowId: "5h" },
						window: { id: "5h", label: "5 Hour" },
						amount: { used: 24, limit: 100, unit: "percent" },
						status: "ok",
					},
				],
			},
		];
		const localReport: UsageReport = {
			provider: "custom-provider",
			fetchedAt: 99,
			limits: [
				{
					id: "custom-provider:monthly",
					label: "Monthly Spend",
					scope: { provider: "custom-provider", windowId: "monthly" },
					window: { id: "monthly", label: "Monthly" },
					amount: { used: 75, limit: 100, unit: "requests" },
					status: "warning",
				},
			],
		};
		const store = {
			...makeMinimalStore(),
			fetchUsageReports: async () => {
				brokerCalls += 1;
				return brokerReports;
			},
		};
		const fake = makeFakeProvider("custom-provider", localReport);
		const authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "custom-provider" ? fake.provider : undefined),
		});

		authStorage.setConfigApiKey("custom-provider", "sk-local-override");

		const reports = await authStorage.fetchUsageReports({ baseUrlResolver: () => undefined });
		const customReports = reports?.filter(candidate => candidate.provider === "custom-provider") ?? [];
		const anthropicReport = reports?.find(candidate => candidate.provider === "anthropic");

		expect(brokerCalls).toBe(1);
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]!.params.credential).toEqual({ type: "api_key", apiKey: "sk-local-override" });
		expect(customReports).toHaveLength(1);
		expect(customReports[0]?.fetchedAt).toBe(99);
		expect(customReports[0]?.limits[0]?.amount.used).toBe(75);
		expect(anthropicReport).toBeDefined();
		expect(anthropicReport?.fetchedAt).toBe(20);
		expect(anthropicReport?.limits[0]?.amount.used).toBe(24);
		authStorage.close();
	});
});
// ─────────────────────────────────────────────────────────────────────────────
// In-flight usage request: invalidate/re-register race
//
// When an upstream usage fetch is in-flight and a re-registration invalidates
// the cache, the old promise's finally() must NOT delete the new promise that
// replaces it at the same map key. Subsequent callers coalesce onto the new
// request, which must be the only upstream call counted.
// ─────────────────────────────────────────────────────────────────────────────

describe("AuthStorage in-flight usage request: invalidate/replace race", () => {
	it("old in-flight promise does not delete new promise after re-register; third caller coalesces onto new request at per-request level", async () => {
		// ── deferred providers ──────────────────────────────────────────────────
		const { promise: oldDeferred, resolve: resolveOld } = Promise.withResolvers<UsageReport>();
		const oldProvider = {
			id: "anthropic",
			calls: [] as Array<{ params: UsageFetchParams; ctx: UsageFetchContext }>,
			async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext) {
				oldProvider.calls.push({ params, ctx });
				return oldDeferred;
			},
		};

		const { promise: newDeferred, resolve: resolveNew } = Promise.withResolvers<UsageReport>();
		const newProvider = {
			id: "anthropic",
			calls: [] as Array<{ params: UsageFetchParams; ctx: UsageFetchContext }>,
			async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext) {
				newProvider.calls.push({ params, ctx });
				return newDeferred;
			},
		};

		// openai-codex provider: deferred so caller 3's aggregate key differs from
		// caller 2 without triggering an extra newProvider call (it won't be called
		// until the next fetchUsageReports cycle after reload).
		const { promise: codexDeferred, resolve: resolveCodex } = Promise.withResolvers<UsageReport>();
		const codexProvider = {
			id: "openai-codex",
			calls: [] as Array<{ params: UsageFetchParams; ctx: UsageFetchContext }>,
			async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext) {
				codexProvider.calls.push({ params, ctx });
				return codexDeferred;
			},
		};

		const store = makeStore([oauthRow(1, "race@example.com")]);

		const authStorage = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
		});

		authStorage.registerUsageProvider("anthropic", oldProvider as unknown as UsageProviderConfig, "ext-old");
		authStorage.registerUsageProvider("openai-codex", codexProvider as unknown as UsageProviderConfig, "ext-codex");

		// ── caller 1: starts upstream fetch that hangs (anthropic:c1) ───────────
		await authStorage.reload();
		const reportPromise1 = authStorage.fetchUsageReports({ baseUrlResolver: () => undefined });
		await Bun.sleep(5);
		expect(oldProvider.calls).toHaveLength(1);

		// ── re-register with new anthropic provider ──────────────────────────────
		// Increments #usageCacheEpoch → stale-epoch guard blocks old promise's
		// cache write. Evicts P1 from #usageRequestInFlight via deleteCachePrefix.
		authStorage.registerUsageProvider("anthropic", newProvider as unknown as UsageProviderConfig, "ext-new");

		// Expire the anthropic cache entry so #fetchUsageCached skips the fresh-cache
		// fast-path and enters the stale-epoch / in-flight branch.
		for (const [key, entry] of store.cache) {
			if (key.startsWith("usage_cache:report:anthropic:")) {
				store.cache.set(key, { value: entry.value, expiresAtSec: 1 });
			}
		}

		// ── caller 2: aggregate = {anthropic:[c1]}  →  cache key A ────────────
		// openai-codex has no stored credential yet → same aggregate key as caller 1.
		// Creates newPerRequest for anthropic:c1, calls newProvider.
		const reportPromise2 = authStorage.fetchUsageReports({ baseUrlResolver: () => undefined });
		await Bun.sleep(5);
		expect(newProvider.calls).toHaveLength(1);

		// ── resolve old promise ─────────────────────────────────────────────────
		// P1's finally() runs: it sees stale epoch, returns raw report without
		// writing to cache. Crucially it also does NOT delete the newPerRequest
		// entry because the key was already evicted by deleteCachePrefix.
		resolveOld({
			provider: "anthropic",
			fetchedAt: 111,
			limits: [
				{
					id: "x",
					label: "X",
					scope: { provider: "anthropic", windowId: "x" },
					amount: { used: 1, limit: 100, unit: "requests" },
					status: "ok",
				},
			],
		});
		await Bun.sleep(5);
		// newProvider still only called once — newPerRequest intact.
		expect(newProvider.calls).toHaveLength(1);

		store.listAuthCredentials().push({
			...oauthRow(2, "other@example.com"),
			provider: "openai-codex",
		});
		await authStorage.reload();

		// ── caller 3: aggregate = {anthropic:[c1], openai-codex:[c2]}  →  key B ≠ A
		// Different aggregate key → caller 3 does NOT coalesce at #usageReportsInFlight.
		// It enters #fetchUsageCached for anthropic:c1 and finds newPerRequest.
		const reportPromise3 = authStorage.fetchUsageReports({ baseUrlResolver: () => undefined });
		await Bun.sleep(5);

		// Exactly three upstream calls overall: old anthropic once, new anthropic once,
		// and caller 3's distinct openai-codex fetch once. If caller 3 collapsed back to
		// aggregate key A, codexProvider would stay at 0 and this assertion would fail.
		expect(oldProvider.calls).toHaveLength(1);
		expect(newProvider.calls).toHaveLength(1);
		expect(codexProvider.calls).toHaveLength(1);
		expect(oldProvider.calls.length + newProvider.calls.length + codexProvider.calls.length).toBe(3);

		// ── resolve new promise and codex promise ────────────────────────────────
		resolveNew({ provider: "anthropic", fetchedAt: 999, limits: [] });
		resolveCodex({ provider: "openai-codex", fetchedAt: 100, limits: [] });
		await Bun.sleep(5);

		const [r1, r2, r3] = await Promise.all([reportPromise1, reportPromise2, reportPromise3]);

		const reports1 = anthropicReports(r1);
		const reports2 = anthropicReports(r2);
		const reports3 = anthropicReports(r3);
		const caller2CodexReports = (r2 ?? []).filter(rep => rep.provider === "openai-codex");
		const caller3CodexReports = (r3 ?? []).filter(rep => rep.provider === "openai-codex");

		expect(reports1).toHaveLength(1);
		expect(reports2).toHaveLength(1);
		expect(reports3).toHaveLength(1);
		expect(caller2CodexReports).toHaveLength(0);
		expect(caller3CodexReports).toHaveLength(1);
		// r1 settled via stale-epoch fast-path (no cache write).
		expect(reports1[0]!.fetchedAt).toBe(111);
		// r2 and r3 coalesced onto newPerRequest → same new anthropic report.
		expect(reports2[0]!.fetchedAt).toBe(999);
		expect(reports3[0]!.fetchedAt).toBe(999);
		// caller 3 alone saw the injected codex credential, proving aggregate key B.
		expect(caller3CodexReports[0]!.fetchedAt).toBe(100);

		authStorage.close();
	});
});
