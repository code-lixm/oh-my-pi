import { type } from "@oh-my-pi/omptype";
import { parseKnownModel, semverEqual } from "../identity/classify";
import type {
	CodexPromptApprovalMessages,
	CodexPromptAutoReviewMessages,
	CodexPromptCollaborationModeMessages,
	CodexPromptInstructionsVariables,
	CodexPromptModelMessages,
	CodexPromptPermissionMessages,
	CodexPromptPersonality,
	CodexPromptProfile,
	CodexPromptTokenBudget,
	FetchImpl,
	ModelSpec,
} from "../types";
import { discoveryFetch } from "../utils";
import { CODEX_BASE_URL, CODEX_CLIENT_VERSION, OPENAI_HEADER_VALUES, OPENAI_HEADERS } from "../wire/codex";

const DEFAULT_MODEL_LIST_PATHS = ["/codex/models", "/models"] as const;
const DEFAULT_CONTEXT_WINDOW = 272_000;
const DEFAULT_MAX_TOKENS = 128_000;
/**
 * GPT-5.6 luna/sol/terra hard context capacity. Codex discovery omits
 * `context_window` for these SKUs, so the generic {@link DEFAULT_CONTEXT_WINDOW}
 * (272000) would understate the real window — OpenAI's Codex model registry
 * declares context_window = max_context_window = 372000 (#5705). Used as the
 * fallback only when upstream reports no value.
 */
const GPT_5_6_CONTEXT_WINDOW = 372_000;
const CODEX_REMOTE_COMPACTION = {
	enabled: true,
	api: "openai-codex-responses",
	v2StreamingEnabled: true,
} as const;
const CODEX_PROMPT_PROFILE_SCHEMA_VERSION = 1;
const MAX_CODEX_PROFILE_MODEL_ID_CHARS = 256;
const MAX_CODEX_PROFILE_BASE_INSTRUCTIONS_CHARS = 512_000;
const MAX_CODEX_PROFILE_COMP_HASH_CHARS = 1_024;
const MAX_CODEX_PROFILE_ETAG_CHARS = 4_096;
const MAX_CODEX_PROFILE_MESSAGE_CHARS = 128_000;
const MAX_CODEX_PROFILE_MODEL_MESSAGES_CHARS = 512_000;
const MAX_CODEX_PROFILE_TOKEN_BUDGET = 2_000_000;
const PERSONALITY_PLACEHOLDER = "{{ personality }}";

const CODEX_MODEL_MESSAGE_FIELDS: Readonly<Record<string, true>> = {
	instructions_template: true,
	instructions_variables: true,
	approvals: true,
	collaboration_modes: true,
	auto_review: true,
	permissions: true,
	token_budget: true,
};
const CODEX_INSTRUCTIONS_VARIABLE_FIELDS: Readonly<Record<string, true>> = {
	personality_default: true,
	personality_friendly: true,
	personality_pragmatic: true,
};
const CODEX_APPROVAL_MESSAGE_FIELDS: Readonly<Record<string, true>> = {
	on_request: true,
	on_request_auto_review: true,
	never: true,
	unless_trusted: true,
};
const CODEX_COLLABORATION_MODE_FIELDS: Readonly<Record<string, true>> = { default: true, plan: true };
const CODEX_AUTO_REVIEW_FIELDS: Readonly<Record<string, true>> = { policy: true, policy_template: true };
const CODEX_PERMISSION_FIELDS: Readonly<Record<string, true>> = {
	danger_full_access: true,
	workspace_write: true,
	read_only: true,
};
const CODEX_TOKEN_BUDGET_FIELDS: Readonly<Record<string, true>> = {
	reminder_threshold_tokens: true,
	reminder_message_template: true,
	guidance_message: true,
	auto_compact_fallback_prompt: true,
	auto_compact_fallback_buffer_tokens: true,
};

interface CodexPromptProfileProvenance {
	etag?: string;
}

