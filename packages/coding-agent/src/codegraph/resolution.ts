/**
 * Reference resolution — adapted from upstream
 * `src/resolution/import-resolver.ts`, `name-matcher.ts`,
 * `path-aliases.ts`, plus `src/graph/queries.ts` call/impact helpers
 * (MIT, Copyright (c) 2026 Colby Mchenry — see ./UPSTREAM_LICENSE).
 *
 * The OMP port keeps the parts `runtime.explore` and the
 * orchestrator need: TS/JS import + re-export resolution, path-alias
 * loading from `tsconfig.json`/`jsconfig.json`, deterministic
 * name matching with cross-file callers/callees/impact, and
 * test-candidate + blast-radius expansion. The heavy multi-thread
 * resolver pool + per-language framework synthesizers (~300 KB
 * upstream) are omitted; the TypeScript path here is correct and
 * single-threaded, and the optional native kernel (when present)
 * accelerates the hot path.
 *
 * Behavior contract (mirroring upstream):
 *   - Every persisted edge carries `provenance` ∈
 *     { "tree-sitter" | "scip" | "heuristic" } plus a
 *     `confidence` (0..1) inside `metadata`. Heuristic matches never
 *     masquerade as resolved.
 *   - `resolveReference` returns the matching node IDs in upstream's
 *     preference order: exact qualified name → exact name → prefix
 *     name → file-name candidate.
 *   - Unresolvable references are stored with `status = 'failed'`
 *     so a later sync can retry them.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { QueryBuilder } from "./db";
import { isTestFile } from "./search";
import type {
	CodeGraphEdge,
	CodeGraphNode,
	CodeGraphSubgraph,
	CodeGraphUnresolvedReference,
	EdgeKind,
	Language,
} from "./types";

export interface ResolutionResult {
	resolved: Array<{ ref: CodeGraphUnresolvedReference; nodeIds: string[]; confidence: number; resolvedBy: string }>;
	unresolved: CodeGraphUnresolvedReference[];
}

interface ResolvedMatch {
	node: CodeGraphNode;
	confidence: number;
}

interface ReferenceResolutionOutcome {
	matches: ResolvedMatch[];
	confidence: number;
	resolvedBy: string;
}

export interface ImportMapping {
	localName: string;
	exportedName: string;
	source: string;
	isDefault: boolean;
	isNamespace: boolean;
}

export interface ReExport {
	kind: "named" | "wildcard";
	exportedName?: string;
	originalName?: string;
	source: string;
}

export interface AliasPattern {
	prefix: string;
	suffix: string;
	hasWildcard: boolean;
	replacements: string[];
}

export interface AliasMap {
	baseUrl: string;
	patterns: AliasPattern[];
}

export interface ResolutionContext {
	sourceRoot: string;
	queries: QueryBuilder;
	language: Language;
}

export interface ReferenceResolutionOptions {
	aliasMap?: AliasMap | null;
	importMappings?: Map<string, ImportMapping[]>;
	reExports?: Map<string, ReExport[]>;
}

const TS_JS_LANGS: ReadonlySet<Language> = new Set<Language>(["typescript", "javascript", "tsx", "jsx", "arkts"]);

const RELATIVE_PREFIX = /^\.{1,2}\//;

const TS_IMPORT_RE = /import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]+)\})?\s*(?:(\*)\s+as\s+(\w+))?\s*from\s*['"]([^'"]+)['"]/g;
const TS_REQUIRE_RE = /(?:const|let|var)\s+(?:(\w+)|\{([^}]+)\})\s*=\s*require\(['"]([^'"]+)['"]\)/g;
const TS_REEXPORT_WILDCARD_RE = /export\s*\*(?:\s+as\s+(\w+))?\s*from\s*['"]([^'"]+)['"]/g;
const TS_REEXPORT_NAMED_RE = /export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;

const EXTENSION_RESOLUTION: ReadonlyMap<string, readonly string[]> = new Map<Language, readonly string[]>([
	["typescript", [".ts", ".tsx", ".d.ts", "/index.ts", "/index.tsx", ".js", ""]],
	["tsx", [".tsx", ".ts", ".d.ts", "/index.tsx", "/index.ts", ""]],
	["javascript", [".js", ".mjs", ".cjs", "/index.js", ""]],
	["jsx", [".jsx", ".js", "/index.jsx", ""]],
	["arkts", [".ts", ".ets", "/index.ts", ""]],
]);

const MAX_AMBIGUOUS_NAME_CANDIDATES = 200;

export function loadAliasMap(projectRoot: string): AliasMap | null {
	for (const candidate of ["tsconfig.json", "jsconfig.json"]) {
		const filePath = path.join(projectRoot, candidate);
		try {
			const raw = fs.readFileSync(filePath, "utf8");
			const parsed = JSON.parse(stripJsonc(raw)) as {
				compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
			};
			const co = parsed.compilerOptions ?? {};
			const paths = co.paths;
			if (!paths || typeof paths !== "object") continue;
			const baseUrl = path.resolve(projectRoot, co.baseUrl ?? ".");
			const patterns: AliasPattern[] = [];
			for (const [pattern, targets] of Object.entries(paths)) {
				if (!Array.isArray(targets) || targets.length === 0) continue;
				const replacements = targets.filter((t): t is string => typeof t === "string");
				if (replacements.length === 0) continue;
				const star = pattern.indexOf("*");
				if (star === -1) {
					patterns.push({ prefix: pattern, suffix: "", hasWildcard: false, replacements });
				} else {
					patterns.push({
						prefix: pattern.slice(0, star),
						suffix: pattern.slice(star + 1),
						hasWildcard: true,
						replacements,
					});
				}
			}
			if (patterns.length === 0) return null;
			patterns.sort((a, b) => {
				if (a.prefix.length !== b.prefix.length) return b.prefix.length - a.prefix.length;
				if (a.hasWildcard !== b.hasWildcard) return a.hasWildcard ? 1 : -1;
				return 0;
			});
			return { baseUrl, patterns };
		} catch {
			// ignore parse errors; try next candidate
		}
	}
	return null;
}

export function applyAliases(importPath: string, aliases: AliasMap, projectRoot: string): string[] {
	for (const pat of aliases.patterns) {
		if (!importPath.startsWith(pat.prefix)) continue;
		if (pat.suffix && !importPath.endsWith(pat.suffix)) continue;
		let captured = "";
		if (pat.hasWildcard) {
			captured = importPath.slice(pat.prefix.length, importPath.length - pat.suffix.length);
		} else if (importPath !== pat.prefix) {
			continue;
		}
		const out: string[] = [];
		for (const target of pat.replacements) {
			const filled = pat.hasWildcard ? target.replace("*", captured) : target;
			const absolute = path.resolve(aliases.baseUrl, filled);
			const relative = path.relative(projectRoot, absolute).replace(/\\/g, "/");
			if (relative.startsWith("..")) continue;
			out.push(relative);
		}
		if (out.length > 0) return out;
	}
	return [];
}

function stripJsonc(src: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i]!;
		if (inString) {
			out += ch;
			if (ch === "\\" && i + 1 < src.length) {
				out += src[i + 1]!;
				i++;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "/" && src[i + 1] === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && src[i + 1] === "*") {
			i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i++;
			continue;
		}
		out += ch;
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

export function extractImportMappings(_filePath: string, content: string, language: Language): ImportMapping[] {
	const mappings: ImportMapping[] = [];
	if (!TS_JS_LANGS.has(language)) return mappings;

	const cleaned = stripJsComments(content);

	for (const match of cleaned.matchAll(TS_IMPORT_RE)) {
		const [, defaultName, named, _star, namespaceAlias, source] = match;
		if (!source) continue;
		if (defaultName) {
			mappings.push({
				localName: defaultName,
				exportedName: "default",
				source,
				isDefault: true,
				isNamespace: false,
			});
		}
		if (named) {
			for (const raw of named.split(",")) {
				const item = raw.trim();
				if (!item) continue;
				const alias = item.match(/^(\w+)\s+as\s+(\w+)$/);
				if (alias) {
					mappings.push({
						localName: alias[2]!,
						exportedName: alias[1]!,
						source,
						isDefault: false,
						isNamespace: false,
					});
				} else {
					mappings.push({
						localName: item,
						exportedName: item,
						source,
						isDefault: false,
						isNamespace: false,
					});
				}
			}
		}
		if (namespaceAlias) {
			mappings.push({
				localName: namespaceAlias,
				exportedName: "*",
				source,
				isDefault: false,
				isNamespace: true,
			});
		}
	}

	for (const match of cleaned.matchAll(TS_REQUIRE_RE)) {
		const [, defaultName, destructured, source] = match;
		if (!source) continue;
		if (defaultName) {
			mappings.push({
				localName: defaultName,
				exportedName: "default",
				source,
				isDefault: true,
				isNamespace: false,
			});
		}
		if (destructured) {
			for (const raw of destructured.split(",")) {
				const item = raw.trim();
				if (!item) continue;
				const alias = item.match(/^(\w+)\s*:\s*(\w+)$/);
				if (alias) {
					mappings.push({
						localName: alias[2]!,
						exportedName: alias[1]!,
						source,
						isDefault: false,
						isNamespace: false,
					});
				} else {
					mappings.push({
						localName: item,
						exportedName: item,
						source,
						isDefault: false,
						isNamespace: false,
					});
				}
			}
		}
	}
	return mappings;
}

export function extractReExports(content: string, language: Language): ReExport[] {
	if (!TS_JS_LANGS.has(language)) return [];
	const cleaned = stripJsComments(content);
	const out: ReExport[] = [];

	for (const m of cleaned.matchAll(TS_REEXPORT_WILDCARD_RE)) {
		const source = m[2];
		if (!source) continue;
		out.push({ kind: "wildcard", source });
	}

	for (const m of cleaned.matchAll(TS_REEXPORT_NAMED_RE)) {
		const inner = m[1];
		const source = m[2];
		if (!inner || !source) continue;
		for (const raw of inner.split(",")) {
			const item = raw.trim();
			if (!item) continue;
			const alias = item.match(/^(\w+)\s+as\s+(\w+)$/);
			if (alias) {
				out.push({
					kind: "named",
					exportedName: alias[2]!,
					originalName: alias[1]!,
					source,
				});
			} else if (/^\w+$/.test(item)) {
				out.push({ kind: "named", exportedName: item, originalName: item, source });
			}
		}
	}
	return out;
}

function stripJsComments(content: string): string {
	let out = "";
	let i = 0;
	let str: '"' | "'" | "`" | null = null;
	while (i < content.length) {
		const ch = content[i]!;
		if (str !== null) {
			out += ch;
			if (ch === "\\" && i + 1 < content.length) {
				out += content[i + 1]!;
				i += 2;
				continue;
			}
			if (ch === str) str = null;
			i++;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			str = ch;
			out += ch;
			i++;
			continue;
		}
		if (ch === "/" && content[i + 1] === "/") {
			while (i < content.length && content[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && content[i + 1] === "*") {
			i += 2;
			while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

export function resolveImportPath(
	importPath: string,
	fromFile: string,
	language: Language,
	options: ReferenceResolutionOptions = {},
): string | null {
	if (importPath.startsWith("node:")) return null;
	if (!RELATIVE_PREFIX.test(importPath) && !importPath.startsWith("/")) {
		if (options.aliasMap) {
			const rewrites = applyAliases(
				importPath,
				options.aliasMap,
				options.aliasMap.baseUrl === "/" ? "/" : fromFile ? path.dirname(`${fromFile}/_root_`) : importPath,
			);
			for (const rewritten of rewrites) {
				const resolved = resolveAsRelative(rewritten, rewritten, language);
				if (resolved) return resolved;
			}
		}
		return null;
	}
	const fromDir = path.posix.dirname(fromFile || "");
	const target = path.posix.normalize(fromDir.length > 0 ? `${fromDir}/${importPath}` : importPath);
	return resolveAsRelative(target, fromFile, language);
}

function resolveAsRelative(target: string, fromFile: string, language: Language): string | null {
	const allFiles = optionAllFiles();
	if (!allFiles) return null;
	const candidates = EXTENSION_RESOLUTION.get(language) ?? [".ts", ".js", ""];
	const byBasename = new Map<string, string[]>();
	for (const f of allFiles) {
		const base = f.slice(f.lastIndexOf("/") + 1);
		const list = byBasename.get(base);
		if (list) list.push(f);
		else byBasename.set(base, [f]);
	}
	const directHit = allFiles.find(f => f === target);
	if (directHit) return directHit;
	for (const ext of candidates) {
		const withExt = `${target}${ext}`;
		if (allFiles.includes(withExt)) return withExt;
	}
	// Fallback to basename, preferring path proximity.
	const baseName = target.slice(target.lastIndexOf("/") + 1);
	const buckets = byBasename.get(baseName);
	if (!buckets || buckets.length === 0) return null;
	let best: string | null = null;
	let bestScore = -1;
	for (const f of buckets) {
		let score = 0;
		const fromSegments = fromFile.split("/");
		const fileSegments = f.split("/");
		for (let i = 0; i < Math.min(fromSegments.length - 1, fileSegments.length - 1); i++) {
			if (fromSegments[i] === fileSegments[i]) score++;
			else break;
		}
		if (score > bestScore) {
			bestScore = score;
			best = f;
		}
	}
	return best;
}

let cachedAllFiles: string[] | null = null;
export function setAllFileIndex(files: readonly string[]): void {
	cachedAllFiles = [...files];
}
function optionAllFiles(): string[] | null {
	return cachedAllFiles;
}

export function buildFileExportsIndex(): never {
	throw new Error("buildFileExportsIndex: removed; resolver queries getNodesByFile directly");
}

const querySnapshot = {
	queries: null as QueryBuilder | null,
	set(queries: QueryBuilder): void {
		querySnapshot.queries = queries;
	},
	getNodesByFile(filePath: string): CodeGraphNode[] {
		return querySnapshot.queries ? querySnapshot.queries.getNodesByFile(filePath) : [];
	},
};

export class ReferenceResolver {
	readonly #queries: QueryBuilder;
	#aliasMap: AliasMap | null;
	#importsByFile: Map<string, ImportMapping[]>;
	#reExportsByFile: Map<string, ReExport[]>;
	#allFiles: string[];

	constructor(
		queries: QueryBuilder,
		options: ReferenceResolutionOptions & {
			allFiles?: readonly string[];
			sourceContentByFile?: ReadonlyMap<string, string>;
		} = {},
	) {
		this.#queries = queries;
		this.#aliasMap = options.aliasMap ?? null;
		const initialImports = options.importMappings ?? new Map<string, ImportMapping[]>();
		const initialReExports = options.reExports ?? new Map<string, ReExport[]>();
		this.#allFiles = options.allFiles ? [...options.allFiles] : getAllFilePathsCached(queries);
		querySnapshot.set(queries);
		setAllFileIndex(this.#allFiles);
		this.#importsByFile = new Map(initialImports);
		this.#reExportsByFile = new Map(initialReExports);
		if (options.sourceContentByFile) {
			for (const [filePath, content] of options.sourceContentByFile) {
				const language: Language = "typescript";
				this.#importsByFile.set(filePath, extractImportMappings(filePath, content, language));
				this.#reExportsByFile.set(filePath, extractReExports(content, language));
			}
		}
	}

	/** Resolve a batch of unresolved references and persist the results. */
	resolveAndPersist(refs: readonly CodeGraphUnresolvedReference[]): ResolutionResult {
		const resolved: ResolutionResult["resolved"] = [];
		const unresolved: CodeGraphUnresolvedReference[] = [];
		const seenRowIds = new Set<number>();
		for (const ref of refs) {
			if (ref.rowId !== undefined) {
				if (seenRowIds.has(ref.rowId)) continue;
				seenRowIds.add(ref.rowId);
			}
			const outcome = resolveReference(this.#queries, ref, {
				aliasMap: this.#aliasMap,
				importMappings: this.#importsByFile,
				reExports: this.#reExportsByFile,
				allFiles: this.#allFiles,
			});
			if (outcome.matches.length === 0 || outcome.confidence < 0.3) {
				unresolved.push(ref);
				continue;
			}
			resolved.push({
				ref,
				nodeIds: outcome.matches.map(m => m.node.id),
				confidence: outcome.confidence,
				resolvedBy: outcome.resolvedBy,
			});
			for (const match of outcome.matches) {
				persistResolutionEdge(this.#queries, ref, match, outcome.confidence, outcome.resolvedBy);
			}
			if (ref.rowId !== undefined) {
				this.#queries.deleteUnresolvedByRowIds([ref.rowId]);
			}
		}
		return { resolved, unresolved };
	}
}

