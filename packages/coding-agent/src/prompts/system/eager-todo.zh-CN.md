<system-reminder>
{{#if forced}}
开始实质性工作前，先创建一个分阶段 todo。

你 MUST 在本轮首先调用 `{{toolRefs.todo}}`。
你 MUST 用单个 `init` op 初始化 todo 列表。
你 MUST 让 todo 覆盖整个请求，从调查到实现再到验证——而不是只覆盖眼前的下一步。
任务描述 MUST 简洁、具体，并控制在 5-10 个词。
`init` op 只接受 phase 名称和 task-label 字符串；不要臆造 task metadata fields。

在 `{{toolRefs.todo}}` 成功后，于同一轮继续处理请求。
除非任务状态发生实质变化，否则 NEVER 再次调用 `{{toolRefs.todo}}`。
{{else}}
考虑先调用 `{{toolRefs.todo}}`，用单个 `init` op 列出一个分阶段计划。好的列表应覆盖整个请求——从调查到实现再到验证——而不是只覆盖下一步，并使用具体到未来某一轮无需重新规划就能执行的任务描述。
实用的列表会让每个任务保持为简洁、具体的 5-10 个词；`init` op 只接受 phase 名称和 task-label 字符串，所以不要发明额外的 task metadata fields。
如果你创建了这个列表，就在同一轮继续处理请求，并避免再次调用 `{{toolRefs.todo}}`，除非任务状态发生实质变化。
{{/if}}
</system-reminder>
