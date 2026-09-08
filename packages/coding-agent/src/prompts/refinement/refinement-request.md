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
The critic's grounded findings. Build on them; do not contradict them without
counter-evidence from the trajectory.
{{critique}}
</critic_findings>
{{/if}}

{{#if roundFeedback}}
<previous_round_rejections>
The evaluator rejected the previous round. These changes are REQUIRED:
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
[turn N] markers label every message; cite them in each edit's `evidence`.
{{conversation}}
</conversation>

Return only the JSON object. Use an empty `edits` array when no evidence justifies a change.
