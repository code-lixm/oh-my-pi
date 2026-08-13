# Development Rules

## Default Context

This repo contains multiple packages, but **`packages/coding-agent/`** is the primary focus. Unless otherwise specified, assume work refers to this package.

**Terminology**: When the user says "agent" or asks "why is agent doing X", they mean the **coding-agent package implementation**, not you (the assistant). The coding-agent is a CLI tool — questions about its behavior refer to code in `packages/coding-agent/`, not your current session.

### Package Structure

| Package                 | Description                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `packages/ai`           | Multi-provider LLM client with streaming support                                        |
| `packages/catalog`      | Model catalog: bundled models.json, provider descriptors, model identity/classification |
| `packages/agent`        | Agent runtime with tool calling and state management                                    |
| `packages/coding-agent` | Main CLI application (primary focus)                                                    |
| `packages/tui`          | Terminal UI library with differential rendering                                         |
| `packages/natives`      | Bindings for native text/image/grep operations                                          |
| `packages/stats`        | Local observability dashboard (`omp stats`)                                             |
| `packages/omptype`      | ArkType-compatible schema validation with a lazy JIT runtime                            |
| `packages/utils`        | Shared utilities (logger, streams, temp files)                                          |
| `crates/pi-natives`     | Rust crate for performance-critical text/grep ops                                       |

**Catalog import convention**: code in this repo imports catalog _values_ (bundled models, model-thinking helpers, identity, descriptors, model manager/cache) from `@oh-my-pi/pi-catalog/<module>` — never via `@oh-my-pi/pi-ai`. The pi-ai barrel re-exports only the model/effort _types_ its own signatures use (`Model`, `Api`, `ThinkingConfig`, `Effort`, …); type-only imports of those from `@oh-my-pi/pi-ai` are fine.

## Develop Functional Inventory

This inventory is the merge gate for the current `develop` feature set. Before and after every merge, you MUST compare each item against pre-merge behavior and focused tests while taking upstream fixes. Package changelogs remain the detailed change log.

### Per-Change Merge Matrix

Every row is an independent merge contract. A merge touching its implementation MUST run the listed focused verification; a neighboring row's test is not substitute coverage. New durable behavior MUST add one row and one focused verification target.

