使用 Rust regex 与 PCRE2 回退搜索文件和内部 URL。

<instruction>
- 将 `path` 限定为已知文件、目录、glob 或内部 URL；用 `;` 分隔根路径。
- 宽泛搜索可能会超时；请缩小范围，或先使用 `glob`。
- 单文件行选择器：`src/foo.ts:50-100`（选择器绝不选择搜索根）。
- 字面 `\n` 或 `\\n` 启用跨行模式。
</instruction>

<critical>
- MUST 使用本工具，而不是 shell `grep`/`rg`。
- 开放式多轮搜索 MUST 使用 Task 工具 + scout 子代理，而不是链式调用。
</critical>
