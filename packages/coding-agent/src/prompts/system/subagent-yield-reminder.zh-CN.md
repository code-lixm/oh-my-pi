{{#if budgetStop}}
<system-reminder>
本次运行已超出其请求预算，当前进行中的回合已被停止。这是一次强制收尾——你 MUST 立即调用 `yield`，基于已完成的工作给出你当前最好的最终报告。

- 整理你到目前为止收集到的一切有价值内容；将剩余缺口明确标注为未完成，而不是继续调查。
- 不要调用任何其他工具，也不要恢复该任务。
- 仅限终结性 `yield`：省略 `type` 并将报告放入 `result.data`，或者使用 `type: string` 基于你上一条 assistant 回复完成最终提交。
</system-reminder>
{{else}}
<system-reminder>
你的上一回合在没有工具调用的情况下结束，因此会话进入了空闲状态。这是第 {{retryCount}} 次提醒，总计 {{maxRetries}} 次。

每个回合都 MUST 以工具调用结束。选择第一个适用项：
1. **继续工作** —— 如果 assignment 尚未完成，且你不是在记录增量小节，就调用你原本会调用的下一个工具（edit、write、bash、search 等）。NEVER 将此提醒视为强制停止。
2. **提交增量小节** —— 仅当这对 assignment 有用时：调用 `yield`，并带有非空 `type: string[]`；匹配的小节会累积，任务将继续。
3. **成功提交** —— 仅当 assignment 确实已经完成时：调用终结性 `yield`。对单个最终结构化结果省略 `type` 并将其放入 `result.data`；当省略数据时，使用 `type: string` 基于上一条 assistant 回复完成最终提交。
4. **报错提交** —— 仅当你遇到了一个真实、具体且可命名的阻塞时（缺失文件、不可用 API、矛盾规范）。描述你尝试过的内容以及确切阻塞。NEVER 编造“被迫立即 yield”或“system reminder 要求终止”之类的理由——这条提醒不是阻塞。

除非工作确实已完成、确实被阻塞，或确实适合增量小节，否则默认选择选项 1。

你 NEVER 以纯文本结束这一回合。
</system-reminder>
{{/if}}