const codexReasoningPresetSchema = type({
	"effort?": "unknown",
});

const codexModelEntrySchema = type({
	"slug?": "unknown",
	"id?": "unknown",
	"display_name?": "unknown",
	"context_window?": "unknown",
	"default_reasoning_level?": "unknown",
	"supported_reasoning_levels?": "unknown",
	"input_modalities?": "unknown",
	"visibility?": "unknown",
	"priority?": "unknown",
	"prefer_websockets?": "unknown",
	"use_responses_lite?": "unknown",
	"base_instructions?": "unknown",
	"model_messages?": "unknown",
	"comp_hash?": "unknown",
});

const codexModelsResponseSchema = type({
	"models?": "unknown[]",
	"data?": "unknown[]",
});

type CodexModelEntry = typeof codexModelEntrySchema.infer;
interface NormalizedCodexModel {
	model: ModelSpec<"openai-codex-responses">;
	priority: number;
}

/**
 * Fetch options for OpenAI Codex model discovery.
 */
export interface CodexModelDiscoveryOptions {
	/** OAuth access token used for `Authorization: Bearer ...`. */
	accessToken: string;
	/** ChatGPT account id value used for `chatgpt-account-id` header. */
	accountId?: string;
	/** Base URL for Codex backend. Defaults to `https://chatgpt.com/backend-api`. */
	baseUrl?: string;
	/** Optional client version attached as `client_version` query parameter. */
	clientVersion?: string;
	/** Optional endpoint path candidates. Defaults to `/codex/models`, then `/models`. */
	paths?: readonly string[];
	/** Additional headers merged on top of required Codex headers. */
	headers?: Record<string, string>;
	/** Abort signal for network request cancellation. */
	signal?: AbortSignal;
	/** Optional fetch implementation override for tests. */
	fetchFn?: FetchImpl;
}

/**
 * Normalized Codex discovery response.
 */
export interface CodexModelDiscoveryResult {
	models: ModelSpec<"openai-codex-responses">[];
	etag?: string;
}

/**
 * Fetches model metadata from Codex backend and normalizes it for pi model management.
 *
 * Returns `null` when no supported model-list route can be fetched/parsed.
 * Returns `{ models: [] }` when a route succeeds but yields no usable models.
 */
export async function fetchCodexModels(options: CodexModelDiscoveryOptions): Promise<CodexModelDiscoveryResult | null> {
	const fetchFn = discoveryFetch(options.fetchFn);
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	const paths = normalizePaths(options.paths);
	const clientVersion = normalizeClientVersion(options.clientVersion) ?? CODEX_CLIENT_VERSION;
	const headers = buildCodexHeaders(options, clientVersion);
	const profileIsTrusted = isTrustedCodexProfileBaseUrl(baseUrl);

	let sawSuccessfulResponse = false;
	for (const path of paths) {
		const requestUrl = buildModelsUrl(baseUrl, path, clientVersion);
		let response: Response;
		try {
			response = await fetchFn(requestUrl, {
				method: "GET",
				headers,
				signal: options.signal,
			});
		} catch {
			continue;
		}

		if (!response.ok) {
			continue;
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			continue;
		}

		const etag = getResponseEtag(response.headers);
		const profileProvenance =
			profileIsTrusted && (!response.headers.has("etag") || etag !== undefined) ? { etag } : undefined;
		const models = normalizeCodexModels(payload, baseUrl, profileProvenance);
		if (models === null) {
			continue;
		}
		sawSuccessfulResponse = true;
		return etag ? { models, etag } : { models };
	}
	return sawSuccessfulResponse ? { models: [] } : null;
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
	const raw = (baseUrl ?? CODEX_BASE_URL).trim();
	if (!raw) {
		return CODEX_BASE_URL;
	}
	return raw.replace(/\/+$/, "");
}

