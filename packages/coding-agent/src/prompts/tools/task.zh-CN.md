{{#if asyncEnabled}}{{#if batchEnabled}}通过在单个 `tasks[]` 批次中传入多个条目，将工作委派给后台子代理。
本调用不会阻塞；会立即收到 ID。{{else}}每次调用将工作委派给 ONE 个后台子代理。
本调用不会阻塞；会立即收到 ID。{{/if}}{{#if hasBlockingAgents}}
标记为 BLOCKING 的代理会内联运行；本调用返回其结果，同批次中的非阻塞条目仍作为后台任务生成。{{/if}}{{else}}{{#if batchEnabled}}通过 `tasks[]` 批次同步运行子代理。本调用会阻塞到全部完成。{{else}}每次调用同步运行 ONE 个子代理。本调用会阻塞到工作完成。{{/if}}{{/if}}
{{#if asyncEnabled}}

# 异步任务契约
- 结果会自动交付。`hub jobs`/`hub wait` 首先观察到 settled job 的快照就是交付；不会再出现重复的 `async-result`。
- 生成后继续父任务中独立的工作。NEVER 仅因任务存在而调用 `hub wait`。
- Job ID 仅在进程内有效，settle 后约五分钟过期。之后使用代理 ID 搭配 `hub send`、`agent://<id>` 或 `history://<id>`。
- `completed` 只表示 yield／job 成功退出，不代表产物已验收。验证声称的改动。
{{/if}}

# 任务设计
- **代理选型：** 为每个条目选择 `agent` 类型。{{#if scoutAvailable}} 只读研究 MUST 使用 `agent: "scout"`（更快的模型）。{{/if}}仅在没有专用代理适合时使用默认 worker。
- **避免额外开销：** 每个 `task` MUST 指示代理跳过 formatter、linter 和项目级测试套件；最后只运行一次。
- **单次完成：** 优先让代理在一次流程内调查并编辑；{{#if scoutAvailable}}仅在受影响文件确实未知时启动只读 scout。{{/if}}
- **协调重叠：** 共享文件编辑需要明确隔离或所有权协调。NEVER 仅因路径重叠而缩小真正独立的批次。两个前提：
  1. 每个任务 MUST 跳过验证（build/lint/tests）— 中途验证会阻塞代理。
  2. 预先决定跨任务契约（例如 A 实现、B 使用的接口），并写入{{#if batchEnabled}}批次 `context`{{else}}任务{{/if}}，不要留给代理临时协商。

# 输入
{{#if batchEnabled}}
- `context`：共享状态、约束与契约。它适用于整个批次；不要在单个任务中重复这些背景。
- `tasks[]`：要生成的子代理数组。
  - `name`：稳定的 CamelCase 标识符（≤32 个字符），用于通过 `hub` 寻址代理。省略时自动生成。
  - `agent`：运行此条目的代理类型（例如 {{#if scoutAvailable}}`scout`、{{/if}}`reviewer`）。省略时使用通用 worker（`{{defaultAgent}}`）— NEVER 显式传入该名称。仅在检查下方代理列表且没有专长匹配时才省略。{{#if allowedAgentsText}} 当前生成策略允许：{{allowedAgentsText}}。{{/if}}
  - `task`：完整、自包含的指令。单行或缺少验收标准都是 PROHIBITED。
{{#if effortEnabled}}  - `effort`：按任务复杂度选择：`"lo"`|`"med"`|`"hi"`。
{{/if}}
  - `outputSchema`：本次调用专用的 JSON Schema，覆盖选中代理和父会话的 schema。
  - `schemaMode`：`"permissive"`（默认）会在重试耗尽后的无效结果附带警告接受；`"strict"` 会失败。
{{#if isolationEnabled}}
{{#if applyIsolatedChanges}}
  - `isolated`：在专用工作树运行；成功改动会自动应用到父检出。
{{else}}
  - `isolated`：在专用工作树运行；改动保留为 patch 或 branch artifacts，不修改父检出。
{{/if}}
{{/if}}
{{else}}
- `name`：稳定的 CamelCase 标识符（≤32 个字符），用于通过 `hub` 寻址代理。省略时自动生成。
- `agent`：要生成的代理类型（例如 {{#if scoutAvailable}}`scout`、{{/if}}`reviewer`）。省略时使用通用 worker（`{{defaultAgent}}`）— NEVER 显式传入该名称。仅在检查下方代理列表且没有专长匹配时才省略。{{#if allowedAgentsText}} 当前生成策略允许：{{allowedAgentsText}}。{{/if}}
- `task`：完整、自包含的指令。单行或缺少验收标准都是 PROHIBITED。
{{#if effortEnabled}}- `effort`：按任务复杂度选择：`"lo"`|`"med"`|`"hi"`。
{{/if}}
- `outputSchema`：本次调用专用的 JSON Schema，覆盖选中代理和父会话的 schema。
- `schemaMode`：`"permissive"`（默认）会在重试耗尽后的无效结果附带警告接受；`"strict"` 会失败。
{{#if isolationEnabled}}
{{#if applyIsolatedChanges}}
- `isolated`：在专用工作树运行；成功改动会自动应用到父检出。
{{else}}
- `isolated`：在专用工作树运行；改动保留为 patch 或 branch artifacts，不修改父检出。
{{/if}}
{{/if}}
{{/if}}

# 通信
子代理从空白状态开始，没有会话历史。
大载荷通过 `local://<path>` URI 传递，NEVER 内联文本。

# 格式契约
{{#if batchEnabled}}
`context` 格式：
# Goal         ← 批次要完成什么
# Constraints  ← 规则与会话决策
# Contract     ← 共享接口
{{/if}}

`task` 格式：
# Target       ← 精确文件和符号；明确非目标
# Change       ← 逐步 add/remove/rename；API 和模式
# Acceptance   ← 可观察结果；不要运行项目级命令

# 可用代理
{{#if spawningDisabled}}
当前已禁用代理生成。
{{else}}
选择最具体的代理；仅在没有专用代理适合时使用默认 worker。
{{#list agents join="\n"}}
### {{name}}{{#if readOnly}}（READ-ONLY）{{/if}}{{#if blocking}}（BLOCKING：内联返回结果）{{/if}}
{{description}}
{{#if readOnly}}仅用于调查；自己编辑或交给可写代理。{{/if}}
{{/list}}
{{/if}}
