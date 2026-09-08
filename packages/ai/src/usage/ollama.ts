import { ProviderHttpError } from "../error";
import type {
	CredentialRankingStrategy,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
} from "../usage";
import { isRecord } from "../utils";
import { DAY_MS, HOUR_MS, usageStatus } from "./shared";

const OLLAMA_PROVIDER = "ollama";
const OLLAMA_CLOUD_PROVIDER = "ollama-cloud";
const OLLAMA_COM_BASE_URL = "https://ollama.com";
const USAGE_PATH = "/api/usage";

/**
 * `GET https://ollama.com/api/usage` response. The endpoint is undocumented
 * (community-discovered; see ollama/ollama#16448, #12532) and returns a
 * 0-1 usage fraction per window plus per-model request counts. No reset
 * timestamps are exposed — the session window rolls on a 5-hour cycle and
 * the weekly window on a 7-day cycle, so both carry duration-based windows
 * without a `resetsAt`.
 */
interface OllamaUsagePayload {
	limits?: {
		session?: unknown;
		weekly?: unknown;
	};
}

function parseUsageFraction(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return undefined;
	return value;
}

function buildWindowLimit(
	windowId: string,
	label: string,
	durationMs: number,
	payload: unknown,
): UsageLimit | undefined {
	if (!isRecord(payload)) return undefined;
	const usedFraction = parseUsageFraction(payload.usage);
	if (usedFraction === undefined) return undefined;
	return {
		id: `ollama-${windowId}`,
		label: `${label} limit`,
		scope: {
			provider: OLLAMA_CLOUD_PROVIDER,
			windowId,
			shared: true,
		},
		window: {
			id: windowId,
			label,
			durationMs,
		},
		amount: {
			usedFraction,
			remainingFraction: Math.max(0, 1 - usedFraction),
			unit: "percent",
		},
		status: usageStatus(usedFraction),
	};
}

async function fetchOllamaCloudUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	const baseUrl = credential.apiEndpoint?.trim() || OLLAMA_COM_BASE_URL;
	const url = `${baseUrl.replace(/\/+$/, "")}${USAGE_PATH}`;
	let payload: OllamaUsagePayload;
	try {
		const response = await ctx.fetch(url, {
			headers: {
				accept: "application/json",
				authorization: `Bearer ${credential.apiKey}`,
			},
			signal: params.signal,
		});
		if (!response.ok) {
			// 401/403 throw so checkCredentials flags the credential as bad
			// rather than unknown; other statuses are transient.
			if (response.status === 401 || response.status === 403) {
				throw new ProviderHttpError(
					`Ollama Cloud usage endpoint returned ${response.status} ${response.statusText}`.trim(),
					response.status,
				);
			}
			ctx.logger?.warn("Ollama Cloud usage fetch failed", {
				status: response.status,
				statusText: response.statusText,
			});
			return null;
		}
		const json: unknown = await response.json();
		if (!isRecord(json)) {
			ctx.logger?.warn("Ollama Cloud usage response was not a JSON object");
			return null;
		}
		payload = json as OllamaUsagePayload;
	} catch (error) {
		// Re-throw auth errors so the credential-health probe can surface them.
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("Ollama Cloud usage fetch error", { error: String(error) });
		return null;
	}

	const limits: UsageLimit[] = [];
	const session = buildWindowLimit("session", "Session", 5 * HOUR_MS, payload.limits?.session);
	if (session) limits.push(session);
	const weekly = buildWindowLimit("weekly", "Weekly", 7 * DAY_MS, payload.limits?.weekly);
	if (weekly) limits.push(weekly);
	// All-or-nothing: a partial report would overwrite the complete last-good
	// report in the usage cache. Treat a malformed window as transient.
	if (limits.length !== 2) {
		ctx.logger?.warn("Ollama Cloud usage response missing or malformed windows");
		return null;
	}

	return {
		provider: OLLAMA_CLOUD_PROVIDER,
		fetchedAt: Date.now(),
		limits,
		metadata: {
			planType: "Ollama Cloud",
			endpoint: url,
		},
		raw: payload,
	};
}

function fetchLocalOrCloudStubUsage(params: UsageFetchParams, _ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== OLLAMA_PROVIDER) return Promise.resolve(null);

	const metadata: Record<string, unknown> = {};
	if (params.credential.email) metadata.email = params.credential.email;
	if (params.credential.accountId) metadata.accountId = params.credential.accountId;

	return Promise.resolve({
		provider: params.provider,
		fetchedAt: Date.now(),
		limits: [],
		notes: ["Local Ollama has no quota limits; per-response token usage is reported during requests."],
		metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
	});
}

/** Registers local Ollama accounts with usage views; the local server has no quota endpoint. */
export const ollamaUsageProvider: UsageProvider = {
	id: OLLAMA_PROVIDER,
	fetchUsage: fetchLocalOrCloudStubUsage,
	supports: params => params.provider === OLLAMA_PROVIDER,
	validatesCredentials: false,
};

/**
 * Fetches Ollama Cloud session (5-hour) and weekly quota fractions from the
 * undocumented `GET /api/usage` endpoint. The endpoint authenticates with the
 * dashboard-issued API key (`Authorization: Bearer`); keys minted through
 * some older flows may not be accepted there (they still work for inference).
 */
export const ollamaCloudUsageProvider: UsageProvider = {
	id: OLLAMA_CLOUD_PROVIDER,
	fetchUsage: fetchOllamaCloudUsage,
	supports: params => params.provider === OLLAMA_CLOUD_PROVIDER && params.credential.type === "api_key",
	validatesCredentials: true,
};

/**
 * Rank Ollama Cloud credentials by real headroom on the 5-hour session and
 * weekly windows. Usage is a shared account-wide fraction — model scoping
 * does not apply.
 */
export const ollamaCloudRankingStrategy = {
	findWindowLimits: report => ({
		primary: report.limits.find(limit => limit.id === "ollama-session"),
		secondary: report.limits.find(limit => limit.id === "ollama-weekly"),
	}),
	windowDefaults: {
		primaryMs: 5 * HOUR_MS,
		secondaryMs: 7 * DAY_MS,
	},
} satisfies CredentialRankingStrategy;
