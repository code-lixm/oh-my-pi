# CodeGraph attribution

This directory contains TypeScript sources adapted from
[`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph)
(MIT, Copyright (c) 2026 Colby Mchenry). The sources are vendored into
OMP so the semantic graph runtime does not depend on an external
`codegraph` PATH or package, and so that all storage paths can flow
through the injected `CodeGraphIndexLocation` rather than the upstream
per-project `.codegraph/` directory.

Each ported file carries an attribution header naming the upstream
module and license. Modules under `./db`, `./graph`, `./context`,
`./extraction`, `./resolution`, `./search`, `./sync`, `./utils`,
`./errors`, `./runtime`, `./index`, and `./types` are adaptations of
upstream sources; structural changes (location injection, native as
optional, SQLite backend switched to `bun:sqlite`) are documented inline.

The full upstream license text is preserved verbatim in
[`./UPSTREAM_LICENSE`](./UPSTREAM_LICENSE) per the MIT terms.

Upstream repository: <https://github.com/colbymchenry/codegraph>
Upstream license: MIT