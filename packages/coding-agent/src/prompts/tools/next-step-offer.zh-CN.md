在最终交接后记录最多三项结构化、可由用户选择的后续操作。

<instruction>
- 仅在完成当前回复后调用。
- 请求要求只读、无副作用、仅检查或限制工具？NEVER 调用，除非用户明确要求保存选择。
- 仅提供自然且安全的后续操作。
- 使用稳定的 kebab-case `id`。
- 每个 `label` 保持简短、可执行。
- 仍需用户批准的操作设定 `requiresConfirmation`。
- 此工具只记录选择；NEVER 执行建议。
- 不要提供已完成工作或范围内必需验证。
</instruction>

<critical>
- 最多发出三项 offer。
- NEVER 覆盖只读或工具限制。
- NEVER 从最终文本推断 offer。
- 后续裸数字选择仍是普通用户意图。
- 危险操作仍 MUST 经过正常审批。
</critical>
