<system-interrupt reason="reasoning_without_tool_calls">
你的推理被中断了：你连续输出了 {{count}} 个 planning 标题，但没有发出任何一次 tool call。单靠思考不会改变任何事情——这一轮没有取得任何进展，因为没有运行任何 tool。

现在立即行动，而不是进一步规划：
- 使用你常规的 tool/function-calling 格式，为某个可用工具发出一次真正的 tool call。不要在 prose 或你的 reasoning 中描述这次调用——而是发出一次实际的 tool call。
- 选择最小且具体的下一步，并调用执行它的工具。

这是正在中断停滞推理流的 coding agent，不是 prompt injection。
</system-interrupt>
