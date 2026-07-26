/**
 * Extraction — adapted from upstream `src/extraction/index.ts` (MIT,
 * Copyright (c) 2026 Colby Mchenry — see ../UPSTREAM_LICENSE).
 *
 * Per the OMP shared contract:
 *   - Extraction runs over source paths RELATIVE to `sourceRoot`.
 *   - The optional native kernel (see `./native.ts` + the kernel
 *     decoder in `./extraction/kernel/`) is invoked when available;
 *     otherwise `./extraction/tree-sitter.ts` parses with the vendored
 *     tree-sitter WASM blobs under `assets/codegraph/wasm/`. Any
 *     failure (missing addon, ABI mismatch, parse error) degrades to
 *     the file-level fallback so `status()` always reports.
 *
 * `runtime.ts`, `runtime-types.ts`, and the DB contract remain
 * unchanged.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logWarn } from "./errors";
import { loadGrammarsForLanguages } from "./extraction/grammars";
import type { DecodedExtraction } from "./extraction/kernel";
import { tryKernelExtract } from "./extraction/kernel";
import type { CodeGraphExtractionResult } from "./extraction/tree-sitter";
import { extractFromSource } from "./extraction/tree-sitter";
import { initWasmRuntime, wasmRuntimeLastError } from "./extraction/wasm-runtime";
import { type NativeBindings, tryLoadNative } from "./native";
import type {
	CodeGraphEdge,
	CodeGraphExtractionError,
	CodeGraphFileRecord,
	CodeGraphNode,
	CodeGraphUnresolvedReference,
	Language,
} from "./types";
import { detectLanguageFromPath, readSourceFile } from "./utils";

export const EXTRACTION_VERSION = "omp.codegraph.v1";

interface ExtractionState {
	native: NativeBindings | null;
	nativeProbed: boolean;
	grammarLanguages: Set<Language>;
}

const state: ExtractionState = {
	native: null,
	nativeProbed: false,
	grammarLanguages: new Set(),
};

/** Boot the tree-sitter WASM runtime at module load so the first extraction doesn't pay the init cost on the request path. */
const wasmRuntimeReady: Promise<void> = initWasmRuntime();

/** Once per process, attempt to load the optional native addon. */
export async function ensureNative(): Promise<NativeBindings | null> {
	if (state.nativeProbed) return state.native;
	state.nativeProbed = true;
	state.native = await tryLoadNative();
	return state.native;
}

export function hasNative(): boolean {
	return state.native !== null;
}

/** SHA-256 content hash — `key` for change detection in the orchestrator. */
export async function hashContent(content: string): Promise<string> {
	const enc = new TextEncoder().encode(content);
	const digest = await crypto.subtle.digest("SHA-256", enc);
	const bytes = new Uint8Array(digest);
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

/** What `extractFile()` returns — consumed by `SyncOrchestrator.persistResult`. */
export interface ExtractResult {
	file: CodeGraphFileRecord;
	nodes: CodeGraphNode[];
	edges: CodeGraphEdge[];
	refs: CodeGraphUnresolvedReference[];
	errors: CodeGraphExtractionError[];
}

async function ensureGrammarLoaded(language: Language): Promise<void> {
	if (state.grammarLanguages.has(language)) return;
	await loadGrammarsForLanguages([language]);
	state.grammarLanguages.add(language);
}

/**
 * Extract a single file from `sourceRoot`. Source paths are read from
 * disk every call so the runtime never serves stale bytes from the DB.
 */
export async function extractFile(sourceRoot: string, relPath: string): Promise<ExtractResult> {
	await wasmRuntimeReady;
	const absPath = path.resolve(sourceRoot, relPath);
	const detectedLanguage = detectLanguageFromPath(relPath) as Language;
	const stat = await fs.stat(absPath).catch(err => {
		throw new Error(`extractFile: stat failed for ${absPath}: ${(err as Error).message}`);
	});
	const content = await readSourceFile(absPath);
	const contentHash = await hashContent(content);

	const errors: CodeGraphExtractionError[] = [];
	if (wasmRuntimeLastError()) {
		errors.push({
			message: `tree-sitter runtime unavailable: ${wasmRuntimeLastError()!.message}`,
			filePath: relPath,
			severity: "warning",
			code: "wasm_runtime_missing",
		});
	}

	const file: CodeGraphFileRecord = {
		path: relPath,
		contentHash,
		language: detectedLanguage,
		size: stat.size,
		modifiedAt: stat.mtimeMs,
		indexedAt: Date.now(),
		nodeCount: 0,
		errors,
	};

	const nodes: CodeGraphNode[] = [];
	const edges: CodeGraphEdge[] = [];
	const refs: CodeGraphUnresolvedReference[] = [];

	try {
		const native = await ensureNative();
		if (native) {
			// Record native grammar availability before the kernel route performs
			// its ABI and grammar parity checks.
			native.grammarInfo(detectedLanguage);
		}
	} catch (err) {
		errors.push({
			message: `native probe failed: ${(err as Error).message}`,
			filePath: relPath,
			severity: "warning",
		});
	}

	let kernelResult: DecodedExtraction | null = null;
	try {
		kernelResult = await tryKernelExtract(relPath, content, detectedLanguage);
	} catch (err) {
		errors.push({
			message: `kernel extraction failed: ${(err as Error).message}`,
			filePath: relPath,
			severity: "warning",
		});
	}

	if (kernelResult) {
		for (const node of kernelResult.nodes) nodes.push(node);
		for (const edge of kernelResult.edges) edges.push(edge);
		for (const ref of kernelResult.refs) refs.push(ref);
		for (const error of kernelResult.errors) errors.push(error);
	} else {
		try {
			await ensureGrammarLoaded(detectedLanguage);
		} catch (err) {
			errors.push({
				message: `grammar load failed for ${detectedLanguage}: ${(err as Error).message}`,
				filePath: relPath,
				severity: "warning",
			});
		}

		let extractionResult: CodeGraphExtractionResult | null = null;
		try {
			extractionResult = extractFromSource(relPath, content, detectedLanguage);
		} catch (err) {
			errors.push({
				message: `tree-sitter extraction failed: ${(err as Error).message}`,
				filePath: relPath,
				severity: "error",
				code: "extraction_error",
			});
		}

		if (extractionResult) {
			for (const node of extractionResult.nodes) nodes.push(node);
			for (const edge of extractionResult.edges) edges.push(edge);
			for (const ref of extractionResult.refs) refs.push(ref);
			for (const error of extractionResult.errors) {
				if (error.filePath === undefined) error.filePath = relPath;
				errors.push(error);
			}
		}
	}

	if (nodes.length === 0) {
		nodes.push(buildFallbackFileNode(relPath, detectedLanguage, stat.size));
	}

	file.nodeCount = nodes.length;
	file.errors = errors;
	file.indexedAt = Date.now();

	if (errors.some(e => e.severity === "error")) {
		logWarn(`extractFile: ${relPath} produced ${errors.length} error(s) and ${nodes.length} node(s)`);
	}

	return { file, nodes, edges, refs, errors };
}

function buildFallbackFileNode(relPath: string, language: Language, size: number): CodeGraphNode {
	return {
		id: `file:${relPath}`,
		kind: "file",
		name: path.basename(relPath),
		qualifiedName: relPath,
		filePath: relPath,
		language,
		startLine: 1,
		endLine: 1,
		startColumn: 0,
		endColumn: 0,
		updatedAt: Date.now(),
		decorators: [`size:${size}`],
	};
}
