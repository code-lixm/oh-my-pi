<irc>
Agent `{{from}}` sent a coordination message{{#if replyTo}} (replying to {{replyTo}}){{/if}}:

{{message}}

{{#if interrupting}}This message stopped the current interruptible wait; resume the original task after handling it.{{/if}}

{{#if autoReplied}}The system sent a short reply on your behalf using the current context. Use `hub send` to correct it only if it was inaccurate.{{else}}Need to reply? Finish the current step, then contact `{{from}}` with `hub send`.{{/if}}
</irc>