function normalizePaths(paths: readonly string[] | undefined): string[] {
	if (!paths || paths.length === 0) {
		return [...DEFAULT_MODEL_LIST_PATHS];
	}
	const normalized = paths
		.map(path => path.trim())
		.filter(path => path.length > 0)
		.map(path => (path.startsWith("/") ? path : `/${path}`));
	return normalized.length > 0 ? normalized : [...DEFAULT_MODEL_LIST_PATHS];
}

function buildModelsUrl(baseUrl: string, path: string, clientVersion: string | undefined): string {
	const url = new URL(`${baseUrl}${path}`);
	if (clientVersion && clientVersion.trim().length > 0) {
		url.searchParams.set("client_version", clientVersion.trim());
	}
	return url.toString();
}

function buildCodexHeaders(options: CodexModelDiscoveryOptions, clientVersion: string): Headers {
	const headers = new Headers(options.headers);
	headers.set("Authorization", `Bearer ${options.accessToken}`);
	if (options.accountId && options.accountId.trim().length > 0) {
		headers.set(OPENAI_HEADERS.ACCOUNT_ID, options.accountId);
	}
	headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	headers.set(OPENAI_HEADERS.VERSION, clientVersion);
	headers.set("accept", "application/json");
	return headers;
}

function normalizeClientVersion(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	if (!/^\d+\.\d+\.\d+$/.test(trimmed)) {
		return undefined;
	}
	return trimmed;
}

function normalizeCodexModels(
	payload: unknown,
	baseUrl: string,
	profileProvenance?: CodexPromptProfileProvenance,
): ModelSpec<"openai-codex-responses">[] | null {
	const parsedResponse = codexModelsResponseSchema(payload);
	if (parsedResponse instanceof type.errors) {
		return null;
	}

	const entries = parsedResponse.models ?? parsedResponse.data ?? [];
	const normalized: NormalizedCodexModel[] = [];
	for (const entry of entries) {
		const model = normalizeCodexModelEntry(entry, baseUrl, profileProvenance);
		if (model) {
			normalized.push(model);
		}
	}

	normalized.sort((left, right) => {
		if (left.priority !== right.priority) {
			return left.priority - right.priority;
		}
		return left.model.id.localeCompare(right.model.id);
	});

	return normalized.map(item => item.model);
}

function normalizeCodexModelEntry(
	entry: unknown,
	baseUrl: string,
	profileProvenance?: CodexPromptProfileProvenance,
): NormalizedCodexModel | null {
	const parsedEntry = codexModelEntrySchema(entry);
	if (parsedEntry instanceof type.errors) {
		return null;
	}

	const payload: CodexModelEntry = parsedEntry;
	const slug = toNonEmptyString(payload.slug) ?? toNonEmptyString(payload.id);
	if (!slug) {
		return null;
	}

	const visibility = toNonEmptyString(payload.visibility)?.toLowerCase();
	if (visibility === "hide" || visibility === "hidden") {
		return null;
	}

	const name = toNonEmptyString(payload.display_name) ?? slug;
	// Codex discovery omits `context_window` for GPT-5.6 luna/sol/terra; the
	// generic 272000 fallback understates their real 372000 window (#5705).
	const parsed = parseKnownModel(slug);
	const fallbackContextWindow =
		parsed.family === "openai" && semverEqual(parsed.version, "5.6")
			? GPT_5_6_CONTEXT_WINDOW
			: DEFAULT_CONTEXT_WINDOW;
	const contextWindow = toPositiveInt(payload.context_window) ?? fallbackContextWindow;
	const maxTokens = Math.min(DEFAULT_MAX_TOKENS, contextWindow);
	const reasoning = supportsReasoning(payload.default_reasoning_level, payload.supported_reasoning_levels);
	const input = normalizeInputModalities(payload.input_modalities);
	const preferWebsockets = toBoolean(payload.prefer_websockets) === true;
	const useResponsesLite = toBoolean(payload.use_responses_lite) === true;
	const priority = toFiniteNumber(payload.priority) ?? Number.MAX_SAFE_INTEGER;
	const codexPromptProfile = profileProvenance
		? normalizeCodexPromptProfile(
				slug,
				payload.base_instructions,
				payload.model_messages,
				payload.comp_hash,
				profileProvenance,
			)
		: undefined;

	return {
		priority,
		model: {
			id: slug,
			name,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl,
			reasoning,
			input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			remoteCompaction: CODEX_REMOTE_COMPACTION,
			contextWindow,
			maxTokens,
			...(preferWebsockets ? { preferWebsockets: true } : {}),
			...(useResponsesLite ? { useResponsesLite: true } : {}),
			...(codexPromptProfile ? { codexPromptProfile } : {}),
			...(priority !== Number.MAX_SAFE_INTEGER ? { priority } : {}),
		},
	};
}

