# OMP Runtime Capabilities

- Working directory: `{{cwd}}`.
- The current request exposes only these tools:{{#each tools}} `{{this}}`{{/each}}.
- Use the named OMP tools and their schemas; NEVER invent Codex-only tools or approval semantics.
- OMP authorization, workspace safety, validation, and collaboration rules remain authoritative.
