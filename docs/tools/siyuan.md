# siyuan

> Query and safely mutate registered SiYuan workspaces through a verified SiYuan Kernel CLI.

## Availability

The tool is registered only when `siyuan.enabled` is on and a `siyuan` command exists on `PATH`.

Startup verification requires:

- `siyuan --version` to return the compatible `siyuan version <semver>` identity.
- `siyuan workspace --help` to expose the compatible workspace command.
- On macOS, `codesign --verify --strict` must pass before metadata confirms `SiYuan-Kernel` and Team ID `FJT3K7XAD8`.

Set `siyuan.workspace` to a registered workspace name or absolute path when more than one workspace exists. `SIYUAN_WORKSPACE_PATH` is the environment fallback; the per-call `workspace` field wins.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | command group | Yes | `asset`, `attr`, `block`, `bookmark`, `dailynote`, `database`, `document`, `export`, `file`, `history`, `import`, `inbox`, `notebook`, `outline`, `ref`, `repo`, `search`, `sql`, `sync`, `system`, `tag`, `template`, or `workspace`. |
| `args` | `string[]` | No | Arguments following the command group. Global flags belong in dedicated fields. |
| `workspace` | `string` | No | Registered workspace name or absolute path. |
| `format` | `"json" \| "table"` | No | Defaults to `json`. |
| `dryRun` | `boolean` | No | Mutations default to `true`; pass `false` only after reviewing the preview. |
| `stdin` | `string` | No | Standard input for commands using `--file -`. |
| `timeout` | `number` | No | Seconds, clamped to 1–3600; defaults to 60. |

`args` cannot override `--workspace`, `--format`, `--dry-run`, or `--log-level`. The `sql` command accepts only queries beginning with `SELECT`.

## Safety and approvals

- Read-only local operations use the `read` tier.
- Local mutation dry-runs use the `read` tier and cannot change data.
- Real local mutations use the `write` tier.
- Plan mode rejects real mutations while allowing read-only calls and dry-run previews.
- Cloud inbox and sync operations use the `exec` tier.
- Unknown/future subcommands are treated as mutations and therefore dry-run by default.
- Workspace selection is restricted to workspaces returned by `siyuan --format json workspace list`.

The tool never edits `.sy` files directly. All logical document and block mutations go through the SiYuan Kernel CLI.

## Examples

```json
{"op":"search","workspace":"My Notes","args":["project plan","--page","1","--page-size","20"]}
```

```json
{"op":"block","workspace":"My Notes","args":["kramdown","--id","BLOCK_ID","--mode","md"]}
```

Preview, then apply the same block update:

```json
{"op":"block","workspace":"My Notes","args":["update","--id","BLOCK_ID","--file","-"],"stdin":"updated Markdown","dryRun":true}
```

```json
{"op":"block","workspace":"My Notes","args":["update","--id","BLOCK_ID","--file","-"],"stdin":"updated Markdown","dryRun":false}
```

## Source

- Tool: `packages/coding-agent/src/tools/siyuan.ts`
- Model prompt: `packages/coding-agent/src/prompts/tools/siyuan.md`
- Settings: `siyuan.enabled`, `siyuan.workspace`