| Functional change | Merge-preserved contract | Focused verification |
| --- | --- | --- |
| Simplified Chinese UI | Settings, setup, selectors, commands, prompts, placeholders, and runtime chrome follow `displayLanguage`; tool identifiers remain English. | `test/modes/components/model-selector-locale.test.ts`, `test/setup-wizard.test.ts`, `test/slash-commands-available-commands-zh.test.ts` |
| Localized prompt overlays | English/Chinese system and tool prompts retain equivalent Codex/Claude overlays and dynamic `xd://` guidance. | `test/system-prompt.test.ts`, `test/system-prompt-model.test.ts`, `test/prompt-templates.test.ts` |
| SiYuan integration | `siyuan` stays opt-in, workspace-explicit, dry-run-first, and rejects direct `.sy` mutation. | `test/tools/siyuan.test.ts` |
| Encrypted config sync | Bun S3 sync retains PBKDF2/AES-GCM bundles, publication DAGs, three-way conflict handling, auth migration, push, and GC. | `test/config-sync.test.ts` |
| Managed CodeGraph | OMP-managed indexes, background initialization, scoped sync, coverage/freshness, current-disk source, safe fallback, CLI governance, and no project `.codegraph` writes remain intact. | `test/tools/codegraph-tool-contract.test.ts`, `test/tools/codegraph-tool-mutation-contract.test.ts`, `test/codegraph-cli-contract.test.ts` |
| Durable workspace checkpoints | Pre-turn checkpoints, Git capsules, stale-lineage guards, crash-safe apply, undo/redo, session isolation, ignored-file baselines, and CAS GC remain intact. | `test/slash-commands/workspace-checkpoint.test.ts`, `test/agent-session-checkpoint-rewind-branch.test.ts`, `test/modes/controllers/selector-controller-checkpoint-preview.test.ts` |
| Checkpoint picker UX | `/rewind` shows prompt previews, affected paths/conflicts, localized completeness/age, and preserves selected scope/strategy. | `test/modes/components/checkpoint-selector.test.ts`, `test/modes/controllers/selector-controller-checkpoint-preview.test.ts` |
| Session path compatibility | Canonical and legacy hashed buckets merge in reads without moving active files; list, continue, and ID resume cover both. | `test/session-paths.test.ts`, `test/session-manager/file-operations.test.ts`, `test/slash-commands/resume.test.ts` |
| Live top-level sessions | `/new` leaves the prior session running; `/resume` reattaches; switching preserves session input, observers, jobs, and runtime identity. | `test/main-cross-project-resume.test.ts`, `test/main-resume-cancel-exit.test.ts`, `test/modes/controllers/resume-preflight.test.ts` |
| `Alt+N` session fork | Text and images move atomically to a new live top-level session and focus returns without extension shadowing. | `test/input-controller-keybindings.test.ts`, `test/extensions-runner.test.ts` |
| Session history | `/history` renders the active branch fullscreen with application scrolling, `Alt+J/K` turn jumps, `/` search, `n/N` match wrapping, and Ghostty Option aliases that remain searchable text while focused. | `test/modes/components/session-history-viewer.test.ts`, `test/session/session-history-format.test.ts` |
| Agent Hub compact dashboard | Only task subagents appear; wide rows are one line, narrow rows at most two; task descriptions never add rows; title/actions share one line; fixed columns, selected background, and width bounds remain stable. | `test/agent-hub-ordering.test.ts`, `test/modes/components/agent-hub-redesign.test.ts` |
| Agent Hub queued state | `activity.phase === "queued"` maps to status `Queued`/`排队中`; `pending` remains `Not started`/`未开始`; queued activity never creates a standalone detail row. | `test/agent-hub-ordering.test.ts` wide localized lifecycle case |
| Agent Hub observations | Live tracked state wins over stale cached state; persisted-only parked metadata remains available; large rosters keep bounded per-visible-row lookup and avoid full observation sorting. | `test/agent-hub-ordering.test.ts`, `test/modes/components/agent-hub-redesign.test.ts`, `test/session-observer-registry.test.ts` |
| Agent Hub navigation/actions | Stable lifecycle/newest ordering, `j/k`, Enter transcript, Esc/left-left close, focus, revive, kill, mouse routing, Main routing, and empty-state gestures remain intact. | `test/agent-hub-activate.test.ts`, `test/agent-hub-actions.test.ts`, `test/agent-hub-ordering.test.ts` |
| Fullscreen subagent transcripts | Views remain read-only, preserve model/status/context/runtime metadata, persisted snapshots and clipboard, `Alt+J/K` agent cycling, `j/k/g/G` scrolling, links/images, and Hub return. | `test/agent-hub-advisor-scroll.test.ts`, `test/modes/components/agent-hub-redesign.test.ts` |
| Fullscreen Jobs Hub | Right-right opens retained Bash/task jobs, bounded output tails, metadata, focus/cancel controls, and explicit empty state; owner isolation remains intact. | `test/jobs-hub.test.ts`, `test/modes/controllers/jobs-command.test.ts`, `test/job-model-badge-renderer.test.ts` |
| Async Bash policy | `bash.async.enabled` disables explicit async Bash without disabling task agents or automatic backgrounding. | `test/tools/bash-async-setting.test.ts`, `test/async-job-manager.test.ts` |
| Root task scheduler | One root scheduler enforces runnable lifecycle concurrency across nested tasks, Eval agents, Hub wakeups, follow-ups, and revivals; request concurrency remains separate. | `test/task/runnable-concurrency.test.ts`, `test/task/request-concurrency.test.ts`, `test/async-yield-queue.test.ts` |
| Idle subagent memory bounds | Finished keep-alive subagents are bounded by `task.maxLiveIdleAgents`; oldest idle sessions park and remain revivable, while running/waiting agents and TTL/CAS lifecycle semantics remain intact. | `test/registry/agent-lifecycle.test.ts`, `test/settings-manager.test.ts` |
| Task/Yield transaction boundary | Successful `yield` stops later same-message tools; queued work, blocking-parent slot release, cancellation, and synthetic skipped results remain correct. | `packages/agent/test/yield.test.ts`, `test/task/executor-async-quiescence.test.ts`, `test/async-yield-queue.test.ts` |
| Task orchestration schema | Task agents preserve source/capability resolution, batch spawn, preflight, blocking splits, progress, repair, advisory, and timeout behavior. | `test/task/task-spawn.test.ts`, `test/task/task-batch.test.ts`, `test/task/task-guards.test.ts`, `test/task/task-preflight.test.ts` |
| Hub/IRC coordination | Needs-reply state, explicit routes, delivery receipts, root relay, await deadlock avoidance, deduplication, silence rules, and job waits remain intact. | `test/tools/irc.test.ts`, `test/tools/irc-pending-reply.test.ts`, `test/tools/irc-roster-activity.test.ts` |
| Agent-managed todos | Phase-wide completion stays rejected; subagent results reconcile immediately; verification remains open until commands pass; mid-run nudges count real progress only. | `test/tools/todo.test.ts`, `test/modes/controllers/todo-command-controller.test.ts`, `test/agent-session-todo-mid-run-nudge.test.ts` |
| Ask countdown | Each question owns a fresh configurable Off/30s/60s countdown and only its valid recommended choice may auto-select. | `test/ask-timeout.test.ts`, `test/modes/components/ask-dialog.test.ts`, `test/tools/ask.test.ts` |
| Eval execution bridge | JavaScript/Python/Ruby/Julia formatting, display values, streaming output, timeouts, agent progress, tool bridge, and worker core remain stable without duplicate result rendering. | `test/tools/eval-*.test.ts`, `test/tools/eval-agent-progress.test.ts`, `test/eval/worker-core.test.ts` |
| Worker-host dispatch | CLI worker selectors, source/SDK fallbacks, tiny worker environment, browser-tab startup, stats sync, and compiled-binary subprocesses stay synchronized. | `test/worker-selector.test.ts`, `test/tiny-worker-env.test.ts`, `test/tools/browser-tab-worker-startup.test.ts`, `omp --smoke-test` |
| Stats project identity | Session headers provide the canonical project path (absolute paths use equivalent-path resolution; relative paths remain unchanged); legacy bucket rows migrate per `session_file` across messages, user messages, and tool calls without collision merges. | `packages/stats/test/project-identity.test.ts`, `packages/stats/test/sync-serial.test.ts` |
| Conversation token totals | The Projects and Models pages show each folder/model's full conversation-token sum (input + output + cache read + cache write), not a subset, matching the overview denominator. | `packages/stats/test/projects-route-token.test.tsx`, `packages/stats/test/models-route-token.test.tsx` |
| Thinking display modes | `full`/`prose`/`hidden` migrate legacy settings, keep Main/subagent rendering aligned, and let `omitThinking` control provider summaries independently. | `test/session/thinking-display.test.ts`, `test/input-controller-thinking-visibility.test.ts`, `test/thinking-summary-visibility.test.ts` |
| Structured activity | Main/subagent Working, HUD, Hub, focused transcript, remote/persisted state, provider streams, and queued jobs report evidence-backed activity without fake percentages or silence-as-stall. | `test/modes/components/agent-activity.test.ts`, `test/task/executor-activity.test.ts`, `test/modes/controllers/event-controller-hub-activity-cluster.test.ts` |
| Advisor lifecycle | Severity colors, concern/blocker interrupt rules, late-note fresh turns, provider options, staleness localization, suppression, and loop prevention remain stable. | `test/advisor/advisor.test.ts`, `test/advisor/advisor-visibility.test.ts`, `test/agent-session-advisor-suppression.test.ts` |
| Retry/fallback lifecycle | Each endpoint exhausts `retry.maxRetries`; temporary model fallbacks probe and safely restore primaries without persistence leaks; model switches cancel pending recovery. | `test/agent-session-retry-fallback.test.ts`, `test/agent-session-retry-recovery.test.ts`, `test/retry-fallback.test.ts` |
| Retry settings/model keys | Arbitrary non-negative retry limits validate; Tab/Shift+Tab cycle model roles; Ctrl+P cycles thinking without autocomplete conflicts. | `test/modes/components/settings-selector-retry-attempts.test.ts`, `test/agent-session-role-thinking.test.ts`, `test/input-controller-keybindings.test.ts` |
| Context-full compaction | Anchored summaries preserve constraints/evidence/active work; auto/mid-turn compaction, provider portability, no-progress rescue, plan references, and direct replay remain intact. | `test/compaction.test.ts`, `test/agent-session-auto-compaction-progress-guard.test.ts`, `test/agent-session-handoff.test.ts` |
| Codex native prompting | Opt-in sidecars preserve Full/Lite role order, prompt identity/cache partition, stable session/thread identity, and generic fallback without telemetry prompt text. | `test/codex-native-prompt-sidecar.test.ts`, `test/system-prompt-model.test.ts` |
| Structured next-step offers | Final binding, expiry/invalidation, numbered selection, and read-only session-write guards remain stable. | `test/next-step-offers.test.ts` |
| No-progress loop guard | One hidden recovery occurs at the first repeated threshold and terminal halt occurs on recurrence without false positives. | `test/agent-session-tool-call-loop-guard.test.ts`, `test/core/hashline-loop-guard.test.ts` |
| Display border styles | `none`, `background`, `accent`, and full frames preserve their distinct gutters, surfaces, breathing rows, semantic colors, and PTY behavior. | `test/output-block-border-style.test.ts`, `test/output-block-theme-refresh.test.ts` |
| Bash/Eval card layout | One rounded legend frame owns code/command and output with a blank separator; streaming and rebuilt transcripts share the same surface. | `test/modes/components/tool-execution-background-task.test.ts`, `test/repro-issue-6879-tool-double-render-retry.test.ts`, `test/tools/eval-code-preview.test.ts` |
| Tool detail budgets | `display.basicToolDetails` and `display.toolDetailMaxLines` preserve semantic headers, first/last rows, middle omission, and Ctrl+O expansion. | `test/output-block-border-style.test.ts`, `test/job-renderer-preview.test.ts` |
| Compact search results | Grep/Glob/CodeGraph keep localized counts, adjacent path trees, one middle omission row, truncation in headers, and zero-result status surfaces. | `test/tools/codegraph-renderer.test.ts`, `test/tools/glob-renderer.test.ts`, `test/tools/grep-renderer.test.ts` |
| Terminal-adaptive themes | Adaptive variants inherit ANSI palettes; `theme.terminalPalette` temporarily overrides and restores configured themes; Poimandres keeps Nerd glyph consistency. | `test/terminal-adaptive-theme.test.ts`, `test/theme-nerd-symbols.test.ts`, `packages/tui/test/terminal-appearance.test.ts` |
| Status-line extensibility | Usage adapters, balances, battery/half-height modes, active-model invalidation, custom presets, and basename-only paths remain stable. | `test/status-line-usage.test.ts`, `test/status-line-usage-refresh.test.ts`, `test/status-line-path.test.ts`, `test/status-line-settings-cache.test.ts` |
| Mouse and rich content | Opt-in mouse input routes editor, overlay, Markdown, image, and selector hits; disabled mode preserves native selection. | `packages/tui/test/mouse-routing.test.ts`, `test/modes/components/session-selector-mouse.test.ts`, `test/extension-list-mouse.test.ts` |
| Terminal keyboard/appearance | Kitty base-layout reporting, Ghostty delayed OSC 11 replies, multiplexer refresh semantics, raw-mode teardown, and alt-screen cleanup remain stable. | `packages/tui/test/keys.test.ts`, `packages/tui/test/terminal-appearance.test.ts`, `packages/tui/test/terminal-disconnect-raw-mode-throw.test.ts` |
| Loader/render backpressure | Loader ticks never catch up multiple frames; expensive renders stay attributed; ConPTY/WSL cadence and stdout backlog caps remain stable. | `packages/tui/test/loader.test.ts`, `packages/tui/test/process-terminal-render.test.ts` |
| Double-Escape safety | One Esc never terminates work; second Esc uses the two-second confirmation; idle tree/branch gestures obey `doubleEscapeAction`. | `test/input-controller-escape.test.ts`, `test/main-resume-cancel-exit.test.ts` |
| Sandbox launch | `--sandbox` remains parsed, creates/enters the sandbox or `--cwd`, and skips project discovery as documented. | `test/sandbox-mode.test.ts` |
| Process/session boundaries | Persisted run boundaries distinguish abrupt exits from normal stop/switch/handoff and surface interrupted turns as aborted diagnostics. | `test/transcript-history-exactly-once.test.ts`, `test/history-storage-session.test.ts`, `test/main-resume-cancel-exit.test.ts` |
| SQLite credentials/auth | Credential storage, migration, rotation, durable row targeting, refresh leases, busy handling, corruption latch, broker import, and session pins remain intact. | `test/auth-storage-rotation.test.ts`, `test/auth-broker-migrate.test.ts`, `test/auth-broker-import.test.ts`, `test/credential-pin.test.ts` |
| Hindsight memory backend | Auth/request failures surface, live settings rebuild the client, forced retains propagate errors, and retention/mental-model caches remain stable. | `test/hindsight-backend.test.ts`, `test/hindsight-client.test.ts`, `test/hindsight-retention-cache.test.ts` |
| Network proxy configuration | Proxy settings remain isolated, validated, and applied without changing unrelated provider behavior. | `test/config/network-proxy.test.ts`, `test/extensibility/tool-proxy.test.ts` |
| TUI sanitization/render safety | Tabs, controls, home paths, long lines, streaming args, and rebuilt transcript previews stay sanitized and width-bounded on every success/error path. | `test/tui/status-line-newline-guard.test.ts`, `test/tool-execution-custom-repaint.test.ts`, `test/tool-execution-write-repaint.test.ts` |
| Persisted session scheduling | Heartbeat and cron jobs remain session-bound, crash-safe, lease-claimed, stale-binding guarded, queue-deduplicated, and correctly rebound across new/switch/resume/dispose transitions. | `test/scheduling/parser.test.ts`, `test/scheduling/store.test.ts`, `test/scheduling/scheduler.test.ts`, `test/scheduling/runtime.test.ts`, `test/scheduling/stale-delivery.test.ts`, `test/agent-session-scheduling-lifecycle.test.ts` |
| Autonomous quality gates | Explicit CLI limits override resumed durable fields, continuation budgets remain monotonic, unchanged gate failures retry only within policy, and timeout/abort tears down the whole gate process tree. | `test/autonomous/controller.test.ts`, `test/autonomous/gate-runner.test.ts`, `test/autonomous/session-integration.test.ts` |
| Continual refinement harness | Prompt/memory/skills/subagent refinements remain opt-in, session-artifact scoped, idle-boundary scheduled, compaction-aware, rollback-safe, localized, and synchronously rejected while disabled. | `test/refinement/controller.test.ts`, `test/refinement/state-and-rollback.test.ts`, `test/tools/refine-tool.test.ts` |
| RLM async lifecycle | RLM admission, child-scoped providers, recursive depth, caller-owned artifacts, terminal status mapping, durable notification retry, parent messaging, and Jobs Hub delivery remain consistent. | `test/eval/rlm-host-bridge.test.ts`, `test/registry/rlm-bridge-lifecycle.test.ts`, `test/registry/rlm-caller-owned-artifacts.test.ts`, `test/task/rlm-session-integration.test.ts` |
| Python-backed skills | Python skills remain trust-gated, dependency-isolated in the selected skill interpreter, preload-failure isolated, prompt-discoverable, and harmless to ordinary Python eval. | `test/eval/py/backend-python-skills.test.ts`, `test/eval/py/skill-preload.test.ts`, `test/eval/py/python-skill-trust.test.ts`, `test/eval/py/python-skill-integration.test.ts` |
| Daemon-backed sessions | Agent-dir-isolated authenticated sockets, worker startup/shutdown, attach leases, request timeouts, crash recovery, stale-socket cleanup, prompt replay, and source/compiled worker dispatch remain leak-free. | `test/daemon/protocol.test.ts`, `test/daemon/supervisor-lifecycle.test.ts`, `test/daemon/commands.test.ts`, `omp --smoke-test` |

