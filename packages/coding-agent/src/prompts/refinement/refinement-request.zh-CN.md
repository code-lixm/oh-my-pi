<requested_scope>
{{scope}}
</requested_scope>

<round>
{{round}}
</round>

{{#if instructions}}
<user_refine_instructions>
{{instructions}}
</user_refine_instructions>
{{/if}}

{{#if critique}}
<critic_findings>
批判者给出的有据发现。在它们的基础上工作；没有轨迹中的反证，不要与之相悖。
{{critique}}
</critic_findings>
{{/if}}

{{#if roundFeedback}}
<previous_round_rejections>
评估者拒绝了上一轮。以下修改是强制性的：
{{roundFeedback}}
</previous_round_rejections>
{{/if}}

<current_harness_state>
{{state}}
</current_harness_state>

<refinement_history>
{{history}}
</refinement_history>

<conversation>
每条消息都以 [turn N] 标记；请在每条编辑的 `evidence` 中引用它们。
{{conversation}}
</conversation>

仅返回 JSON 对象。没有证据支持变更时，返回空的 `edits` 数组。
