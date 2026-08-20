# Changelog

## [Unreleased]

### Added

- Added the OpenCode 1.18.18 native Web source, backed directly by OMP sessions, models, tools, files, PTY, LSP, MCP, permissions, questions, and event streaming.
- Added an OMP-native graphical settings surface with a persistent Common/Web/CLI scope switcher: canonical Agent/runtime settings are shared by Web and CLI, selected OMP light/dark themes drive the adaptive Web `OMP` palette, Web-local interface and server controls stay independent, and CLI/TUI-only display, interaction, and keybinding settings are isolated; it also includes credential-safe advanced editors, plugin/MCP management, project discovery, and session deletion.
- Added OMP-native prompt-bar controls for per-input thinking effort plus live advisor and approval settings, removed the inherited Build/Plan selector, agent-cycle commands, and their stale Web keybinding rows, and retained the single internal Build identity only for transport compatibility.
- Added a complete OMP-native runtime control surface for Web: live activity/LSP/tool/todo/subagent/job snapshots, agent and Bash interruption, async job cancellation, compaction, model/thinking changes, slash commands, login, RPC worker restart, checkpoints/restores, subagent messaging, settings, keybindings, MCP, and plugin management now use canonical OMP RPC contracts without OpenCode fallback behavior.

### Fixed

- Fixed incomplete Web settings localization across every supported locale: OMP settings and keybinding catalogs now use Simplified Chinese when the Web locale is `zh` and English otherwise, enum labels and new schema copy are translated, and MCP/plugin metadata no longer leaks raw scope or kind values.
- Fixed OMP Web tool calls losing their details behind OpenCode-shaped fields, collapsed Shell cards, and context summaries: historical and live projections now share OMP-aware path/edit metadata, completed Shell results default to expanded with a one-time settings migration, read/search/task results remain expandable, multi-file edits render every diff, and unknown or failed tools expose their complete input, output, metadata, and error.
- Fixed remaining Web transcript data loss across multi-part user messages, Assistant and tool-result images, orphan tool results, compaction and branch summaries, aborted turns, and hidden custom events; generated images now have a dedicated preview, compaction summaries remain visibly bounded, and generic tool input/output/metadata mounts reliably when opened.
- Fixed newly opened projects showing no history by importing canonical OMP sessions into the global Web session index and normalizing the OMP adapter page before Home filters by project.
- Fixed historical sessions failing during first render or message hydration: session layout accessors are initialized synchronously, message parent chains stay user-rooted, and generated-client single-message/trailing-slash routes now resolve correctly.
- Fixed OMP provider-order settings collapsing their descriptions into zero-width columns, and preserved configured OMP/plugin secrets when password fields lose focus without a replacement value.
- Prevented session-status polling from spawning every persisted RPC worker, and made each Web state database single-owner across server processes so duplicate servers cannot resume the same sessions concurrently.
- Prevented the legacy new-session route from mounting incomplete session state while creating a new-layout draft, normalized partial Agent/provider/model state, and made the default-only PTY shell capability explicit instead of falling through to HTML.
- Replaced inherited OpenCode wordmarks, loading marks, icons, and product copy with OMP branding; Web now identifies as OMP Web, reads its version and explicit OMP Web contract from runtime health, and routes support to OMP documentation and repositories.
- Added explicit server capabilities so provider management becomes read-only against OMP while canonical MCP management remains available; the OMP bridge uses the `/api/omp/*` transport and serves real global-config, reference, and MCP-resource reads instead of mismatched response envelopes or placeholder errors.
- Hid inherited OpenCode-only provider, project, workspace, archive, fork, revert, and share controls when the OMP bridge does not advertise those capabilities, and kept the MCP form width-bounded in the Desktop dialog.
- Removed inherited OpenCode root API, health, event, storage, and environment fallbacks; OMP Web now requires exact `oh-my-pi`/`omp-web/v1` identity, keeps business routes under `/api/omp/*`, and exposes provider models in the complete Web view-model shape.

- Fixed cold session metadata, status, diff, and rename requests from activating historical `rpc-ui` workers; only explicit live session operations activate a worker, and active workers are bounded by idle TTL/LRU cleanup while busy workers remain protected.
- Fixed a race that could blank a session page with an uncaught `TypeError: Cannot read properties of undefined (reading 'directory')`: session-key derivation and the deferred ownership callbacks now tolerate the directory-scoped SDK being momentarily unavailable during context teardown/rebuild, falling back to a bare route key and re-resolving once the SDK returns instead of throwing from inside the queued `requestAnimationFrame`/`setTimeout` action.
- Kept the OMP thinking and approval selectors in the main prompt input's bottom toolbar as semantic icon-plus-value controls, removed the advisor toggle from both main prompt implementations, and kept child-session transcripts read-only without an advisor toggle or disabled-composer placeholder card; the main submit button remains pinned and prompt text reclaims the removed control's horizontal space.
- Replaced the Web and Desktop tab and notification favicons with the PI mark, cache-busted the active assets to `v4`, and made the square background fully opaque so all four corner pixels match without white seams.
- Fixed vendored UI locale fallbacks to import OMP English copy through an exported package subpath, so consumers using the UI as a file dependency resolve the same runtime text.
- Fixed snapcompact compaction frames overwhelming Web session history as dense inline bitmaps: archived frames now render as individually named, downloadable resource cards while ordinary user, assistant, and tool-result images retain their existing previews.
### Removed

- Removed inherited WSL server management because OMP Web and Desktop do not ship a WSL OMP runtime.