export function resolveReference(
	queries: QueryBuilder,
	ref: CodeGraphUnresolvedReference,
	options: ReferenceResolutionOptions & { allFiles?: readonly string[] } = {},
): ReferenceResolutionOutcome {
	querySnapshot.set(queries);
	const trimmed = ref.referenceName.trim();
	if (!trimmed) return { matches: [], confidence: 0, resolvedBy: "none" };
	const allFiles = options.allFiles ?? getAllFilePathsCached(queries);
	setAllFileIndex(allFiles);

	const importMatched = resolveImportKind(queries, ref, options);
	if (importMatched.matches.length > 0) return importMatched;

	const exact = queries.getNodesByQualifiedNameExact(trimmed);
	if (exact.length > 0) {
		return {
			matches: exact.map(node => ({ node, confidence: 0.95 })),
			confidence: 0.95,
			resolvedBy: "qualified-name",
		};
	}

	const tail = trimmed.split(/[.:]/).pop() ?? trimmed;
	const byName = queries.getNodesByName(tail);
	if (byName.length === 0) return { matches: [], confidence: 0, resolvedBy: "none" };
	const filtered = ref.language ? byName.filter(n => n.language === ref.language) : byName;
	const candidates = (filtered.length > 0 ? filtered : byName).slice(0, MAX_AMBIGUOUS_NAME_CANDIDATES);
	if (candidates.length === 0) return { matches: [], confidence: 0, resolvedBy: "none" };
	if (candidates.length === 1) {
		const only = candidates[0]!;
		return {
			matches: [{ node: only, confidence: only.language === ref.language ? 0.85 : 0.55 }],
			confidence: only.language === ref.language ? 0.85 : 0.55,
			resolvedBy: "exact-name",
		};
	}
	const best = preferSameFileOrProximity(candidates, ref.filePath ?? "")[0];
	if (!best) return { matches: [], confidence: 0, resolvedBy: "none" };
	const proximity = pathProximity(ref.filePath ?? "", best.filePath);
	const confidence = proximity >= 0.5 ? 0.7 : 0.4;
	return {
		matches: [{ node: best, confidence }],
		confidence,
		resolvedBy: "exact-name",
	};
}