### Merge Review Rules

- **Before merge:** You MUST inspect upstream diffs by feature, not file.
- **Change ledger:** You MUST enumerate every affected package's `[Unreleased]` bullet and map it to a matrix row plus its focused verification before resolving conflicts.
- **Missing row:** You MUST add the concrete contract and verification target before merging that change.
- **After merge:** You MUST run focused tests for every touched feature and compare representative wide/narrow localized renders.
- **NEVER:** choose one whole file, delete a listed feature, or accept a visual regression without a contract update.
- **Evidence:** You MUST preserve relevant tests, changelog entries, and merge notes for changed behavior or presentation.

## GitHub

Unless user tells you exactly what to write:

- **Never comment on GitHub** (issues, PRs, discussions).
- **Never create issues on GitHub**.

## Code Quality

- No `any` unless absolutely necessary.
- **NEVER use `ReturnType<>`** — use the actual type name.
- **NEVER use inline imports** — no `await import()`, no `import("pkg").Type` in type positions, no dynamic type imports. Always top-level.
- Check `node_modules` for external API types instead of guessing.
- **Barrel exports**: prefer `export * from "./module"` over named re-exports, including `export type { ... } from`. In pure `index.ts` barrels, use star re-exports even for single-specifier cases. If stars create ambiguity, remove the redundant export path; do not keep duplicates.
- **Class privacy**: use ES `#private` fields; leave externally accessible members bare. **No `private`/`protected`/`public` keyword on fields or methods**, except on **constructor parameter properties** where TypeScript requires it (e.g. `constructor(private readonly session: ToolSession)`).
- **Promises**: use `Promise.withResolvers()` instead of `new Promise((resolve, reject) => ...)`.
- **Prompts**: never build prompts in code (no inline strings, template literals, or concatenation). Prompts live in static `.md` files; use Handlebars for dynamic content. Import them via `import content from "./prompt.md" with { type: "text" }` — not `readFile`.
- **Worker scripts**: workers re-enter the CLI entrypoint; never spawn separate worker entry modules. `cli.ts` declares itself as the worker host at startup (`declareWorkerHostEntry()` from `@oh-my-pi/pi-utils/env`) and dispatches hidden argv selectors (`__omp_worker_stats_sync`, `__omp_worker_tab`, `__omp_worker_js_eval`, `__omp_worker_tiny_inference`) before loading the command registry. Spawn sites use:
  ```ts
  import { workerHostEntry } from "@oh-my-pi/pi-utils";
  const hostEntry = workerHostEntry();
  const worker = hostEntry
  	? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_<name>"] })
  	: new Worker(new URL("./<worker>.ts", import.meta.url).href, { type: "module" });
  ```
  When the process was started from the omp CLI — source `cli.ts`, npm-bundle `dist/cli.js`, or compiled binary — `workerHostEntry()` is `Bun.main` and the worker re-enters the single entry module, so no per-worker `--compile` entrypoints or bundle entries exist. Outside a CLI host (`bun test`, SDK embedding, standalone `omp-stats`) it returns `null` and the direct-module fallback loads the worker source. New worker kinds MUST add their selector to the dispatch table in `cli.ts` and keep the fallback branch.
  History: `with { type: "file" }` only copied the entry as a raw asset (workers crashed silently in compiled binaries — issues #1011, #1027), and the later literal-path + extra-entrypoint pattern required keeping spawn literals and two build scripts in sync (issue #1150). The smoke probe below is the live validation of this contract.
  Validate any new worker with the dedicated smoke probe: `omp --smoke-test` spawns the stats sync worker and the tiny-model subprocess, pings them, and exits — it's wired into `ci:test:smoke` and `scripts/install-tests/run-ci.sh` so binary, source-link, and tarball installs all exercise it. Add a sibling smoke if the new worker is on a different module graph.

## Central Utilities

Before writing a helper, check whether one already exists — `packages/coding-agent/src/utils/`, `@oh-my-pi/pi-utils`, `@oh-my-pi/pi-tui`, and the domain modules next to your callsite. This applies to **everything**: VCS wrappers, formatting/truncation/path-display helpers, image handling, clipboard, streams, temp files, caching. The central versions carry hardening a fresh copy always loses (timeouts, output caps, non-interactive env, lock avoidance, caching, TUI sanitization).

- Search first: `grep` for the operation before implementing it. Two implementations of the same thing is a bug even when both work.
- Examples of the pattern: `src/utils/git.ts` and `src/utils/jj.ts` are the only sanctioned way to run git/jj (`import * as git from "../utils/git"` — never hand-spawn via `$`/`Bun.spawn`); rendering goes through the helpers in TUI Sanitization below (`replaceTabs`, `truncateToWidth`, `shortenPath`, `PREVIEW_LIMITS`) rather than ad-hoc string math.
- Missing capability? Extend the central helper (new option, new sub-function on the namespace) and call it — don't fork its logic locally.

## Bun Over Node

Use Bun APIs where they provide a cleaner alternative; fall back to `node:*` only for what Bun doesn't cover. **Never spawn shell commands for operations with proper APIs** (e.g., don't `Bun.spawnSync(["mkdir", "-p", dir])` — use `mkdirSync`).

