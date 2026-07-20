在探索性工作开始前创建一个上下文 checkpoint，这样你稍后可以回退，并且只保留一份简洁报告。

当你需要通过许多中间工具调用（read/grep/glob/lsp/etc.）进行调查，并希望随后尽量减少上下文成本时，使用此工具。

规则：
- 开始一个 checkpoint 后，在结束当前轮次前你 MUST 调用 `rewind`。
- 当另一个 checkpoint 仍处于活跃状态时，你 NEVER 调用 `checkpoint`。
- 子代理中不可用。

典型流程：
1. `checkpoint(goal: …)`
2. 执行探索性工作
3. 使用 `rewind(report: …)` 提交简洁发现

回退后，中间的 checkpoint 消息会从活动上下文中移除，并由该报告替代。
