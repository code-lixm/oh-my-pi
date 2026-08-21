/**
 * Structured metadata for tool outputs.
 *
 * Tools populate details.meta using the fluent OutputMetaBuilder.
 * The tool wrapper automatically formats and appends notices at message boundary.
 */
import type {
	AgentTool,
	AgentToolContext,
	AgentToolExecFn,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { getDefault, type Settings } from "../config/settings";
import { tSettingsUi } from "../i18n/settings-locale";
import { formatGroupedDiagnosticMessages } from "../lsp/utils";
import type { Theme } from "../modes/theme/theme";
import {
	type OutputSummary,
	type TruncationResult,
	truncateHeadBytes,
	truncateMiddle,
	truncateTail,
	truncateTailBytes,
} from "../session/streaming-output";
import { formatBytes, wrapBrackets } from "./render-utils";
import { renderError } from "./tool-errors";
import { recordLiveToolPreview } from "./tool-output-telemetry";

/**
 * Truncation metadata for the output notice.
 */
export interface TruncationMeta {
	direction: "head" | "tail" | "middle";
	truncatedBy: "lines" | "bytes" | "middle";
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	maxBytes?: number;
	/** Line range shown (1-indexed, inclusive). Omitted for middle elision. */
	shownRange?: { start: number; end: number };
	/** Head/tail line ranges shown when direction === "middle". */
	headRange?: { start: number; end: number };
	tailRange?: { start: number; end: number };
	/** Bytes elided from the middle. */
	elidedBytes?: number;
	/** Lines elided from the middle. */
	elidedLines?: number;
	/** Artifact ID if full output was saved */
	artifactId?: string;
	/** Next offset for pagination (head truncation only) */
	nextOffset?: number;
}

/**
 * Source resolution info for the output.
 */
export type SourceMeta =
	| { type: "path"; value: string }
	| { type: "url"; value: string }
	| { type: "internal"; value: string };

/**
 * LSP diagnostic info (for edit/write tools).
 */
export interface DiagnosticMeta {
	summary: string;
	messages: string[];
}

/**
 * Limit-specific notices.
 */
export interface LimitsMeta {
	matchLimit?: { reached: number; suggestion: number };
	resultLimit?: { reached: number; suggestion: number };
	headLimit?: { reached: number; suggestion: number };
	columnTruncated?: { maxColumn: number };
}

/**
 * Structured metadata for tool outputs.
 */
export interface OutputMeta {
	truncation?: TruncationMeta;
	source?: SourceMeta;
	diagnostics?: DiagnosticMeta;
	limits?: LimitsMeta;
}

// =============================================================================
// OutputMetaBuilder - Fluent API for building OutputMeta
// =============================================================================

export interface TruncationOptions {
	direction: "head" | "tail" | "middle";
	startLine?: number;
	totalFileLines?: number;
	artifactId?: string;
}

export interface TruncationSummaryOptions {
	direction: "head" | "tail" | "middle";
	startLine?: number;
	totalFileLines?: number;
}

export interface TruncationTextOptions {
	direction: "head" | "tail" | "middle";
	totalLines?: number;
	totalBytes?: number;
	maxBytes?: number;
}

/**
 * Fluent builder for OutputMeta.
 *
 * @example
 * ```ts
 * details.meta = outputMeta()
 *   .truncation(truncation, { direction: "head" })
 *   .matchLimit(limitReached ? effectiveLimit : 0)
 *   .columnTruncated(linesTruncated ? DEFAULT_MAX_COLUMN : 0)
 *   .get();
 * ```
 */
export class OutputMetaBuilder {
	#meta: OutputMeta = {};

	/** Add truncation info from TruncationResult. No-op if not truncated. */
	truncation(result: TruncationResult, options: TruncationOptions): this {
		if (!result.truncated) return this;

		const { direction, startLine = 1, totalFileLines, artifactId } = options;
		const outputLines = result.outputLines ?? result.totalLines;
		const outputBytes = result.outputBytes ?? result.totalBytes;
		const isMiddle = direction === "middle" || result.truncatedBy === "middle";
		const truncatedBy: "lines" | "bytes" | "middle" = isMiddle
			? "middle"
			: result.truncatedBy === "lines"
				? "lines"
				: "bytes";

		const effectiveTotalLines = totalFileLines ?? result.totalLines;

		if (isMiddle) {
			const elidedLines = result.elidedLines ?? Math.max(0, effectiveTotalLines - outputLines);
			const elidedBytes = result.elidedBytes ?? Math.max(0, result.totalBytes - outputBytes);
			// Reconstruct head/tail line ranges. The kept output spans the first
			// `headLines` lines and the last `tailLines` lines of the source; lines
			// in the middle (count == elidedLines) are dropped.
			const keptLines = Math.max(0, outputLines - 1); // -1 for marker line
			const headLines = Math.ceil(keptLines / 2);
			const tailLines = keptLines - headLines;
			this.#meta.truncation = {
				direction: "middle",
				truncatedBy: "middle",
				totalLines: effectiveTotalLines,
				totalBytes: result.totalBytes,
				outputLines,
				outputBytes,
				headRange: headLines > 0 ? { start: 1, end: headLines } : undefined,
				tailRange:
					tailLines > 0 ? { start: effectiveTotalLines - tailLines + 1, end: effectiveTotalLines } : undefined,
				elidedLines,
				elidedBytes,
				artifactId,
			};
			return this;
		}

		let shownStart: number;
		let shownEnd: number;

		if (direction === "tail") {
			shownStart = result.totalLines - outputLines + 1;
			shownEnd = result.totalLines;
		} else {
			shownStart = startLine;
			shownEnd = startLine + outputLines - 1;
		}

		this.#meta.truncation = {
			direction,
			truncatedBy,
			totalLines: effectiveTotalLines,
			totalBytes: result.totalBytes,
			outputLines,
			outputBytes,
			shownRange: { start: shownStart, end: shownEnd },
			artifactId,
			nextOffset: direction === "head" ? shownEnd + 1 : undefined,
		};

		return this;
	}

	/** Add truncation info from OutputSummary. No-op if not truncated. */
	truncationFromSummary(summary: OutputSummary, options: TruncationSummaryOptions): this {
		// A per-line column cap only trims individual lines (with a `…` marker);
		// it is not a window/byte truncation, so surface it as its own limit
		// notice rather than a "Showing lines X-Y … limit" range. This runs even
		// when the output is otherwise complete (`truncated === false`).
		if (summary.columnMax != null && summary.columnMax > 0 && (summary.columnTruncatedLines ?? 0) > 0) {
			this.columnTruncated(summary.columnMax);
		}
		if (!summary.truncated) return this;

		const { direction, startLine = 1, totalFileLines } = options;
		const totalLines = totalFileLines ?? summary.totalLines;

		// Middle elision: the sink retained head + tail with an elision marker.
		if (summary.elidedBytes != null && summary.elidedBytes > 0) {
			const elidedLines = summary.elidedLines ?? Math.max(0, totalLines - summary.outputLines);
			const keptLines = Math.max(0, summary.outputLines - 1); // -1 for marker line
			const headLines = Math.ceil(keptLines / 2);
			const tailLines = keptLines - headLines;
			this.#meta.truncation = {
				direction: "middle",
				truncatedBy: "middle",
				totalLines,
				totalBytes: summary.totalBytes,
				outputLines: summary.outputLines,
				outputBytes: summary.outputBytes,
				headRange: headLines > 0 ? { start: 1, end: headLines } : undefined,
				tailRange: tailLines > 0 ? { start: totalLines - tailLines + 1, end: totalLines } : undefined,
				elidedBytes: summary.elidedBytes,
				elidedLines,
				artifactId: summary.artifactId,
			};
			return this;
		}

		const truncatedBy: "lines" | "bytes" =
			summary.outputBytes < summary.totalBytes
				? "bytes"
				: summary.outputLines < summary.totalLines
					? "lines"
					: "bytes";

		let shownStart: number;
		let shownEnd: number;

		if (direction === "tail") {
			shownStart = totalLines - summary.outputLines + 1;
			shownEnd = totalLines;
		} else {
			shownStart = startLine;
			shownEnd = startLine + summary.outputLines - 1;
		}

		this.#meta.truncation = {
			direction,
			truncatedBy,
			totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			shownRange: { start: shownStart, end: shownEnd },
			artifactId: summary.artifactId,
			nextOffset: direction === "head" ? shownEnd + 1 : undefined,
		};

		return this;
	}

	/** Add truncation info from truncated output text. No-op if truncation not detected. */
	truncationFromText(text: string, options: TruncationTextOptions): this {
		const outputLines = text.length > 0 ? text.split("\n").length : 0;
		const outputBytes = Buffer.byteLength(text, "utf-8");
		const totalLines = options.totalLines ?? outputLines;
		const totalBytes = options.totalBytes ?? outputBytes;

		const truncated = totalLines > outputLines || totalBytes > outputBytes || false;
		if (!truncated) return this;

		const truncatedBy: "lines" | "bytes" =
			options.maxBytes && outputBytes >= options.maxBytes
				? "bytes"
				: totalBytes > outputBytes
					? "bytes"
					: totalLines > outputLines
						? "lines"
						: "bytes";

		let shownStart: number;
		let shownEnd: number;

		if (options.direction === "tail") {
			shownStart = totalLines - outputLines + 1;
			shownEnd = totalLines;
		} else {
			shownStart = 1;
			shownEnd = outputLines;
		}

		this.#meta.truncation = {
			direction: options.direction,
			truncatedBy,
			totalLines,
			totalBytes,
			outputLines,
			outputBytes,
			maxBytes: options.maxBytes,
			shownRange: { start: shownStart, end: shownEnd },
			nextOffset: options.direction === "head" ? shownEnd + 1 : undefined,
		};

		return this;
	}

	/** Add match limit notice. No-op if reached <= 0. */
	matchLimit(reached: number, suggestion = reached * 2): this {
		if (reached <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, matchLimit: { reached, suggestion } };
		return this;
	}

	/** Add limit notices in one call. */
	limits(limits: { matchLimit?: number; resultLimit?: number; headLimit?: number; columnMax?: number }): this {
		if (limits.matchLimit !== undefined) {
			this.matchLimit(limits.matchLimit);
		}
		if (limits.resultLimit !== undefined) {
			this.resultLimit(limits.resultLimit);
		}
		if (limits.headLimit !== undefined) {
			this.headLimit(limits.headLimit);
		}
		if (limits.columnMax !== undefined) {
			this.columnTruncated(limits.columnMax);
		}
		return this;
	}

	/** Add result limit notice. No-op if reached <= 0. */
	resultLimit(reached: number, suggestion = reached * 2): this {
		if (reached <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, resultLimit: { reached, suggestion } };
		return this;
	}

	/** Add limit notice for head truncation. No-op if reached <= 0. */
	headLimit(reached: number, suggestion = reached * 2): this {
		if (reached <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, headLimit: { reached, suggestion } };
		return this;
	}

	/** Add column truncation notice. No-op if maxColumn <= 0. */
	columnTruncated(maxColumn: number): this {
		if (maxColumn <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, columnTruncated: { maxColumn } };
		return this;
	}

	/** Add source path info. */
	sourcePath(value: string): this {
		this.#meta.source = { type: "path", value };
		return this;
	}

	/** Add source URL info. */
	sourceUrl(value: string): this {
		this.#meta.source = { type: "url", value };
		return this;
	}

	/** Add internal URL source info (skill://, agent://, artifact://). */
	sourceInternal(value: string): this {
		this.#meta.source = { type: "internal", value };
		return this;
	}

	/** Add LSP diagnostics. No-op if no messages. */
	diagnostics(summary: string, messages: string[]): this {
		if (messages.length === 0) return this;
		this.#meta.diagnostics = { summary, messages };
		return this;
	}

	/** Get the built OutputMeta, or undefined if empty. */
	get(): OutputMeta | undefined {
		return Object.keys(this.#meta).length > 0 ? this.#meta : undefined;
	}
}

