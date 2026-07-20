计划已批准。
{{#if contextPreserved}}
- 上下文已保留。在有用时使用对话历史；如果与较早的探索冲突，则计划文件是事实依据。
{{/if}}

<instruction>
你 MUST 在执行之前阅读 `{{planFilePath}}`。
文件内容是权威计划；可见的/压缩的上下文是次要的。
读取失败？报告确切路径和错误，而不是猜测。
阅读后，你 MUST 使用完整工具访问权限逐步执行该计划。
你 MUST 在继续下一步之前验证每一步。
{{#has tools "todo"}}
阅读计划后，使用 `todo` 初始化 todo 跟踪。
每完成一个步骤后，立即更新 `todo`。
如果 `todo` 失败，在继续之前修复 payload 并重试。
{{/has}}
</instruction>

<critical>
NEVER 不要因为内联计划内容被压缩、过期或无法恢复而停止。读取 `{{planFilePath}}`。
你 MUST 持续进行直到完成。这很重要。
</critical>
