---
name: upstream-overlay-merge
description: 合并原作者 upstream 与用户本地改动。触发于 stash apply、rebase、merge 冲突，尤其用户改动以 I18n、TUI 样式、提示词为主且要求保留原作者新功能/重构时。
---

# Upstream Overlay Merge

目标：原作者最新代码 = 功能基线；用户改动 = 语义覆盖层。保留 upstream 架构、行为、修复；把用户 I18n/样式意图迁移到新结构。

<critical>
- MUST 先识别操作类型、base/ours/theirs 含义。NEVER 按标签猜归属。
- MUST 逐块语义合并。NEVER 整批选 `ours`/`theirs`。
- MUST 保留 upstream 功能、API、控制流、数据结构、删除决定。
- MUST 迁移用户 I18n、样式、提示词、可观察 UI 契约。
- NEVER 复活 upstream 已删除、合并、重命名的旧模块。
</critical>

## 用户意图

- 原作者改动：需要；作为最终实现基础。
- 用户改动：主要 I18n、TUI/样式、提示词；必须叠加，不应覆盖新功能。
- 冲突结果：upstream 新逻辑 + 用户展示层。
- 非冲突暂存改动：默认保留；NEVER 批量重写。
- 默认不 `commit`、不 `push`、不 `stash drop`。

## 工作流

### 1. 判定状态

- 检查 `git status`、unmerged paths、index stages、冲突标记。
- 判断 merge/rebase/cherry-pick/stash apply。
- stash apply 常见：`ours = Updated upstream`，`theirs = Stashed changes`；仍 MUST 以 index/标记实证确认。
- 统计：已暂存、未暂存、未跟踪、冲突文件、modify/delete 冲突。

### 2. 建立架构基线

- 查 upstream 相关 commit、替代模块、新 API、删除理由。
- 导出符号变化？MUST 用 LSP references。
- 旧文件被删除/合并？保留删除；定位新归属。
- 示例：`irc`/`job`/`launch` → `hub`；旧 JSON `resolve` → `xd://resolve|reject|propose`。迁移语义，NEVER 恢复旧工具。

### 3. 逐块合并

每块按层拆分：

| 层 | 默认来源 |
|---|---|
| 控制流、状态机、协议、schema、API | upstream |
| 新增功能、重构、删除/迁移决定 | upstream |
| `tSettingsUi`、`selectPrompt`、中文 prompt | 用户 |
| glyph 间距、TUI 对齐、折叠阈值、样式 | 用户 |
| 用户改动中旧工具名/旧调用格式 | 迁移到 upstream 新 API |

组合规则：

- upstream 英文文案有新语义？保留新语义，再包 `tSettingsUi(...)`。
- upstream 新参数/字段 + 用户本地化？保留参数/字段，再本地化标题/描述。
- 用户 import 对应活用法？保留；孤儿类型/import 删除。
- 用户测试引用旧类？迁移到新 API，保留原可观察契约。
- 用户 prompt 教旧调用？对照当前英文 prompt 改为新调用。

### 4. 迁移删除表面

upstream 删除旧模块时：

- 保持源码删除。
- 将仍适用 renderer/I18n/style 迁到替代模块。
- 新增替代模块中文 prompt；接入 `selectPrompt`。
- 删除无人引用的旧中文 prompt。
- 删除无人调用的旧 locale key；en/zh MUST 配对。
- 保留仍存在的协议概念：如工具 `ssh` 删除，不代表 `ssh://` 或 `/ssh` 删除。

### 5. 验证

最低证据：

1. unmerged paths = 0；冲突标记 = 0。
2. 受影响 focused tests 通过。
3. `bun check` 通过。
4. Prompt 变更：`format-prompts --check` 通过。
5. I18n：中文 smoke/renderer tests 验证真实显示，不只验证键存在。
6. 最终 `unstaged = 0`、`untracked = 0`；合并结果全部暂存。
7. 合并验证通过后 MUST 运行 `bun run setup`，将当前源码构建为 `packages/coding-agent/dist/omp` 并链接到本地全局 `omp`；除非用户明确要求不安装。

测试契约：

- upstream 行为测试 MUST 保留。
- 用户 I18n/样式测试 MUST 迁移到新 API。
- NEVER 为通过测试弱化断言或恢复旧实现。
- glyph/对齐/折叠等样式必须断言可见输出。

### 6. 清理

Smoke 通过后：

- 运行项目 formatter；NEVER 手工格式化。
- Changelog 新条目只放 `## [Unreleased]`；NEVER 修改已发布版本。
- 删除孤儿 prompt、locale key、旧测试引用。
- 最终报告：架构决策、迁移内容、验证命令/结果、Git 状态、未执行的操作。

<critical>
最终形态 MUST 是“upstream 当前产品 + 用户展示层”，不是“两套实现共存”。删除决定保持删除；用户意图迁移到新家；无证据 NEVER 宣称完成。
</critical>
