/**
 * Grammar registry + parser cache — ported from upstream
 * `codegraph/src/extraction/grammars.ts` (MIT, Copyright (c) 2026 Colby
 * Mchenry — see ./ATTRIBUTION.md and ../UPSTREAM_LICENSE).
 *
 * The OMP port keeps the same shape (language → WASM file → cached
 * `WasmLanguage`, detect-by-extension, is-supported helper) so the rest
 * of the extraction pipeline stays drop-in. The upstream tree-sitter-wasms
 * dependency is replaced by the vendored grammars under
 * `packages/coding-agent/assets/codegraph/wasm/` — see the `VENDORED_*`
 * constants.
 */
import * as fsp from "node:fs/promises";

import { Parser, Language as WasmLanguage } from "web-tree-sitter";

import type { Language } from "../types";
import { CODEGRAPH_WASM_PATH_BY_FILENAME } from "./wasm-assets";
import { initWasmRuntime } from "./wasm-runtime";

/** WASM-backed languages. Svelte/Vue/Astro use a script-delegate extractor; their grammar is JS/TS. */
export type GrammarLanguage = Exclude<
	Language,
	"svelte" | "vue" | "astro" | "liquid" | "razor" | "yaml" | "twig" | "xml" | "properties" | "unknown"
>;

/** `extension → Language` mapping for built-in support. */
const EXTENSION_MAP: Record<string, Language> = {
	".ts": "typescript",
	".tsx": "tsx",
	".mts": "typescript",
	".cts": "typescript",
	".ets": "arkts",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "jsx",
	".py": "python",
	".pyw": "python",
	".go": "go",
	".rs": "rust",
	".java": "java",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hxx": "cpp",
	".cs": "csharp",
	".cshtml": "razor",
	".razor": "razor",
	".php": "php",
	".module": "php",
	".install": "php",
	".theme": "php",
	".inc": "php",
	".rb": "ruby",
	".rake": "ruby",
	".swift": "swift",
	".kt": "kotlin",
	".kts": "kotlin",
	".dart": "dart",
	".liquid": "liquid",
	".svelte": "svelte",
	".vue": "vue",
	".astro": "astro",
	".r": "r",
	".pas": "pascal",
	".dpr": "pascal",
	".dpk": "pascal",
	".lpr": "pascal",
	".dfm": "pascal",
	".fmx": "pascal",
	".scala": "scala",
	".sc": "scala",
	".lua": "lua",
	".luau": "luau",
	".m": "objc",
	".mm": "objc",
	".sol": "solidity",
	".cfc": "cfml",
	".cfm": "cfml",
	".cfs": "cfscript",
	".nix": "nix",
	".xml": "xml",
	".yml": "yaml",
	".yaml": "yaml",
	".twig": "twig",
	".properties": "properties",
	".tf": "terraform",
	".tfvars": "terraform",
	".cbl": "cobol",
	".cob": "cobol",
	".cobol": "cobol",
	".cpy": "cobol",
	".vb": "vbnet",
	".erl": "erlang",
	".hrl": "erlang",
	".escript": "erlang",
	".metal": "cpp",
	".cu": "cpp",
	".cuh": "cpp",
};

const WASM_GRAMMAR_FILE: Record<GrammarLanguage, string> = {
	typescript: "tree-sitter-typescript.wasm",
	tsx: "tree-sitter-tsx.wasm",
	javascript: "tree-sitter-javascript.wasm",
	jsx: "tree-sitter-javascript.wasm",
	python: "tree-sitter-python.wasm",
	go: "tree-sitter-go.wasm",
	rust: "tree-sitter-rust.wasm",
	java: "tree-sitter-java.wasm",
	c: "tree-sitter-c.wasm",
	cpp: "tree-sitter-cpp.wasm",
	csharp: "tree-sitter-c_sharp.wasm",
	php: "tree-sitter-php.wasm",
	ruby: "tree-sitter-ruby.wasm",
	swift: "tree-sitter-swift.wasm",
	kotlin: "tree-sitter-kotlin.wasm",
	dart: "tree-sitter-dart.wasm",
	pascal: "tree-sitter-pascal.wasm",
	scala: "tree-sitter-scala.wasm",
	lua: "tree-sitter-lua.wasm",
	r: "tree-sitter-r.wasm",
	luau: "tree-sitter-luau.wasm",
	objc: "tree-sitter-objc.wasm", // not vendored — falls back to identifier-only extraction
	cfml: "tree-sitter-cfml.wasm",
	cfscript: "tree-sitter-cfscript.wasm",
	cfquery: "tree-sitter-cfquery.wasm",
	cobol: "tree-sitter-cobol.wasm",
	vbnet: "tree-sitter-vbnet.wasm",
	erlang: "tree-sitter-erlang.wasm",
	solidity: "tree-sitter-solidity.wasm", // not vendored — falls back to identifier-only extraction
	terraform: "tree-sitter-terraform.wasm",
	arkts: "tree-sitter-arkts.wasm",
	nix: "tree-sitter-nix.wasm",
};

