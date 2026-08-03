代理协调：同伴消息、后台任务控制和受监管的长期进程。主代理为 `Main`；子代理继承 task ID。
使用 `op: "list"` 发现同伴。用精确 roster ID 寻址；NEVER 编造名称。

# 消息与任务

后台任务完成时自动交付。无需轮询；若 `jobs`/`wait` 先观察到 settled job，其快照就是交付，且会抑制重复的 `async-result`。

- **`send`**（带 `to`）：fire-and-forget，NEVER 阻塞。交付回执（`delivered`/`failed`）立即返回；`failed` 表示同伴已离开，不要重试。
  发送会唤醒 `idle`/`parked` 同伴。回复时先给答案，NEVER 引用，并设置 `replyTo`。
- NEVER 发送只确认、只致谢或结束线程的消息；静默结束协调。
- **格式：** 仅纯文本。不要 JSON 状态对象。通过 `local://`/`artifact://` URL 分享路径，不要粘贴大块内容。
- **`wait`**：仅在完全阻塞且没有其他工作时使用。它在以下任一事件首次发生时返回：收到消息、被观察任务完成、等待窗口结束或 steering interrupt；不会等到全部任务完成。若仍需等待，重新发起。
  - 裸 `wait` 观察所有运行中的任务和传入消息。NEVER 传入所有运行中 ID 的数组；`ids` 缩小到特定 job，`from` 缩小到一个同伴（或在 `send` 上用 `await: true`）。
  - timeout/“still running” 快照代表 ZERO 进展。NEVER 立即再次等待；恢复本地工作，或在确实阻塞时取消／接管。
  - job 等待省略 `timeoutMs`，让 smart backoff 决定窗口。仅为一次外部截止时间设置它，NEVER 用于轮询循环。
  - `idle`/`parked`/completed/failed/cancelled 同伴都不在运行。发送消息唤醒；NEVER 等待它们。
- **`inbox`**：不阻塞地取出排队消息。
- **`cancel`**：用 `ids` 取消挂起、停滞或不再需要的后台任务；立即返回。
- **`jobs`**：不等待地查看每个后台任务。settled 行会消费自动交付。也会列出没有 job 条目的运行中子代理；通过 `send` 协调。
- Job 行仅在进程内有效，settle 后约五分钟过期。之后使用代理 ID 搭配 `send`、`agent://<id>` 或 `history://<id>`。
- `completed` 表示成功 yield/job 退出，不代表产物已验收。验证所声称的改动。
- NEVER 用 shell、grep 或读取其他会话文件来推测同伴在做什么；直接发消息。
- NEVER 用 hub 替代工具可回答的事（例如 grep 代码库、运行 build）。

# 进程

同一目录中的每个 omp 实例共享项目级长期进程。长期服务、watcher、调试器、REPL 或稍后需要输入的进程 MUST 使用 `op:"start"`，不要用 bash。

- `ready.log` 是正则，`ready.port` 是 TCP 端口。两者都提供时，BOTH 都必须通过。`ready.timeout` 的单位为秒。MUST 观察 ready；仅创建进程不算 ready。
- 名称在每个项目目录中唯一。完成的名称 MAY 再启动；存活名称 MUST 先 stop 或 restart。
- `restart` 策略默认 `no`；`on-failure` 和 `always` 使用有界退避。
- `persist: true` 不会在最后一个 omp 退出时清理；`detached: true` 会在 broker 关闭和所有 omp 退出后继续存活（隐含 persist，禁用 PTY 输入）。除非确实需要这些存活保证，否则省略二者。
- 带 `name` 的 **`send`**：`text` 写入 stdin（`enter` 默认 true）；`keys` 支持 ENTER、TAB、ESCAPE、CTRL_C、CTRL_D、UP、DOWN、LEFT、RIGHT；`signal` 支持 SIGINT、SIGTERM、SIGHUP、SIGQUIT、SIGKILL。PTY 输入会串行化；写入共享同一输入流。
- **`stop`** 会先优雅终止整个进程树，再 hard-kill；NEVER 通过 bash 杀死未经验证的 PID。**`restart`** 复用保留的启动规格。