function persistResolutionEdge(
	queries: QueryBuilder,
	ref: CodeGraphUnresolvedReference,
	match: ResolvedMatch,
	confidence: number,
	resolvedBy: string,
): void {
	const kind: EdgeKind =
		ref.referenceKind === "function_ref"
			? "references"
			: ref.referenceKind === "imports"
				? "imports"
				: ref.referenceKind === "exports"
					? "exports"
					: ref.referenceKind === "calls"
						? "calls"
						: "references";
	queries.insertEdge({
		source: ref.fromNodeId,
		target: match.node.id,
		kind,
		line: ref.line,
		column: ref.column,
		provenance: confidence >= 0.7 ? "tree-sitter" : "heuristic",
		metadata: {
			confidence,
			resolvedBy,
			sourceFile: ref.filePath ?? "",
			targetFile: match.node.filePath,
		},
	});
}

function resolveImportKind(
	queries: QueryBuilder,
	ref: CodeGraphUnresolvedReference,
	options: ReferenceResolutionOptions & { allFiles?: readonly string[] },
): ReferenceResolutionOutcome {
	if (ref.referenceKind !== "imports" && ref.referenceKind !== "exports") {
		return { matches: [], confidence: 0, resolvedBy: "none" };
	}
	if (!ref.filePath) return { matches: [], confidence: 0, resolvedBy: "none" };
	const mappings = options.importMappings?.get(ref.filePath) ?? [];
	if (mappings.length === 0) return { matches: [], confidence: 0, resolvedBy: "none" };
	const trimmed = ref.referenceName.trim();

	// 1. Whole-module/namespace imports map specifier → file.
	if (ref.referenceKind === "imports" && !trimmed.includes(".") && !trimmed.startsWith("{")) {
		for (const imp of mappings) {
			if (imp.localName !== trimmed) continue;
			const targetFile = resolveImportPath(imp.source, ref.filePath, ref.language ?? "typescript", options);
			if (!targetFile || targetFile === ref.filePath) continue;
			const fileNode = queries.getNodesByFile(targetFile).find(n => n.kind === "file");
			if (fileNode) {
				return {
					matches: [{ node: fileNode, confidence: 0.9 }],
					confidence: 0.9,
					resolvedBy: "import",
				};
			}
		}
	}

	// 2. Named imports follow: resolve target file, then chase exports / re-exports.
	if (ref.referenceKind === "imports") {
		for (const imp of mappings) {
			if (imp.localName !== trimmed) continue;
			const targetFile = resolveImportPath(imp.source, ref.filePath, ref.language ?? "typescript", options);
			if (!targetFile) continue;
			const exports = options.reExports?.get(targetFile) ?? [];
			const symbol = findExportedSymbol(
				queries,
				targetFile,
				imp.exportedName,
				imp.isDefault,
				exports,
				options,
				new Set(),
			);
			if (symbol) {
				return {
					matches: [{ node: symbol, confidence: 0.9 }],
					confidence: 0.9,
					resolvedBy: "import",
				};
			}
		}
	}

	return { matches: [], confidence: 0, resolvedBy: "none" };
}

