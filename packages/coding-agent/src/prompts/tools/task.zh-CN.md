{{#if asyncEnabled}}{{#if batchEnabled}}通过在单次 `tasks[]` 批次中传入多个条目，将工作委派给后台子代理。{{else}}每次调用仅委派 ONE 个后台子代理。{{/if}}
执行不会阻塞你的当前轮次：你会立即收到代理和任务 ID，最终结果会在子代理完成后自动送达。{{#if hasBlockingAgents}}
例外：下方标记为 BLOCKING 的代理会内联运行——它们的结果会在本次调用中返回，而同一批次中的非阻塞条目仍会作为后台任务生成。{{/if}}{{else}}{{#if batchEnabled}}通过 `tasks[]` 批次同步运行子代理。{{else}}每次调用同步运行 ONE 个子代理。{{/if}}
执行会阻塞你的当前轮次：只有在工作完全完成后，本次调用才会返回。{{/if}}

# 任务设计
- **代理选型：** 先为每个条目选择 `agent` 类型。只读研究 MUST 使用 `agent: "scout"`，它运行在更快的模型上。只有当下列列表中没有合适的专门代理时，才使用默认代理。
- **避免额外开销：** 每个 `task` 都 MUST 指示其代理跳过格式化工具、代码检查工具和项目级测试套件。这些你会在最后统一运行。
- **单次完成代理：** 优先使用能够在一次流程中同时调查并编辑的代理；只有在确实不知道受影响文件时，才额外启动只读发现步骤（例如 `agent: "scout"`）。

# 输入
{{#if batchEnabled}}
- `context`：共享的项目状态、约束与契约。它作用于整个批次；不要把这些背景重复写进各个任务。
- `tasks[]`：要生成的子代理数组。
  - `name`：稳定的 CamelCase 标识符（≤32 个字符），用于在 `hub` 中寻址该代理；如省略则自动生成。
  - `agent`：运行该条目的代理类型（例如 `scout`、`reviewer`）。如省略，则会使用通用代理（`{{defaultAgent}}`）—— NEVER 显式传入这个名称。只有在检查过下方代理列表且确实没有合适专长时，才可以省略。{{#if allowedAgentsText}} 当前生成策略允许：{{allowedAgentsText}}。{{/if}}
  - `task`：完整、自包含的指令。单行任务或缺少验收标准都是 PROHIBITED。
{{#if isolationEnabled}}
  - `isolated`：在独立工作树中运行并返回补丁。隔离代理在完成后会被销毁，之后无法再寻址。
{{/if}}
{{else}}
- `name`：稳定的 CamelCase 标识符（≤32 个字符），用于在 `hub` 中寻址该代理；如省略则自动生成。
- `agent`：要生成的代理类型（例如 `scout`、`reviewer`）。如省略，则会使用通用代理（`{{defaultAgent}}`）—— NEVER 显式传入这个名称。只有在检查过下方代理列表且确实没有合适专长时，才可以省略。{{#if allowedAgentsText}} 当前生成策略允许：{{allowedAgentsText}}。{{/if}}
- `task`：完整、自包含的指令。单行任务或缺少验收标准都是 PROHIBITED。
{{#if isolationEnabled}}
- `isolated`：在独立工作树中运行并返回补丁。隔离代理在完成后会被销毁，之后无法再寻址。
{{/if}}
{{/if}}

# 子代理协作

子代理启动时没有当前对话历史。主代理负责提供上下文、补充要求和验收结果；子代理只处理分配给自己的任务。
{{#if ircEnabled}}- 主代理可通过 `hub send` 补充要求；消息会立即送达子代理。
- 子代理因缺少信息而无法继续时，可通过 `hub send` 询问主代理。
- 任务或文件可能重叠时，相关子代理 MUST 先确认分工。{{/if}}
{{#if batchEnabled}}- 大段内容通过 `local://<path>` 分享，NEVER 直接粘贴到消息中。{{else}}- 将共享项目状态只写一次到 `local://` 文件（例如 `local://ctx.md`），再由各任务引用。{{/if}}
- 子代理完成后结果会自动返回；NEVER 轮询等待。

# 格式契约
{{#if batchEnabled}}
`context` 字段 MUST 遵循以下格式：
# Goal         ← 该批次要完成什么
# Constraints  ← 规则与会话决策
# Contract     ← 共享接口
{{/if}}

`task` 字段 MUST 遵循以下格式：
# Target       ← 精确文件与符号；明确非目标
# Change       ← 分步说明 add/remove/rename；API 与模式
# Acceptance   ← 可观察结果；不要运行项目级命令

# 可用代理
{{#if spawningDisabled}}
当前已禁用生成代理。
{{else}}
为每个任务选择最具体的代理。只有当下方没有合适专长时，才使用默认代理。
{{#list agents join="\n"}}
### {{name}}{{#if readOnly}} （READ-ONLY：无 edit/write/command 工具）{{/if}}{{#if blocking}} （BLOCKING：内联运行；结果会在本次调用中返回）{{/if}}
{{description}}
{{#if readOnly}}仅可用于调查与汇报；编辑请由你自己完成，或交给可写代理。{{/if}}
{{/list}}
{{/if}}
