<system-notice>
上面的用户消息包含 **workflowz** 关键词：将此任务作为一个确定性的多子代理工作流来执行。使用 `task` 工具 {{#if taskBatch}}进行批量扇出{{else}}对每个独立子代理调用一次{{/if}}——以求全面（分解任务并并行覆盖），以增强把握（在你提交前提供独立视角和对抗性检查），或处理单一上下文无法容纳的规模（审计、迁移、大范围扫描）。这优先于任何默认的内联完成整个任务的倾向，因为在这种情况下扇出会更为周全。

<when>
当任务能从拆解加并行覆盖中受益，或在你提交之前需要独立／对抗性交叉检查时，这样做是值得的。对于快速查找或单次编辑，直接处理即可——不要启动 agents。先内联侦察（列出文件、界定 diff 范围、找到调用点）以发现工作清单，然后再对其展开并行处理。常见形态：
- **理解** — 对各子系统进行并行阅读 → 结构化地图。
- **设计** — 独立方案 → 评分综合。
- **审查** — 拆分维度 → 按维度发现问题 → 对每个发现进行对抗性验证。
- **研究** — 多模态扫描 → 深读命中结果 → 综合。
- **迁移** — 发现位置 → 逐一转换 → 验证。
</when>

<task-contract>
{{#if taskBatch}}
每个独立的并行展开批次调用一次 `task`。将共享背景放在 `context` 中，将每个独立工作项放在 `tasks[]` 中。不要用 shell 循环或 eval 辅助 API 来模拟批处理。

`context` 必须承载共享契约：

    # 目标
    该批次要完成的内容。
    # 约束
    规则、非目标、权限和验证限制。
    # 契约
    共享接口、输出形式、分支／基线假设，以及协作规则。

每个任务分配都必须是自包含的：

    # 目标对象
    精确的文件、符号、子系统或证据表面；明确的非目标。
    # 变更
    要检查或修改的内容，按步骤说明，包括要复用的 API 和模式。
    # 验收
    可观察的结果、返回包以及本地验证。子代理跳过格式化器，
    linter 和项目范围测试；父级统一运行共享证明一次。
{{else}}
每个独立的子代理调用一次 `task`。将完整的共享背景和叶子工作放入该调用的 `assignment` 中。不要传递 `context` 或 `tasks[]`：当批量调用被禁用时，扁平任务模式会拒绝它们。

每项分配必须是自包含的：

    # 目标
    精确的文件、符号、子系统或证据范围；明确的非目标。
    # 变更
    共享背景以及要检查或修改的内容，按步骤说明，包括要复用的 API 和模式。
    # 验收
    可观察的结果、返回包以及本地验证。子代理跳过格式化器，
    linter 和项目范围测试；父级统一运行共享证明一次。
{{/if}}

<structure>
先分解，然后{{#if taskBatch}}将相互独立的叶子节点批量处理{{else}}在同一轮中为每个叶子节点发起一次独立的任务调用{{/if}}：

{{#if taskBatch}}
    task(
      context: "# Goal\n审查 auth diff……\n# Constraints\n只读……\n# Contract\n以 severity/file/line/fix 的形式返回发现……",
      tasks: [
        { id: "AuthOwner", role: "Auth Storage Reviewer", assignment: "# Target\npackages/ai/src/auth-storage.ts\n# Change\n追踪凭证选择……\n# Acceptance\n仅返回已确认的发现……" },
        { id: "PromptOwner", role: "Prompt Contract Reviewer", assignment: "# Target\npackages/coding-agent/src/prompts/**\n# Change\n检查 active-tool 指导……\n# Acceptance\n返回不匹配项和确切的 prompt 行……" },
      ]
    )
{{else}}
    task(
      role: "Auth Storage Reviewer",
      assignment: "# Target\npackages/ai/src/auth-storage.ts\n# Change\n审查 auth 差异。共享契约：只读；以 severity/file/line/fix 的格式返回问题。\n# Acceptance\n仅返回已确认的问题……"
    )
    task(
      role: "Prompt Contract Reviewer",
      assignment: "# Target\npackages/coding-agent/src/prompts/**\n# Change\n检查 active-tool 指南。共享契约：只读；返回不匹配项和确切的 prompt 行。\n# Acceptance\n仅返回已确认的问题……"
    )
{{/if}}

{{#if taskBatch}}当各工作项不共享文件时，优先一次发起一个大批次，而不是串行调用子代理。如果任务有重叠，请明确指出重叠部分，并让代理在编辑前通过 IRC 协调。{{else}}当各工作项不共享文件时，优先在一次 assistant 回合中发出所有相互独立的任务调用，而不是进行串行分派。如果任务有重叠，请明确指出重叠部分，并让代理在编辑前通过 IRC 协调。{{/if}}
</structure>

<patterns>
- **Adversarial verify** — 派遣目标各不相同的怀疑型审查者，然后只保留父级能够根据源码验证的问题。
- **Perspective-diverse review** — 使用分别负责正确性、安全性、性能和可维护性的不同角色，而不是使用相同的审查者。
- **Completeness critic** — 在第一批之后，派遣一名只读的审查者，询问遗漏了哪种模态、文件、主张或证明。
- **No silent caps** — 如果你限制了覆盖范围（top-N、无重试、采样），在行动之前说明省略了什么以及为什么省略。
- **Parent owns closure** — 子代理返回证据；父级读取证据，解决矛盾，运行证明，并作出最终决定。
</patterns>

<execution>
- 在可用时，在可见的待办系统中记录多阶段工作流状态。
{{#if taskBatch}}- 在一次 `task` 调用中批量处理相互独立的子代理。{{else}}- 在同一轮中将相互独立的子代理作为单独的 `task` 调用分派。{{/if}}
- 给每个子代理一个狭窄的目标、明确的非目标，以及一个具体的返回包。
- 在扇出返回之后，读取产物，修补或作出决定，并运行共享门禁。
- 持续进行直到任务关闭——返回的扇出是一个步骤，而不是停止点。
</execution>
</system-notice>
