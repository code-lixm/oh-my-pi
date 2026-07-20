驱动真实的 Chromium 标签页；可通过 JS 完整访问浏览器自动化功能。

<instruction>
- 静态内容（文章、文档、issues/PRs、JSON、PDFs、订阅源）？`read` 该 URL。浏览器仅用于 JS 执行、认证、交互操作。
- 三个操作：
  - `open` — acquire/reuse 已命名的标签页（`name` 默认为 `"main"`）。可选 `url`（就绪后再导航）、`viewport`、`dialogs: "accept" | "dismiss"`（自动处理 `alert`/`confirm`/`beforeunload`；否则页面会挂起，直到你接好 `page.on('dialog', …)`）。
  - `close` — 按 `name` 释放标签页，或用 `all: true` 释放全部。`kill: true` 还会终止已启动应用的进程树。
  - `run` — 在现有标签页中执行 JS。`code` = 异步函数体；`page`、`browser`、`tab`、`display`、`assert`、`wait` 在作用域中。返回值会经 JSON 字符串化后写入结果；`display(value)` 会累积 text/images.
- 标签页会跨 `run` 调用和进程内子代理保留——打开一次，重复使用。
- 浏览器类型（`app` 于 `open`）：
  - 默认（无 `app`）→ 带伪装补丁的无头 Chromium。
  - `app.path` → 启动绝对路径二进制文件（Electron/CDP）。没有伪装补丁——NEVER 对真实桌面应用动手脚。
  - `app.cdp_url` → 连接到现有的 CDP 端点（例如 `http://127.0.0.1:9222`）。
  - `app.target`（配合 `path`/`cdp_url`）— 按 URL+标题 的子串匹配选取 BrowserWindow。
- `tab` 辅助项；凡未覆盖之处，可下探到原始浏览器自动化 `page`：
  - `tab.goto(url, { waitUntil? })` — 导航。
  - `tab.observe({ includeAll?, viewportOnly? })` — 无障碍快照：`{ url, title, viewport, scroll, elements: [{ id, role, name, value, states, … }] }`。标识符在下一次 observe/goto. 前保持稳定
  - `tab.ariaSnapshot(selector?, { depth?, boxes? })` — Playwright 格式的 ARIA 树 YAML（嵌套角色 + 可访问名称 + `/url`/`/placeholder`），范围限定为 `selector` 或整个文档。每个节点都带有 `[ref=eN]` 标识符；`[cursor=pointer]` 标记可点击项。它会捕获稠密、分层的 structure/text，这是 `observe()` 的平面列表会抹平掉的。引用每次调用都会从 e1 重新编号，并在下一次 `ariaSnapshot()` 前保持有效。
  - `tab.ref("e5")` — 上一次无障碍快照中的 `[ref=eN]` → 具有常见操作方法的元素句柄（`.click()`、`.type()`、`.fill()`、`.hover()`、`.evaluate()`，……）；这是对引用执行操作的主要方式。为方便起见，`aria-ref=e5` 也可直接内联用于 `tab.click`/`type`/`fill`/`waitFor`/`scrollIntoView`（例如 `tab.click("aria-ref=e5")`）。
  - `tab.id(n)` — 上一次观察中的标识符 → 具有相同操作方法的元素句柄（`.click()`、`.type()`、`.fill()`，……）。
  - `tab.click(selector)` / `tab.type(selector, text)` / `tab.fill(selector, value)` / `tab.press(key, { selector? })` / `tab.scroll(dx, dy)`.
  - `tab.waitFor(selector, { timeout? })` / `tab.waitForSelector(selector, { timeout?, visible?, hidden? })` — 等待直到附着（可选用 visible/hidden）；返回一个操作方法句柄。
  - `tab.drag(from, to)` — 端点可以是选择器（中心到中心），或 `{ x, y }` 视口点（画布、滑块）。
  - `tab.scrollIntoView(selector)` — 在视口中居中；用于点击屏外元素之前。
  - `tab.select(selector, …values)` — 设置 `<select>` 选项；返回所选项。`tab.fill` NEVER 也适用于下拉选择框。
  - `tab.uploadFile(selector, …filePaths)` — 将文件附加到 `<input type="file">`；路径相对于当前工作目录。
  - `tab.waitForUrl(pattern, { timeout? })` — 子串或 `RegExp`（匹配 SPA 的历史状态导航）；返回匹配到的 URL。
  - `tab.waitForResponse(pattern, { timeout? })` — 子串、`RegExp` 或 `(response) => boolean`；返回浏览器自动化库 `HTTPResponse`（`.text()`/`.json()`/`.status()`/`.headers()`）。
  - `tab.waitForNavigation({ waitUntil?, timeout? })` — 会在下一次导航时完成。要在触发它的 click/submit 之前启动；在 `tab.goto` 之后（其本身已等待）改用 `tab.waitForUrl`/`tab.waitForSelector`。
  - `tab.evaluate(fn, …args)` — 用于临时 DOM 读取的 `page.evaluate`。
  - `tab.screenshot({ selector?, fullPage?, save?, silent? })` — 捕获并附加以供查看（`silent: true` 会跳过）。仅当后续步骤需要该文件时才传入 `save`。
  - `tab.extract(format = "markdown")` — 可读的页面内容（`"markdown"` | `"text"`）；没有可读内容时会抛错。
- 选择器：CSS + 该自动化库处理器 `aria/Sign in`、`text/Continue`、`xpath/…`、`pierce/…`；以及 Playwright 风格的 `p-aria/…`、`p-text/…`。仅限 Playwright 的 engines/pseudos（`:has-text()`、`:visible`、……）会被拒绝 — 改用 `text/…` 或 `aria/…`。卡住的 action/wait 会快速失败，并给出带名称的 `tab.<op>` 错误，其中包含匹配数量诊断，而不会等到整个单元超时；未匹配到任何内容的选择器会在约 2 秒内失败（向 `waitFor`/`waitForSelector` 传入显式 `{ timeout }`，即可等待缓慢出现的元素）。
</instruction>

<critical>
- MUST `open` 在 `run` 之前——`run` 绝不会创建标签页。
- 页面状态默认使用 `tab.observe()` —— 结构化数据、可操作的 id。仅当外观重要时才使用截图。
- 导航会使元素 id 失效——使用前重新观察。
- `code` 运行时拥有完整的 Node 访问权限。将其视为你的代码，而非沙箱环境。
</critical>

<output>
每次调用：先是 `display(value)` 输出，然后是 `code` 的返回值。`run` 总会至少产生一行状态信息。
</output>