function supportsReasoning(defaultReasoningLevel: unknown, supportedReasoningLevels: unknown): boolean {
	const defaultLevel = toNonEmptyString(defaultReasoningLevel)?.toLowerCase();
	if (defaultLevel && defaultLevel !== "none") {
		return true;
	}

	if (!Array.isArray(supportedReasoningLevels)) {
		return false;
	}

	for (const level of supportedReasoningLevels) {
		const parsedLevel = codexReasoningPresetSchema(level);
		if (parsedLevel instanceof type.errors) {
			continue;
		}
		const effort = toNonEmptyString(parsedLevel.effort)?.toLowerCase();
		if (effort && effort !== "none") {
			return true;
		}
	}

	return false;
}

function normalizeInputModalities(inputModalities: unknown): ("text" | "image")[] {
	if (!Array.isArray(inputModalities)) {
		return ["text", "image"];
	}

	const set = new Set<"text" | "image">();
	for (const modality of inputModalities) {
		const normalized = toNonEmptyString(modality)?.toLowerCase();
		if (normalized === "text" || normalized === "image") {
			set.add(normalized);
		}
	}

	if (set.size === 0) {
		return ["text", "image"];
	}

	const canonical: ("text" | "image")[] = ["text", "image"];
	return canonical.filter(modality => set.has(modality));
}

function getResponseEtag(headers: Headers): string | undefined {
	const etag = headers.get("etag");
	if (!etag) {
		return undefined;
	}
	const trimmed = etag.trim();
	return trimmed.length > 0 && trimmed.length <= MAX_CODEX_PROFILE_ETAG_CHARS ? trimmed : undefined;
}

function toNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function toPositiveInt(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	if (value <= 0) {
		return null;
	}
	return Math.trunc(value);
}

function toFiniteNumber(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	return value;
}

function toBoolean(value: unknown): boolean | null {
	if (typeof value !== "boolean") {
		return null;
	}
	return value;
}

/** Render only Codex's one supported personality placeholder. */
export function renderCodexPromptInstructions(
	profile: CodexPromptProfile,
	personality: CodexPromptPersonality,
): string {
	const template = profile.modelMessages.instructionsTemplate;
	const variables = profile.modelMessages.instructionsVariables;
	if (
		typeof template !== "string" ||
		countOccurrences(template, PERSONALITY_PLACEHOLDER) !== 1 ||
		!variables ||
		typeof variables.personalityDefault !== "string" ||
		typeof variables.personalityFriendly !== "string" ||
		typeof variables.personalityPragmatic !== "string"
	) {
		return profile.baseInstructions;
	}

	const personalityInstruction =
		personality === "friendly"
			? variables.personalityFriendly
			: personality === "pragmatic"
				? variables.personalityPragmatic
				: variables.personalityDefault;
	return template.replace(PERSONALITY_PLACEHOLDER, personalityInstruction);
}

function isTrustedCodexProfileBaseUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return (
			url.protocol === "https:" &&
			url.hostname === "chatgpt.com" &&
			url.port === "" &&
			url.pathname.replace(/\/+$/, "") === "/backend-api" &&
			url.search.length === 0 &&
			url.hash.length === 0
		);
	} catch {
		return false;
	}
}

