调用本地 SiYuan Kernel CLI，无需启动 HTTP 服务。用于管理思源工作空间、笔记本、文档、块、搜索、反链、标签、属性、数据库、日记、模板、资源、历史、快照、导入导出、收集箱和同步。

<instruction>
- 用 `op` 选择顶层命令；`args` 只传该命令之后的参数。
- `args` 中省略全局参数；改用 `workspace`、`format`、`dryRun`、`timeout` 字段。
- 参数不确定？使用 `args: ["--help"]`；NEVER 猜测。
- 注册了多个工作空间？MUST 传 `workspace`，值为注册名称或绝对路径。
- 查询默认返回 JSON。`sql` 仅允许 SELECT。
- 修改默认 `dryRun: true`。检查预览后，仅在确需执行时用 `dryRun: false` 重复调用。
- Plan mode 仅允许读取和 dry-run；真实修改会被拒绝。
- 长 Markdown：使用 `args: ["update", "--id", "…", "--file", "-"]` + `stdin`。
- 删除、清理、回滚等危险操作 MUST 在 dry-run 后征得用户确认。批量修改前 SHOULD 创建 repo 快照。
</instruction>

<examples>
搜索块：
```json
{"op":"search","workspace":"我的文档","args":["项目计划","--page","1","--page-size","20"]}
```

读取块 Markdown：
```json
{"op":"block","workspace":"我的文档","args":["kramdown","--id","BLOCK_ID","--mode","md"]}
```

预览块更新：
```json
{"op":"block","workspace":"我的文档","args":["update","--id","BLOCK_ID","--file","-"],"stdin":"更新后的 Markdown","dryRun":true}
```

执行已确认的更新：
```json
{"op":"block","workspace":"我的文档","args":["update","--id","BLOCK_ID","--file","-"],"stdin":"更新后的 Markdown","dryRun":false}
```
</examples>

<critical>
- NEVER 直接修改 `.sy` 文件；使用本工具。
- 修改操作 NEVER 跳过 dry-run。
- NEVER 猜测工作空间名称或块 ID。
</critical>
