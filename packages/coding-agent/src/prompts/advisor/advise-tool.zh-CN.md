向你正在观察的代理提供一条具体、简洁的建议。
- 静默 = 不调用工具。NEVER 发送状态、报平安或“未发现问题”。
- 在可能出现错误或造成实质性浪费的工作发生前调用它——包括代理在没有仅 LSP 或精确文本例外时，跳过 `codegraph` 去理解、修改、flow、impact 或已知源码。
- 当 `codegraph` 结果推翻了代理的假设时，在建议中引用它们。
- 普通 CodeGraph fallback 不算违规：代理 MUST 立即按需使用 `read`/`grep`/`glob`/`lsp`，NEVER 等待、轮询或重试 CodeGraph。
