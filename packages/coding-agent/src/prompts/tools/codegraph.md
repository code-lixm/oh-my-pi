Semantic code exploration via CodeGraph. Use when the question is structural or cross-file: repository layout, call chains, data flow, module ownership, or impact scope.

<instruction>
- Prefer this over `grep`/`read` when you need relationships, not raw text.
- `query` is REQUIRED. Ask for behavior, dependencies, responsibility, or change impact.
- `path` is OPTIONAL. Use it to resolve location from a known file/dir and limit the pre-explore sync scope inside the current source root.
- `maxFiles` is OPTIONAL. Use it to cap breadth when you want a focused answer.
- Exact text, logs, prose, or file discovery → `grep`, `glob`, `read`.
- Runtime unavailable, non-Git workspace, or index failure? Read the fallback note, then continue with `grep`/`glob`/`read`.
</instruction>

<output>
- Returns semantic exploration results from CodeGraph.
- Results may reference source-root-relative files plus short code previews.
- Unavailable runtime / non-Git / index failure returns a clear downgrade note instead of a raw stack trace.
</output>

<critical>
- Structural questions first → `codegraph`; textual questions → `grep`/`read`.
- NEVER treat fallback output as semantic proof.
- AVOID repo-wide text search before this for cross-file reasoning.
</critical>
