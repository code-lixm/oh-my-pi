/**
 * Tree-sitter WASM runtime — ported from upstream
 * `codegraph/src/extraction/grammars.ts::initGrammars` (MIT, Copyright (c)
 * 2026 Colby Mchenry — see ./ATTRIBUTION.md and ../UPSTREAM_LICENSE).
 *
 * Boots the shared `web-tree-sitter` runtime exactly once per process.
 * The vendored `tree-sitter-runtime.wasm` lives next to the grammar
 * `*.wasm` blobs in `packages/coding-agent/assets/codegraph/wasm/`
 * so that consumers can resolve it via `import.meta.url` without
 * chasing Node-style `require.resolve` paths at runtime.
 *
 * CONTRACT (shared `local://codegraph-contract.md`):
 *   - `initWasmRuntime()` is idempotent and safe to call before the first
 *     parser is needed (a no-op after the first successful init).
 *   - A failure here must NOT crash the host; the caller (extractFile or
 *     SyncOrchestrator.initialize) logs and falls back to the
 *     file-level path. Extraction still produces a file node.
 *   - The grammars loaded by `grammars.ts` only succeed once this module
 *     has been initialized.
 */

import { pathToFileURL } from "node:url";
import { Parser } from "web-tree-sitter";

import { type CodeGraphLogger, silentLogger } from "../errors";
import { CODEGRAPH_WASM_PATH_BY_FILENAME } from "./wasm-assets";

const RUNTIME_WASM_NAME = "tree-sitter.wasm";
const RUNTIME_WASM_FILE = "tree-sitter-runtime.wasm";

export const WASM_RUNTIME_URL: URL = pathToFileURL(CODEGRAPH_WASM_PATH_BY_FILENAME[RUNTIME_WASM_FILE]);

const state: {
	initialized: boolean;
	pending: Promise<void> | null;
	lastError: Error | null;
	logger: CodeGraphLogger;
} = {
	initialized: false,
	pending: null,
	lastError: null,
	logger: silentLogger,
};

/** Override the diagnostic logger used when initialization fails. */
export function setWasmRuntimeLogger(logger: CodeGraphLogger): void {
	state.logger = logger;
}

/** `true` once the runtime has been successfully initialized in this process. */
export function isWasmRuntimeInitialized(): boolean {
	return state.initialized;
}

/** Last initialization error if any — never thrown, diagnostics only. */
export function wasmRuntimeLastError(): Error | null {
	return state.lastError;
}

/** URL string for the vendored runtime WASM (passed to `locateFile` below). */
export function wasmRuntimeUrlString(): string {
	return WASM_RUNTIME_URL.toString();
}

/**
 * Resolve the `web-tree-sitter` `locateFile` callback. Returns the vendored
 * runtime WASM when Emscripten asks for `tree-sitter.wasm`; passes through
 * any other requests so language grammars can still be loaded by path.
 */
export function runtimeLocateFile(scriptName: string, scriptDirectory?: string): string {
	if (scriptName === RUNTIME_WASM_NAME) {
		return WASM_RUNTIME_URL.toString();
	}
	if (scriptDirectory && !scriptName.startsWith("file:") && !scriptName.startsWith("/")) {
		return `${scriptDirectory}${scriptName}`;
	}
	return scriptName;
}

/**
 * Initialize the tree-sitter WASM runtime exactly once. Subsequent calls
 * reuse the cached init; a previously failed init is retried.
 */
export async function initWasmRuntime(): Promise<void> {
	if (state.initialized) return;
	if (state.pending) {
		await state.pending;
		return;
	}

	state.pending = (async () => {
		try {
			await Parser.init({
				locateFile: runtimeLocateFile,
			});
			state.initialized = true;
			state.lastError = null;
		} catch (err) {
			state.lastError = err instanceof Error ? err : new Error(`tree-sitter init failed: ${String(err)}`);
			state.logger.warn(
				`[codegraph] tree-sitter WASM runtime unavailable, falling back to file-level extraction: ${state.lastError.message}`,
			);
		} finally {
			state.pending = null;
		}
	})();

	await state.pending;
}