### Quick reference

| Operation       | Use                                       | Not                                |
| --------------- | ----------------------------------------- | ---------------------------------- |
| File read/write | `Bun.file()`, `Bun.write()`               | `readFileSync`, `writeFileSync`    |
| Spawn process   | `` $`cmd` ``, `Bun.spawn()`               | `child_process`                    |
| Sleep           | `Bun.sleep(ms)`                           | `setTimeout` promise               |
| Binary lookup   | `$which("git")` from `@oh-my-pi/pi-utils` | `spawnSync(["which", "git"])`      |
| HTTP server     | `Bun.serve()`                             | `http.createServer()`              |
| SQLite          | `bun:sqlite`                              | `better-sqlite3`                   |
| Hashing         | `Bun.hash()`, `Bun.password.*`, WebCrypto | `node:crypto`                      |
| Path resolution | `import.meta.dir`, `import.meta.path`     | `fileURLToPath` dance              |
| JSON5           | `Bun.JSON5.parse()` / `.stringify()`      | `json5` package                    |
| JSONL           | `Bun.JSONL.parse()` / `.parseChunk()`     | `text.split("\n").map(JSON.parse)` |
| String width    | `Bun.stringWidth()`                       | `get-east-asian-width`, custom     |
| Text wrapping   | `Bun.wrapAnsi()`                          | custom ANSI-aware wrappers         |