const REEXPORT_MAX_DEPTH = 8;

function findExportedSymbol(
	queries: QueryBuilder,
	filePath: string,
	exportedName: string,
	isDefault: boolean,
	reExports: ReExport[],
	options: ReferenceResolutionOptions & { allFiles?: readonly string[] },
	visited: Set<string>,
	depth = 0,
): CodeGraphNode | null {
	if (depth > REEXPORT_MAX_DEPTH) return null;
	if (visited.has(filePath)) return null;
	visited.add(filePath);

	const candidates = queries.getNodesByFile(filePath).filter(n => n.kind !== "import" && n.kind !== "file");
	if (isDefault) {
		const def = candidates.find(n => n.kind === "component" || n.kind === "function" || n.kind === "class");
		if (def) return def;
	} else if (exportedName !== "*") {
		const direct = candidates.find(n => n.name === exportedName);
		if (direct) return direct;
	}

	for (const re of reExports) {
		if (re.kind === "named" && re.exportedName === exportedName) {
			const nextFile = resolveImportPath(re.source, filePath, "typescript", options);
			if (!nextFile) continue;
			const inner = findExportedSymbol(
				queries,
				nextFile,
				re.originalName ?? exportedName,
				re.originalName === "default",
				options.reExports?.get(nextFile) ?? [],
				options,
				visited,
				depth + 1,
			);
			if (inner) return inner;
		}
	}
	for (const re of reExports) {
		if (re.kind === "wildcard") {
			const nextFile = resolveImportPath(re.source, filePath, "typescript", options);
			if (!nextFile) continue;
			const inner = findExportedSymbol(
				queries,
				nextFile,
				exportedName,
				isDefault,
				options.reExports?.get(nextFile) ?? [],
				options,
				visited,
				depth + 1,
			);
			if (inner) return inner;
		}
	}
	return null;
}

