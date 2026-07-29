<irc>
代理 `{{from}}` 发来协作消息{{#if expectsReply}}，需要你的回复{{/if}}{{#if replyTo}}（回复 {{replyTo}}）{{/if}}：

{{message}}

{{#if interrupting}}这条消息已停止当前可中断的等待；处理后可继续原任务。{{/if}}

{{#if autoReplied}}系统已根据当前上下文代你发送一条简短回复。仅当回复不准确时，才使用 `hub send` 联系 `{{from}}` 更正。{{else}}仅当消息需要回答、决策、更正或行动时才回复。NEVER 发送纯确认或结束线程的回复；否则保持静默并继续当前任务。{{/if}}
</irc>
