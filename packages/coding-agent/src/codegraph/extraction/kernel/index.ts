/**
 * Kernel dispatch + route gating — ported from upstream
 * `codegraph/src/extraction/kernel/index.ts` (MIT, Copyright (c) 2026
 * Colby Mchenry — see ../ATTRIBUTION.md and ../../UPSTREAM_LICENSE).
 *
 * Native ABI is OPTIONAL. When a verified `@oh-my-pi/pi-natives`
 * codegraph host is present and `grammarInfo(language)` reports support,
 * we extract through the native kernel and decode its buffers here.
 * Otherwise the caller falls back to the TS/WASM extractor.
 */
import * as logger from "@oh-my-pi/pi-utils/logger";
import type {
	CodeGraphEdge,
	CodeGraphExtractionError,
	CodeGraphNode,
	CodeGraphUnresolvedReference,
	Language,
} from "../../types";
import type { DecodedExtraction } from "./decode";
import { decodeExtractBuffers } from "./decode";

export type { DecodedExtraction } from "./decode";

import type { KernelBuffers } from "./loader";
import { getKernel, kernelSupports } from "./loader";

/**
 * Languages the JS side is willing to route through the kernel when the
 * loaded native module reports support. This mirrors the upstream shape,
 * but final routing is STILL dynamic: `grammarInfo(language)` must succeed.
 */
export const DEFAULT_ROUTED: Partial<Record<Language, true>> = {
	typescript: true,
	tsx: true,
	javascript: true,
	jsx: true,
	python: true,
	go: true,
	rust: true,
	java: true,
	c: true,
	cpp: true,
	csharp: true,
	php: true,
	ruby: true,
	swift: true,
	kotlin: true,
	dart: true,
	pascal: true,
	scala: true,
	lua: true,
	r: true,
	luau: true,
	objc: true,
	solidity: true,
	nix: true,
	cfml: true,
	cfscript: true,
	cfquery: true,
	cobol: true,
	vbnet: true,
	erlang: true,
	terraform: true,
	arkts: true,
};

export interface KernelRawResult {
	filePath: string;
	language: Language;
	buffers: KernelBuffers;
	pre?: string;
}

export interface DecodedKernelExtraction {
	nodes: CodeGraphNode[];
	edges: CodeGraphEdge[];
	refs: CodeGraphUnresolvedReference[];
	errors: CodeGraphExtractionError[];
}

export const EMPTY: DecodedKernelExtraction = {
	nodes: [],
	edges: [],
	refs: [],
	errors: [],
};

/** True when the loaded kernel can extract `language` right now. */
export async function kernelRoutes(language: Language): Promise<boolean> {
	if (!DEFAULT_ROUTED[language]) return false;
	const mod = await getKernel();
	if (!mod) return false;
	return kernelSupports(language);
}

/**
 * Try the native kernel extraction path. Returns `null` when the addon
 * is unavailable, the language is unsupported, or the kernel throws.
 * The caller MUST treat `null` as "fall back to TS/WASM".
 */
export async function tryKernelExtract(
	filePath: string,
	source: string,
	language: Language,
): Promise<DecodedExtraction | null> {
	if (!(await kernelRoutes(language))) return null;
	const mod = await getKernel();
	if (!mod) return null;

	try {
		const buffers = mod.extractFile(filePath, source, language);
		return decodeExtractBuffers(buffers, filePath, language);
	} catch (err) {
		logger.debug("CodeGraph native extraction failed", {
			filePath,
			language,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}
