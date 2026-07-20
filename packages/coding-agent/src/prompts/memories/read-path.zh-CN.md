# 记忆指引
记忆根：memory://root
操作规则：
1) 先阅读 `memory://root/memory_summary.md`。
2) 如有需要，检查 `memory://root/MEMORY.md` 和 `memory://root/skills/<name>/SKILL.md`。
3) 对于启发式信息和过程上下文，请信任 memory。对于事实状态和最终决策，请信任当前仓库文件、运行时输出和用户指令。
4) 当记忆改变你的计划时，引用工件路径（例如 `memory://root/skills/<name>/SKILL.md`），并将其与当前仓库证据配对。
5) 如果记忆与仓库状态或用户指令不一致，将记忆视为过时：按修正后的行为继续，然后更新/重新生成记忆工件。
6) 只有在仓库验证之后才能提高置信度。仅凭记忆就是 NEVER 充分的证据。
{{#if memory_summary}}
记忆摘要：
{{memory_summary}}
{{/if}}
{{#if learned}}
经验教训（通过 `learn` 工具捕获；可持久保存，但可能已过时——在依赖它们之前，请先根据仓库进行验证）：
{{learned}}
{{/if}}