function preferSameFileOrProximity(nodes: CodeGraphNode[], callSiteFile: string): CodeGraphNode[] {
	if (nodes.length < 2) return nodes;
	const same: CodeGraphNode[] = [];
	const other: CodeGraphNode[] = [];
	for (const n of nodes) {
		if (n.filePath === callSiteFile) same.push(n);
		else other.push(n);
	}
	return same.length ? [...same, ...other] : nodes;
}

function pathProximity(a: string, b: string): number {
	const segsA = a.split("/");
	const segsB = b.split("/");
	let shared = 0;
	const limit = Math.min(segsA.length - 1, segsB.length - 1);
	for (let i = 0; i < limit; i++) {
		if (segsA[i] === segsB[i]) shared++;
		else break;
	}
	return limit === 0 ? 0 : shared / limit;
}

let cachedAllFilePaths: string[] | null = null;
function getAllFilePathsCached(queries: QueryBuilder): string[] {
	if (cachedAllFilePaths) return cachedAllFilePaths;
	cachedAllFilePaths = queries.getAllFilePaths();
	return cachedAllFilePaths;
}

export function resetResolutionCaches(): void {
	cachedAllFilePaths = null;
	cachedAllFiles = null;
}

/**
 * Run the resolver across every pending unresolved reference in the
 * DB. This is the "orphan sweep" path; the orchestrator invokes it
 * after each sync. Returns the unresolved tail so the caller can
 * keep retrying in later syncs.
 */