/** Create a new OutputMetaBuilder. */
export function outputMeta(): OutputMetaBuilder {
	return new OutputMetaBuilder();
}

// =============================================================================
// Notice formatting
// =============================================================================

export function formatFullOutputReference(artifactId: string): string {
	return `Read artifact://${artifactId} for full output`;
}

const RAW_OUTPUT_ARTIFACT_PREFIX = "[raw output: artifact://";
const RAW_OUTPUT_ARTIFACT_SUFFIX = "]";

/** Remove the trailing bash raw-output artifact footer while preserving its artifact id. */
export function stripRawOutputArtifactNotice(text: string): { text: string; artifactId?: string } {
	const trimmed = text.trimEnd();
	const lineStart = trimmed.lastIndexOf("\n");
	const candidateStart = lineStart === -1 ? 0 : lineStart + 1;
	if (
		!trimmed.startsWith(RAW_OUTPUT_ARTIFACT_PREFIX, candidateStart) ||
		!trimmed.endsWith(RAW_OUTPUT_ARTIFACT_SUFFIX)
	) {
		return { text };
	}

	const idStart = candidateStart + RAW_OUTPUT_ARTIFACT_PREFIX.length;
	const idEnd = trimmed.length - RAW_OUTPUT_ARTIFACT_SUFFIX.length;
	if (idStart === idEnd) return { text };
	for (let i = idStart; i < idEnd; i++) {
		const code = trimmed.charCodeAt(i);
		if (code < 48 || code > 57) return { text };
	}

	const artifactId = trimmed.slice(idStart, idEnd);
	return {
		text: trimmed.slice(0, lineStart === -1 ? 0 : lineStart).trimEnd(),
		artifactId,
	};
}

