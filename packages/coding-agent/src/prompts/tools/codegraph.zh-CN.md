通过 CodeGraph 做语义级代码探索。用于结构性或跨文件问题：仓库结构、调用链、数据流、模块职责、影响范围。

<instruction>
- 需要关系与结构，而不是原始文本时，优先用它而不是 `grep`/`read`。
- `query` 为 REQUIRED。询问行为、依赖、职责或改动影响。
- `path` 为 OPTIONAL。已知范围时，用它从目标文件/目录解析 location，并把预 explore 的 sync 限制在 source root 内对应范围。
- `maxFiles` 为 OPTIONAL。需要聚焦答案时，用它限制搜索宽度。
- 精确文本、日志、说明文档或文件发现 → `grep`、`glob`、`read`。
- 运行时不可用、当前目录不是 Git 仓库、或索引失败？先读取 fallback 提示，再继续用 `grep`/`glob`/`read`。
</instruction>

<output>
- 返回来自 CodeGraph 的语义探索结果。
- 结果 MAY 引用相对 source root 的文件，并附短代码预览。
- 运行时不可用 / 非 Git / 索引失败时，返回清楚的降级说明，而不是无上下文堆栈。
</output>

<critical>
- 结构性问题优先 → `codegraph`；文本问题 → `grep`/`read`。
- NEVER 把 fallback 输出当作语义证明。
- 做跨文件推理前，AVOID 先跑整仓库文本搜索。
</critical>
