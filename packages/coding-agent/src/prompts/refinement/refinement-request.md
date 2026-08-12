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

Return only the JSON object. Use an empty `edits` array when no evidence justifies a change.