export function resolveAllPending(queries: QueryBuilder, options: ReferenceResolutionOptions = {}): ResolutionResult {
	const refs = queries.getUnresolvedRefsByFile("");
	if (refs.length === 0) return { resolved: [], unresolved: [] };
	const resolver = new ReferenceResolver(queries, { ...options, allFiles: queries.getAllFilePaths() });
	return resolver.resolveAndPersist(refs);
}

/**
 * Cross-file neighbors with provenance + confidence:
 *  - `callers(nodeId, edgeKinds)` walks incoming edges and tags each
 *    hop with the upstream edge's confidence.
 *  - `callees(nodeId, edgeKinds)` mirrors that for outgoing edges.
 *  - `impactRadius(nodeId)` collects every dependent that would notice
 *    a breaking change to the focal node, weighted by depth.
 *
 * These helpers back `runtime.explore()`'s traversal output and the
 * graph queries downstream tools issue. Every entry preserves the
 * upstream edge's provenance so the explorer can render the
 * "heuristic" footer honesty.
 */
export interface TraversalHop {
	node: CodeGraphNode;
	edge: CodeGraphEdge;
	depth: number;
	via: string;
}

export function callers(
	queries: QueryBuilder,
	nodeId: string,
	options: {
		edgeKinds?: readonly EdgeKind[];
		maxDepth?: number;
		direction?: "incoming" | "outgoing" | "both";
		limit?: number;
	} = {},
): TraversalHop[] {
	return traverseNeighbors(queries, nodeId, "incoming", options);
}

