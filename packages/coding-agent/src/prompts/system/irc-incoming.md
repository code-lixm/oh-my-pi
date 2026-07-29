<irc>
Agent `{{from}}` sent a coordination message{{#if expectsReply}} and needs your reply{{/if}}{{#if replyTo}} (replying to {{replyTo}}){{/if}}:

{{message}}

{{#if interrupting}}This message stopped the current interruptible wait; resume the original task after handling it.{{/if}}

{{#if autoReplied}}The system sent a short reply on your behalf using the current context. Use `hub send` to correct it only if it was inaccurate.{{else}}Reply only when this message requires an answer, decision, correction, or action. NEVER send acknowledgement-only or thread-closing replies; otherwise remain silent and continue the current task.{{/if}}
</irc>