/** Languages we ship a WASM blob for. Subset of `WASM_GRAMMAR_FILE` keys. */
const VENDORED_WASM_LANGS: Partial<Record<GrammarLanguage, true>> = {
	pascal: true,
	scala: true,
	lua: true,
	luau: true,
	csharp: true,
	r: true,
	cfml: true,
	cfscript: true,
	cfquery: true,
	cobol: true,
	vbnet: true,
	erlang: true,
	terraform: true,
	arkts: true,
	nix: true,
	typescript: true,
	tsx: true,
	javascript: true,
	jsx: true,
	java: true,
	python: true,
	go: true,
	c: true,
	cpp: true,
	rust: true,
	ruby: true,
	php: true,
	swift: true,
	kotlin: true,
	dart: true,
};

/** Cached `WasmLanguage` instances, keyed by `Language`. */
const languageCache = new Map<Language, WasmLanguage>();
/** Cached `Parser` instances — built once a language is loaded. */
const parserCache = new Map<Language, Parser>();
/** Failures collected by language so callers can report them in status. */
const unavailableErrors = new Map<Language, string>();

let parserInitialized = false;

/** Resolve the absolute filesystem path of a vendored grammar WASM. */
function resolveWasmPath(lang: GrammarLanguage): string {
	const filename = WASM_GRAMMAR_FILE[lang];
	const filePath = CODEGRAPH_WASM_PATH_BY_FILENAME[filename as keyof typeof CODEGRAPH_WASM_PATH_BY_FILENAME];
	if (!filePath) throw new Error(`CodeGraph grammar asset is not packaged: ${filename}`);
	return filePath;
}

/** Pre-read grammar WASM bytes for an index set (or single language). */
export async function readGrammarWasmBytes(languages: readonly Language[]): Promise<Record<string, Uint8Array>> {
	const out: Record<string, Uint8Array> = {};
	const seen = new Set<Language>();
	for (const lang of languages) {
		if (seen.has(lang)) continue;
		seen.add(lang);
		if (!(lang in WASM_GRAMMAR_FILE)) continue;
		const grammarLang = lang as GrammarLanguage;
		try {
			out[lang] = await fsp.readFile(resolveWasmPath(grammarLang));
		} catch {
			// Fall through; the loader's own read will surface the real failure.
		}
	}
	return out;
}

/** Initialize the shared tree-sitter WASM runtime exactly once. */
export async function initGrammars(): Promise<void> {
	if (parserInitialized) return;
	await initWasmRuntime();
	parserInitialized = true;
}

/** True if the runtime has been initialized (used as a fast-path gate). */
export function isGrammarsInitialized(): boolean {
	return parserInitialized;
}

/**
 * Load grammar WASM files for specific languages. Idempotent: a language
 * already in `languageCache` is skipped. Failures are recorded in
 * `unavailableErrors` and the language is skipped — callers MUST check
 * `isGrammarLoaded(language)` rather than assume success.
 */
export async function loadGrammarsForLanguages(
	languages: readonly Language[],
	wasmBytes?: Record<string, Uint8Array>,
): Promise<void> {
	await initGrammars();

	const seen = new Set<Language>();
	for (const lang of languages) {
		if (seen.has(lang)) continue;
		seen.add(lang);
		if (!(lang in WASM_GRAMMAR_FILE)) continue;
		if (languageCache.has(lang)) continue;
		if (unavailableErrors.has(lang)) continue;

		const grammarLang = lang as GrammarLanguage;
		try {
			const bytes = wasmBytes?.[lang];
			const filePath = resolveWasmPath(grammarLang);
			const language = bytes ? await WasmLanguage.load(bytes) : await WasmLanguage.load(filePath);
			languageCache.set(lang, language);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			unavailableErrors.set(lang, message);
		}
	}
}

/** Load every grammars we vend a WASM for. Convenience for `runtime.open*`. */
export async function loadAllGrammars(): Promise<void> {
	const all: GrammarLanguage[] = [];
	for (const lang of Object.keys(WASM_GRAMMAR_FILE) as GrammarLanguage[]) {
		if (VENDORED_WASM_LANGS[lang]) all.push(lang);
	}
	await loadGrammarsForLanguages(all);
}

/** `true` if the parser + grammar for `language` is ready. */
export function isGrammarLoaded(language: Language): boolean {
	if (
		language === "svelte" ||
		language === "vue" ||
		language === "astro" ||
		language === "liquid" ||
		language === "razor" ||
		language === "yaml" ||
		language === "twig" ||
		language === "xml" ||
		language === "properties"
	) {
		return true;
	}
	return languageCache.has(language);
}

/** True for languages that need parser extraction. */
export function isLanguageSupported(language: Language): boolean {
	if (
		language === "svelte" ||
		language === "vue" ||
		language === "astro" ||
		language === "liquid" ||
		language === "razor" ||
		language === "yaml" ||
		language === "twig" ||
		language === "xml" ||
		language === "properties"
	) {
		return true;
	}
	return language in WASM_GRAMMAR_FILE;
}