function normalizeCodexPromptProfile(
	modelId: string,
	baseInstructionsValue: unknown,
	modelMessagesValue: unknown,
	compHashValue: unknown,
	provenance: CodexPromptProfileProvenance,
): CodexPromptProfile | undefined {
	if (modelId.length === 0 || modelId.length > MAX_CODEX_PROFILE_MODEL_ID_CHARS) {
		return undefined;
	}

	const baseInstructions = toNonBlankBoundedString(baseInstructionsValue, MAX_CODEX_PROFILE_BASE_INSTRUCTIONS_CHARS);
	const compHash = toNonBlankBoundedString(compHashValue, MAX_CODEX_PROFILE_COMP_HASH_CHARS);
	const modelMessages = normalizeCodexPromptModelMessages(modelMessagesValue);
	if (!baseInstructions || !compHash || !modelMessages) {
		return undefined;
	}

	const vendorDigest = calculateCodexPromptVendorDigest(modelId, baseInstructions, compHash, modelMessages);
	return {
		modelId,
		baseInstructions,
		modelMessages,
		compHash,
		...(provenance.etag ? { etag: provenance.etag } : {}),
		source: "openai-codex",
		vendorDigest,
	};
}

function normalizeCodexPromptModelMessages(value: unknown): CodexPromptModelMessages | undefined {
	const record = toStrictRecord(value, CODEX_MODEL_MESSAGE_FIELDS);
	if (!record) {
		return undefined;
	}

	const instructionsTemplate = nullableProfileString(record, "instructions_template");
	const instructionsVariables = nullableProfileSection(
		record,
		"instructions_variables",
		normalizeCodexPromptInstructionsVariables,
	);
	const approvals = nullableProfileSection(record, "approvals", normalizeCodexPromptApprovalMessages);
	const collaborationModes = nullableProfileSection(
		record,
		"collaboration_modes",
		normalizeCodexPromptCollaborationModeMessages,
	);
	const autoReview = nullableProfileSection(record, "auto_review", normalizeCodexPromptAutoReviewMessages);
	const permissions = nullableProfileSection(record, "permissions", normalizeCodexPromptPermissionMessages);
	const tokenBudget = nullableProfileSection(record, "token_budget", normalizeCodexPromptTokenBudget);
	if (
		instructionsTemplate === undefined ||
		instructionsVariables === undefined ||
		approvals === undefined ||
		collaborationModes === undefined ||
		autoReview === undefined ||
		permissions === undefined ||
		tokenBudget === undefined
	) {
		return undefined;
	}

	const modelMessages: CodexPromptModelMessages = {
		instructionsTemplate,
		instructionsVariables,
		approvals,
		collaborationModes,
		autoReview,
		permissions,
		tokenBudget,
	};
	return canonicalJson(codexPromptModelMessagesWireValue(modelMessages)).length <=
		MAX_CODEX_PROFILE_MODEL_MESSAGES_CHARS
		? modelMessages
		: undefined;
}

function normalizeCodexPromptInstructionsVariables(value: unknown): CodexPromptInstructionsVariables | undefined {
	const record = toStrictRecord(value, CODEX_INSTRUCTIONS_VARIABLE_FIELDS);
	if (!record) return undefined;

	const personalityDefault = nullableProfileString(record, "personality_default");
	const personalityFriendly = nullableProfileString(record, "personality_friendly");
	const personalityPragmatic = nullableProfileString(record, "personality_pragmatic");
	if (personalityDefault === undefined || personalityFriendly === undefined || personalityPragmatic === undefined) {
		return undefined;
	}
	return { personalityDefault, personalityFriendly, personalityPragmatic };
}

