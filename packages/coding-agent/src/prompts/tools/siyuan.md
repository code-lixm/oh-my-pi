Run the local SiYuan Kernel CLI without starting its HTTP server. Use it for SiYuan workspaces, notebooks, documents, blocks, search, backlinks, tags, attributes, databases, daily notes, templates, assets, history, snapshots, import/export, inbox, and sync.

<instruction>
- Choose the top-level command with `op`; pass only its following arguments through `args`.
- Omit global flags from `args`; use `workspace`, `format`, `dryRun`, and `timeout` fields.
- Unknown arguments? Run that command with `args: ["--help"]`; NEVER guess.
- Multiple registered workspaces require `workspace`; use its registered name or absolute path.
- Queries default to JSON. `sql` permits SELECT only.
- Mutations default to `dryRun: true`. Inspect the preview, then repeat with `dryRun: false` only when the change should occur.
- Plan mode permits read operations and dry-runs only; real mutations are rejected.
- Long Markdown input: use `args: ["update", "--id", "…", "--file", "-"]` plus `stdin`.
- Destructive operations and snapshot rollback require user confirmation after dry-run. Batch mutation? Create a repo snapshot first.
</instruction>

<examples>
Search blocks:
```json
{"op":"search","workspace":"My Notes","args":["project plan","--page","1","--page-size","20"]}
```

Read block Markdown:
```json
{"op":"block","workspace":"My Notes","args":["kramdown","--id","BLOCK_ID","--mode","md"]}
```

Preview a block update:
```json
{"op":"block","workspace":"My Notes","args":["update","--id","BLOCK_ID","--file","-"],"stdin":"updated Markdown","dryRun":true}
```

Apply the reviewed update:
```json
{"op":"block","workspace":"My Notes","args":["update","--id","BLOCK_ID","--file","-"],"stdin":"updated Markdown","dryRun":false}
```
</examples>

<critical>
- NEVER modify `.sy` files directly; use this tool.
- NEVER skip dry-run for mutations.
- NEVER guess workspace names or block IDs.
</critical>