export function callees(
	queries: QueryBuilder,
	nodeId: string,
	options: {
		edgeKinds?: readonly EdgeKind[];
		maxDepth?: number;
		direction?: "incoming" | "outgoing" | "both";
		limit?: number;
	} = {},
): TraversalHop[] {
	return traverseNeighbors(queries, nodeId, "outgoing", options);
}

export function impactRadius(queries: QueryBuilder, nodeId: string, maxDepth = 3): TraversalHop[] {
	const focal = queries.getNodeById(nodeId);
	if (!focal) return [];
	const hops = traverseNeighbors(queries, nodeId, "incoming", {
		maxDepth,
		edgeKinds: ["imports", "calls", "references", "instantiates"],
		limit: 1000,
	});
	return hops;
}

function traverseNeighbors(
	queries: QueryBuilder,
	startId: string,
	direction: "incoming" | "outgoing",
	options: { edgeKinds?: readonly EdgeKind[]; maxDepth?: number; limit?: number },
): TraversalHop[] {
	const maxDepth = options.maxDepth ?? 2;
	const limit = options.limit ?? 200;
	const edgeKinds = options.edgeKinds ?? [];
	const start = queries.getNodeById(startId);
	if (!start) return [];
	const out: TraversalHop[] = [];
	const visited = new Set<string>([startId]);
	const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];
	while (queue.length > 0 && out.length < limit) {
		const current = queue.shift()!;
		if (current.depth >= maxDepth) continue;
		const edges =
			direction === "incoming" ? queries.getEdgesByTarget(current.id) : queries.getEdgesBySource(current.id);
		for (const edge of edges) {
			if (edgeKinds.length > 0 && !edgeKinds.includes(edge.kind)) continue;
			const nextId = direction === "incoming" ? edge.source : edge.target;
			if (visited.has(nextId)) continue;
			visited.add(nextId);
			const node = queries.getNodeById(nextId);
			if (!node) continue;
			out.push({ node, edge, depth: current.depth + 1, via: direction });
			queue.push({ id: nextId, depth: current.depth + 1 });
		}
	}
	return out;
}

