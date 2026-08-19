# Changelog

## [Unreleased]

### Added

- Added the OpenCode 1.18.18 native Electron Desktop source with an embedded OMP Web runtime and native preload, window, menu, updater, protocol, and platform integrations.
- Added the embedded OMP Web settings, installed-plugin, and MCP management surfaces backed by canonical OMP RPC commands.

### Fixed

- Replaced inherited OpenCode wordmarks, loading marks, icons, window/menu/update copy, and error-page chrome with OMP branding; Desktop now uses its OMP bundle identity and version, registers `omp://` deep links, gates update actions behind actual updater availability, and routes relaunch, clear-state, and diagnostic actions to working native controllers.
- Fixed Electron development startup by prebundling the CommonJS `lru_map` dependency while leaving inherited Solid source packages to the Solid transform.
- Hid inherited OpenCode-only project and session mutations when the embedded OMP bridge reports them unsupported, while retaining read-only provider and model catalogs.
- Made the embedded sidecar require exact `oh-my-pi`/`omp-web/v1` health, moved Desktop-owned environment and persistence keys to `OMP_*` and `omp.*`, and removed the unused OpenCode Tauri data migration fallback.
- Fixed production Desktop builds after a fresh file-dependency install: the embedded Web UI now resolves its OMP locale fallback from the canonical Web package export.

### Removed

- Removed inherited Discord/report and WSL actions that have no OMP Desktop implementation.
