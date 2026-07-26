/**
 * Query parser + symbol-name tokenizer — adapted from upstream
 * `src/search/query-parser.ts` and
 * `src/search/identifier-segments.ts` (MIT, Colby Mchenry).
 *
 * The OMP port keeps the same field-qualified semantics:
 *   kind:function name:auth path:src/api authenticate
 *
 * but the heavy FTS path runs through `QueryBuilder.searchByTerm` on
 * top of `bun:sqlite`. Native-bun's FTS5 is the same engine
 * upstream's `node:sqlite` path used, so the SQL is unchanged.
 */
import * as path from "node:path";

import { LANGUAGES, type Language, NODE_KINDS, type NodeKind } from "./types";

export interface ParsedQuery {
	kinds: NodeKind[];
	languages: Language[];
	pathIncludes: string[];
	nameIncludes: string[];
	freeText: string;
}

const KIND_VALUES: ReadonlySet<string> = new Set<string>(NODE_KINDS);
const LANGUAGE_VALUES: ReadonlySet<string> = new Set<string>(LANGUAGES);

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1);
	}
	return value;
}

/** Parse a raw query into structured filters + remaining text. */
export function parseQuery(raw: string): ParsedQuery {
	const out: ParsedQuery = {
		kinds: [],
		languages: [],
		pathIncludes: [],
		nameIncludes: [],
		freeText: "",
	};

	const text: string[] = [];
	const tokens = raw.match(/(?:"[^"]+"|\S+)/g) ?? [];

	for (const raw of tokens) {
		const colon = raw.indexOf(":");
		if (colon > 0) {
			const field = raw.slice(0, colon).toLowerCase();
			const value = unquote(raw.slice(colon + 1));
			switch (field) {
				case "kind": {
					if (KIND_VALUES.has(value)) out.kinds.push(value as NodeKind);
					else text.push(raw);
					continue;
				}
				case "lang":
				case "language": {
					if (LANGUAGE_VALUES.has(value)) out.languages.push(value as Language);
					else text.push(raw);
					continue;
				}
				case "path": {
					if (value) out.pathIncludes.push(value.toLowerCase());
					else text.push(raw);
					continue;
				}
				case "name": {
					if (value) out.nameIncludes.push(value.toLowerCase());
					else text.push(raw);
					continue;
				}
				default: {
					// Unknown `foo:bar` passes through to free text so a
					// search for `TODO:` still finds the literal token.
					text.push(raw);
				}
			}
		} else {
			text.push(raw);
		}
	}

	out.freeText = text.join(" ").trim();
	return out;
}

/**
 * Split an identifier into lowercase word segments. "OrderStateMachine"
 * → order / state / machine. The split rules are intentionally
 * narrower than upstream's heuristic so we don't have to pull in the
 * upstream locale tables; the runtime's full explore path lives in
 * `explorer.ts` and can grow the rules later.
 */
export function splitIdentifierSegments(name: string): string[] {
	const out: string[] = [];
	let buffer = "";
	for (let i = 0; i < name.length; i++) {
		const ch = name[i];
		if (!ch) continue;
		const upper = ch >= "A" && ch <= "Z";
		const prev = buffer[buffer.length - 1];
		const prevLower = prev !== undefined && !(prev >= "A" && prev <= "Z");
		const isDigit = ch >= "0" && ch <= "9";
		const prevDigit = prev !== undefined && prev >= "0" && prev <= "9";
		const transition = (upper && prevLower) || (isDigit && !prevDigit);
		const isSeparator = ch === "_" || ch === "-" || ch === " " || ch === "." || ch === "/";
		if (transition || isSeparator) {
			if (buffer.length > 0) {
				out.push(buffer.toLowerCase());
				buffer = "";
			}
			if (isSeparator) continue;
		}
		buffer += ch.toLowerCase();
	}
	if (buffer.length > 0) out.push(buffer);
	return out.filter(seg => seg.length >= 2);
}

/** Normalize a prose word for segment-vocab lookup. */
export function normalizeProseWord(word: string): string {
	return word
		.normalize("NFD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase();
}

const ENGLISH_PROSE_STOPWORDS: ReadonlySet<string> = new Set([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"into",
	"from",
	"are",
	"but",
	"not",
	"you",
	"any",
	"can",
	"how",
	"who",
	"why",
	"when",
	"where",
	"what",
	"does",
	"did",
	"fix",
	"show",
	"give",
	"help",
	"make",
	"find",
	"where",
	"what",
]);

const MIN_PROSE_CHARS = 4;
const MAX_PROSE_CHARS = 24;
const MAX_PROSE_CANDIDATES = 16;

/** Pull meaningful prose candidates from a prompt for segment lookup. */
export function extractProseCandidates(prompt: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of prompt.split(/\s+/u)) {
		const word = normalizeProseWord(raw);
		if (word.length < MIN_PROSE_CHARS || word.length > MAX_PROSE_CHARS) continue;
		if (ENGLISH_PROSE_STOPWORDS.has(word)) continue;
		if (seen.has(word)) continue;
		seen.add(word);
		out.push(word);
		if (out.length >= MAX_PROSE_CANDIDATES) break;
	}
	return out;
}

/** Light plural-folding for vocab lookup. */
export function segmentLookupVariants(word: string): string[] {
	const w = word.toLowerCase();
	if (w.length > 3 && w.endsWith("ies")) return [w, `${w.slice(0, -3)}y`];
	if (w.length > 3 && w.endsWith("es")) return [w, w.slice(0, -2)];
	if (w.length > 2 && w.endsWith("s")) return [w, w.slice(0, -1)];
	return [w];
}

export const STOP_WORDS: ReadonlySet<string> = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"but",
	"in",
	"on",
	"at",
	"to",
	"for",
	"of",
	"with",
	"by",
	"from",
	"is",
	"it",
	"that",
	"this",
	"are",
	"was",
	"be",
	"has",
	"had",
	"have",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"can",
	"shall",
	"not",
	"no",
	"all",
	"each",
	"every",
	"how",
	"what",
	"where",
	"when",
	"who",
	"which",
	"why",
	"show",
	"give",
	"tell",
	"need",
	"needs",
	"want",
	"code",
	"file",
	"files",
	"function",
	"method",
	"class",
	"type",
	"fix",
	"bug",
	"called",
]);

