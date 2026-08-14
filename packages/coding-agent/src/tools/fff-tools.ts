import * as path from "node:path";
import type { GrepCursor, GrepMatch, GrepMode, GrepResult, SearchResult } from "@ff-labs/fff-bun";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { formatHashlineSourceHeader, recordFileSnapshot, recordSeenLinesFromBody } from "../edit/file-snapshot-store";
import { selectPrompt } from "../prompts/prompt-locale";
import fffGrepDescription from "../prompts/tools/fff-grep.md" with { type: "text" };
import fffGrepDescriptionZh from "../prompts/tools/fff-grep.zh-CN.md" with { type: "text" };
import findDescription from "../prompts/tools/find.md" with { type: "text" };
import findDescriptionZh from "../prompts/tools/find.zh-CN.md" with { type: "text" };
import multiGrepDescription from "../prompts/tools/multi-grep.md" with { type: "text" };
import multiGrepDescriptionZh from "../prompts/tools/multi-grep.zh-CN.md" with { type: "text" };
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import {
	type FffFinderManager,
	type FffScopeIdentity,
	getSessionFffFinderManager,
	type ResolvedFffScope,
	resolveFffScope,
	resumeFffScope,
} from "./fff-manager";
import { buildFffQuery } from "./fff-query";
import { formatGroupedFiles } from "./grouped-file-output";
import { formatMatchLine } from "./match-line-format";
import type { FindToolDetails, GrepToolDetails as SearchGrepToolDetails } from "./search-details";
import { ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const DEFAULT_GREP_LIMIT = 20;
const DEFAULT_FIND_LIMIT = 30;
const GREP_PAGE_SIZE_MAX = 1_000;
const GREP_CONTEXT_MAX = 20;
const GREP_TIME_BUDGET_MS = 10_000;
const FIND_WEAK_SAMPLE_SIZE = 5;
const FIND_CURSOR_LIMIT = 200;
const GREP_CURSOR_LIMIT = 200;

const grepSchema = type({
	pattern: type("string").describe("search pattern (literal text or regex)"),
	"path?": type("string").describe("directory, filename, glob, or external path constraint"),
	"exclude?": type("string | string[]").describe("excluded paths, directories, or globs"),
	"caseSensitive?": type("boolean").describe(
		"true forces case-sensitive; false forces case-insensitive; omitted uses smart-case",
	),
	"literal?": type("boolean").describe("treat pattern as literal text even when it contains regex syntax"),
	"context?": type("number").describe("context lines before and after each match (0-20)"),
	"limit?": type("number").describe("max matches (default 20)"),
	"cursor?": type("string").describe("pagination cursor from a previous result"),
});

const findSchema = type({
	pattern: type("string").describe("fuzzy path query; may be empty when path is a glob"),
	"path?": type("string").describe("directory, filename, glob, or external path constraint"),
	"exclude?": type("string | string[]").describe("excluded paths, directories, or globs"),
	"limit?": type("number").describe("max results per page (default 30)"),
	"cursor?": type("string").describe("pagination cursor from a previous result"),
});

const multiGrepSchema = type({
	patterns: type("string[]").describe("one or more literal patterns matched with OR logic"),
	"constraints?": type("string").describe("file constraints such as '*.{ts,tsx} !test/'"),
	"context?": type("number").describe("context lines before and after each match (0-20)"),
	"limit?": type("number").describe("max matches (default 20)"),
	"cursor?": type("string").describe("pagination cursor from a previous result"),
});

export type FffGrepToolInput = typeof grepSchema.infer;
export type FffFindToolInput = typeof findSchema.infer;
export type FffMultiGrepToolInput = typeof multiGrepSchema.infer;
export type GrepToolInput = FffGrepToolInput;
export type FindToolInput = FffFindToolInput;
export type MultiGrepToolInput = FffMultiGrepToolInput;

interface FindCursor {
	query: string;
	pattern: string;
	pageSize: number;
	nextPageIndex: number;
	scope: FffScopeIdentity;
}

interface GrepPageState {
	native: GrepCursor | null;
	pending: GrepMatch[];
	perFileMatchCounts: Map<string, number>;
	totalFilesSearched: number;
	totalFiles: number;
	filteredFileCount: number;
	regexFallbackError?: string;
	perFileLimitReached?: number;
}

interface GrepCursorState extends GrepPageState {
	scope: FffScopeIdentity;
	query: string;
	mode: GrepMode;
	smartCase: boolean;
	pageSize: number;
	beforeContext: number;
	afterContext: number;
	fuzzyFallback: boolean;
}

interface MultiGrepCursorState extends GrepPageState {
	scope: FffScopeIdentity;
	patterns: string[];
	constraints?: string;
	pageSize: number;
	beforeContext: number;
	afterContext: number;
}

interface EffectiveContext {
	before: number;
	after: number;
}

/** Cursor bridge-only execution controls that are intentionally absent from the model schema. */
export interface FffGrepToolOptions {
	/** FFF file-order offset used by Cursor's legacy paginated grep frame. */
	fileOffset?: number;
	/** One-shot total cap used by Cursor's modern pi_grep frame, which cannot consume a local cursor. */
	terminalLimit?: number;
}

export type { FindToolDetails } from "./search-details";
export type GrepToolDetails = SearchGrepToolDetails;
interface FffFindDetails extends FindToolDetails {}
interface FffGrepDetails extends SearchGrepToolDetails {}
const NATIVE_GREP_FILE_PAGE_SIZE = 8;
const NATIVE_GREP_PER_FILE_LIMIT = 1_000;
const NATIVE_GREP_PER_FILE_SENTINEL = NATIVE_GREP_PER_FILE_LIMIT + 1;

function mergeGrepPageState(state: GrepPageState | undefined, result: GrepResult): GrepPageState {
	const counts = new Map(state?.perFileMatchCounts ?? []);
	const fetched: GrepMatch[] = [];
	let perFileLimitReached = state?.perFileLimitReached;
	for (const match of result.items) {
		const count = counts.get(match.relativePath) ?? 0;
		if (count >= NATIVE_GREP_PER_FILE_LIMIT) {
			perFileLimitReached = NATIVE_GREP_PER_FILE_LIMIT;
			continue;
		}
		counts.set(match.relativePath, count + 1);
		fetched.push(match);
	}
	return {
		native: result.nextCursor,
		pending: [...(state?.pending ?? []), ...fetched],
		perFileMatchCounts: counts,
		totalFilesSearched: (state?.totalFilesSearched ?? 0) + result.totalFilesSearched,
		totalFiles: result.totalFiles,
		filteredFileCount: result.filteredFileCount,
		regexFallbackError: result.regexFallbackError ?? state?.regexFallbackError,
		perFileLimitReached,
	};
}

function fillGrepPage(initial: GrepPageState, limit: number, fetch: (cursor: GrepCursor) => GrepResult): GrepPageState {
	let state = initial;
	while (state.pending.length < limit && state.native) {
		state = mergeGrepPageState(state, fetch(state.native));
	}
	return state;
}

function consumeGrepPage(state: GrepPageState, limit: number): { result: GrepResult; next: GrepPageState | undefined } {
	const items = state.pending.slice(0, limit);
	const pending = state.pending.slice(items.length);
	const hasMore = pending.length > 0 || state.native !== null;
	return {
		result: {
			items,
			totalMatched: items.length,
			totalFilesSearched: state.totalFilesSearched,
			totalFiles: state.totalFiles,
			filteredFileCount: state.filteredFileCount,
			nextCursor: state.native,
			regexFallbackError: state.regexFallbackError,
		},
		next: hasMore ? { ...state, pending } : undefined,
	};
}

class CursorStore<T> {
	#values = new Map<string, T>();
	#next = 0;

	constructor(
		private readonly prefix: string,
		private readonly limit: number,
	) {}

	store(value: T): string {
		const id = `${this.prefix}${++this.#next}`;
		this.#values.set(id, value);
		if (this.#values.size > this.limit) {
			const first = this.#values.keys().next().value;
			if (first) this.#values.delete(first);
		}
		return id;
	}

	get(id: string): T | undefined {
		return this.#values.get(id);
	}
}

function clampContext(value: number | undefined): number {
	if (!value || value < 0) return 0;
	return Math.min(Math.floor(value), GREP_CONTEXT_MAX);
}

function clampLimit(value: number | undefined, fallback: number, maximum?: number): number {
	const normalized = Number.isFinite(value) && value !== undefined ? Math.max(1, Math.floor(value)) : fallback;
	return maximum === undefined ? normalized : Math.min(normalized, maximum);
}

function resolveContext(session: ToolSession, value: number | undefined): EffectiveContext {
	if (value !== undefined) {
		const context = clampContext(value);
		return { before: context, after: context };
	}
	return {
		before: clampContext(session.settings.get("grep.contextBefore")),
		after: clampContext(session.settings.get("grep.contextAfter")),
	};
}

function escapeRegexLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveGrepPattern(
	pattern: string,
	literal: boolean | undefined,
	caseSensitive: boolean | undefined,
): { pattern: string; mode: GrepMode; smartCase: boolean } {
	const mode: GrepMode = literal === true ? "plain" : isRegexPattern(pattern) ? "regex" : "plain";
	if (caseSensitive === false) {
		const body = mode === "regex" ? pattern : escapeRegexLiteral(pattern);
		return { pattern: `(?i:${body})`, mode: "regex", smartCase: false };
	}
	return { pattern, mode, smartCase: caseSensitive === undefined };
}

function scopeIdentity(scope: ResolvedFffScope): FffScopeIdentity {
	return {
		root: scope.root,
		pathConstraint: scope.pathConstraint,
		displayPath: scope.displayPath,
		kind: scope.kind,
	};
}

function isRegexPattern(pattern: string): boolean {
	if (pattern === pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) return false;
	try {
		new RegExp(pattern);
		return true;
	} catch {
		return false;
	}
}

function isWildcardOnlyPattern(pattern: string): boolean {
	const trimmed = pattern.trim();
	return (
		trimmed.length === 0 ||
		/^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(trimmed)
	);
}

function weakScoreThreshold(pattern: string): number {
	return Math.floor(pattern.length * 12 * 0.5);
}

function formatFindResult(
	result: SearchResult,
	limit: number,
	pattern: string,
	root: string,
	cwd: string,
): { files: string[]; weak: boolean } {
	const weak = result.items.length > 0 && (result.scores[0]?.total ?? 0) < weakScoreThreshold(pattern);
	const effectiveLimit = weak ? Math.min(limit, FIND_WEAK_SAMPLE_SIZE) : limit;
	return {
		files: result.items.slice(0, effectiveLimit).map(item => {
			const absolute = path.resolve(root, item.relativePath);
			return path.relative(cwd, absolute) || item.relativePath;
		}),
		weak,
	};
}

async function resolvePicker(
	manager: FffFinderManager,
	session: ToolSession,
	pathConstraint: string | undefined,
): Promise<ResolvedFffScope> {
	return resolveFffScope(manager, session.cwd, pathConstraint);
}

function resolveQuery(
	scope: { root: string; pathConstraint?: string },
	pattern: string,
	exclude: string | string[] | undefined,
): string {
	return buildFffQuery(scope.pathConstraint, pattern, exclude, scope.root);
}

async function renderFffGrepResult(
	session: ToolSession,
	result: GrepResult,
	scope: { root: string; pathConstraint?: string },
	options: { cursor?: string; fuzzyFallback?: boolean; patterns?: string[]; perFileLimitReached?: number },
): Promise<AgentToolResult<FffGrepDetails>> {
	if (result.items.length === 0) {
		const continueNotice = options.cursor ? `\nContinue with cursor="${options.cursor}"` : "";
		return toolResult<FffGrepDetails>({
			scopePath: scope.pathConstraint ?? ".",
			searchPath: scope.root,
			cwd: session.cwd,
			matchCount: 0,
			fileCount: 0,
			searchedPaths: [scope.pathConstraint ?? "."],
			truncated: Boolean(options.cursor || options.perFileLimitReached),
			perFileLimitReached: options.perFileLimitReached,
			cursor: options.cursor,
			patterns: options.patterns,
		})
			.text(`No matches found${continueNotice}`)
			.useless(!options.cursor)
			.done();
	}

	const matchesByFile = new Map<string, GrepMatch[]>();
	for (const match of result.items) {
		const displayPath =
			path.relative(session.cwd, path.resolve(scope.root, match.relativePath)) || match.relativePath;
		const matches = matchesByFile.get(displayPath) ?? [];
		matches.push(match);
		matchesByFile.set(displayPath, matches);
	}
	const files = [...matchesByFile.keys()];
	const hashContexts = new Map<string, string>();
	if (resolveFileDisplayMode(session).hashLines) {
		await Promise.all(
			files.map(async displayPath => {
				const absolutePath = path.resolve(session.cwd, displayPath);
				const tag = await recordFileSnapshot(session, absolutePath);
				if (tag) hashContexts.set(displayPath, tag);
			}),
		);
	}

	const grouped = formatGroupedFiles(files, displayPath => {
		const useHashLines = hashContexts.has(displayPath);
		const modelLines: string[] = [];
		let lastLine: number | undefined;
		const append = (lineNumber: number, line: string, matched: boolean) => {
			if (lastLine !== undefined && lineNumber > lastLine + 1) modelLines.push("...");
			modelLines.push(formatMatchLine(lineNumber, line, matched, { useHashLines }));
			lastLine = lineNumber;
		};
		for (const match of matchesByFile.get(displayPath) ?? []) {
			match.contextBefore?.forEach((line, index) => {
				append(match.lineNumber - match.contextBefore!.length + index, line, false);
			});
			append(match.lineNumber, match.lineContent, true);
			match.contextAfter?.forEach((line, index) => {
				append(match.lineNumber + index + 1, line, false);
			});
		}
		const tag = hashContexts.get(displayPath);
		if (!tag) return { modelLines, displayLines: modelLines };
		recordSeenLinesFromBody(session, path.resolve(session.cwd, displayPath), tag, modelLines.join("\n"));
		return {
			modelLines: [formatHashlineSourceHeader(displayPath, tag), ...modelLines],
			displayLines: modelLines,
		};
	});

	const notices: string[] = [];
	if (result.regexFallbackError) notices.push(`Invalid regex: ${result.regexFallbackError}; used literal matching`);
	if (options.fuzzyFallback) notices.push("0 exact matches. Maybe you meant this?");
	if (options.cursor) notices.push(`Continue with cursor="${options.cursor}"`);
	const text =
		notices.length > 0 ? `${grouped.model.join("\n")}\n\n[${notices.join(". ")}]` : grouped.model.join("\n");
	return toolResult<FffGrepDetails>({
		scopePath: scope.pathConstraint ?? ".",
		searchPath: scope.root,
		cwd: session.cwd,
		matchCount: result.items.length,
		fileCount: files.length,
		files,
		fileMatches: files.map(file => ({ path: file, count: matchesByFile.get(file)?.length ?? 0 })),
		fileLocations: files.map(file => ({
			path: file,
			lineNumbers: [...new Set((matchesByFile.get(file) ?? []).map(match => match.lineNumber))].sort(
				(a, b) => a - b,
			),
		})),
		searchedPaths: [scope.pathConstraint ?? "."],
		truncated: Boolean(options.cursor || options.perFileLimitReached),
		perFileLimitReached: options.perFileLimitReached,
		cursor: options.cursor,
		fuzzyFallback: options.fuzzyFallback,
		patterns: options.patterns,
	})
		.text(text)
		.done();
}

export class FffGrepTool implements AgentTool<typeof grepSchema, FffGrepDetails> {
	readonly name = "grep";
	readonly label = "Grep";
	readonly approval = "read" as const;
	readonly loadMode = "essential" as const;
	readonly strict = true;
	readonly parameters = grepSchema;
	readonly #manager: FffFinderManager;
	readonly #cursors = new CursorStore<GrepCursorState>("fff_g", GREP_CURSOR_LIMIT);

	readonly examples: readonly ToolExample<FffGrepToolInput>[] = [
		{ caption: "Search a symbol", call: { pattern: "FileFinder", path: "src/", exclude: ["test/"] } },
	];

	constructor(
		private readonly session: ToolSession,
		private readonly options: FffGrepToolOptions = {},
	) {
		this.#manager = getSessionFffFinderManager(session);
	}

	get description(): string {
		return prompt.render(selectPrompt(fffGrepDescription, fffGrepDescriptionZh));
	}

	async execute(
		_toolCallId: string,
		params: FffGrepToolInput,
		signal?: AbortSignal,
	): Promise<AgentToolResult<FffGrepDetails>> {
		throwIfAborted(signal);
		if (isWildcardOnlyPattern(params.pattern)) {
			throw new ToolError(`Pattern '${params.pattern}' matches everything; grep needs a concrete term`);
		}
		const resumed = params.cursor ? this.#cursors.get(params.cursor) : undefined;
		if (params.cursor && !resumed) throw new ToolError(`Unknown or expired grep cursor: ${params.cursor}`);
		const scope = resumed
			? await resumeFffScope(this.#manager, resumed.scope)
			: await resolvePicker(this.#manager, this.session, params.path);
		throwIfAborted(signal);
		const pageSize =
			resumed?.pageSize ??
			this.options.terminalLimit ??
			clampLimit(params.limit, DEFAULT_GREP_LIMIT, GREP_PAGE_SIZE_MAX);
		const context = resumed
			? { before: resumed.beforeContext, after: resumed.afterContext }
			: resolveContext(this.session, params.context);
		const resolvedPattern = resumed
			? { pattern: resumed.query, mode: resumed.mode, smartCase: resumed.smartCase }
			: resolveGrepPattern(params.pattern, params.literal, params.caseSensitive);
		const query = resumed ? resumed.query : resolveQuery(scope, resolvedPattern.pattern, params.exclude);
		let mode = resumed?.mode ?? resolvedPattern.mode;
		const smartCase = resumed?.smartCase ?? resolvedPattern.smartCase;
		let fuzzyFallback = resumed?.fuzzyFallback ?? false;
		const fetch = (cursor: GrepCursor | null, searchMode = mode): GrepResult => {
			const effectiveCursor =
				cursor ??
				(this.options.fileOffset && this.options.fileOffset > 0
					? { __brand: "GrepCursor" as const, _offset: Math.floor(this.options.fileOffset) }
					: null);
			const value = scope.finder.grep(query, {
				mode: searchMode,
				smartCase,
				maxMatchesPerFile: NATIVE_GREP_PER_FILE_SENTINEL,
				pageSize: NATIVE_GREP_FILE_PAGE_SIZE,
				cursor: effectiveCursor,
				beforeContext: searchMode === "fuzzy" ? 0 : context.before,
				afterContext: searchMode === "fuzzy" ? 0 : context.after,
				classifyDefinitions: true,
				timeBudgetMs: GREP_TIME_BUDGET_MS,
			});
			if (!value.ok) throw new ToolError(value.error);
			return value.value;
		};
		let state = resumed
			? fillGrepPage(resumed, pageSize, cursor => fetch(cursor))
			: mergeGrepPageState(undefined, fetch(null));
		if (!resumed) state = fillGrepPage(state, pageSize, cursor => fetch(cursor));
		if (state.pending.length === 0 && !state.native && mode === "plain") {
			const fuzzy = mergeGrepPageState(undefined, fetch(null, "fuzzy"));
			state = fillGrepPage(fuzzy, pageSize, cursor => fetch(cursor, "fuzzy"));
			if (state.pending.length > 0 || state.native) {
				mode = "fuzzy";
				fuzzyFallback = true;
			}
		}
		const page = consumeGrepPage(state, pageSize);
		if (this.options.terminalLimit !== undefined && page.next && page.result.items.length >= pageSize) {
			state = { ...state, perFileLimitReached: pageSize };
		}
		const cursor =
			this.options.terminalLimit === undefined && page.next
				? this.#cursors.store({
						...page.next,
						scope: scopeIdentity(scope),
						query,
						mode,
						smartCase,
						pageSize,
						beforeContext: mode === "fuzzy" ? 0 : context.before,
						afterContext: mode === "fuzzy" ? 0 : context.after,
						fuzzyFallback,
					})
				: undefined;
		return renderFffGrepResult(this.session, page.result, scope, {
			cursor,
			fuzzyFallback,
			perFileLimitReached: state.perFileLimitReached,
		});
	}
}

export class FffFindTool implements AgentTool<typeof findSchema, FffFindDetails> {
	readonly name = "find";
	readonly label = "Find";
	readonly approval = "read" as const;
	readonly loadMode = "essential" as const;
	readonly strict = true;
	readonly parameters = findSchema;
	readonly #manager: FffFinderManager;
	readonly #cursors = new CursorStore<FindCursor>("fff_f", FIND_CURSOR_LIMIT);

	readonly examples: readonly ToolExample<FffFindToolInput>[] = [
		{ caption: "Fuzzy path search", call: { pattern: "session history", path: "src/", exclude: "test/" } },
	];

	constructor(private readonly session: ToolSession) {
		this.#manager = getSessionFffFinderManager(session);
	}

	get description(): string {
		return prompt.render(selectPrompt(findDescription, findDescriptionZh));
	}

	async execute(
		_toolCallId: string,
		params: FffFindToolInput,
		signal?: AbortSignal,
	): Promise<AgentToolResult<FffFindDetails>> {
		throwIfAborted(signal);
		if (!params.cursor && !params.pattern.trim() && !params.path?.trim()) {
			throw new ToolError("find requires a pattern or path constraint");
		}
		const resumed = params.cursor ? this.#cursors.get(params.cursor) : undefined;
		if (params.cursor && !resumed) throw new ToolError(`Unknown or expired find cursor: ${params.cursor}`);
		const scope = resumed
			? await resumeFffScope(this.#manager, resumed.scope)
			: await resolvePicker(this.#manager, this.session, params.path);
		throwIfAborted(signal);
		const limit = resumed?.pageSize ?? clampLimit(params.limit, DEFAULT_FIND_LIMIT);
		const pattern = resumed?.pattern ?? params.pattern;
		const query = resumed?.query ?? resolveQuery(scope, pattern, params.exclude);
		const pageIndex = resumed?.nextPageIndex ?? 0;
		const searchResult = scope.finder.fileSearch(query, { pageIndex, pageSize: limit });
		if (!searchResult.ok) throw new ToolError(searchResult.error);
		const result = searchResult.value;
		const formatted = formatFindResult(result, limit, pattern, scope.root, this.session.cwd);
		const shown = pageIndex * limit + result.items.length;
		const hasMore = !formatted.weak && result.items.length >= limit && result.totalMatched > shown;
		const cursor = hasMore
			? this.#cursors.store({
					query,
					pattern,
					pageSize: limit,
					nextPageIndex: pageIndex + 1,
					scope: scopeIdentity(scope),
				})
			: undefined;
		const notices: string[] = [];
		if (formatted.weak && formatted.files.length > 0) {
			notices.push(
				`Query '${pattern}' produced only weak fuzzy matches; showing ${formatted.files.length}/${result.totalMatched}`,
			);
		}
		if (cursor) notices.push(`${result.totalMatched - shown} more matches available; cursor="${cursor}"`);
		const output =
			notices.length > 0 ? `${formatted.files.join("\n")}\n\n[${notices.join(". ")}]` : formatted.files.join("\n");
		return toolResult<FffFindDetails>({
			scopePath: scope.displayPath,
			fileCount: formatted.files.length,
			files: formatted.files,
			cwd: this.session.cwd,
			totalMatched: result.totalMatched,
			pageIndex,
			hasMore,
			weak: formatted.weak,
			truncated: Boolean(hasMore || formatted.weak),
		})
			.text(output || "No files found matching pattern")
			.done();
	}
}

export class FffMultiGrepTool implements AgentTool<typeof multiGrepSchema, FffGrepDetails> {
	readonly name = "multi_grep";
	readonly label = "Multi Grep";
	readonly approval = "read" as const;
	readonly loadMode = "essential" as const;
	readonly strict = true;
	readonly parameters = multiGrepSchema;
	readonly #manager: FffFinderManager;
	readonly #cursors = new CursorStore<MultiGrepCursorState>("fff_m", GREP_CURSOR_LIMIT);

	readonly examples: readonly ToolExample<FffMultiGrepToolInput>[] = [
		{
			caption: "Search naming variants",
			call: { patterns: ["file_finder", "FileFinder", "fileFinder"], constraints: "*.ts !test/" },
		},
	];

	constructor(private readonly session: ToolSession) {
		this.#manager = getSessionFffFinderManager(session);
	}

	get description(): string {
		return prompt.render(selectPrompt(multiGrepDescription, multiGrepDescriptionZh));
	}

	async execute(
		_toolCallId: string,
		params: FffMultiGrepToolInput,
		signal?: AbortSignal,
	): Promise<AgentToolResult<FffGrepDetails>> {
		throwIfAborted(signal);
		const normalizedPatterns = params.cursor
			? undefined
			: params.patterns.map(pattern => pattern.trim()).filter(Boolean);
		if (!params.cursor && normalizedPatterns?.length === 0)
			throw new ToolError("multi_grep requires at least one pattern");
		const resumed = params.cursor ? this.#cursors.get(params.cursor) : undefined;
		if (params.cursor && !resumed) throw new ToolError(`Unknown or expired multi_grep cursor: ${params.cursor}`);
		const scope = resumed
			? await resumeFffScope(this.#manager, resumed.scope)
			: await resolvePicker(this.#manager, this.session, undefined);
		throwIfAborted(signal);
		const pageSize = resumed?.pageSize ?? clampLimit(params.limit, DEFAULT_GREP_LIMIT, GREP_PAGE_SIZE_MAX);
		const context = resumed
			? { before: resumed.beforeContext, after: resumed.afterContext }
			: resolveContext(this.session, params.context);
		const patterns = resumed?.patterns ?? normalizedPatterns!;
		const constraints = resumed?.constraints ?? params.constraints;
		const fetch = (cursor: GrepCursor | null): GrepResult => {
			const value = scope.finder.multiGrep({
				patterns,
				constraints,
				maxMatchesPerFile: NATIVE_GREP_PER_FILE_SENTINEL,
				pageSize: NATIVE_GREP_FILE_PAGE_SIZE,
				smartCase: true,
				cursor,
				beforeContext: context.before,
				afterContext: context.after,
				classifyDefinitions: true,
			});
			if (!value.ok) throw new ToolError(value.error);
			return value.value;
		};
		let state = resumed ? fillGrepPage(resumed, pageSize, fetch) : mergeGrepPageState(undefined, fetch(null));
		if (!resumed) state = fillGrepPage(state, pageSize, fetch);
		const page = consumeGrepPage(state, pageSize);
		const cursor = page.next
			? this.#cursors.store({
					...page.next,
					scope: scopeIdentity(scope),
					patterns: [...patterns],
					constraints,
					pageSize,
					beforeContext: context.before,
					afterContext: context.after,
				})
			: undefined;
		return renderFffGrepResult(this.session, page.result, scope, {
			cursor,
			patterns,
			perFileLimitReached: state.perFileLimitReached,
		});
	}
}
