调试器访问。

<instruction>
- 当涉及程序状态、断点、单步执行、线程检查或中断正在运行的进程时，你 SHOULD 优先使用这个而不是 bash。
- `action: "launch"` 启动一个会话；`program` 必需，`adapter` 可选。Python：`program` = 目标 `.py`，解释器/脚本标志在 `args` 中。Go：`program` = 包目录、`.go` 文件，或已编译的二进制文件。
- `action: "attach"` 连接到正在运行的进程：`pid`（本地），`port`（远程），`adapter` 强制使用特定调试器。
- **断点**：`set_breakpoint`/`remove_breakpoint`，可带源码（`file`+`line`）或函数（`function`）；`condition` 可选。
- **流程控制**：`continue`（继续），`step_over`/`step_in`/`step_out`（单步），`pause`（中断正在运行的程序）。
- **检查**：`threads`，`stack_trace`（当前停止的线程），`scopes`（需要 `frame_id` 或当前停止的栈帧），`variables`（需要 `variable_ref` 或 `scope_id`），`evaluate`（需要 `expression`；`context: "repl"` 用于原始调试器命令），`output`（stdout/stderr/console），`sessions`，`terminate`。
</instruction>

<caution>
- 一次只能有一个活动的调试会话。
- `adapter` 是一个已配置的 id：`gdb`、`lldb-dap`、`debugpy`、`dlv`、`rdbg`，或任何 `dap.json` 条目；其命令必须已安装。
- `program` 是目标路径，不是 shell 命令。目录需要支持目录的适配器，例如 `dlv`。
- Python 需要 `debugpy`（`pip install debugpy`）；Go 需要 Delve（`go install github.com/go-delve/delve/cmd/dlv@latest`）；Ruby 需要 `rdbg`（`gem install debug`）。
</caution>