function normalizeCodexPromptApprovalMessages(value: unknown): CodexPromptApprovalMessages | undefined {
	const record = toStrictRecord(value, CODEX_APPROVAL_MESSAGE_FIELDS);
	if (!record) return undefined;

	const onRequest = nullableProfileString(record, "on_request");
	const onRequestAutoReview = nullableProfileString(record, "on_request_auto_review");
	const never = nullableProfileString(record, "never");
	const unlessTrusted = nullableProfileString(record, "unless_trusted");
	if (
		onRequest === undefined ||
		onRequestAutoReview === undefined ||
		never === undefined ||
		unlessTrusted === undefined
	) {
		return undefined;
	}
	return { onRequest, onRequestAutoReview, never, unlessTrusted };
}

function normalizeCodexPromptCollaborationModeMessages(
	value: unknown,
): CodexPromptCollaborationModeMessages | undefined {
	const record = toStrictRecord(value, CODEX_COLLABORATION_MODE_FIELDS);
	if (!record) return undefined;

	const defaultMessage = nullableProfileString(record, "default");
	const plan = nullableProfileString(record, "plan");
	if (defaultMessage === undefined || plan === undefined) return undefined;
	return { default: defaultMessage, plan };
}

function normalizeCodexPromptAutoReviewMessages(value: unknown): CodexPromptAutoReviewMessages | undefined {
	const record = toStrictRecord(value, CODEX_AUTO_REVIEW_FIELDS);
	if (!record) return undefined;

	const policy = nullableProfileString(record, "policy");
	const policyTemplate = nullableProfileString(record, "policy_template");
	if (policy === undefined || policyTemplate === undefined) return undefined;
	return { policy, policyTemplate };
}

function normalizeCodexPromptPermissionMessages(value: unknown): CodexPromptPermissionMessages | undefined {
	const record = toStrictRecord(value, CODEX_PERMISSION_FIELDS);
	if (!record) return undefined;

	const dangerFullAccess = nullableProfileString(record, "danger_full_access");
	const workspaceWrite = nullableProfileString(record, "workspace_write");
	const readOnly = nullableProfileString(record, "read_only");
	if (dangerFullAccess === undefined || workspaceWrite === undefined || readOnly === undefined) return undefined;
	return { dangerFullAccess, workspaceWrite, readOnly };
}

function normalizeCodexPromptTokenBudget(value: unknown): CodexPromptTokenBudget | undefined {
	const record = toStrictRecord(value, CODEX_TOKEN_BUDGET_FIELDS);
	if (!record) return undefined;

	const reminderThresholdTokens = toProfileTokenBudget(record.reminder_threshold_tokens);
	const reminderMessageTemplate = toBoundedString(record.reminder_message_template, MAX_CODEX_PROFILE_MESSAGE_CHARS);
	const guidanceMessage = toBoundedString(record.guidance_message, MAX_CODEX_PROFILE_MESSAGE_CHARS);
	const autoCompactFallbackPrompt = toBoundedString(
		record.auto_compact_fallback_prompt,
		MAX_CODEX_PROFILE_MESSAGE_CHARS,
	);
	const autoCompactFallbackBufferTokens = toProfileTokenBudget(record.auto_compact_fallback_buffer_tokens);
	if (
		reminderThresholdTokens === undefined ||
		reminderMessageTemplate === undefined ||
		guidanceMessage === undefined ||
		autoCompactFallbackPrompt === undefined ||
		autoCompactFallbackBufferTokens === undefined
	) {
		return undefined;
	}
	return {
		reminderThresholdTokens,
		reminderMessageTemplate,
		guidanceMessage,
		autoCompactFallbackPrompt,
		autoCompactFallbackBufferTokens,
	};
}

function nullableProfileSection<T>(
	record: Record<string, unknown>,
	field: string,
	normalize: (value: unknown) => T | undefined,
): T | null | undefined {
	if (!Object.hasOwn(record, field)) return null;
	const value = record[field];
	return value === null ? null : normalize(value);
}