/** Languages that file-level tracking only — no symbol extraction. */
export function isFileLevelOnlyLanguage(language: Language): boolean {
	return language === "yaml" || language === "twig" || language === "properties";
}

/** Failures collected during grammar loading. */
export function getUnavailableGrammarErrors(): Partial<Record<Language, string>> {
	const out: Partial<Record<Language, string>> = {};
	for (const [lang, message] of unavailableErrors) {
		out[lang] = message;
	}
	return out;
}

/** Reclaim tree-sitter WASM heap memory for `language`. */
export function resetParser(language: Language): void {
	const old = parserCache.get(language);
	if (!old) return;
	try {
		old.delete();
	} catch {
		// parser may already be torn down — fine to swallow.
	}
	parserCache.delete(language);
}

/** Drop every cached parser (WasmLanguage instances are kept). */
export function clearParserCache(): void {
	for (const parser of parserCache.values()) {
		try {
			parser.delete();
		} catch {
			// ignore — same reason as `resetParser`.
		}
	}
	parserCache.clear();
	unavailableErrors.clear();
}

/**
 * Get (or construct) a parser for `language`. Returns `null` when the
 * grammar hasn't been loaded — callers fall back to identifier-only
 * extraction in that case.
 */
export function getParser(language: Language): Parser | null {
	const cached = parserCache.get(language);
	if (cached) return cached;
	const wasmLang = languageCache.get(language);
	if (!wasmLang) return null;
	const parser = new Parser();
	parser.setLanguage(wasmLang);
	parserCache.set(language, parser);
	return parser;
}

/**
 * Detect language from file extension. `.h` is heuristically C/C++/ObjC
 * (we let the caller run the heuristics; this returns the raw guess).
 */
export function detectLanguage(filePath: string, source?: string, overrides?: Record<string, Language>): Language {
	const lastDot = filePath.lastIndexOf(".");
	const ext = lastDot >= 0 ? filePath.slice(lastDot).toLowerCase() : "";
	const lang = overrides?.[ext] || EXTENSION_MAP[ext] || "unknown";

	if (lang === "c" && ext === ".h" && source) {
		const head = source.substring(0, 8192);
		if (looksLikeCpp(head)) return "cpp";
		if (looksLikeObjc(head)) return "objc";
	}
	return lang;
}

function looksLikeCpp(source: string): boolean {
	return (
		/\bnamespace\b/.test(source) ||
		/\bclass\s+\w+\s*[:{]/.test(source) ||
		/\btemplate\s*</.test(source) ||
		/\b(?:public|private|protected)\s*:/.test(source) ||
		/\bvirtual\b/.test(source) ||
		/\busing\s+(?:namespace\b|\w+\s*=)/.test(source)
	);
}

function looksLikeObjc(source: string): boolean {
	return /@(?:interface|implementation|protocol|synthesize)\b/.test(source);
}

/** `true` if `filePath` has an indexable extension. */
export function isSourceFile(filePath: string, overrides?: Record<string, Language>): boolean {
	const dot = filePath.lastIndexOf(".");
	if (dot < 0) return false;
	const ext = filePath.slice(dot).toLowerCase();
	return ext in EXTENSION_MAP || !!(overrides && ext in overrides);
}

/** All languages that have a WASM grammar. */
export function getSupportedLanguages(): Language[] {
	const result: Language[] = [];
	for (const lang of Object.keys(WASM_GRAMMAR_FILE) as GrammarLanguage[]) result.push(lang);
	result.push("svelte", "vue", "astro", "liquid");
	return result;
}

/** Human-readable name for `language`. */
export function getLanguageDisplayName(language: Language): string {
	const names: Record<Language, string> = {
		typescript: "TypeScript",
		javascript: "JavaScript",
		tsx: "TypeScript (TSX)",
		jsx: "JavaScript (JSX)",
		python: "Python",
		go: "Go",
		rust: "Rust",
		java: "Java",
		c: "C",
		cpp: "C++",
		csharp: "C#",
		razor: "Razor/Blazor",
		php: "PHP",
		ruby: "Ruby",
		swift: "Swift",
		kotlin: "Kotlin",
		dart: "Dart",
		svelte: "Svelte",
		vue: "Vue",
		astro: "Astro",
		liquid: "Liquid",
		pascal: "Pascal / Delphi",
		scala: "Scala",
		lua: "Lua",
		luau: "Luau",
		r: "R",
		objc: "Objective-C",
		solidity: "Solidity",
		nix: "Nix",
		yaml: "YAML",
		twig: "Twig",
		xml: "XML",
		properties: "Java properties",
		cfml: "CFML",
		cfscript: "CFScript",
		cfquery: "CFQuery (SQL)",
		cobol: "COBOL",
		vbnet: "Visual Basic .NET",
		erlang: "Erlang",
		terraform: "Terraform",
		arkts: "ArkTS",
		unknown: "Unknown",
	};
	return names[language] ?? language;
}
