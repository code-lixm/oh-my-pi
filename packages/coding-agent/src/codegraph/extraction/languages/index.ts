/**
 * Languages registry — ported from upstream
 * `codegraph/src/extraction/languages/index.ts` (MIT, Copyright (c)
 * 2026 Colby Mchenry — see ../ATTRIBUTION.md and ../../UPSTREAM_LICENSE).
 *
 * The OMP port wires up the four languages needed by the smoke harness
 * (TS/JS/Python/Rust). Other upstream languages land incrementally
 * alongside their WASM blob.
 */
import type { Language } from "../../types";
import type { LanguageExtractor } from "../tree-sitter-types";

import { javascriptExtractor } from "./javascript";
import { pythonExtractor } from "./python";
import { rustExtractor } from "./rust";
import { typescriptExtractor } from "./typescript";

export const EXTRACTORS: Partial<Record<Language, LanguageExtractor>> = {
	typescript: typescriptExtractor,
	tsx: typescriptExtractor,
	javascript: javascriptExtractor,
	jsx: javascriptExtractor,
	python: pythonExtractor,
	rust: rustExtractor,
};

export { javascriptExtractor, pythonExtractor, rustExtractor, typescriptExtractor };
