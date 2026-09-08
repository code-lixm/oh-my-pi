import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ollamaCloudRankingStrategy, ollamaCloudUsageProvider, ollamaUsageProvider } from "../src/usage/ollama";

const USAGE_URL = "https://ollama.com/api/usage";

/** Live capture from `GET https://ollama.com/api/usage`, 2026-08-27. */
function usagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		activity: { cost: "0.00000", period: { type: "last_4_weeks" }, models: [] },
		limits: {
			session: { usage: 0.308, models: [{ name: "glm-5.3-flash", request_count: 341 }] },
			weekly: { usage: 0.054, models: [{ name: "glm-5.3-flash", request_count: 341 }] },
			...overrides,
		},
	};
}

function fakeFetch(payload: unknown, status = 200): FetchImpl {
	const fn = async () =>
		new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
	return fn as unknown as typeof fetch;
}

function fetchRecorder(
	calls: Array<{ url: string; headers: Record<string, string> }>,
	payload: unknown,
	status = 200,
): FetchImpl {
	const fn = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(input),
			headers: (init?.headers as Record<string, string>) ?? {},
		});
		return new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
	};
	return fn as unknown as typeof fetch;
}

const cloudParams = { provider: "ollama-cloud", credential: { type: "api_key" as const, apiKey: "ok-key" } };

describe("ollama-cloud usage provider", () => {
	it("parses session and weekly windows into percent limits with canonical ids", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(cloudParams, { fetch: fakeFetch(usagePayload()) });
		expect(report).not.toBeNull();
		expect(report?.provider).toBe("ollama-cloud");
		expect(report?.limits.map(limit => [limit.id, limit.scope.windowId, limit.amount.usedFraction])).toEqual([
			["ollama-session", "session", 0.308],
			["ollama-weekly", "weekly", 0.054],
		]);
		const session = report?.limits.find(limit => limit.id === "ollama-session");
		expect(session?.amount.unit).toBe("percent");
		expect(session?.window?.durationMs).toBe(5 * 3_600_000);
		expect(session?.window?.resetsAt).toBeUndefined();
		const weekly = report?.limits.find(limit => limit.id === "ollama-weekly");
		expect(weekly?.window?.durationMs).toBe(7 * 24 * 3_600_000);
	});

	it("maps usage fractions to ok/warning/exhausted statuses", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(cloudParams, {
			fetch: fakeFetch(
				usagePayload({
					session: { usage: 0.95, models: [] },
					weekly: { usage: 1, models: [] },
				}),
			),
		});
		expect(report?.limits.find(limit => limit.id === "ollama-session")?.status).toBe("warning");
		expect(report?.limits.find(limit => limit.id === "ollama-weekly")?.status).toBe("exhausted");
	});

	it("sends Authorization: Bearer <key> to the fixed usage route", async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		await ollamaCloudUsageProvider.fetchUsage(cloudParams, { fetch: fetchRecorder(calls, usagePayload()) });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(USAGE_URL);
		expect(calls[0]?.headers.authorization).toBe("Bearer ok-key");
	});

	it("throws on 401 so checkCredentials flags the key instead of leaving it unknown", async () => {
		await expect(
			ollamaCloudUsageProvider.fetchUsage(cloudParams, { fetch: fakeFetch({ error: "invalid credentials" }, 401) }),
		).rejects.toThrow(/401/);
	});

	it("returns null on transient failures so the cached last-good report serves", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(cloudParams, {
			fetch: fakeFetch({ error: "boom" }, 500),
		});
		expect(report).toBeNull();
	});

	it("returns null on a malformed window instead of emitting a partial report", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(cloudParams, {
			fetch: fakeFetch({
				limits: { session: { usage: 0.3, models: [] }, weekly: { usage: 7 } },
			}),
		});
		expect(report).toBeNull();
	});

	it("rejects usage fractions outside 0-1", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(cloudParams, {
			fetch: fakeFetch({
				limits: { session: { usage: 1.5 }, weekly: { usage: 0.1 } },
			}),
		});
		expect(report).toBeNull();
	});

	it("does not handle the local ollama provider", () => {
		expect(
			ollamaCloudUsageProvider.supports?.({
				provider: "ollama",
				credential: { type: "api_key", apiKey: "k" },
			}),
		).toBe(false);
	});

	it("ranks by session then weekly headroom", async () => {
		const report = {
			provider: "ollama-cloud",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "ollama-weekly",
					label: "Weekly limit",
					scope: { provider: "ollama-cloud", windowId: "weekly" },
					amount: { usedFraction: 0.1, unit: "percent" as const },
				},
				{
					id: "ollama-session",
					label: "Session limit",
					scope: { provider: "ollama-cloud", windowId: "session" },
					amount: { usedFraction: 0.6, unit: "percent" as const },
				},
			],
		};
		const { primary, secondary } = ollamaCloudRankingStrategy.findWindowLimits(report);
		expect(primary?.id).toBe("ollama-session");
		expect(secondary?.id).toBe("ollama-weekly");
	});
});

describe("local ollama usage provider", () => {
	it("reports no limits with an explanatory note", async () => {
		const report = await ollamaUsageProvider.fetchUsage(
			{ provider: "ollama", credential: { type: "api_key", apiKey: "k" } },
			{ fetch: fakeFetch({}) },
		);
		expect(report?.limits).toEqual([]);
		expect(report?.notes?.length).toBeGreaterThan(0);
	});
});
