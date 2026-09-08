<system-interrupt reason="cross_turn_thinking_loop_detected">
最近 {{count}} 个回合的思考重复了同一段内容，行为没有任何变化：
`{{summary}}`

每一轮看起来略有不同（工具参数不同），但思考卡在同一个意图上。不要在思考里反复宣告自己陷入了循环——真正改变行动：调用你一直决定要调用的工具（严格按照它的 schema），或者先排查该调用为什么失败再重试。如果确实无法调用该工具，用一句话说明具体阻塞原因并结束回合。
</system-interrupt>