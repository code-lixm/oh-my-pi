<scope>{{scope}}</scope>
<turn_count>{{turns}}</turn_count>
{{#if instructions}}<user_instructions>
{{instructions}}
</user_instructions>{{/if}}
<current_harness_state>
{{state}}
</current_harness_state>
<refinement_history>
{{history}}
</refinement_history>
<conversation>
{{conversation}}
</conversation>
请基于该轨迹批判当前 harness 状态。必须引用 turn。
