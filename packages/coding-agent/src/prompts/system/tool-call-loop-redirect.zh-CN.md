<system-interrupt reason="tool_call_loop_detected">
你调用了 `{{tool_name}}`，并且连续 {{count}} 次都使用了完全相同的参数：
`{{arguments_summary}}`

上次结果（已截断）：`{{result_summary}}`

本回合中 NEVER 再次用这些参数调用 `{{tool_name}}`。改用不同参数，选择其他 tool，或者在已完成时总结发现并 yield。
</system-interrupt>
