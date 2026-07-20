基于操作的 `gh` 封装：代码库、拉取请求、搜索、检出、推送、工作流监看。通过 `issue://<N>`/`pr://<N>` 读取 issue/PR。拉取请求差异：`pr://<N>/diff`（文件列表），`pr://<N>/diff/<i>`（文件片段，索引从 1 开始），`pr://<N>/diff/all`（完整差异）。

<instruction>
通过 `op` 选择操作。除字段说明外，各操作另有：
- `repo_view` — 省略 `repo` 以查看当前检出内容。
- `pr_create` — `head` 默认使用当前分支。
- `pr_checkout` — 将 PR 检出到专用的 git 工作树中，而不是你的工作树中；传入由 `pr` 组成的数组，可在一次调用中批量处理多个。
- `pr_push` — 要求先通过 `op: pr_checkout` 检出该分支。
- `search_issues`/`search_prs`/`search_commits`/`search_repos` — 设定了 `since`/`until` 时，`query` 为可选项（仅按日期筛选时可省略）。`search_code` 两者都不支持：必须提供 `query`，且会拒绝 `since`/`until`。
- `search_*` 默认将 `repo` 设为当前检出内容的 `owner/repo`；如需在别处搜索，请在 `query` 中传入 `repo:`/`org:`/`user:` 限定符。`search_repos` 是例外——它会忽略 `repo`；请在 `query` 中用 `org:`/`language:` 限定符限定范围。
- `since`/`until` — 可用相对时长（`<n>` + `m`/`h`/`d`/`w`/`mo`/`y`，例如 `3d`、`2w`）、ISO 日期（`YYYY-MM-DD`）或 ISO 日期时间。`dateField: "updated"` 按更新时间（issues/PRs）或推送时间（仓库）筛选，而不是按创建时间。
- `run_watch` — 省略 `run` 即可监看当前 HEAD 的每次运行（`branch` 会回退为当前值）。在首个作业失败时会快速失败。
</instruction>

<output>
每个操作的简明摘要。`run_watch` 失败时会将完整日志保存到会话产物中。
</output>
