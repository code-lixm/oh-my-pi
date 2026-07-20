`hub` 管理会话中的协作对象：代理通信、后台任务和长期运行进程。主代理 ID 为 `Main`；子代理沿用其 task ID。

# 代理通信

- `list`：查看当前可联系的代理及其任务。按列表中的精确 ID 寻址，NEVER 编造名称。
- `send`（带 `to`）：发送后立即返回，不等待回复。需要答复？设置 `await: true`；否则继续当前工作。
- 回复消息时直接回答，设置 `replyTo`，NEVER 引用原消息。
- 消息只使用纯文本。大段内容通过 `local://` 或 `artifact://` 分享。
- `inbox`：立即取出当前排队消息，不等待新消息。
- 任务或文件可能重叠？先向相关代理确认分工。
- NEVER 使用 shell、grep 或其他会话文件猜测代理状态；用 `list` 或直接询问。

# 后台任务

后台任务完成后会自动交付结果，NEVER 轮询。

- `jobs`：立即查看后台任务快照。
- `wait`：仅在完全阻塞且没有其他工作时使用；收到消息、任务完成、等待超时或新指令到达时立即返回，并不等待全部任务完成。
- 裸 `wait` 同时关注所有运行中任务和传入消息。`ids` 只用于缩小任务范围，`from` 只用于等待某个代理。
- `cancel`：终止卡住、停滞或不再需要的任务。
- NEVER 用 `hub` 代替代码搜索、构建或测试等已有工具能力。

# 进程

同一目录中的每个 omp 实例共享项目级长期运行进程。长期服务、watcher、调试器、REPL，或稍后还要继续输入的进程 MUST 使用 `op:"start"`，不要用 `bash`。

- **`start`** 直接启动 `application` + `args`。`cwd` 默认为当前会话目录；`pty` 默认为 true。
  - `ready.log` 是正则；`ready.port` 是 TCP 端口。两者都提供了？两者都 MUST 通过。`ready.timeout` 单位为秒。MUST 观察就绪状态；仅创建进程不等于就绪。
  - 名称在每个项目目录内唯一。已结束的名称 MAY 再次启动；仍在运行的名称 MUST 先停止或重启。
  - `restart` 策略默认 `no`；`on-failure` 与 `always` 使用有界退避。
  - `persist: true` 可避免最后一个 omp 退出时被清理；`detached: true` 可在 broker 关闭和所有 omp 退出后继续存活（隐含 persist，并禁用 PTY 输入）。除非确实需要这些存活保证，否则不要设置。
- **`ps`**、**`logs`**、**`wait`**（带 `name`）、**`send`**（带 `name`）、**`stop`**、**`restart`**、**`describe`** 都通过稳定的 `name` 定位。
- **`logs`** 默认读取最后 100 行。`head: true` 读取开头。`grep` 是正则。`follow: true` 会等待 `cursor` 之后的新输出；下次调用复用返回的 cursor。
- **`wait`**（带 `name`）会阻塞到 ready / exit / `pattern` / `timeout`（秒）之一发生。
- **`send`**（带 `name`）：`text` 写入 stdin（`enter` 默认为 true）；`keys` 支持 ENTER、TAB、ESCAPE、CTRL_C、CTRL_D、UP、DOWN、LEFT、RIGHT；`signal` 支持 SIGINT、SIGTERM、SIGHUP、SIGQUIT、SIGKILL。PTY 输入会串行化；写入共享同一输入流。
- **`stop`** 会先优雅终止整个进程树，再强杀。NEVER 通过 bash 杀死未经验证的 PID。**`restart`** 会复用保留的启动规格。
