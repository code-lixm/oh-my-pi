通过 CodeGraph 做语义级代码探索。用于仓库结构、行为理解、已知源码目标、修改、调用链、flow、模块职责或 impact。

<instruction>
- 结构、行为、flow、impact、修改或已知源码问题？除非请求仅是 LSP 符号操作，否则你 MUST 先调用本工具，再使用 `grep`/`glob`/`read`。
- `mode` 使用 `CodeGraphExploreMode = auto|locate|understand|flow|impact|edit`：`auto` 自动推断；`locate` 返回定义与完整目标 body；`understand`/`edit` 返回目标 body 与关键关系；`flow` 返回路径及端点／脊柱源码；`impact` 返回影响、tests 与焦点源码，外围字段保持紧凑。
- `query` 为 REQUIRED。围绕行为、依赖、职责或改动影响提问，并按所选 mode 组织问题。
- `projectPath` 选择目标索引；`path` 仅指定目标或限制 sync scope。
- 精确文本、日志、配置、文档、精确 selector → `grep`/`read`；文件发现 → `glob`；definition/type/references/hover/code actions → 可用时使用 `lsp`。
</instruction>
<output>
- 返回 source sections/entries，以及 `edges`、`flow`、`blastRadius`、`testCandidates`、`coverage`、`freshness`、`budget`。
- 当前磁盘源码 section 可能带有 `[PATH#TAG]` 与原始行号。将其视为已读，并可直接交给 `edit`。
- coverage 为 partial、omitted 或 stale？对缺失范围、精确 selector、验证或过期 hashline 使用系统工具；NEVER 机械重读完整返回文件。
- 探索前会 drain OMP mutations。索引候选文件发生漂移时做 scoped sync，最多重跑一次；仍未解决时源码仍取当前磁盘，关系标为 `partial-stale`，并列出受影响路径。
- runtime 不可用／error、indexing、缺失／失败的 index 或非 Git 工作区会返回正常 fallback 说明，而不是原始堆栈。
</output>
<critical>
- 出现当前 coverage 之外的新分支 → 新提问一次；coverage 未变或每次 edit 后 → NEVER 机械重调。
- 普通 fallback（runtime 不可用／error、indexing、缺失／失败的 index 或非 Git）后？本项目立即按需使用 `read`/`grep`/`glob`/`lsp`；NEVER 等待、轮询或重试 CodeGraph。
- 非法或不安全路径属于错误，不是 fallback；修正或报告。
- CodeGraph 只提供探索依据；NEVER 替代 LSP、compiler、tests 或验证。
</critical>
