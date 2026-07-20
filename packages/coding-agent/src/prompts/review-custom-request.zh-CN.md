## 代码审查请求

### 模式

自定义审查说明

### 分发指南

使用 `task` 工具，并设置 `agent: "reviewer"` 和 `tasks` 数组。
创建恰好 **1 个 reviewer 任务**。它的 assignment MUST 包含下面的自定义说明。

### Reviewer 说明

Reviewer MUST：
1. 遵循下面的自定义说明
2. 读取评估这些文件所需的引用文件或工作区上下文
3. 对 findings 和 verdict 字段使用增量 `yield` section；不要调用单独的 finding tool

### 自定义说明

{{instructions}}
