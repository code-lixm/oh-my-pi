<current_harness_state>
{{state}}
</current_harness_state>

<refinement_history>
{{history}}
</refinement_history>

<conversation>
{{conversation}}
</conversation>

<requested_scope>
{{scope}}
</requested_scope>

{{#instructions}}
<user_refine_instructions>
{{instructions}}
</user_refine_instructions>
{{/instructions}}

仅返回 JSON 对象。没有证据支持变更时，返回空的 `edits` 数组。