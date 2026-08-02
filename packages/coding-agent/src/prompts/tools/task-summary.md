<task-result id="{{id}}" agent="{{agentName}}" status="{{status}}" duration="{{duration}}">
{{#if meta}}<meta lines="{{meta.lineCount}}" size="{{meta.charSize}}" />{{/if}}
{{#if abortReason}}
<abort-reason>{{abortReason}}{{#if resumable}} — the agent is still live with its full context; message it via `hub` to resume instead of redoing the work.{{/if}}</abort-reason>
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
This task failed. Do not treat it as completed. Preserve successful sibling results, inspect the failure evidence above, then continue the unresolved work with a corrected approach or reassign it to an appropriate agent. Retry only work that has not already completed. If recovery is not possible, report the blocker explicitly.
</recovery-required>
{{/if}}
</task-result>