export function getStemVariants(term: string): string[] {
	const variants = new Set<string>();
	const t = term.toLowerCase();
	if (t.endsWith("ing") && t.length > 5) {
		const base = t.slice(0, -3);
		variants.add(base);
		variants.add(`${base}e`);
		if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
			variants.add(base.slice(0, -1));
		}
	}
	if ((t.endsWith("tion") || t.endsWith("sion")) && t.length > 5) variants.add(t.slice(0, -3));
	if (t.endsWith("ment") && t.length > 6) variants.add(t.slice(0, -4));
	if (t.endsWith("ies") && t.length > 4) variants.add(`${t.slice(0, -3)}y`);
	else if (t.endsWith("es") && t.length > 4) variants.add(t.slice(0, -2));
	else if (t.endsWith("s") && !t.endsWith("ss") && t.length > 4) variants.add(t.slice(0, -1));
	if (t.endsWith("ed") && !t.endsWith("eed") && t.length > 4) {
		variants.add(t.slice(0, -1));
		variants.add(t.slice(0, -2));
		if (t.endsWith("ied") && t.length > 5) variants.add(`${t.slice(0, -3)}y`);
	}
	if (t.endsWith("er") && t.length > 4) {
		const base = t.slice(0, -2);
		variants.add(base);
		variants.add(`${base}e`);
		if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
			variants.add(base.slice(0, -1));
		}
	}
	return [...variants].filter(v => v.length >= 3 && v !== t && !STOP_WORDS.has(v));
}

export function extractSearchTerms(query: string, options?: { stems?: boolean }): string[] {
	const includeStems = options?.stems !== false;
	const tokens = new Set<string>();
	const compoundPattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:[A-Z][a-z]+)+|[A-Z][a-z]+(?:[A-Z][a-z]*)+)\b/g;
	for (const match of query.matchAll(compoundPattern)) {
		const token = match[1];
		if (token && token.length >= 3) tokens.add(token.toLowerCase());
	}
	const snakePattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+)\b/g;
	for (const match of query.matchAll(snakePattern)) {
		const token = match[1];
		if (token && token.length >= 3) tokens.add(token.toLowerCase());
	}
	const words = query
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replace(/[_.]+/g, " ")
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean);
	for (const word of words) {
		const lower = word.toLowerCase();
		if (lower.length < 3 || STOP_WORDS.has(lower)) continue;
		tokens.add(lower);
	}
	if (includeStems) {
		for (const token of [...tokens]) {
			for (const variant of getStemVariants(token)) tokens.add(variant);
		}
	}
	return [...tokens];
}

