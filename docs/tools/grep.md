# grep

> Indexed content search powered by FFF. The built-in search surface is `grep`, `find`, and `multi_grep`; legacy `search` and `glob` tools are not registered.

## Source

- Tools: `packages/coding-agent/src/tools/fff-tools.ts`
- Index lifecycle and external-path routing: `packages/coding-agent/src/tools/fff-manager.ts`
- Query normalization: `packages/coding-agent/src/tools/fff-query.ts`
- Renderers: `packages/coding-agent/src/tools/fff-renderer.ts`
- Model prompts: `packages/coding-agent/src/prompts/tools/fff-grep.md`, `find.md`, and `multi-grep.md`
- SDK: `@ff-labs/fff-bun` (`0.10.3`, MIT)

## Tools

### `grep`

Search one literal or regex pattern in the FFF content index.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `pattern` | `string` | Yes | Literal text or regex. Empty and wildcard-only patterns fail. |
| `path` | `string` | No | Directory, filename, glob, or external filesystem constraint. |
| `exclude` | `string \| string[]` | No | Excluded paths/globs. |
| `caseSensitive` | `boolean` | No | Omitted = smart-case; `true` = exact case; `false` = case-insensitive. |
| `literal` | `boolean` | No | Force literal interpretation. |
| `context` | `number` | No | Symmetric context lines, clamped to `0..20`. |
| `limit` | `number` | No | Matches per page; default `20`, maximum `1000`. |
| `cursor` | `string` | No | Opaque cursor returned by the prior page. |

Plain search automatically retries FFF fuzzy content search only when the exact page has no matches. Regex features use FFF's regex mode. Invalid regular expressions surface the FFF literal-fallback notice in the result.

### `find`

Fuzzy path and glob search over the FFF file index.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `pattern` | `string` | Yes | Fuzzy path terms; may be empty when `path` is a concrete glob. |
| `path` | `string` | No | Directory prefix, exact filename, glob, or external path constraint. |
| `exclude` | `string \| string[]` | No | Excluded paths/globs. |
| `limit` | `number` | No | Paths per page; default `30`. |
| `cursor` | `string` | No | Opaque cursor returned by the prior page. |

FFF ranks matches by fuzzy score, frecency, Git status, filename bonuses, and distance. Very weak matches are intentionally sampled to five results instead of presenting a large low-confidence list.

### `multi_grep`

Search several literal naming variants with OR semantics in one indexed call.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `patterns` | `string[]` | Yes | Non-empty literal patterns matched with OR semantics. |
| `constraints` | `string` | No | FFF path constraints and exclusions. |
| `context` | `number` | No | Symmetric context lines, clamped to `0..20`. |
| `limit` | `number` | No | Matches per page; default `20`, maximum `1000`. |
| `cursor` | `string` | No | Opaque cursor returned by the prior page. |

## Index lifecycle

- One process-local `FffFinderManager` is shared by live sessions with the same canonical agent directory and workspace root; independent CLI/RPC processes do not share the native index.
- The main workspace index stores frecency and query history under `~/.omp/agent/fff/<workspace-hash>/`.
- Tool construction only leases the manager. The first `grep`, `find`, or `multi_grep` call initializes and waits for the workspace index.
- If LMDB reader slots are exhausted, workspace initialization retries without the optional frecency/query-history stores; file/content search remains available with neutral durable ranking for that process.
- Up to three auxiliary indexes cover filesystem paths outside the workspace. They are reused by covering root, evicted by age/capacity, and never enable unrestricted home/root scanning.
- Session disposal releases its lease. The final owner destroys the native finder and watcher.
- Initial scan wait is bounded at 15 seconds; a timeout logs a warning and allows partial indexed results.

## Pagination

Cursors are process-local, opaque, and bounded to 200 entries per tool instance.

- `find` stores the normalized query, page size, next page index, and logical scope.
- `grep` and `multi_grep` preserve the native FFF cursor plus buffered matches, context settings, query/mode, per-file counts, and scope.
- Resumed calls ignore replacement query/path options and continue the original logical search.
- Unknown or expired cursors fail explicitly.

## Output and edit anchors

- Content results are grouped by path and include match/context line numbers.
- In hashline edit mode, readable workspace files mint snapshot tags and record exactly the displayed lines as seen.
- Structured details expose counts, displayed file locations, pagination/truncation state, and fuzzy-fallback state.
- Renderers use the shared compact search surface, localized titles/counts, bounded details, path hyperlinks, and explicit empty states.

## Distribution

`@ff-labs/fff-bun` resolves a platform-specific native library. Source execution imports the installed package directly. `bun run gen:bundle` copies the selected platform package into the npm tarball. `bun run build` embeds the native library into compiled executables, and the runtime loader materializes it before FFI loading. `omp --smoke-test` imports FFF and executes a live indexed query so source, npm-bundle, and compiled-binary packaging failures are observable.

## Deliberate compatibility boundary

The previous native `GrepTool`/`GlobTool`, their prompts, renderer exports, `search`/`glob` tool-name aliases, and old settings migration are removed. Existing SDK entry points named `createGrepTool*` and `createFindTool*` remain public API names, but their built-in implementations delegate to the FFF tools. Operation-injection overloads remain bridge-specific compatibility seams rather than additional built-in tools.
