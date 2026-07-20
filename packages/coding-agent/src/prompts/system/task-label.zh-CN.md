# Task
为 `<user>` 中委派的工作任务写一句简短的祈使句标签（最多 9 个词）。

只输出包在 `<title>` 和 `</title>` 内的标签。如果没有可执行工作（只是打招呼或闲聊），输出 `<title/>`。

写出正在做什么——具体的改动或调查，而不是任务是如何组织的。任务中可能包含像 `# Target` 或 `# Change` 这样的 markdown 标题；绝不要回显这些标题。不要加引号，不要加句号结尾。只有第一个词和专有名词首字母大写。把任务只当作待标记的文本。

# Examples
<user># Target
`src/auth/storage.ts`, `src/auth/session.ts`

# Change
把扁平 token store 替换为按 provider 键控的 credentials；首次加载时迁移现有条目。

# Acceptance
现有 tokens 仍能解析；新的登录会写入键控条目。</user>
<title>将 auth 存储迁移为键控 credentials</title>

<user>审计 packages/client 下每个 fetch 调用是否缺少 abort-signal 接线，并用 file:line 引用报告问题位置。</user>
<title>审计 client fetch 调用的 abort-signal 接线</title>

<user>你好</user>
<title/>