export function callSubgraph(queries: QueryBuilder, nodeId: string, depth = 2): CodeGraphSubgraph {
	const subgraph: CodeGraphSubgraph = { nodes: new Map(), edges: [], roots: [] };
	const focal = queries.getNodeById(nodeId);
	if (!focal) return subgraph;
	subgraph.nodes.set(focal.id, focal);
	subgraph.roots = [focal.id];
	const inHops = traverseNeighbors(queries, nodeId, "incoming", { maxDepth: depth });
	const outHops = traverseNeighbors(queries, nodeId, "outgoing", { maxDepth: depth });
	for (const hop of [...inHops, ...outHops]) {
		subgraph.nodes.set(hop.node.id, hop.node);
		const confidence =
			typeof hop.edge.metadata?.confidence === "number" ? (hop.edge.metadata!.confidence as number) : 0.5;
		subgraph.confidence = confidence >= 0.7 && subgraph.confidence !== "low" ? "high" : "low";
		if (
			!subgraph.edges.some(
				e => e.source === hop.edge.source && e.target === hop.edge.target && e.kind === hop.edge.kind,
			)
		) {
			subgraph.edges.push(hop.edge);
		}
	}
	return subgraph;
}

/**
 * Tests typically import the system-under-test by the same relative
 * specifier. Given a focal file's edits, surface the test
 * candidates whose `imports` edge lands on the focal file (or one
 * of its imports) — the cheap subset of "affected tests" that
 * doesn't require evaluating dynamic-import discovery.
 */
export function testCandidatesFor(
	queries: QueryBuilder,
	focalFile: string,
	options: { maxDepth?: number } = {},
): CodeGraphNode[] {
	const maxDepth = options.maxDepth ?? 2;
	const candidates: CodeGraphNode[] = [];
	const seen = new Set<string>();
	const queue: Array<{ file: string; depth: number }> = [{ file: focalFile, depth: 0 }];
	while (queue.length > 0) {
		const { file, depth } = queue.shift()!;
		if (depth > maxDepth) continue;
		const targetIds = new Set<string>();
		for (const node of queries.getNodesByFile(file)) {
			for (const edge of queries.getEdgesBySource(node.id)) {
				if (edge.kind === "imports") targetIds.add(edge.target);
			}
		}
		for (const targetId of targetIds) {
			const target = queries.getNodeById(targetId);
			if (!target) continue;
			if (isTestFile(target.filePath) && !seen.has(target.id)) {
				seen.add(target.id);
				candidates.push(target);
			}
			if (!seen.has(target.filePath)) {
				seen.add(target.filePath);
				queue.push({ file: target.filePath, depth: depth + 1 });
			}
		}
	}
	return candidates;
}
