在嵌入式 shell 中运行命令——终端操作：git、bun、cargo、python。

# 何时使用 bash——以及何时不该使用

shell 会用简单参数调用**真实二进制程序**。它不是完整的 GNU Bash。

仅在以下情况使用 bash：单次二进制调用，或一个用于**计算**某个事实且不依赖 shell 特定 regex/quoting 的简短管道（`wc -l`、`sort | uniq -c`、`comm`、`diff`、校验和、`git status`）。

{{#if hasEval}}下面的任何内容 → `eval` 单元格，不是 bash:
- 当该语言存在 eval 运行时时，使用内联解释器脚本（`-e`/`-c`/`--eval`）
- Heredocs（`<<EOF`），`while`/`for`/`if`/`case` shell 控制流
- 嵌套在另一个命令内部的 `$(…)` 命令替换
- 超过两个阶段的管道，或需要控制流或 quote/JSON 转义的阶段
- 多行命令、混合控制流的 `&&` 链
- 与 shell 冲突的 quote/JSON 转义
{{else}}以下任何内容都意味着你是在编写 shell 程序，而不是调用 shell 程序。请优先改用专门构建的工具、已签入的脚本，或单个仓库命令：
- 内联解释器脚本（`-e`/`-c`/`--eval`）
- Heredocs（`<<EOF`），`while`/`for`/`if`/`case` shell 控制流
- 嵌套在另一个命令内部的 `$(…)` 命令替换
- 超过两个阶段的管道，或需要控制流或 quote/JSON 转义的阶段
- 多行命令、混合控制流的 `&&` 链
- 与 shell 冲突的 quote/JSON 转义
{{/if}}
{{#if hasGrep}}- 嵌入式 shell 中不保证支持 GNU grep BRE 扩展：请使用 `grep -E 'json|tool'` 表示交替，而不要使用 `grep 'json\|tool'`；使用内置的 `grep` 工具并配合 `pattern: "json|tool"`（Rust 正则，因此 `\bword\b` 在那里可用）{{#if hasEval}}，或使用 `eval` 进行精确文本处理{{/if}}。{{else}}- 嵌入式 shell 中不保证支持 GNU grep BRE 扩展：请使用 `grep -E 'json|tool'` 表示交替，而不要使用 `grep 'json\|tool'`{{#if hasEval}}，或使用 `eval` 进行精确文本处理{{/if}}。{{/if}}

<instruction>
- `cwd` 设置工作目录，而不是 `cd dir && …`
- 对于多行／大量引号／不可信的值使用 `env: { NAME: "…" }`；引用 `$NAME`
- 对展开内容（`"$NAME"`）加引号以保留精确内容
- 仅当命令需要真实终端时才使用 `pty: true`（`sudo`、`ssh` 需要输入）；默认使用 `false`
- 仅当即使较早的命令失败，后续命令也应运行时才使用 `;`
- 每条消息中的多个 bash 调用会并发运行。对于依赖顺序的命令，NEVER 将其拆分到并行调用中——请在一次调用中使用 `&&` 将其串联。
- 内部 URI（`skill://`、`agent://`、……）会自动解析为文件系统路径
{{#if hasEval}}- 需要精确的管道语义（`cmd | head`，多阶段过滤）或输出截断吗？优先使用 `eval` 并直接处理流。{{else}}- 需要精确的管道语义（`cmd | head`，多阶段过滤）或输出截断吗？使用已提交到版本库的脚本、专用工具或能控制输出形式的单条命令。{{/if}}
{{#if asyncEnabled}}
- 当你不需要立即输出时，对长时间运行的命令使用 `async: true`：会返回一个后台作业 ID；结果将作为后续消息返回。
{{/if}}
</instruction>

<critical>
{{#if hasEval}}- 内嵌 shell 会用简单参数调用真实二进制程序；它不是完整的 GNU Bash，也不是脚本编写环境。循环、条件语句、heredoc、存在 eval 运行时时的内联解释器脚本（`-e`/`-c`/`--eval`）、多个管道阶段、精确的管道语义，或引号/JSON 转义，都意味着你是在编写程序 → 请使用 `eval` 单元：可重启、有状态，并且没有 shell 引号陷阱。{{else}}- 内嵌 shell 会用简单参数调用真实二进制程序；它不是完整的 GNU Bash，也不是脚本编写环境。循环、条件语句、heredoc、内联解释器脚本、多个管道阶段、精确的管道语义，或引号/JSON 转义，都意味着你是在编写 shell 程序；请改用专门的工具或已检入的脚本。{{/if}}
{{#if hasGrep}}- NEVER调用 shell 搜索内容或文件：`grep/rg` → `grep`。{{else}}- 避免调用 shell 进行大范围内容搜索；在有可用工具时，请使用主动搜索/读取工具。{{/if}}
{{#if hasRead}}{{#if hasGlob}}- NEVER 使用 `ls` 或 `find` 来列出或定位文件——`ls` → `read`（目录路径会列出条目），`find` → `glob` 工具（glob 匹配）。这是不可协商的，即使只是一次快速列出也不例外。{{else}}- 对于已知文件和目录的读取，优先使用 `read`。仅在没有启用文件列出工具时才使用 shell 列出。{{/if}}{{else}}{{#if hasGlob}}- 优先使用 `glob` 进行文件发现；当 `glob` 处于活动状态时，避免使用 `find`。{{else}}- 如果没有启用文件读取/列出工具，请将 shell 检查范围保持在最小，并说明这一限制。{{/if}}{{/if}}
- 避免使用 head／tail／重定向：stderr 已经合并；长输出会被自动截断，完整捕获内容保存在 `artifact://<id>`。
</critical>

<output>
- 返回输出（stderr 已合并到 stdout）；退出码非零时会显示。
- 截断的输出 → `artifact://<id>`（在元数据中链接）。
</output>

{{#if asyncEnabled}}
# 超时与异步

- `timeout` 的单位为秒；非零值会被限制到 `1..3600`，并且在到时后终止进程。仅对必须运行到完成或显式取消的命令设置 `timeout: 0`。
- `async: true` 仅延迟报告——它不会延长非零超时；当守护进程或监视器必须由取消操作接管时，请使用 `timeout: 0`。
- 需要守护进程或运行超过 3600 秒？当 harness 应保持其存活直到取消时，请将 `async: true` 与 `timeout: 0` 一起使用，或者自行分离／管理生命周期（`cmd &`、supervisor、自重启脚本）。Shell 会话会在多次调用之间保持持续。
{{/if}}
{{#if autoBackgroundEnabled}}

## 自动转入后台

- 一个长时间运行的前台调用可能会转换为后台作业；最终结果会作为后续工具调用返回。这不是失败——不要重试，也不要同步等待。
- 需要内联获得结果（例如通过管道传给另一个命令）？将 `timeout` 提高到高于预期持续时间{{#if asyncEnabled}}，或一开始就设置 `async: true`{{/if}}。
{{/if}}

# 输出最小化器

- 长输出已被截断；测试/lint 运行器输出已过滤为仅显示失败项。当可见文本发生变化时，`[raw output: artifact://<id>]` 页脚会链接到完整捕获内容——如果某次运行看起来可疑，或你需要精确字节，请阅读它。
- 没有页脚 = 你所看到的内容与命令实际输出的内容完全一致。