### Process execution

Prefer Bun Shell (`` $`cmd` ``) for simple commands:

```typescript
import { $ } from "bun";

const result = await $`git status`.cwd(dir).quiet().nothrow();
if (result.exitCode === 0) {
	const text = result.text();
}

$`do-stuff ${tmpFile}`.quiet().nothrow(); // fire and forget
```

Methods: `.quiet()`, `.nothrow()`, `.text()`, `.cwd(path)`.

Use `Bun.spawn`/`Bun.spawnSync` only for: long-running processes (LSP, kernels), streaming stdin/stdout/stderr (SSE, JSON-RPC), or process control (signals, kill, complex lifecycle).

When using `pipe` mode, cast the stream:

```typescript
const child = Bun.spawn(["cmd"], { stdout: "pipe", stderr: "pipe" });
const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
```

### Node module imports

Always use **namespace imports** for `node:fs`, `node:path`, `node:os`:

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
```

- Async-only file → `node:fs/promises`.
- Needs both sync and async → `node:fs`, then `fs.promises.xxx` for async.

### File I/O

Prefer Bun:

```typescript
const text = await Bun.file(path).text();
const data = await Bun.file(path).json();
await Bun.write(path, data); // auto-creates parent dirs
```

Use `node:fs/promises` for directory ops (`fs.mkdir`, `fs.rm`, `fs.readdir`) — Bun has no native directory APIs. Avoid sync APIs in async flows; use sync only when forced by a synchronous interface.

**Anti-patterns:**

- `existsSync`/`readFileSync`/`writeFileSync` in async code → `Bun.file()` APIs.
- `mkdir(dirname(path), …)` before `Bun.write(path, …)` → redundant; `Bun.write` handles it.
- `if (await file.exists()) { await file.json() }` → two syscalls plus race. Use try-catch with `isEnoent`:
  ```typescript
  import { isEnoent } from "@oh-my-pi/pi-utils";
  try {
  	return await Bun.file(path).json();
  } catch (err) {
  	if (isEnoent(err)) return null;
  	throw err;
  }
  ```
- Multiple `Bun.file(path)` handles for the same path (including across `checkX`/`loadX` helpers).
- `Buffer.from(await Bun.file(x).arrayBuffer())` → `await fs.readFile(path)`.
- Existence check + try-catch around the same read → drop the existence check.

### Streams

Prefer centralized helpers:

```typescript
import { readStream, readLines } from "./utils/stream";
const text = await readStream(child.stdout);
for await (const line of readLines(stream)) {
	/* ... */
}
```

Manual reader loops only when the protocol requires it (SSE, streaming JSON-RPC).

### Misc

- **Sleep**: `await Bun.sleep(ms)`, never `new Promise(r => setTimeout(r, ms))`.
- **Password hashing**: `Bun.password.hash(pw, "bcrypt")` / `Bun.password.verify(pw, hash)`.
- **String width**: `Bun.stringWidth(text, { countAnsiEscapeCodes?: false })`.
- **Wrapping**: `Bun.wrapAnsi(text, width, { wordWrap, hard, trim })`.

## Generated Files

**NEVER edit `packages/catalog/src/models.json` directly.** It is generated from upstream sources (stencil.so, provider catalog discovery, OpenCode docs) by `packages/catalog/scripts/generate-models.ts` and the descriptors/resolvers in `packages/catalog/src/provider-models/`. Hand-edits get overwritten on the next regen.

To change an entry, fix the source:

- **Resolution rules / per-id overrides** → relevant resolver in `packages/catalog/src/provider-models/openai-compat.ts` (e.g. `createOpenCodeApiResolution`'s id-override map).
- **Provider catalog entries** (default model, discovery factory/flags) → the `CATALOG_PROVIDERS` table in `packages/catalog/src/provider-models/descriptors.ts`.
- **Generator-level fixups** (premium multipliers, codex pricing fallback, fallback models, post-processing) → `packages/catalog/scripts/generate-models.ts`.
- **Thinking metadata / generated policies** → `packages/catalog/src/model-thinking.ts` (`applyGeneratedModelPolicies`); model-id classification (family/version parsing) lives in `packages/catalog/src/identity/classify.ts`.

Regenerate with `bun run gen:models` and commit `models.json` alongside the source change. Add a regression test against the **resolver/descriptor**, not the bundled JSON, so it survives upstream metadata shifts.

## Logging and CLI Output

Code that may run while the TUI, RPC, SDK, workers, or background runtimes are active MUST NOT use `console.log`/`error`/`warn`; it corrupts rendering or protocols. Use the centralized logger:

```typescript
import { logger } from "@oh-my-pi/pi-utils";

