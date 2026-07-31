Semantic code exploration via CodeGraph. Use for repository structure, behavior understanding, known source targets, edits, call chains, flow, ownership, or impact.

<instruction>
- Structural, behavioral, flow, impact, modification, or known-source question? You MUST call this before `grep`/`glob`/`read`, unless the request is solely an LSP symbol operation.
- `mode` uses `CodeGraphExploreMode = auto|locate|understand|flow|impact|edit`: `auto` infers; `locate` returns definition + complete target body; `understand`/`edit` return target body + key relations; `flow` returns the path + endpoint/spine source; `impact` returns impact + tests + focal source, with peripheral fields compact.
- `query` is REQUIRED. Ask for behavior, dependencies, responsibility, or change impact; phrase it for the selected mode.
- `projectPath` selects the target index; `path` only identifies the target or limits sync scope.
- Exact text, logs, configs, docs, and precise selectors → `grep`/`read`; file discovery → `glob`; definition/type/references/hover/code actions → `lsp` when available.
</instruction>
<output>
- Returns source sections/entries plus `edges`, `flow`, `blastRadius`, `testCandidates`, `coverage`, `freshness`, and `budget`.
- A current-disk source section may include `[PATH#TAG]` and original line numbers. Treat it as read and hand it directly to `edit`.
- Partial, omitted, or stale coverage? Use system tools for missing ranges, exact selectors, validation, or stale hashlines; NEVER mechanically reread complete returned files.
- Before exploring, OMP mutations are drained. Indexed candidate drift gets scoped sync and at most one rerun; if it remains unresolved, source is still current disk, relations are `partial-stale`, and affected paths are listed.
- Runtime unavailable/error, indexing, missing/failed index, or non-Git workspace returns a normal fallback note, not a raw stack trace.
</output>
<critical>
- New branch outside current coverage → one new query; unchanged coverage or every edit → NEVER re-query mechanically.
- Ordinary fallback (runtime unavailable/error, indexing, missing/failed index, or non-Git) → immediately use `read`/`grep`/`glob`/`lsp` as applicable for this project; NEVER wait, poll, or retry CodeGraph.
- Illegal or unsafe paths are errors, not fallback; fix or report them.
- CodeGraph informs exploration; it NEVER replaces LSP, compiler, tests, or validation.
</critical>
