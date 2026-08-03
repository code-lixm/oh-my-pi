驱动真实 Chromium 标签页；可通过 JS 完整访问 puppeteer。

<instruction>
- 静态内容？用 `read` 读取 URL。浏览器仅用于 JS 执行、认证和交互操作。
- `open` → `run`：标签页跨调用和子代理存活，打开一次、重复使用。
- `run` 作用域：可用 `page`、`browser`、`tab`、`display`、`assert`、`wait`。`wait(fn)` 会轮询至真值；不要在 `tab.evaluate` 中自行轮询。

- `tab` helpers（未覆盖的场景可下探到原始 puppeteer `page`）：
  元素句柄：`tab.ref("e5")` / `tab.id(n)` 返回可直接调用的句柄 — `(await tab.id(n)).click()`。句柄不是选择器：`tab.click`/`type`/`fill`/`waitFor*` 只接受字符串选择器。快照引用可用于任何选择器位置：`tab.click("e5")` ≡ `tab.click("aria-ref=e5")`。
  简单操作：`tab.goto`、`tab.click`、`tab.type`、`tab.fill`、`tab.press`、`tab.scroll`、`tab.scrollIntoView`、`tab.drag`、`tab.uploadFile`、`tab.select`、`tab.screenshot`、`tab.extract`、`tab.evaluate`。
  截图：`tab.screenshot({ selector?, fullPage?, silent? })` 保存到 `browser.screenshotDir`，未设置时保存至 OS 临时目录，然后返回路径。它 NEVER 接受路径。
  等待：`tab.waitFor`、`tab.waitForSelector`、`tab.waitForUrl`、`tab.waitForResponse`、`tab.waitForNavigation`。
  快照：`tab.observe()` → 无障碍树；`tab.ariaSnapshot()` → 带 `[ref=eN]` 的 ARIA YAML。

  注意事项：
  - `tab.fill` NEVER 适用于 `<select>`；改用 `tab.select`。
  - `tab.waitForNavigation` 必须在触发点击之前启动。
  - 导航和重新渲染（虚拟列表、SPA 更新）会使 id/ref 失效；重新 observe 或 snapshot，再在同一单元中操作。
  - 卡住的操作会以具名错误快速失败，不会耗尽整个单元超时。
  - 原始请求拦截只在本次 run 中有效：run 结束会移除 `request` handlers、禁用拦截并释放挂起请求。

- `app.path` → NEVER 篡改真实桌面应用（不加 stealth patch）。
- 选择器：CSS + puppeteer `aria/…`、`text/…`、`xpath/…`、`pierce/…`。仅 Playwright 的伪选择器（`:has-text()`、`:visible`）会被拒绝。
</instruction>

<critical>
- MUST 先 `open` 再 `run`。默认用 `tab.observe()`；仅在外观重要时截图。`code` 具有完整 Node 访问权限，并非沙箱。
</critical>
