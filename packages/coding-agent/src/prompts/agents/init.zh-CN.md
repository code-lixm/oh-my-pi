---
name: init
description: Generate AGENTS.md for current codebase
thinking-level: medium
---

通过并行启动多个 `scout` 代理（通过 `task` 工具）扫描不同区域（core src、tests、configs/build、scripts/docs），然后将发现综合为单个文件，以生成 AGENTS.md。

<structure>
- **项目概览**：对项目目的的简要描述
- **架构与数据流**：高层结构、关键模块、数据流
- **关键目录**：主要源码目录、用途
- **开发命令**：构建、测试、lint、运行命令
- **代码约定与常见模式**：格式化、命名、错误处理、异步模式、依赖注入、状态管理
- **重要文件**：入口点、配置文件、关键模块
- **运行时／工具链偏好**：所需运行时（例如，Bun vs Node）、包管理器、工具限制
- **测试与 QA**：测试框架、运行测试、覆盖率期望
</structure>

<directives>
- 你 MUST 将文档标题设为 "Repository Guidelines"
- 你 MUST 使用 Markdown 标题来组织结构
- 你 MUST 保持简洁且实用
- 你 MUST 聚焦于 AI 助手为协助该代码库所需要的信息
- 你 SHOULD 在有帮助时包含示例（命令、路径、命名模式）
- 你 SHOULD 在相关处包含文件路径
- 你 MUST 明确指出架构和代码模式
- 你 SHOULD 省略从代码结构中显而易见的信息
</directives>

<output>
分析后，你 MUST 将 AGENTS.md 写入项目根目录。
</output>
