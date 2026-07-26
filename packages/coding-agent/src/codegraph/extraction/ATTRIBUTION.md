# CodeGraph extraction — upstream attribution

This subdirectory ports parts of [colbymchenry/codegraph][cg] (MIT, © 2026
Colby Mchenry) into OMP. The MIT license text is preserved at
[`../UPSTREAM_LICENSE`][license].

The port keeps the same public surface (`extractFromSource(filePath, source, language?)`
+ `TreeSitterExtractor` instance + kernel decoder) so future upstream
re-syncing stays a `diff` away.

## Per-file mapping

| File in OMP                                                         | Upstream source (see [cg] / [cg-kernel])                                    | Notes                                                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `wasm-runtime.ts`                                                    | `src/extraction/grammars.ts::initGrammars`                                   | Init wrapper around `web-tree-sitter`'s `Parser.init`; vendors `tree-sitter.wasm`.          |
| `grammars.ts`                                                        | `src/extraction/grammars.ts`                                                 | Language→WASM map + parser cache; vendor paths replace `tree-sitter-wasms`.                 |
| `tree-sitter-types.ts`                                               | `src/extraction/tree-sitter-types.ts`                                        | `LanguageExtractor` interface (compact subset of the upstream interface).                    |
| `tree-sitter-helpers.ts`                                             | `src/extraction/tree-sitter-helpers.ts`                                      | `generateNodeId`, `getNodeText`, `getChildByField`, `getPrecedingDocstring`.               |
| `tree-sitter.ts`                                                     | `src/extraction/tree-sitter.ts`                                              | `TreeSitterExtractor` class + `extractFromSource` entry; slimmed from the upstream 6.6k-LOC. |
| `svelte-extractor.ts`                                                | `src/extraction/svelte-extractor.ts`                                         | SFC script delegation + template component refs.                                            |
| `vue-extractor.ts`                                                   | `src/extraction/vue-extractor.ts`                                            | Vue SFC script delegation + template component refs.                                         |
| `languages/typescript.ts`                                            | `src/extraction/languages/typescript.ts`                                     | TS extractor config.                                                                        |
| `languages/javascript.ts`                                            | `src/extraction/languages/javascript.ts`                                     | JS extractor config.                                                                        |
| `languages/python.ts`                                                | `src/extraction/languages/python.ts`                                         | Python extractor config.                                                                   |
| `languages/rust.ts`                                                  | `src/extraction/languages/rust.ts`                                           | Rust extractor config.                                                                     |
| `languages/index.ts`                                                 | `src/extraction/languages/index.ts`                                          | Barrel registry.                                                                            |
| `kernel/layout.ts`                                                   | `src/extraction/kernel/layout.ts`                                            | Kernel byte layout (NODE/EDGE/REF/META offsets).                                          |
| `kernel/loader.ts`                                                   | `src/extraction/kernel/loader.ts`                                            | Probe `pi-natives.codegraph`, verify ABI version.                                          |
| `kernel/decode.ts`                                                   | `src/extraction/kernel/decode.ts`                                            | Decode kernel buffers to OMP `CodeGraphNode` / `Edge` / `UnresolvedReference`.             |
| `kernel/index.ts`                                                    | `src/extraction/kernel/index.ts`                                             | Route-by-language dispatch + wasm fallback.                                                |

The vendored WASM files under `packages/coding-agent/assets/codegraph/wasm/*`
are byte-identical to upstream
[`src/extraction/wasm/`][wasm]; their MIT attribution is covered by the
[UPSTREAM_LICENSE][license].

## What's adapted vs. verbatim

* **Vendoring over npm:** upstream pulls grammars from the
  `tree-sitter-wasms` package; the OMP port vendors the grammar WASM
  blobs (per upstream's own `VENDORED_WASM_LANGS` set in
  `grammars.ts`) so the runtime works without an extra dependency.
* **Kernels are contract-verified:** the runner checks `KERNEL_ABI_VERSION`
  + `NODE_KINDS` / `EDGE_KINDS` table sizes before calling the kernel, so
  a stale `.node` degrades to the wasm path instead of corrupting the
  decode.
* **Subset of `LanguageExtractor`:** the upstream interface has roughly
  twenty hooks; only the ones consumed by the OMP walker are wired.
  Adding more languages usually requires porting new hooks; we mirror
  upstream here so a sync is straightforward.

## License

The MIT text is at [`../UPSTREAM_LICENSE`][license]. All ported
modules keep the upstream copyright header inside their source files.

[cg]: https://github.com/colbymchenry/codegraph
[cg-kernel]: https://github.com/colbymchenry/codegraph/tree/main/codegraph-kernel
[license]: ../UPSTREAM_LICENSE
[wasm]: https://github.com/colbymchenry/codegraph/tree/main/src/extraction/wasm