export function isTestFile(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	const fileName = path.basename(filePath);
	const lowerName = fileName.toLowerCase();
	if (
		lowerName.startsWith("test_") ||
		lowerName.startsWith("test.") ||
		/[._-](test|tests|spec|specs)\.[a-z0-9]+$/.test(lowerName) ||
		/(?:Test|Tests|TestCase|Tester|Spec|Specs)\.[A-Za-z0-9]+$/.test(fileName)
	) {
		return true;
	}
	if (
		lower.includes("/tests/") ||
		lower.includes("/test/") ||
		lower.includes("/__tests__/") ||
		lower.includes("/spec/") ||
		lower.includes("/specs/") ||
		lower.startsWith("test/") ||
		lower.startsWith("tests/") ||
		lower.startsWith("spec/") ||
		lower.startsWith("specs/") ||
		/(?:^|\/)[A-Za-z0-9]*(?:Test|Tests|Spec)\//.test(filePath)
	) {
		return true;
	}
	return [
		"integration",
		"sample",
		"samples",
		"example",
		"examples",
		"fixture",
		"fixtures",
		"benchmark",
		"benchmarks",
		"demo",
		"demos",
	].some(dir => lower.includes(`/${dir}/`) || lower.startsWith(`${dir}/`));
}

export function scorePathRelevance(filePath: string, query: string): number {
	const pathLower = filePath.toLowerCase();
	const fileName = path.basename(filePath).toLowerCase();
	const dirName = path.dirname(filePath).toLowerCase();
	let score = 0;
	const words = query.split(/\s+/).filter(w => w.length > 0);
	for (const word of words) {
		const subtokens = extractSearchTerms(word, { stems: false });
		if (subtokens.length === 0) continue;
		if (subtokens.some(t => fileName.includes(t))) score += 10;
		if (subtokens.some(t => dirName.includes(t))) score += 5;
		else if (subtokens.some(t => pathLower.includes(t))) score += 3;
	}
	const queryLower = query.toLowerCase();
	if (!queryLower.includes("test") && !queryLower.includes("spec") && isTestFile(filePath)) score -= 15;
	return score;
}

export function nameMatchBonus(nodeName: string, query: string): number {
	const nameLower = nodeName.toLowerCase();
	const rawTerms = query
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.split(/[\s_.-]+/)
		.map(t => t.toLowerCase())
		.filter(t => t.length >= 2);
	const queryTokens = query
		.split(/\s+/)
		.map(t => t.toLowerCase())
		.filter(t => t.length >= 2);
	const queryLower = query.replace(/[\s]+/g, "").toLowerCase();
	if (nameLower === queryLower) return 80;
	if (queryTokens.length > 1 && queryTokens.includes(nameLower)) return 60;
	if (nameLower.startsWith(queryLower)) return Math.round(10 + 30 * (queryLower.length / nameLower.length));
	if (rawTerms.length > 1 && rawTerms.every(t => nameLower.includes(t))) return 15;
	if (nameLower.includes(queryLower)) return 10;
	return 0;
}

export function kindBonus(kind: NodeKind): number {
	const bonuses: Partial<Record<NodeKind, number>> = {
		function: 10,
		method: 10,
		class: 8,
		interface: 9,
		type_alias: 6,
		struct: 6,
		trait: 9,
		enum: 5,
		component: 8,
		route: 9,
		module: 4,
		property: 3,
		field: 3,
		variable: 2,
		constant: 3,
		import: 1,
		export: 1,
		namespace: 4,
		protocol: 9,
		enum_member: 3,
	};
	return bonuses[kind] ?? 0;
}

export function isDistinctiveIdentifier(token: string): boolean {
	if (!token) return false;
	if (/[_0-9]/.test(token)) return true;
	return /[A-Z]/.test(token.slice(1));
}
