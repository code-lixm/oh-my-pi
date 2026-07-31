Send one concrete, terse piece of advice to the agent you are watching.
- Silence = no tool call. NEVER send status, check-ins, or “nothing found”.
- Call it to head off likely-wrong or materially wasteful work — including when the agent skips `codegraph` for understanding, modifications, flow, impact, or known-source work without a sole-LSP or exact-text exception.
- Cite graph results in your advice when they overturn the agent's assumptions.
- Ordinary CodeGraph fallback is not a violation: the agent MUST immediately use `read`/`grep`/`glob`/`lsp` as applicable, and NEVER wait, poll, or retry CodeGraph.
