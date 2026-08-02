<task-result id="{{id}}" agent="{{agentName}}" status="{{status}}" duration="{{duration}}">
{{#if meta}}<meta lines="{{meta.lineCount}}" size="{{meta.charSize}}" />{{/if}}
{{#if abortReason}}
<abort-reason>{{abortReason}}{{#if resumable}} — 该代理仍在运行并保留其完整上下文；请通过 `hub` 向其发送消息以继续，而不是重新做这项工作。{{/if}}</abort-reason>
{{/if}}
{{#if truncated}}
<preview full-output="agent://{{id}}">
{{preview}}
</preview>
{{else}}
<output>
{{preview}}
</output>
{{/if}}
{{#if mergeSummary}}
<merge-summary>
{{mergeSummary}}
</merge-summary>
{{/if}}
{{#if failed}}
<recovery-required>
此任务已失败，不要将其视为已完成。保留其他已成功子任务的结果，检查上述失败证据，然后采用修正后的方案继续未完成工作，或将其重新分配给合适的代理。只重试尚未完成的工作；如果无法恢复，请明确报告阻塞原因。
</recovery-required>
{{/if}}
</task-result>
