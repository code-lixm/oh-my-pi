# codegraph

> Explore repository structure, behavior, call flow, ownership, and change impact through the managed CodeGraph index.

## Source
- Entry: `packages/coding-agent/src/tools/codegraph.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/codegraph.md`
- Renderer: `packages/coding-agent/src/tools/codegraph-renderer.ts`
- Runtime: `packages/coding-agent/src/codegraph/runtime.ts`
- Index governance: `packages/coding-agent/src/codegraph/index-manager.ts`

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "essential"`.
- Registration always succeeds. Missing, indexing, unavailable, or non-Git indexes return a normal fallback result instead of removing the tool.
- OMP stores managed indexes outside the project under the agent data directory; the tool does not create a project `.codegraph` directory.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | Yes | Natural-language behavior, dependency, flow, ownership, or impact question. Blank-after-trim input is rejected. |
| `mode` | `auto \| locate \| understand \| flow \| impact \| edit` | No | Exploration intent. `auto` infers an intent from `query`. |
| `projectPath` | `string` | No | Selects the Git-root index when the session cwd is not the intended project. |
| `path` | `string` | No | Identifies a target or limits scoped synchronization inside the selected source root. |
| `maxFiles` | positive number | No | Caps returned entry-point files, subject to the runtime's project-size budget. |

## Outputs
The text result contains formatted source sections and compact relationship data. Structured details may include:

- resolved source root and managed index directory
- requested/resolved mode and effective `maxFiles`
- entries and current-disk source sections
- edges, flow chains, blast radius, and test candidates
- coverage, freshness, and budget metadata
- fallback reason or indexing progress

Current-disk source sections may carry hashline `[PATH#TAG]` anchors and original line numbers suitable for the `edit` tool.

## Flow
1. Resolve `projectPath`/session cwd to a managed Git-root index and validate `path` remains inside its source root.
2. Drain recorded OMP file mutations and scope incremental synchronization to affected paths.
3. Start or reuse the managed index runtime. An initializing runtime returns an indexing fallback rather than blocking.
4. Explore with the requested mode and budget.
5. If freshness reports candidate drift, run one scoped synchronization and one retry.
6. Format current-disk source plus graph relationships and record the coverage ledger for later tool routing.

## Fallbacks and Errors
- Runtime unavailable, indexing, missing/failed index, and non-Git workspace states return `CodeGraph fallback: ...` with structured details.
- A path outside the selected source root is an error result.
- Runtime/index failures never replace compiler, LSP, or test validation; callers continue with `read`, `grep`, `glob`, or `lsp` as appropriate.