logger.error("MCP request failed", { url, method });
logger.warn("Theme file invalid, using fallback", { path });
logger.debug("LSP fallback triggered", { reason });
```

Logs go to `~/.omp/logs/omp.YYYY-MM-DD.log` with automatic rotation. Standalone CLI commands that exit without entering the TUI MAY use `console.*` or process streams for intentional user-facing output. Keep structured stdout clean. This exception is semantic, not filename-based; shared code must use `logger` or an explicit output sink.

## TUI Sanitization

All text displayed in tool renderers must be sanitized. Raw content (file contents, error messages, tool output) breaks terminal rendering: tabs → visual holes, long lines → overflow, paths → leak home directory.

**Rules:**

- **Tabs → spaces** via `replaceTabs()` (from `@oh-my-pi/pi-tui` or `../tools/render-utils`).
- **Truncate** lines with `truncateToWidth()` / `ui.truncate()`. Use `TRUNCATE_LENGTHS` constants.
- **Shorten paths** with `shortenPath()` (replaces home with `~`).
- **Preview limits** from `PREVIEW_LIMITS`. No ad-hoc numbers.

**Apply to every render path**, not just the happy one:

- Success output (file previews, command output, search results).
- **Error messages** — these often embed file content (e.g., patch failure messages include unmatched lines). If a message contains file content, it needs `replaceTabs()`.
- Diff content (added and removed).
- Streaming previews.

### Streaming tool previews

Tool-call previews can have **multiple render paths**. If you add preview-only fields or depend on partially streamed args, update every path — not only the final renderer. Streamed argument buffers decode into display args via `decodeStreamedToolArgs` / `ToolArgsRevealController` (`modes/controllers/tool-args-reveal.ts`); both the live event path and transcript rebuilds must go through them — never spread provider-parsed `arguments` next to a raw `__partialJson` (parsed args lag the stream by a throttled parse window).

For the bash tool specifically:

- The pending preview may need raw `partialJson`, not just parsed `arguments`. Parsed args lag until a JSON object closes, which makes inline env assignments appear only at the end.
- Preserve preview-only fields (e.g. `__partialJson`) through `event-controller.ts`, transcript rebuilds in `ui-helpers.ts`, and merged call/result rendering in `tool-execution.ts`. Missing one path causes inconsistent previews.
- `ToolExecutionComponent.#buildRenderContext()` for bash must work even before a result exists — the renderer uses call args plus render context to show the command preview while streaming.
- Verify both live streaming and rebuilt transcript paths after any bash preview change. A fix in one path does not fix the other.

