/**
 * Tool output pruning utilities for compaction.
 */

import type { TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { AgentMessage, AgentToolCall } from "../types";
import { estimateTokens } from "./compaction";
import type { SessionEntry, SessionMessageEntry } from "./entries";
import { invalidateMessageCache } from "./message-cache";
import {
	collectToolCallsById,
	isProtectedToolResult,
	isSkillReadToolResult,
	type ProtectedToolMatcher,
} from "./tool-protection";
import { splitReadSelector } from "./utils";

export interface PruneConfig {
	/** Keep the most recent tool output tokens intact. */
	protectTokens: number;
	/** Only prune if total savings meets this threshold. */
	minimumSavings: number;
	/** Tool-result protection matchers. String entries protect every result from that tool; predicates may inspect the paired tool call. */
	protectedTools: ProtectedToolMatcher[];
	/**
	 * Optional supersede key function (see {@link SupersedePruneConfig.supersedeKey}).
	 * When provided, superseded tool results are pruned first — even inside the
	 * `protectTokens` window — before age-based victims. Absent, behavior is
	 * unchanged.
	 */
	supersedeKey?: SupersedeKeyFn;
	/** Useless-flagged results bypass the protect window (see {@link USELESS_NOTICE}). Default true. */
	pruneUseless?: boolean;
	/** Prune earlier exact duplicate results. Default false unless enabled by the caller. */
	pruneDuplicates?: boolean;
	/** Prune errors only after the same operation later succeeds. Default false unless enabled by the caller. */
	pruneResolvedErrors?: boolean;
	/**
	 * Compaction boundary: the `firstKeptEntryId` of the latest compaction on
	 * the branch. Entries at indices BEFORE this id are summarized away and never
	 * sent to the model, so mutating them only churns persisted history without
	 * shrinking the prompt — they are skipped. Undefined = no compaction (the
	 * whole branch is sent).
	 */
	keepBoundaryId?: string;
	/**
	 * Prompt-cache guard. When set, a tool result whose all-message suffix
	 * (tokens of every message after it) EXCEEDS this is part of the warm,
	 * already-sent cache prefix: mutating it forces the provider to re-write the
	 * whole suffix (cacheWrite premium). Such results — including superseded and
	 * useless ones, which otherwise bypass {@link protectTokens} — are left for
	 * compaction/shake (which rebuild the cache anyway) to reclaim. Undefined =
	 * no cache guard (legacy: superseded/useless prune at any depth).
	 */
	cacheWarmSuffixTokens?: number;
	/** Recent suffix retained before a proven-resolved error becomes eligible. Defaults to {@link protectTokens}. */
	resolvedErrorProtectTokens?: number;
}

export const DEFAULT_PRUNE_CONFIG: PruneConfig = {
	protectTokens: 40_000,
	minimumSavings: 20_000,
	protectedTools: ["skill", isSkillReadToolResult],
	pruneUseless: true,
};

export type PruneReason = "superseded" | "useless" | "duplicate" | "resolved-error" | "age";

export interface PruneCandidate {
	entry: SessionMessageEntry;
	index: number;
	tokens: number;
	reason: PruneReason;
	notice: string;
	requiresArchive: boolean;
	toolName: string;
	canonicalArgs: string;
	textBlocks: readonly string[];
}

export interface PruneMetrics {
	considered: number;
	selected: number;
	byReason: Record<PruneReason, number>;
	skippedBoundary: number;
	skippedWarmPrefix: number;
	skippedProtected: number;
	skippedRecent: number;
	skippedSmall: number;
	skippedMinimumSavings: number;
	estimatedTokensSaved: number;
}

export interface PrunePlan {
	candidates: PruneCandidate[];
	metrics: PruneMetrics;
}

export interface PruneBudget {
	protectTokens: number;
	minimumSavings: number;
	cacheWarmSuffixTokens: number;
}

export interface PruneResult {
	prunedCount: number;
	tokensSaved: number;
}

/** Exact placeholder written over a superseded tool result. */
export const SUPERSEDED_NOTICE = "[Superseded by a newer read of this file]";

/** Exact placeholder written over an elided useless tool result. */
export const USELESS_NOTICE = "[Uneventful result elided]";

/** Exact placeholder written over an earlier byte-identical result. */
export const DUPLICATE_NOTICE = "[Duplicate of a later identical tool result]";

/** Exact placeholder written over an error proven obsolete by a later successful retry. */
export const RESOLVED_ERROR_NOTICE = "[Earlier error resolved by a later successful retry]";

/**
 * Maps a tool call to a supersede key. Results sharing a key form a group in
 * which every result except the newest is a supersede candidate. A key `K`
 * additionally supersedes keys with prefix `K + "\u0000"` (selector-free read
 * supersedes selector-carrying reads of the same base path). Return
 * `undefined` to exempt a call from supersede grouping.
 */
export type SupersedeKeyFn = (toolName: string, args: Record<string, unknown>) => string | undefined;

export interface SupersedePruneConfig {
	/** Supersede key function; results sharing a key supersede older ones. */
	supersedeKey?: SupersedeKeyFn;
	/** Also prune results flagged useless by their tool. Default false. */
	pruneUseless?: boolean;
	/** Also prune earlier exact duplicate results. Default false. */
	pruneDuplicates?: boolean;
	/** Also prune errors proven resolved by a later successful result. Default false. */
	pruneResolvedErrors?: boolean;
	/** Recent all-message suffix retained before a resolved error becomes eligible. Default 40 000. */
	resolvedErrorProtectTokens?: number;
	/** Prune a candidate now when all messages after it total at most this many estimated tokens. Default 8 000. */
	suffixTokenLimit?: number;
	/**
	 * Prune all candidates when the last message is at least this old: the
	 * provider prompt cache is then cold, so re-writing it is free. MUST exceed
	 * the cache retention (Anthropic "long" = 1h) or a still-warm prefix is busted
	 * by the flush. Default 30 min — callers on long retention override it.
	 */
	idleFlushMs?: number;
	/** Clock override for tests. */
	now?: number;
	/**
	 * Compaction boundary (`firstKeptEntryId` of the latest compaction). Entries
	 * before it are summarized away and never sent, so they are skipped in every
	 * path — including the idle flush — to avoid pointless history churn.
	 * Undefined = no compaction (the whole branch is sent).
	 */
	keepBoundaryId?: string;
	/** Tool-result protection matchers (same contract as {@link PruneConfig.protectedTools}). */
	protectedTools: ProtectedToolMatcher[];
}

const DEFAULT_SUFFIX_TOKEN_LIMIT = 8_000;
const DEFAULT_IDLE_FLUSH_MS = 30 * 60_000;

const BASELINE_CONTEXT_WINDOW = 200_000;

function scaleBudget(contextWindow: number, baseline: number, minimum: number, maximum: number): number {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return baseline;
	return Math.min(maximum, Math.max(minimum, Math.round((contextWindow / BASELINE_CONTEXT_WINDOW) * baseline)));
}

/** Resolve pruning budgets while preserving the established 200k-window behavior. */
export function resolvePruneBudget(
	contextWindow: number | null | undefined,
	protectTokensOverride?: number,
): PruneBudget {
	const window = contextWindow ?? BASELINE_CONTEXT_WINDOW;
	const adaptiveProtectTokens = scaleBudget(window, 40_000, 8_000, 80_000);
	const protectTokens =
		protectTokensOverride !== undefined && Number.isFinite(protectTokensOverride) && protectTokensOverride > 0
			? Math.round(protectTokensOverride)
			: adaptiveProtectTokens;
	return {
		protectTokens,
		minimumSavings: scaleBudget(window, 20_000, 2_000, 40_000),
		cacheWarmSuffixTokens: scaleBudget(window, 8_000, 2_000, 16_000),
	};
}

function emptyReasonCounts(): Record<PruneReason, number> {
	return { superseded: 0, useless: 0, duplicate: 0, "resolved-error": 0, age: 0 };
}

function createMetrics(): PruneMetrics {
	return {
		considered: 0,
		selected: 0,
		byReason: emptyReasonCounts(),
		skippedBoundary: 0,
		skippedWarmPrefix: 0,
		skippedProtected: 0,
		skippedRecent: 0,
		skippedSmall: 0,
		skippedMinimumSavings: 0,
		estimatedTokensSaved: 0,
	};
}

function emptyPlan(metrics = createMetrics()): PrunePlan {
	return { candidates: [], metrics };
}

function canonicalizeJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
	if (Array.isArray(value)) return `[${value.map(item => canonicalizeJson(item)).join(",")}]`;
	if (typeof value !== "object") return "null";
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.filter(key => record[key] !== undefined)
		.map(key => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
		.join(",")}}`;
}

/** Stable operation identity shared by pruning and deterministic compaction facts. */
export function toolOperationKey(toolName: string, args: unknown): string {
	return `${toolName}\u0000${canonicalizeJson(args)}`;
}

function textBlocks(message: ToolResultMessage): readonly string[] | undefined {
	if (!message.content.every((block): block is TextContent => block.type === "text")) return undefined;
	return message.content.map(block => block.text);
}

function sameTextBlocks(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((text, index) => text === right[index]);
}

function createPrunedNotice(tokens: number): string {
	return `[Output truncated - ${tokens} tokens]`;
}

/**
 * Generic age-based pruning floor. Below this, blanking a result to
 * `[Output truncated - N tokens]` recovers nothing — the placeholder itself
 * costs ~8 tokens, so a sub-floor result grows the context (and churns the
 * prompt cache) instead of shrinking it. Superseded/useless results keep their
 * own rules: useless already drops no-savings candidates, superseded prunes for
 * correctness regardless of size.
 */
const MIN_PRUNE_TOKENS = 50;

function getToolResultMessage(entry: SessionEntry): ToolResultMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as AgentMessage;
	if (message.role !== "toolResult") return undefined;
	return message as ToolResultMessage;
}

function estimatePrunedSavings(tokens: number, notice: string): number {
	const noticeTokens = Math.ceil(notice.length / 4);
	return Math.max(0, tokens - noticeTokens);
}

/**
 * For each entry index, the estimated token total of all *message* entries
 * strictly after it — how much prompt-cache content the provider must re-write
 * (cacheWrite premium) if that entry is mutated in place. Used to keep prune
 * mutations inside the cheap-to-recache tail.
 */
function computeMessageSuffixTokens(entries: readonly SessionEntry[]): number[] {
	const suffix = new Array<number>(entries.length);
	let accumulated = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		suffix[i] = accumulated;
		const entry = entries[i];
		if (entry.type === "message") accumulated += estimateTokens(entry.message as AgentMessage);
	}
	return suffix;
}

/**
 * Resolve the array index of the compaction boundary (`keepBoundaryId`). Entries
 * before this index are summarized away by the latest compaction and never sent,
 * so prune passes must not mutate them. Returns 0 when there is no boundary (no
 * compaction → whole branch is sent) or the id is absent from `entries`.
 */
function resolveBoundaryIndex(entries: readonly SessionEntry[], keepBoundaryId: string | undefined): number {
	if (keepBoundaryId === undefined) return 0;
	const index = entries.findIndex(entry => entry.id === keepBoundaryId);
	return index < 0 ? 0 : index;
}

function createCandidate(
	entry: SessionEntry,
	index: number,
	message: ToolResultMessage,
	toolCall: AgentToolCall | undefined,
	reason: PruneReason,
	notice: string,
	requiresArchive: boolean,
): PruneCandidate | undefined {
	const blocks = textBlocks(message);
	if (!blocks) return undefined;
	return {
		entry: entry as SessionMessageEntry,
		index,
		tokens: estimateTokens(message as AgentMessage),
		reason,
		notice,
		requiresArchive,
		toolName: toolCall?.name ?? message.toolName,
		canonicalArgs: canonicalizeJson(toolCall?.arguments ?? {}),
		textBlocks: blocks,
	};
}

/** Collect stale results superseded by a later call in the same key group. */
function collectSupersededResults(
	entries: readonly SessionEntry[],
	toolCallsById: ReadonlyMap<string, AgentToolCall>,
	supersedeKey: SupersedeKeyFn,
	protectedTools: readonly ProtectedToolMatcher[],
): PruneCandidate[] {
	const candidates: PruneCandidate[] = [];
	const seenKeys = new Set<string>();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message || message.prunedAt !== undefined) continue;
		const toolCall = toolCallsById.get(message.toolCallId);
		if (!toolCall || isProtectedToolResult(message, toolCall, protectedTools)) continue;
		const key = supersedeKey(toolCall.name, toolCall.arguments as Record<string, unknown>);
		if (key === undefined) continue;
		const separator = key.indexOf("\u0000");
		const superseded = seenKeys.has(key) || (separator >= 0 && seenKeys.has(key.slice(0, separator)));
		seenKeys.add(key);
		if (!superseded) continue;
		const candidate = createCandidate(entry, i, message, toolCall, "superseded", SUPERSEDED_NOTICE, true);
		if (candidate) candidates.push(candidate);
	}
	return candidates.reverse();
}

/** Collect exact text duplicates while retaining the newest byte-identical result. */
function collectDuplicateResults(
	entries: readonly SessionEntry[],
	toolCallsById: ReadonlyMap<string, AgentToolCall>,
	protectedTools: readonly ProtectedToolMatcher[],
	exclude: ReadonlySet<ToolResultMessage>,
): PruneCandidate[] {
	type SeenResult = { blocks: readonly string[] };
	const seen = new Map<string, Map<string, SeenResult[]>>();
	const candidates: PruneCandidate[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message || message.prunedAt !== undefined) continue;
		const toolCall = toolCallsById.get(message.toolCallId);
		if (!toolCall || isProtectedToolResult(message, toolCall, protectedTools)) continue;
		const blocks = textBlocks(message);
		if (!blocks) continue;
		const operation = `${toolOperationKey(toolCall.name, toolCall.arguments)}\u0000${message.isError ? "error" : "success"}`;
		let hashes = seen.get(operation);
		if (!hashes) {
			hashes = new Map();
			seen.set(operation, hashes);
		}
		const hashInput = blocks.length === 1 ? blocks[0] : blocks.join("\u0000");
		const hash = String(Bun.hash(hashInput));
		let bucket = hashes.get(hash);
		if (!bucket) {
			bucket = [];
			hashes.set(hash, bucket);
		}
		const duplicate = bucket.some(result => sameTextBlocks(result.blocks, blocks));
		bucket.push({ blocks });
		if (!duplicate || exclude.has(message)) continue;
		const candidate = createCandidate(entry, i, message, toolCall, "duplicate", DUPLICATE_NOTICE, false);
		if (candidate) candidates.push(candidate);
	}
	return candidates.reverse();
}

function isConclusiveSuccess(message: ToolResultMessage): boolean {
	if (message.isError) return false;
	const details = message.details;
	if (details === null || typeof details !== "object" || !("async" in details)) return true;
	const asyncDetails = details.async;
	if (asyncDetails === null || typeof asyncDetails !== "object" || !("state" in asyncDetails)) return true;
	return asyncDetails.state !== "running";
}

/** Collect errors whose exact operation key later produced a conclusive success. */
function collectResolvedErrors(
	entries: readonly SessionEntry[],
	toolCallsById: ReadonlyMap<string, AgentToolCall>,
	protectedTools: readonly ProtectedToolMatcher[],
	exclude: ReadonlySet<ToolResultMessage>,
): PruneCandidate[] {
	const laterSuccesses = new Set<string>();
	const candidates: PruneCandidate[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message || message.prunedAt !== undefined) continue;
		const toolCall = toolCallsById.get(message.toolCallId);
		if (!toolCall || isProtectedToolResult(message, toolCall, protectedTools)) continue;
		const operation = toolOperationKey(toolCall.name, toolCall.arguments);
		if (isConclusiveSuccess(message)) {
			laterSuccesses.add(operation);
			continue;
		}
		if (!message.isError || !laterSuccesses.has(operation) || exclude.has(message)) continue;
		const candidate = createCandidate(entry, i, message, toolCall, "resolved-error", RESOLVED_ERROR_NOTICE, true);
		if (candidate) candidates.push(candidate);
	}
	return candidates.reverse();
}

/** Collect non-error results explicitly marked contextually useless by their tool. */
function collectUselessResults(
	entries: readonly SessionEntry[],
	toolCallsById: ReadonlyMap<string, AgentToolCall>,
	protectedTools: readonly ProtectedToolMatcher[],
	exclude: ReadonlySet<ToolResultMessage>,
): PruneCandidate[] {
	const candidates: PruneCandidate[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (message?.useless !== true || message.prunedAt !== undefined || message.isError || exclude.has(message))
			continue;
		const toolCall = toolCallsById.get(message.toolCallId);
		if (!toolCall || isProtectedToolResult(message, toolCall, protectedTools)) continue;
		const tokens = estimateTokens(message as AgentMessage);
		if (estimatePrunedSavings(tokens, USELESS_NOTICE) <= 0) continue;
		const candidate = createCandidate(entry, i, message, toolCall, "useless", USELESS_NOTICE, false);
		if (candidate) candidates.push(candidate);
	}
	return candidates;
}

function candidateMessage(candidate: PruneCandidate): ToolResultMessage {
	return candidate.entry.message as ToolResultMessage;
}

function countBaseCandidates(
	entries: readonly SessionEntry[],
	toolCallsById: ReadonlyMap<string, AgentToolCall>,
	protectedTools: readonly ProtectedToolMatcher[],
	metrics: PruneMetrics,
): void {
	for (const entry of entries) {
		const message = getToolResultMessage(entry);
		if (!message || message.prunedAt !== undefined) continue;
		metrics.considered++;
		if (isProtectedToolResult(message, toolCallsById.get(message.toolCallId), protectedTools)) {
			metrics.skippedProtected++;
		}
	}
}

function finalizePlan(candidates: PruneCandidate[], metrics: PruneMetrics): PrunePlan {
	metrics.selected = candidates.length;
	for (const candidate of candidates) {
		metrics.byReason[candidate.reason]++;
		metrics.estimatedTokensSaved += estimatePrunedSavings(candidate.tokens, candidate.notice);
	}
	return { candidates, metrics };
}

/** Plan cheap per-turn pruning without mutating session history. */
export function planSupersededToolResults(entries: readonly SessionEntry[], config: SupersedePruneConfig): PrunePlan {
	const metrics = createMetrics();
	const toolCallsById = collectToolCallsById(entries);
	countBaseCandidates(entries, toolCallsById, config.protectedTools, metrics);
	const candidates = config.supersedeKey
		? collectSupersededResults(entries, toolCallsById, config.supersedeKey, config.protectedTools)
		: [];
	const excluded = new Set(candidates.map(candidateMessage));
	if (config.pruneDuplicates) {
		const duplicates = collectDuplicateResults(entries, toolCallsById, config.protectedTools, excluded);
		candidates.push(...duplicates);
		for (const candidate of duplicates) excluded.add(candidateMessage(candidate));
	}
	if (config.pruneUseless) {
		const useless = collectUselessResults(entries, toolCallsById, config.protectedTools, excluded);
		candidates.push(...useless);
		for (const candidate of useless) excluded.add(candidateMessage(candidate));
	}
	if (config.pruneResolvedErrors) {
		candidates.push(...collectResolvedErrors(entries, toolCallsById, config.protectedTools, excluded));
	}
	if (candidates.length === 0) return emptyPlan(metrics);
	candidates.sort((left, right) => left.index - right.index);

	const now = config.now ?? Date.now();
	let lastMessageTimestamp: number | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const timestamp = (entry.message as AgentMessage).timestamp;
		if (typeof timestamp === "number") lastMessageTimestamp = timestamp;
		break;
	}
	const idle =
		lastMessageTimestamp !== undefined && now - lastMessageTimestamp >= (config.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS);
	const boundaryIndex = resolveBoundaryIndex(entries, config.keepBoundaryId);
	const suffixTokens = computeMessageSuffixTokens(entries);
	const suffixTokenLimit = config.suffixTokenLimit ?? DEFAULT_SUFFIX_TOKEN_LIMIT;
	const resolvedErrorProtectTokens = config.resolvedErrorProtectTokens ?? DEFAULT_PRUNE_CONFIG.protectTokens;
	const selected: PruneCandidate[] = [];
	for (const candidate of candidates) {
		if (candidate.index < boundaryIndex) {
			metrics.skippedBoundary++;
			continue;
		}
		if (candidate.reason === "resolved-error") {
			if (!idle || suffixTokens[candidate.index] < resolvedErrorProtectTokens) {
				metrics.skippedRecent++;
				continue;
			}
		} else if (!idle && suffixTokens[candidate.index] > suffixTokenLimit) {
			metrics.skippedWarmPrefix++;
			continue;
		}
		selected.push(candidate);
	}
	return selected.length > 0 ? finalizePlan(selected, metrics) : emptyPlan(metrics);
}

/** Apply a prepared plan. Callers may substitute recoverable placeholders or omit candidates after archival failure. */
export function applyPrunePlan(
	plan: PrunePlan,
	options?: {
		candidates?: readonly PruneCandidate[];
		replacements?: ReadonlyMap<PruneCandidate, string>;
	},
): PruneResult {
	const candidates = options?.candidates ?? plan.candidates;
	if (candidates.length === 0) return { prunedCount: 0, tokensSaved: 0 };
	const prunedAt = Date.now();
	let tokensSaved = 0;
	for (const candidate of candidates) {
		const message = candidateMessage(candidate);
		const notice = options?.replacements?.get(candidate) ?? candidate.notice;
		message.content = [{ type: "text", text: notice }];
		message.prunedAt = prunedAt;
		invalidateMessageCache(message as AgentMessage);
		tokensSaved += estimatePrunedSavings(candidate.tokens, notice);
	}
	return { prunedCount: candidates.length, tokensSaved };
}

/** Backward-compatible synchronous convenience wrapper. */
export function pruneSupersededToolResults(entries: SessionEntry[], config: SupersedePruneConfig): PruneResult {
	return applyPrunePlan(planSupersededToolResults(entries, config));
}

/** Plan threshold-based pruning without mutating session history. */
export function planToolOutputPruning(
	entries: readonly SessionEntry[],
	config: PruneConfig = DEFAULT_PRUNE_CONFIG,
): PrunePlan {
	const metrics = createMetrics();
	const toolCallsById = collectToolCallsById(entries);
	countBaseCandidates(entries, toolCallsById, config.protectedTools, metrics);
	const classified = new Map<ToolResultMessage, PruneCandidate>();
	if (config.supersedeKey) {
		for (const candidate of collectSupersededResults(
			entries,
			toolCallsById,
			config.supersedeKey,
			config.protectedTools,
		)) {
			classified.set(candidateMessage(candidate), candidate);
		}
	}
	let excluded = new Set(classified.keys());
	if (config.pruneDuplicates) {
		for (const candidate of collectDuplicateResults(entries, toolCallsById, config.protectedTools, excluded)) {
			classified.set(candidateMessage(candidate), candidate);
		}
		excluded = new Set(classified.keys());
	}
	if (config.pruneUseless !== false) {
		for (const candidate of collectUselessResults(entries, toolCallsById, config.protectedTools, excluded)) {
			classified.set(candidateMessage(candidate), candidate);
		}
		excluded = new Set(classified.keys());
	}
	if (config.pruneResolvedErrors) {
		for (const candidate of collectResolvedErrors(entries, toolCallsById, config.protectedTools, excluded)) {
			classified.set(candidateMessage(candidate), candidate);
		}
	}

	let accumulatedTokens = 0;
	const candidates: PruneCandidate[] = [];
	const boundaryIndex = resolveBoundaryIndex(entries, config.keepBoundaryId);
	const cacheWarmSuffixTokens = config.cacheWarmSuffixTokens;
	const messageSuffix = cacheWarmSuffixTokens === undefined ? undefined : computeMessageSuffixTokens(entries);
	const resolvedErrorProtectTokens = config.resolvedErrorProtectTokens ?? config.protectTokens;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message) continue;
		const tokens = estimateTokens(message as AgentMessage);
		if (message.prunedAt !== undefined) {
			accumulatedTokens += tokens;
			continue;
		}
		if (i < boundaryIndex) {
			metrics.skippedBoundary++;
			accumulatedTokens += tokens;
			continue;
		}
		if (
			messageSuffix !== undefined &&
			cacheWarmSuffixTokens !== undefined &&
			messageSuffix[i] > cacheWarmSuffixTokens
		) {
			metrics.skippedWarmPrefix++;
			accumulatedTokens += tokens;
			continue;
		}
		const toolCall = toolCallsById.get(message.toolCallId);
		if (isProtectedToolResult(message, toolCall, config.protectedTools)) {
			accumulatedTokens += tokens;
			continue;
		}

		let candidate = classified.get(message);
		if (message.isError && candidate?.reason !== "resolved-error") {
			accumulatedTokens += tokens;
			continue;
		}
		const bypassRecent =
			candidate?.reason === "superseded" || candidate?.reason === "useless" || candidate?.reason === "duplicate";
		const protectTokens = candidate?.reason === "resolved-error" ? resolvedErrorProtectTokens : config.protectTokens;
		if (!bypassRecent && accumulatedTokens < protectTokens) {
			metrics.skippedRecent++;
			accumulatedTokens += tokens;
			continue;
		}
		if (!candidate) {
			if (tokens < MIN_PRUNE_TOKENS) {
				metrics.skippedSmall++;
				accumulatedTokens += tokens;
				continue;
			}
			candidate = createCandidate(entry, i, message, toolCall, "age", createPrunedNotice(tokens), true);
		}
		if (!candidate || estimatePrunedSavings(candidate.tokens, candidate.notice) <= 0) {
			metrics.skippedSmall++;
			accumulatedTokens += tokens;
			continue;
		}
		candidates.push(candidate);
		accumulatedTokens += tokens;
	}

	const tokensSaved = candidates.reduce(
		(total, candidate) => total + estimatePrunedSavings(candidate.tokens, candidate.notice),
		0,
	);
	if (candidates.length === 0 || tokensSaved < config.minimumSavings) {
		metrics.skippedMinimumSavings = candidates.length;
		return emptyPlan(metrics);
	}
	return finalizePlan(candidates, metrics);
}

/** Backward-compatible synchronous convenience wrapper. */
export function pruneToolOutputs(entries: SessionEntry[], config: PruneConfig = DEFAULT_PRUNE_CONFIG): PruneResult {
	return applyPrunePlan(planToolOutputPruning(entries, config));
}

/**
 * Supersede key for the `read` tool: the file path with the trailing line/raw
 * selector stripped (the read tool's own splitter grammar via
 * {@link splitReadSelector}, e.g. `src/foo.ts:50-200`, `:2-4:raw`).
 * Internal/URL-scheme paths (`skill://…`, `https://…`) are exempt.
 * Selector-free reads key on the bare path; selector-carrying reads key on
 * `path + "\u0000" + selector`, so two reads collide only when the newer is
 * selector-free or the selectors are identical (the pass's prefix rule lets a
 * bare-path read supersede selector-carrying reads of the same file).
 */
export function readToolSupersedeKey(toolName: string, args: Record<string, unknown>): string | undefined {
	if (toolName !== "read") return undefined;
	const path = args.path;
	if (typeof path !== "string" || path.length === 0) return undefined;
	if (path.includes("://")) return undefined;
	const { path: base, sel } = splitReadSelector(path);
	return sel === undefined ? base : `${base}\u0000${sel}`;
}
