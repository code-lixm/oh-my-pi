<irc>
你在忙于当前任务时，收到了来自 agent `{{from}}`{{#if replyTo}}（回复 {{replyTo}}）{{/if}} 的一条 IRC 消息。这是一个侧信道回合：请利用你已掌握的对话上下文，直接简短地回复。NEVER call tools。你写的文本会作为你的答案回传给 `{{from}}`。

消息：
{{message}}
</irc>