function isGeneratedOutputNoticeLine(line: string): boolean {
	if (!line.startsWith("[") || !line.endsWith("]")) return false;
	const body = line.slice(1, -1);
	return (
		body.startsWith("Showing ") ||
		/^\d+ matches limit reached\. Use limit=\d+ for more/u.test(body) ||
		/^\d+ results limit reached\. Use limit=\d+ for more/u.test(body) ||
		body.startsWith("Some lines truncated to ")
	);
}

/** Remove a trailing generated output notice when metadata is unavailable. */
export function stripGeneratedOutputNotice(text: string): string {
	const trimmed = text.trimEnd();
	const lineStart = trimmed.lastIndexOf("\n");
	const candidateStart = lineStart === -1 ? 0 : lineStart + 1;
	if (!isGeneratedOutputNoticeLine(trimmed.slice(candidateStart))) return text;
	return trimmed.slice(0, lineStart === -1 ? 0 : lineStart).trimEnd();
}

export function formatTruncationMetaNotice(truncation: TruncationMeta): string {
	let notice: string;

	if (truncation.direction === "middle") {
		const head = truncation.headRange;
		const tail = truncation.tailRange;
		const totalLines = truncation.totalLines;
		const elidedBytes = truncation.elidedBytes ?? Math.max(0, truncation.totalBytes - truncation.outputBytes);
		const elidedLines = truncation.elidedLines ?? Math.max(0, totalLines - truncation.outputLines);
		const headPart = head ? `lines ${head.start}-${head.end}` : "";
		const tailPart = tail ? `${tail.start}-${tail.end}` : "";
		if (headPart && tailPart) {
			notice = `Showing ${headPart} and ${tailPart} of ${totalLines}; ${elidedLines.toLocaleString()} middle line${elidedLines === 1 ? "" : "s"} (${formatBytes(elidedBytes)}) elided`;
		} else {
			notice = `Showing ${truncation.outputLines} of ${totalLines} lines; middle elided`;
		}
		if (truncation.nextOffset != null) {
			notice += `. Use :${truncation.nextOffset} to continue`;
		}
		if (truncation.artifactId != null) {
			notice += `. ${formatFullOutputReference(truncation.artifactId)}`;
		}
		return notice;
	}

	const range = truncation.shownRange;
	if (range && range.end >= range.start) {
		notice = `Showing lines ${range.start}-${range.end} of ${truncation.totalLines}`;
	} else {
		notice = `Showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	}

	if (truncation.truncatedBy === "bytes") {
		const maxBytes = truncation.maxBytes ?? truncation.outputBytes;
		notice += ` (${formatBytes(maxBytes)} limit)`;
	}

	if (truncation.nextOffset != null) {
		notice += `. Use :${truncation.nextOffset} to continue`;
	}

	if (truncation.artifactId != null) {
		notice += `. ${formatFullOutputReference(truncation.artifactId)}`;
	}

	return notice;
}

/**
 * Format styled artifact reference with warning color and brackets.
 * For TUI rendering of truncation warnings.
 */
export function formatStyledArtifactReference(artifactId: string, theme: Theme): string {
	return theme.fg("warning", formatFullOutputReference(artifactId));
}

/**
 * Format notices from OutputMeta for LLM consumption.
 * Returns empty string if no notices needed.
 */
export function formatOutputNotice(meta: OutputMeta | undefined): string {
	if (!meta) return "";

	const parts: string[] = [];

	// Truncation notice
	if (meta.truncation) {
		parts.push(formatTruncationMetaNotice(meta.truncation));
	}

	// Limit notices
	if (meta.limits?.matchLimit) {
		const l = meta.limits.matchLimit;
		parts.push(`${l.reached} matches limit reached. Use limit=${l.suggestion} for more`);
	}
	if (meta.limits?.resultLimit) {
		const l = meta.limits.resultLimit;
		parts.push(`${l.reached} results limit reached. Use limit=${l.suggestion} for more`);
	}
	if (meta.limits?.headLimit) {
		const l = meta.limits.headLimit;
		parts.push(`${l.reached} results limit reached. Use limit=${l.suggestion} for more`);
	}
	if (meta.limits?.columnTruncated) {
		parts.push(`Some lines truncated to ${meta.limits.columnTruncated.maxColumn} chars`);
	}

	// Diagnostics
	let diagnosticsNotice = "";
	if (meta.diagnostics && meta.diagnostics.messages.length > 0) {
		const d = meta.diagnostics;
		diagnosticsNotice = `\n\nLSP Diagnostics (${d.summary}):\n${formatGroupedDiagnosticMessages(d.messages)}`;
	}

	const notice = parts.length ? `\n\n[${parts.join(". ")}]` : "";
	return notice + diagnosticsNotice;
}

/**
 * Format a styled truncation warning message.
 * Returns null if no truncation metadata present.
 */
export function formatStyledTruncationWarning(meta: OutputMeta | undefined, theme: Theme): string | null {
	if (!meta?.truncation) return null;
	const message = formatTruncationMetaNotice(meta.truncation);
	return theme.fg("warning", wrapBrackets(message, theme));
}

/**
 * Strip the trailing notice that {@link appendOutputNotice} bakes into the
 * LLM-facing content body. Renderers should call this before printing
 * `result.content` text in the TUI, because they emit a styled warning line of
 * their own; without this, users see the same `[Showing lines …]` string twice
 * (once verbatim from the body, once as the styled `⟨…⟩` warning).
 *
 * Safe to call eagerly: returns the input unchanged when no notice is present
 * (e.g. during streaming, before {@link wrappedExecute} runs).
 */
export function stripOutputNotice(text: string, meta: OutputMeta | undefined): string {
	const notice = formatOutputNotice(meta);
	if (!notice) return text;
	// Trim trailing whitespace from `text` and from the notice itself so we
	// match regardless of whether: (a) the caller already trimEnd()'d, (b)
	// extra blank lines slipped in after the notice (diagnostics blocks add
	// `\n\n` between sections, OutputSink may pad), or (c) neither. Returns
	// the prefix before the notice so the caller can re-trim as needed.
	const trimmedText = text.trimEnd();
	const trimmedNotice = notice.trimEnd();
	if (trimmedText.endsWith(trimmedNotice)) {
		return trimmedText.slice(0, -trimmedNotice.length);
	}
	return text;
}

// =============================================================================
// Tool wrapper
// =============================================================================

/**
 * Append output notice to tool result content if meta is present.
 */
function appendOutputNotice(
	content: (TextContent | ImageContent)[],
	meta: OutputMeta | undefined,
): (TextContent | ImageContent)[] {
	const notice = formatOutputNotice(meta);
	if (!notice) return content;

	const result = [...content];
	for (let i = result.length - 1; i >= 0; i--) {
		const item = result[i];
		if (item.type === "text") {
			result[i] = { ...item, text: item.text + notice };
			return result;
		}
	}

	result.push({ type: "text", text: notice.trim() });
	return result;
}

const kUnwrappedExecute = Symbol("OutputMeta.UnwrappedExecute");

// =============================================================================
// Centralized artifact spill for large tool results
// =============================================================================

/** Resolved artifact spill config sourced from the session settings (or schema defaults). */
function getSpillConfig(s: Settings | undefined) {
	type Path =
		| "tools.artifactSpillThreshold"
		| "tools.artifactTailBytes"
		| "tools.artifactTailLines"
		| "tools.artifactHeadBytes";
	const get = <P extends Path>(path: P) => s?.get(path) ?? getDefault(path);
	return {
		threshold: get("tools.artifactSpillThreshold") * 1024,
		tailBytes: get("tools.artifactTailBytes") * 1024,
		tailLines: get("tools.artifactTailLines"),
		headBytes: get("tools.artifactHeadBytes") * 1024,
	};
}

/**
 * Live tool updates are transient UI/RPC snapshots, not recoverable tool
 * results. Keep them materially smaller than a final inline result even when
 * a user configured a large artifact threshold: a slow consumer otherwise
 * repeatedly serializes the same growing buffer before the final spill runs.
 */
const LIVE_PARTIAL_HARD_MAX_BYTES = 64 * 1024;
const LIVE_PARTIAL_MIN_BYTES = 1024;
const LIVE_PARTIAL_MAX_LINES = 500;
const LIVE_PARTIAL_MAX_DEPTH = 8;
const LIVE_PARTIAL_MAX_ARRAY_ITEMS = 32;
const LIVE_PARTIAL_MAX_OBJECT_ITEMS = 48;
const LIVE_PARTIAL_FAST_MAX_ENTRIES = 192;
const LIVE_PARTIAL_TRUNCATION_SLACK_BYTES = 128;
const LIVE_PARTIAL_DIRECT_SCAN_MAX_CHARS = LIVE_PARTIAL_HARD_MAX_BYTES * 2;
const LIVE_PARTIAL_FALLBACK_FIELD_MAX_CHARS = 32;
const kLivePreviewOmitted = Symbol("OutputMeta.LivePreviewOmitted");

type LivePreviewValue = unknown | typeof kLivePreviewOmitted;

interface LivePartialBudget {
	maxBytes: number;
	contentBytes: number;
	detailBytes: number;
	headBytes: number;
	tailLines: number;
}
type LivePartialPreviewObserver = (
	originalBytes: number | undefined,
	previewBytes: number | undefined,
	wasLimited: boolean,
) => void;

/** Safe fallback when an extension-provided settings accessor cannot be read. */
const LIVE_PARTIAL_SETTINGS_FAILURE_BUDGET: LivePartialBudget = {
	maxBytes: LIVE_PARTIAL_MIN_BYTES,
	contentBytes: Math.floor(LIVE_PARTIAL_MIN_BYTES / 2),
	detailBytes: Math.floor(LIVE_PARTIAL_MIN_BYTES / 4),
	headBytes: 0,
	tailLines: 1,
};

interface LivePreviewState {
	remaining: number;
	seen: WeakSet<object>;
	truncated: boolean;
}

interface LivePreviewEstimateState {
	remaining: number;
	seen: WeakSet<object>;
	entries: number;
}

const LIVE_PARTIAL_DETAIL_PRIORITY_KEYS = [
	"terminalId",
	"jobId",
	"state",
	"status",
	"async",
	"isError",
	"error",
	"message",
	"notice",
	"meta",
	"language",
	"languages",
	"statusEvents",
	"cells",
	"images",
	"jsonOutputs",
	"xdev",
] as const;

function clampLivePartialInteger(value: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Resolve one hard byte budget from the existing artifact display settings. */
function resolveLivePartialBudget(settings: Settings | undefined): LivePartialBudget {
	const { threshold, tailBytes, tailLines, headBytes } = getSpillConfig(settings);
	const safeThreshold = clampLivePartialInteger(
		threshold,
		LIVE_PARTIAL_MIN_BYTES,
		LIVE_PARTIAL_HARD_MAX_BYTES,
		LIVE_PARTIAL_MIN_BYTES,
	);
	const safeTailBytes = clampLivePartialInteger(tailBytes, 0, LIVE_PARTIAL_HARD_MAX_BYTES, 0);
	const safeHeadBytes = clampLivePartialInteger(headBytes, 0, LIVE_PARTIAL_HARD_MAX_BYTES, 0);
	const displayBytes = Math.max(1, Math.min(LIVE_PARTIAL_HARD_MAX_BYTES, safeHeadBytes + safeTailBytes));
	const maxBytes = Math.max(LIVE_PARTIAL_MIN_BYTES, Math.min(safeThreshold, displayBytes));

	return {
		maxBytes,
		contentBytes: Math.max(128, Math.floor(maxBytes * 0.5)),
		detailBytes: Math.max(128, Math.floor(maxBytes * 0.35)),
		headBytes: Math.min(safeHeadBytes, Math.floor(maxBytes * 0.3)),
		tailLines: clampLivePartialInteger(tailLines, 1, LIVE_PARTIAL_MAX_LINES, LIVE_PARTIAL_MAX_LINES),
	};
}

function formatLivePartialPreviewNotice(maxBytes: number): string {
	return `\n\n[${tSettingsUi(
		"Live preview limited to {size}; this update has no artifact. The final tool result will follow.",
		{
			size: formatBytes(maxBytes),
		},
	)}]`;
}

function serializedByteLength(value: unknown): number | undefined {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf-8");
	} catch {
		return undefined;
	}
}

function consumeLivePreviewBudget(state: LivePreviewState, bytes: number): boolean {
	if (!Number.isFinite(bytes) || bytes > state.remaining) {
		state.truncated = true;
		return false;
	}
	state.remaining -= bytes;
	return true;
}

function copyLivePreviewImage(image: ImageContent): ImageContent {
	return image.detail === undefined
		? { type: "image", data: image.data, mimeType: image.mimeType }
		: { type: "image", data: image.data, mimeType: image.mimeType, detail: image.detail };
}

function truncateLivePreviewText(text: string, maxBytes: number, budget: LivePartialBudget): string {
	if (maxBytes <= 0) return "";
	if (text.length <= maxBytes && Buffer.byteLength(text, "utf-8") <= maxBytes) return text;

	const bodyBytes = Math.max(1, maxBytes - LIVE_PARTIAL_TRUNCATION_SLACK_BYTES);
	if (text.length > LIVE_PARTIAL_DIRECT_SCAN_MAX_CHARS) {
		if (budget.headBytes > 0 && bodyBytes > 2) {
			const headBytes = Math.min(budget.headBytes, Math.max(1, Math.floor(bodyBytes * 0.6)));
			const tailBytes = Math.max(1, bodyBytes - headBytes);
			const head = truncateHeadBytes(text, headBytes).text;
			const tail = truncateTailBytes(text, tailBytes).text;
			if (head && tail) return `${head}\n[…live preview elided…]\n${tail}`;
			return head || tail;
		}
		return truncateTailBytes(text, bodyBytes).text;
	}

	if (budget.headBytes > 0) {
		return truncateMiddle(text, {
			maxBytes: bodyBytes,
			maxLines: Math.max(2, budget.tailLines * 2),
			maxHeadBytes: Math.min(budget.headBytes, Math.max(1, Math.floor(bodyBytes * 0.6))),
			maxHeadLines: budget.tailLines,
		}).content;
	}
	return truncateTail(text, { maxBytes: bodyBytes, maxLines: budget.tailLines }).content;
}

function appendLivePartialPreviewNotice(
	content: (TextContent | ImageContent)[],
	notice: string,
): (TextContent | ImageContent)[] {
	const result = [...content];
	for (let i = result.length - 1; i >= 0; i--) {
		const block = result[i];
		if (block.type === "text") {
			result[i] = { type: "text", text: block.text + notice };
			return result;
		}
	}
	result.push({ type: "text", text: notice.trim() });
	return result;
}

function previewLivePartialContent(
	rawContent: unknown,
	budget: LivePartialBudget,
): { content: (TextContent | ImageContent)[]; truncated: boolean } {
	if (!Array.isArray(rawContent)) return { content: [], truncated: true };

	const noticeBytes = Buffer.byteLength(formatLivePartialPreviewNotice(budget.maxBytes), "utf-8");
	let remaining = Math.max(0, budget.contentBytes - noticeBytes);
	let truncated = false;
	const content: (TextContent | ImageContent)[] = [];
	const count = Math.min(rawContent.length, LIVE_PARTIAL_MAX_ARRAY_ITEMS);
	if (rawContent.length > count) truncated = true;

	for (let i = 0; i < count; i++) {
		const block = rawContent[i];
		if (!block || typeof block !== "object") {
			truncated = true;
			continue;
		}
		const candidate = block as {
			type?: unknown;
			text?: unknown;
			data?: unknown;
			mimeType?: unknown;
			detail?: unknown;
		};

		if (candidate.type === "text" && typeof candidate.text === "string") {
			if (remaining <= 0) {
				truncated = true;
				continue;
			}
			const text = truncateLivePreviewText(candidate.text, remaining, budget);
			const textBytes = Buffer.byteLength(text, "utf-8");
			if (text !== candidate.text) truncated = true;
			if (text || !candidate.text) content.push({ type: "text", text });
			remaining = Math.max(0, remaining - textBytes);
			continue;
		}

		if (candidate.type === "image" && typeof candidate.data === "string" && typeof candidate.mimeType === "string") {
			const detail = candidate.detail;
			const image: ImageContent =
				detail === "auto" || detail === "low" || detail === "high" || detail === "original"
					? { type: "image", data: candidate.data, mimeType: candidate.mimeType, detail }
					: { type: "image", data: candidate.data, mimeType: candidate.mimeType };
			if (image.data.length > remaining) {
				truncated = true;
				continue;
			}
			const imageBytes = serializedByteLength(image);
			if (imageBytes === undefined || imageBytes > remaining) {
				truncated = true;
				continue;
			}
			content.push(copyLivePreviewImage(image));
			remaining -= imageBytes;
			continue;
		}

		truncated = true;
	}

	return { content, truncated };
}

function isPlainLivePreviewRecord(value: object): value is Record<string, unknown> {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasUnsafeToJson(value: object): boolean {
	const descriptor = Object.getOwnPropertyDescriptor(value, "toJSON");
	return descriptor !== undefined && (descriptor.get !== undefined || typeof descriptor.value === "function");
}

function consumeLiveEstimate(state: LivePreviewEstimateState, bytes: number): boolean {
	if (!Number.isFinite(bytes) || bytes > state.remaining) return false;
	state.remaining -= bytes;
	return true;
}

function consumeLiveStringEstimate(state: LivePreviewEstimateState, value: string): boolean {
	const remainingForText = state.remaining - 2;
	if (remainingForText < 0 || value.length > Math.floor(remainingForText / 6)) return false;
	state.remaining -= 2 + value.length * 6;
	return true;
}

function isOmittedByJson(value: unknown): boolean {
	return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function estimateLiveJsonValue(
	value: unknown,
	state: LivePreviewEstimateState,
	depth: number,
	inArray: boolean,
): boolean {
	if (state.entries++ >= LIVE_PARTIAL_FAST_MAX_ENTRIES || depth > LIVE_PARTIAL_MAX_DEPTH) return false;
	if (value === null) return consumeLiveEstimate(state, 4);
	if (typeof value === "string") return consumeLiveStringEstimate(state, value);
	if (typeof value === "boolean") return consumeLiveEstimate(state, value ? 4 : 5);
	if (typeof value === "number") return consumeLiveEstimate(state, Number.isFinite(value) ? 32 : 4);
	if (typeof value === "bigint") return false;
	if (isOmittedByJson(value)) return !inArray || consumeLiveEstimate(state, 4);
	if (typeof value !== "object") return false;

	if (state.seen.has(value)) return false;
	if (hasUnsafeToJson(value)) return false;
	state.seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > LIVE_PARTIAL_FAST_MAX_ENTRIES || !consumeLiveEstimate(state, 2)) return false;
			for (let i = 0; i < value.length; i++) {
				if (i > 0 && !consumeLiveEstimate(state, 1)) return false;
				const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
				if (descriptor?.get !== undefined || descriptor?.set !== undefined) return false;
				if (!estimateLiveJsonValue(descriptor?.value ?? null, state, depth + 1, true)) return false;
			}
			return true;
		}

		if (!isPlainLivePreviewRecord(value) || !consumeLiveEstimate(state, 2)) return false;
		let propertyCount = 0;
		let hasProperty = false;
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			if (++propertyCount > LIVE_PARTIAL_FAST_MAX_ENTRIES) return false;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) return false;
			if (isOmittedByJson(descriptor.value)) continue;
			if (hasProperty && !consumeLiveEstimate(state, 1)) return false;
			if (!consumeLiveStringEstimate(state, key) || !consumeLiveEstimate(state, 1)) return false;
			if (!estimateLiveJsonValue(descriptor.value, state, depth + 1, false)) return false;
			hasProperty = true;
		}
		return true;
	} finally {
		state.seen.delete(value);
	}
}

function isLivePartialWithinBudget(partialResult: AgentToolResult, budget: LivePartialBudget): boolean {
	try {
		return estimateLiveJsonValue(
			partialResult,
			{ remaining: budget.maxBytes, seen: new WeakSet<object>(), entries: 0 },
			0,
			false,
		);
	} catch {
		return false;
	}
}

function previewLiveString(value: string, state: LivePreviewState, budget: LivePartialBudget): LivePreviewValue {
	if (value.length <= state.remaining) {
		const bytes = serializedByteLength(value);
		if (bytes !== undefined && consumeLivePreviewBudget(state, bytes)) return value;
	}

	state.truncated = true;
	const text = truncateLivePreviewText(value, Math.max(1, Math.floor(state.remaining / 2)), budget);
	const bytes = serializedByteLength(text);
	if (bytes !== undefined && consumeLivePreviewBudget(state, bytes)) return text;
	if (consumeLivePreviewBudget(state, 5)) return "…";
	return kLivePreviewOmitted;
}

function previewLiveImage(value: ImageContent, state: LivePreviewState): LivePreviewValue {
	if (value.data.length > state.remaining) {
		state.truncated = true;
		return kLivePreviewOmitted;
	}
	const image = copyLivePreviewImage(value);
	const bytes = serializedByteLength(image);
	if (bytes !== undefined && consumeLivePreviewBudget(state, bytes)) return image;
	state.truncated = true;
	return kLivePreviewOmitted;
}

function previewLiveArray(
	value: unknown[],
	state: LivePreviewState,
	budget: LivePartialBudget,
	depth: number,
): LivePreviewValue {
	if (state.seen.has(value)) {
		state.truncated = true;
		return previewLiveString("[circular reference omitted]", state, budget);
	}
	if (!consumeLivePreviewBudget(state, 2)) return kLivePreviewOmitted;

	state.seen.add(value);
	try {
		const result: unknown[] = [];
		const count = Math.min(value.length, LIVE_PARTIAL_MAX_ARRAY_ITEMS);
		if (value.length > count) state.truncated = true;
		for (let i = 0; i < count; i++) {
			const before = state.remaining;
			if (result.length > 0 && !consumeLivePreviewBudget(state, 1)) break;
			const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
			if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
				state.remaining = before;
				state.truncated = true;
				continue;
			}
			const item = previewLiveValue(descriptor?.value ?? null, state, budget, depth + 1, true);
			if (item === kLivePreviewOmitted) {
				state.remaining = before;
				continue;
			}
			result.push(item);
		}
		return result;
	} finally {
		state.seen.delete(value);
	}
}

function previewLiveRecord(
	value: Record<string, unknown>,
	state: LivePreviewState,
	budget: LivePartialBudget,
	depth: number,
): LivePreviewValue {
	if (state.seen.has(value)) {
		state.truncated = true;
		return previewLiveString("[circular reference omitted]", state, budget);
	}
	if (!consumeLivePreviewBudget(state, 2)) return kLivePreviewOmitted;

	state.seen.add(value);
	try {
		const result: Record<string, unknown> = Object.create(null);
		const seenKeys = new Set<string>();
		let propertyCount = 0;
		let hasProperty = false;

		const addProperty = (key: string): boolean => {
			if (++propertyCount > LIVE_PARTIAL_MAX_OBJECT_ITEMS) {
				state.truncated = true;
				return false;
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
				state.truncated = true;
				return true;
			}
			if (isOmittedByJson(descriptor.value)) return true;

			const before = state.remaining;
			const keyBytes = key.length <= state.remaining ? serializedByteLength(key) : undefined;
			if (keyBytes === undefined || !consumeLivePreviewBudget(state, keyBytes + 1 + (hasProperty ? 1 : 0))) {
				state.remaining = before;
				state.truncated = true;
				return false;
			}
			const item = previewLiveValue(descriptor.value, state, budget, depth + 1, false);
			if (item === kLivePreviewOmitted) {
				state.remaining = before;
				return true;
			}
			Object.defineProperty(result, key, {
				value: item,
				enumerable: true,
				configurable: true,
				writable: true,
			});
			hasProperty = true;
			return true;
		};

		for (const key of LIVE_PARTIAL_DETAIL_PRIORITY_KEYS) {
			if (!Object.hasOwn(value, key)) continue;
			seenKeys.add(key);
			if (!addProperty(key)) return result;
		}
		for (const key in value) {
			if (!Object.hasOwn(value, key) || seenKeys.has(key)) continue;
			if (!addProperty(key)) break;
		}
		return result;
	} finally {
		state.seen.delete(value);
	}
}

function asLivePreviewImage(value: object): ImageContent | undefined {
	const candidate = value as { type?: unknown; data?: unknown; mimeType?: unknown; detail?: unknown };
	if (candidate.type !== "image" || typeof candidate.data !== "string" || typeof candidate.mimeType !== "string") {
		return undefined;
	}
	return candidate.detail === "auto" ||
		candidate.detail === "low" ||
		candidate.detail === "high" ||
		candidate.detail === "original"
		? { type: "image", data: candidate.data, mimeType: candidate.mimeType, detail: candidate.detail }
		: { type: "image", data: candidate.data, mimeType: candidate.mimeType };
}

function previewLiveValue(
	value: unknown,
	state: LivePreviewState,
	budget: LivePartialBudget,
	depth: number,
	inArray: boolean,
): LivePreviewValue {
	if (depth > LIVE_PARTIAL_MAX_DEPTH) {
		state.truncated = true;
		return kLivePreviewOmitted;
	}
	if (value === null) return consumeLivePreviewBudget(state, 4) ? null : kLivePreviewOmitted;
	if (typeof value === "string") return previewLiveString(value, state, budget);
	if (typeof value === "boolean") return consumeLivePreviewBudget(state, value ? 4 : 5) ? value : kLivePreviewOmitted;
	if (typeof value === "number") {
		return consumeLivePreviewBudget(state, Number.isFinite(value) ? 32 : 4) ? value : kLivePreviewOmitted;
	}
	if (typeof value === "bigint") {
		state.truncated = true;
		return previewLiveString("[bigint omitted from live preview]", state, budget);
	}
	if (isOmittedByJson(value)) {
		return inArray && consumeLivePreviewBudget(state, 4) ? null : kLivePreviewOmitted;
	}
	if (typeof value !== "object") {
		state.truncated = true;
		return kLivePreviewOmitted;
	}

	const image = asLivePreviewImage(value);
	if (image) return previewLiveImage(image, state);
	if (value instanceof Error) {
		return previewLiveRecord({ name: value.name, message: value.message }, state, budget, depth);
	}
	if (value instanceof Date) {
		try {
			return previewLiveString(value.toISOString(), state, budget);
		} catch {
			state.truncated = true;
			return kLivePreviewOmitted;
		}
	}
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
		return previewLiveString("[binary data omitted from live preview]", state, budget);
	}
	if (Array.isArray(value)) return previewLiveArray(value, state, budget, depth);
	if (isPlainLivePreviewRecord(value)) return previewLiveRecord(value, state, budget, depth);

	state.truncated = true;
	return previewLiveString(`[${value.constructor?.name ?? "object"} omitted from live preview]`, state, budget);
}

/** Read an own data property without evaluating extension-provided accessors. */
function getOwnLivePreviewDataProperty(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) return undefined;
	return descriptor.value;
}

function truncateLivePartialFallbackField(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.length <= LIVE_PARTIAL_FALLBACK_FIELD_MAX_CHARS
		? value
		: value.slice(0, LIVE_PARTIAL_FALLBACK_FIELD_MAX_CHARS);
}

/** Preserve the minimal async shape that drives terminal-update delivery. */
function fallbackLivePartialAsyncDetails(
	partialResult: AgentToolResult,
): { async: { state: string; jobId?: string; type?: string } } | undefined {
	try {
		const details = getOwnLivePreviewDataProperty(partialResult, "details");
		const async = getOwnLivePreviewDataProperty(details, "async");
		const state = truncateLivePartialFallbackField(getOwnLivePreviewDataProperty(async, "state"));
		if (state === undefined) return undefined;

		const fallbackAsync: { state: string; jobId?: string; type?: string } = { state };
		const jobId = truncateLivePartialFallbackField(getOwnLivePreviewDataProperty(async, "jobId"));
		if (jobId !== undefined) fallbackAsync.jobId = jobId;
		const type = truncateLivePartialFallbackField(getOwnLivePreviewDataProperty(async, "type"));
		if (type !== undefined) fallbackAsync.type = type;
		return { async: fallbackAsync };
	} catch {
		return undefined;
	}
}

function fallbackLivePartialPreview(partialResult: AgentToolResult, budget: LivePartialBudget): AgentToolResult {
	let isError = false;
	let useless = false;
	try {
		isError = Boolean(getOwnLivePreviewDataProperty(partialResult, "isError"));
		useless = Boolean(getOwnLivePreviewDataProperty(partialResult, "useless"));
	} catch {
		// A hostile extension object still gets a serializable, bounded fallback.
	}
	const details = fallbackLivePartialAsyncDetails(partialResult);
	return {
		content: [{ type: "text", text: formatLivePartialPreviewNotice(budget.maxBytes).trim() }],
		...(details === undefined ? {} : { details }),
		...(isError ? { isError: true } : {}),
		...(useless && !isError ? { useless: true } : {}),
	};
}

function previewLivePartialResult(
	partialResult: AgentToolResult,
	settings: Settings | undefined,
	onPreview?: LivePartialPreviewObserver,
): AgentToolResult {
	let budget = LIVE_PARTIAL_SETTINGS_FAILURE_BUDGET;
	const originalBytes = serializedByteLength(partialResult);
	const reportPreview = (result: AgentToolResult, wasLimited: boolean): AgentToolResult => {
		onPreview?.(originalBytes, serializedByteLength(result), wasLimited);
		return result;
	};
	try {
		budget = resolveLivePartialBudget(settings);
		if (isLivePartialWithinBudget(partialResult, budget)) return reportPreview(partialResult, false);

		const raw = partialResult as unknown as Record<string, unknown>;
		const contentPreview = previewLivePartialContent(raw.content, budget);
		const state: LivePreviewState = {
			remaining: budget.detailBytes,
			seen: new WeakSet<object>(),
			truncated: false,
		};
		const result: AgentToolResult = { content: contentPreview.content };

		if (Object.hasOwn(raw, "details")) {
			const details = previewLiveValue(raw.details, state, budget, 0, false);
			if (details !== kLivePreviewOmitted) result.details = details;
		}
		if (Object.hasOwn(raw, "providerMetadata")) {
			const providerMetadata = previewLiveValue(raw.providerMetadata, state, budget, 0, false);
			if (providerMetadata !== kLivePreviewOmitted) {
				result.providerMetadata = providerMetadata as AgentToolResult["providerMetadata"];
			}
		}
		if (getOwnLivePreviewDataProperty(raw, "isError")) result.isError = true;
		if (getOwnLivePreviewDataProperty(raw, "useless") && !result.isError) result.useless = true;

		if (contentPreview.truncated || state.truncated) {
			result.content = appendLivePartialPreviewNotice(
				result.content,
				formatLivePartialPreviewNotice(budget.maxBytes),
			);
		}

		const bytes = serializedByteLength(result);
		return reportPreview(
			bytes !== undefined && bytes <= budget.maxBytes ? result : fallbackLivePartialPreview(partialResult, budget),
			true,
		);
	} catch {
		return reportPreview(fallbackLivePartialPreview(partialResult, budget), true);
	}
}

/**
 * Resolve the OutputSink `headBytes` budget from session settings.
 * Exposed so streaming executors (bash/python/ssh/eval) can opt into
 * middle elision with the same per-user configuration.
 */
export function resolveOutputSinkHeadBytes(s: Settings | undefined): number {
	return getSpillConfig(s).headBytes;
}

/**
 * Slack on top of the configured spill threshold before the final-defense
 * inline byte cap fires. The OutputSink already bounds inline bodies to the
 * threshold; only notice slop (wall time, exit code, elision marker,
 * `[raw output: artifact://N]` footer) rides above it. The slack keeps the
 * cap a genuine last resort for paths that bypass the sink (e.g. ACP
 * client-bridge terminals) instead of re-truncating — and re-saving — every
 * sink-elided result (the double-artifact `Artifact: N+1` vs `artifact://N`
 * mismatch).
 */
const INLINE_CAP_SLACK_BYTES = 2 * 1024;

/**
 * Resolve the `enforceInlineByteCap` budget for streaming tools (bash/ssh)
 * from session settings: the user's spill threshold plus notice slack.
 */
export function resolveInlineByteCapBudget(s: Settings | undefined): number {
	return getSpillConfig(s).threshold + INLINE_CAP_SLACK_BYTES;
}

/**
 * Resolve the per-line column cap from session settings. Shared by streaming
 * executors (bash/python/ssh/eval via OutputSink) and the `read` tool's
 * line-buffer post-processing, so one setting controls both surfaces.
 */
export function resolveOutputMaxColumns(s: Settings | undefined): number {
	return s?.get("tools.outputMaxColumns") ?? getDefault("tools.outputMaxColumns");
}

/**
 * If the tool result text exceeds the spill threshold, save the full output
 * as a session artifact and replace the content with a head+tail (middle
 * elision) view plus an artifact reference. When `tools.artifactHeadBytes`
 * is 0, falls back to tail-only truncation. Skips when the tool already
 * saved its own artifact (e.g. bash/python via OutputSink).
 */
async function spillLargeResultToArtifact(
	result: AgentToolResult,
	toolName: string,
	context: AgentToolContext | undefined,
): Promise<AgentToolResult> {
	const sessionManager = context?.sessionManager;
	if (!sessionManager) return result;
	const { threshold, tailBytes, tailLines, headBytes } = getSpillConfig(context?.settings);

	// Skip if tool already saved an artifact
	const existingMeta: OutputMeta | undefined = result.details?.meta;
	if (existingMeta?.truncation?.artifactId) return result;

	// Reading an artifact already addresses recoverable full output. Spilling that
	// read would only create a redundant artifact containing another artifact's
	// page (and can repeat indefinitely on subsequent reads).
	if (
		toolName === "read" &&
		existingMeta?.source?.type === "internal" &&
		existingMeta.source.value.startsWith("artifact://")
	) {
		return result;
	}

	// Measure total text content
	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && block.text) {
			textParts.push(block.text);
		}
	}
	if (textParts.length === 0) return result;

	const fullText = textParts.length === 1 ? textParts[0] : textParts.join("\n");
	const totalBytes = Buffer.byteLength(fullText, "utf-8");
	if (totalBytes <= threshold) return result;

	// Save the full output as an artifact so the elided bytes stay recoverable.
	// In a persistent session this hits `Bun.write`, which can throw (disk full,
	// permissions). The spill wraps arbitrary tools (built-in, MCP, extension,
	// RPC-host); a save failure must never convert a successful call into an
	// error, nor re-expose the full (possibly context-blowing) output. Mirror
	// `enforceInlineByteCap`: always truncate past the threshold, and only
	// attach the `artifact://` recovery link when the save actually succeeded.
	let artifactId: string | undefined;
	try {
		artifactId = await sessionManager.saveArtifact(fullText, toolName);
	} catch (error) {
		logger.warn("Failed to spill large tool result to artifact", {
			tool: toolName,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	// Truncate: middle elision when a head budget is configured, otherwise tail-only.
	const useMiddle = headBytes > 0;
	const truncated = useMiddle
		? truncateMiddle(fullText, {
				maxBytes: headBytes + tailBytes,
				maxLines: tailLines * 2,
				maxHeadBytes: headBytes,
				maxHeadLines: tailLines,
			})
		: truncateTail(fullText, {
				maxBytes: tailBytes,
				maxLines: tailLines,
			});

	// Replace text blocks with single truncated block, keep images
	const newContent: (TextContent | ImageContent)[] = [];
	for (const block of result.content) {
		if (block.type !== "text") {
			newContent.push(block);
		}
	}
	newContent.push({ type: "text", text: truncated.content });

	// Build truncation meta
	const outputLines = truncated.outputLines ?? truncated.totalLines;
	const outputBytes = truncated.outputBytes ?? truncated.totalBytes;
	let truncationMeta: TruncationMeta;
	if (truncated.truncatedBy === "middle") {
		const elidedLines = truncated.elidedLines ?? Math.max(0, truncated.totalLines - outputLines);
		const elidedBytes = truncated.elidedBytes ?? Math.max(0, truncated.totalBytes - outputBytes);
		const keptLines = Math.max(0, outputLines - 1); // -1 for marker line
		const headLines = Math.ceil(keptLines / 2);
		const tailLineCount = keptLines - headLines;
		truncationMeta = {
			direction: "middle",
			truncatedBy: "middle",
			totalLines: truncated.totalLines,
			totalBytes: truncated.totalBytes,
			outputLines,
			outputBytes,
			maxBytes: headBytes + tailBytes,
			headRange: headLines > 0 ? { start: 1, end: headLines } : undefined,
			tailRange:
				tailLineCount > 0
					? { start: truncated.totalLines - tailLineCount + 1, end: truncated.totalLines }
					: undefined,
			elidedLines,
			elidedBytes,
			artifactId,
			nextOffset: existingMeta?.truncation?.nextOffset,
		};
	} else {
		const shownStart = truncated.totalLines - outputLines + 1;
		truncationMeta = {
			direction: "tail",
			truncatedBy: truncated.truncatedBy ?? "bytes",
			totalLines: truncated.totalLines,
			totalBytes: truncated.totalBytes,
			outputLines,
			outputBytes,
			maxBytes: tailBytes,
			shownRange: { start: shownStart, end: truncated.totalLines },
			artifactId,
			nextOffset: existingMeta?.truncation?.nextOffset,
		};
	}

	const newMeta: OutputMeta = { ...(existingMeta ?? {}), truncation: truncationMeta };
	const newDetails = { ...(result.details ?? {}), meta: newMeta };

	return { ...result, content: newContent, details: newDetails };
}

// =============================================================================
// Tool wrapper
// =============================================================================

async function wrappedExecute(
	this: AgentTool & { [kUnwrappedExecute]: AgentToolExecFn },
	toolCallId: string,
	params: any,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback,
	context?: AgentToolContext,
): Promise<AgentToolResult> {
	const originalExecute = this[kUnwrappedExecute];
	const boundedOnUpdate: AgentToolUpdateCallback | undefined = onUpdate
		? partialResult => {
				const preview = previewLivePartialResult(
					partialResult,
					context?.settings,
					(originalBytes, previewBytes, wasLimited) => {
						recordLiveToolPreview(toolCallId, this.name, originalBytes, previewBytes, undefined, wasLimited);
					},
				);
				onUpdate(preview);
			}
		: undefined;

	try {
		let result = await originalExecute.call(this, toolCallId, params, signal, boundedOnUpdate, context);

		// Spill large results to artifact, truncate to tail
		result = await spillLargeResultToArtifact(result, this.name, context);

		// Append notices from meta
		const meta: OutputMeta | undefined = result.details?.meta;
		if (meta) {
			return {
				...result,
				content: appendOutputNotice(result.content, meta),
			};
		}
		return result;
	} catch (e) {
		// Re-throw with formatted message so agent-loop sets isError flag
		throw new Error(renderError(e));
	}
}

/**
 * Wrap a tool to:
 * 1. Automatically append output notices based on details.meta
 * 2. Handle ToolError rendering
 */
export function wrapToolWithMetaNotice<T extends AgentTool<any, any, any>>(tool: T): T {
	if (kUnwrappedExecute in tool) {
		return tool;
	}

	const originalExecute = tool.execute;

	return Object.defineProperties(tool, {
		[kUnwrappedExecute]: {
			value: originalExecute,
			enumerable: false,
			configurable: true,
		},
		execute: {
			value: wrappedExecute,
			enumerable: false,
			configurable: true,
			writable: true,
		},
	});
}
