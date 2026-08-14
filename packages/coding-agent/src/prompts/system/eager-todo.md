<system-reminder>
{{#if forced}}
Before substantive work, create a phased todo.

You MUST include the `{{toolRefs.todo}}` `init` op in your first tool-call message.
Batch it with independent reads or edits you already need (`find`, `grep`, `read`, etc.).
NEVER make the `{{toolRefs.todo}}` call your turn's only tool call.
You MUST cover the entire request from investigation through implementation and verification — not just the next immediate step.
Task descriptions MUST be concise, specific 5-10 word labels.
The `init` op only accepts phase names and task-label strings; do not invent task metadata fields.

After the batched tool call succeeds, continue the request in the same turn.
NEVER call the `{{toolRefs.todo}}` tool again unless task state has materially changed.
{{else}}
Consider calling `{{toolRefs.todo}}` first to lay out a phased plan with a single `init` op. A good list covers the whole request — investigation through implementation and verification — not just the next step, with specific task descriptions a future turn could execute without re-planning.
A useful list keeps each task to a concise, specific 5-10 word label; the `init` op only accepts phase names and task-label strings, so don't invent extra task metadata fields.
If you create the list, continue the request in the same turn and avoid re-calling `{{toolRefs.todo}}` unless task state materially changes.
{{/if}}
</system-reminder>
