使用智能大小写、路径约束和模糊恢复搜索已建立索引的文件内容。

<instruction>
- 优先使用具体标识符或字面短语；纯通配模式会被拒绝。
- `path` 包含目录、文件名、Glob 或外部路径；`exclude` 排除噪声路径。
- 默认省略 `caseSensitive` 以使用智能大小写；仅需严格大小写时设置。
- 下一页使用返回的 cursor。获得有效匹配后应 `read` 最佳文件，不要继续串联搜索。
</instruction>

<critical>
- MUST 使用本工具而不是 shell `grep`/`rg`。
- 开放式多轮探索 → Task + scout，而非串联搜索。
</critical>
