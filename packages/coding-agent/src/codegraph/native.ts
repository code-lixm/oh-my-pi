/**
 * Optional native extraction loader.
 *
 * Per the shared `local://codegraph-contract.md`, the native extractor
 * is OPTIONAL and ACCELERATOR-only. The runtime MUST keep working when
 * the addon is absent or its ABI mismatches — the TS/WASM fallback in
 * `extraction.ts` covers that path.
 *
 * The loader uses the upstream ABI names the contract pins:
 *   - contractInfo()
 *   - grammarInfo(language)
 *   - extractFile(filePath, content, language) → ExtractBuffers
 *   - cfnptrScanFiles(files) → CfnptrFacts[]
 *   - cfnptrStripC(text) → string
 *
 * Binding probes are guarded so a missing host surface or ABI mismatch
 * returns `null` rather than breaking graph indexing.
 */

import type {
	CfnptrFacts as NativeCfnptrFacts,
	CfnptrFileIn as NativeCfnptrFileIn,
	ContractInfo as NativeContractInfo,
	ExtractBuffers as NativeExtractBuffers,
	GrammarInfo as NativeGrammarInfo,
} from "@oh-my-pi/pi-natives";
import { loadNative } from "@oh-my-pi/pi-natives/loader";
import { KERNEL_ABI_VERSION } from "./extraction/kernel/layout";
import type {
	CodeGraphEdge,
	CodeGraphExtractionError,
	CodeGraphNode,
	CodeGraphUnresolvedReference,
	Language,
} from "./types";
import { EDGE_KINDS, NODE_KINDS } from "./types";

export type ContractInfo = NativeContractInfo;
export type GrammarInfo = NativeGrammarInfo;
export type ExtractBuffers = NativeExtractBuffers;
export type CfnptrFileIn = NativeCfnptrFileIn;
export type CfnptrFacts = NativeCfnptrFacts;

export interface NativeBindings {
	contractInfo(): ContractInfo;
	grammarInfo(language: string): GrammarInfo | null;
	extractFile(filePath: string, content: string, language: Language): ExtractBuffers;
	cfnptrScanFiles(files: CfnptrFileIn[]): CfnptrFacts[];
	cfnptrStripC(text: string): string;
}

export function nativeContractMatches(info: ContractInfo): boolean {
	return (
		info.abiVersion === KERNEL_ABI_VERSION &&
		info.nodeKinds.length === NODE_KINDS.length &&
		info.nodeKinds.every((kind, index) => kind === NODE_KINDS[index]) &&
		info.edgeKinds.length === EDGE_KINDS.length &&
		info.edgeKinds.every((kind, index) => kind === EDGE_KINDS[index])
	);
}

/** Decode the kernel-extraction buffers into the public graph types. */
export interface KernelDecoder {
	decode(
		buffers: ExtractBuffers,
		filePath: string,
		language: Language,
	): {
		nodes: CodeGraphNode[];
		edges: CodeGraphEdge[];
		refs: CodeGraphUnresolvedReference[];
		errors: CodeGraphExtractionError[];
	};
}

/**
 * Lazily probe the bundled native CodeGraph surface. Returns `null` when
 * any required binding is missing or its surface cannot be inspected.
 * Callers MUST treat `null` as "use the TS/WASM fallback".
 */
export async function tryLoadNative(): Promise<NativeBindings | null> {
	try {
		const mod = loadNative() as Partial<NativeBindings> & {
			codegraph?: Partial<NativeBindings>;
		};
		const bindings: Partial<NativeBindings> = mod.codegraph ?? mod;
		const required: Array<keyof NativeBindings> = [
			"contractInfo",
			"grammarInfo",
			"extractFile",
			"cfnptrScanFiles",
			"cfnptrStripC",
		];
		for (const key of required) {
			if (typeof bindings[key] !== "function") return null;
		}
		return bindings as NativeBindings;
	} catch {
		return null;
	}
}

/** Best-effort native availability probe used by `runtime.status()`. */
export async function describeNative(): Promise<{ available: boolean; reason?: string }> {
	try {
		const bindings = await tryLoadNative();
		if (!bindings) return { available: false, reason: "addon or bindings missing" };
		const info = bindings.contractInfo();
		if (!nativeContractMatches(info)) return { available: false, reason: "contract mismatch" };
		return { available: true };
	} catch (err) {
		return {
			available: false,
			reason: err instanceof Error ? err.message : "load failed",
		};
	}
}
