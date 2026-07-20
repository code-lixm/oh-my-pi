结束一个活跃的 checkpoint。将上下文回退到该 checkpoint，并用你的报告替换中间的探索过程。

在由 `checkpoint` 开始的调查工作之后立即调用。

要求：
- `report` MUST 简洁、事实性强且可执行。
- 包含关键发现、决策以及任何未解决风险。
- 除非确有必要，否则 AVOID 原始草稿日志。
- 如果存在活跃 checkpoint，则在结束当前轮次前 MUST 调用它。

行为：
- 如果没有活跃 checkpoint，此工具会报错。如果该 checkpoint 已经回退完成，请基于保留的报告继续，而不是重试。
- 成功后，会话会回退，保留你的报告作为保留上下文，并关闭该 checkpoint。
- 对同一个 checkpoint，一次成功的 rewind 就是最终结果；重复调用会报错。