function nullableProfileString(record: Record<string, unknown>, field: string): string | null | undefined {
	if (!Object.hasOwn(record, field)) return null;
	const value = record[field];
	return value === null ? null : toBoundedString(value, MAX_CODEX_PROFILE_MESSAGE_CHARS);
}

function toStrictRecord(
	value: unknown,
	allowedFields: Readonly<Record<string, true>>,
): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	const record = value as Record<string, unknown>;
	for (const field of Object.keys(record)) {
		if (allowedFields[field] !== true) return undefined;
	}
	return record;
}

function toNonBlankBoundedString(value: unknown, maximumLength: number): string | undefined {
	const parsed = toBoundedString(value, maximumLength);
	if (parsed === undefined || parsed.trim().length === 0) return undefined;
	return parsed;
}

function toBoundedString(value: unknown, maximumLength: number): string | undefined {
	if (typeof value !== "string" || value.length > maximumLength) return undefined;
	return value;
}

function toProfileTokenBudget(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
	if (value < 0 || value > MAX_CODEX_PROFILE_TOKEN_BUDGET) return undefined;
	return value;
}

function calculateCodexPromptVendorDigest(
	modelId: string,
	baseInstructions: string,
	compHash: string,
	modelMessages: CodexPromptModelMessages,
): string {
	const canonicalPayload = canonicalJson({
		schema_version: CODEX_PROMPT_PROFILE_SCHEMA_VERSION,
		source: "openai-codex",
		model_id: modelId,
		base_instructions: baseInstructions,
		comp_hash: compHash,
		model_messages: codexPromptModelMessagesWireValue(modelMessages),
	});
	return `sha256:${new Bun.CryptoHasher("sha256").update(canonicalPayload).digest("hex")}`;
}

function codexPromptModelMessagesWireValue(modelMessages: CodexPromptModelMessages): Record<string, unknown> {
	return {
		instructions_template: modelMessages.instructionsTemplate,
		instructions_variables: modelMessages.instructionsVariables && {
			personality_default: modelMessages.instructionsVariables.personalityDefault,
			personality_friendly: modelMessages.instructionsVariables.personalityFriendly,
			personality_pragmatic: modelMessages.instructionsVariables.personalityPragmatic,
		},
		approvals: modelMessages.approvals && {
			on_request: modelMessages.approvals.onRequest,
			on_request_auto_review: modelMessages.approvals.onRequestAutoReview,
			never: modelMessages.approvals.never,
			unless_trusted: modelMessages.approvals.unlessTrusted,
		},
		collaboration_modes: modelMessages.collaborationModes && {
			default: modelMessages.collaborationModes.default,
			plan: modelMessages.collaborationModes.plan,
		},
		auto_review: modelMessages.autoReview && {
			policy: modelMessages.autoReview.policy,
			policy_template: modelMessages.autoReview.policyTemplate,
		},
		permissions: modelMessages.permissions && {
			danger_full_access: modelMessages.permissions.dangerFullAccess,
			workspace_write: modelMessages.permissions.workspaceWrite,
			read_only: modelMessages.permissions.readOnly,
		},
		token_budget: modelMessages.tokenBudget && {
			reminder_threshold_tokens: modelMessages.tokenBudget.reminderThresholdTokens,
			reminder_message_template: modelMessages.tokenBudget.reminderMessageTemplate,
			guidance_message: modelMessages.tokenBudget.guidanceMessage,
			auto_compact_fallback_prompt: modelMessages.tokenBudget.autoCompactFallbackPrompt,
			auto_compact_fallback_buffer_tokens: modelMessages.tokenBudget.autoCompactFallbackBufferTokens,
		},
	};
}

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Canonical JSON requires finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	throw new Error("Canonical JSON supports only JSON values");
}

function countOccurrences(value: string, needle: string): number {
	let count = 0;
	let index = value.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = value.indexOf(needle, index + needle.length);
	}
	return count;
}