## Commands

- NEVER commit unless asked.
- Never use `tsc`/`npx tsc` — always `bun check`.
- Merge commits (maintainer merges of PRs) follow: `Merge PR #<number>: <conventional PR subject> (@<author>)` — e.g. `Merge PR #6386: feat(catalog): add native Meta Model API provider (@eggpeat)`.

## Testing Guidance

Test the contract the system exposes — not the easiest internal detail to assert.

- Every new test must defend one **concrete, externally observable contract**: behavior, output shape, state transition, error mapping, or a regression-prone parsing boundary. If you cannot name the contract, do not add the test.
- No placeholder tests, tautologies, or "the code ran" assertions (`expect(true).toBe(true)`, bare `not.toThrow()`, non-empty string checks, length-grew checks, "prompt exists" checks without semantic assertion).
- Prefer contract-level tests over implementation details. Avoid asserting internal helper wiring, field assignment, singleton identity, incidental ordering, prompt boilerplate, or passthrough option forwarding unless another component depends on that exact detail.
- Don't duplicate coverage across abstraction levels. If an integration test already proves the behavior, drop the narrower unit test that restates it through mocks.
- Tests **must be full-suite safe**, not just file-local safe. No long-lived file-wide mutations of `Bun.*`, `process.platform`, `process.env`, or `Bun.env` when a narrower seam exists. Prefer per-test `vi.spyOn(...)` with `vi.restoreAllMocks()` in `afterEach`. A test that passes alone but poisons later files is broken.
- **Never use `mock.module()`**. Bun's `mock.module()` mutates the global module registry and leaks across files ([oven-sh/bun#12823](https://github.com/oven-sh/bun/issues/12823)). Use `spyOn` on the imported module object instead. For pass deps, import the pass and spy on `.run`. For package deps, namespace-import and spy on the exported function.
- For lifecycle/stateful code, prefer one test per invariant or transition over several tiny tests asserting one field each from the same transition.
- For error handling, trigger the real failure path and assert the surfaced contract — don't instantiate error classes directly or inspect internal metadata.
- Smoke tests are acceptable only when they catch a failure mode narrower tests would miss. "Package boots" or "command starts" alone is not enough.
- Assert exact strings, ordering, and formatting only when downstream code parses or depends on the exact bytes. Otherwise assert semantic content.
- Compile-time guarantees → type checks/type tests, not runtime placeholders.
- **Never source-grep.** A test that reads an implementation file (`.ts`/`.rs`/build script) and asserts on its _text_ — `expect(src).toContain("someCall()")`, `.toMatch(/import .../)`, `.not.toContain("oldName")`, or "comment must say X" — is banned. It tests how code _looks_, not what it _does_: it breaks on harmless refactors (comment reflow, rename, import reorder) and passes while the behavior is broken. Assert the observable contract instead (run the code, check output/state/error), use the runtime smoke probe for wiring you cannot exercise in-process, and enforce structural invariants (no value-import of X, no self-import) with a type test or a lint/biome rule — never a string scan of the source. (Reading a file your code _wrote_ — apply-patch result, generated bundle, temp fixture — and asserting on that output is fine; that is behavior, not a source grep.)
- Don't add tests for tiny low-risk changes unless they protect a real contract or fix a regression-prone edge case.
- Prefer focused package-local verification for the changed area.

## Changelog

Location: `packages/*/CHANGELOG.md` (per package).

**Format** — sections under `## [Unreleased]`:

- `### Breaking Changes` (first if present)
- `### Added`
- `### Changed`
- `### Fixed`
- `### Removed`

**Rules:**

- New entries always go under `## [Unreleased]`.
- Never modify already-released sections (e.g., `## [0.12.2]`) — they are immutable.
- Don't flag changelog section order or formatting in reviews or PRs — `bun run release` runs `fix-changelogs` which normalizes everything automatically.

**Attribution:**

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/can1357/oh-my-pi/issues/123))`.
- External contributions: `Added feature X ([#456](https://github.com/can1357/oh-my-pi/pull/456) by [@username](https://github.com/username))`.

## Releasing

1. Ensure all changes since last release are in each affected package's `[Unreleased]` section.
2. Run `bun run release`.

The script handles version bump, CHANGELOG finalization, commit, tag, publish, and adding new `[Unreleased]` sections.
