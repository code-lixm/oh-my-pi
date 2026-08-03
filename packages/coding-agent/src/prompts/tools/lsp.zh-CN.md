来自语言服务器的符号感知代码智能 —— 导航、重构和诊断中，文本工具会漏掉调用点时应使用它。

<operations>
- 基于位置：`file` + `line` + `symbol`（子串；`#N` 表示第 N 个匹配）。`line` 从 1 开始计数。
- `rename` 默认应用；`apply: false` 仅预览。项目感知的查找缺少 `symbol` 时会 ERROR，不会对缺失或歧义符号静默回退。
- `code_actions` 默认列出；仅以 `apply: true` + `query` 应用一个（标题子串或索引）。
- `rename_file` 会移动文件并重写所有 import/reference；默认应用。
- `diagnostics`：单一路径、glob（`src/**/*.ts`）或整个工作区（`file: "*"`）。
- `symbols`：`file` 列出文件符号；`file: "*"` + `query` 搜索工作区。
- `reload`：重启一个服务器（`file`）或全部（`*`）；`reload *` 会重新读取 LSP 配置。
- `request` 原始请求：`query` = 方法，`payload` = JSON 参数（否则自动构建）。
</operations>

<critical>
- 符号感知工作（rename、references、definition、code actions）在有语言服务器时 MUST 使用 `lsp`。
  它会跟踪文本工具遗漏的遮蔽、重新导出和跨文件用法。
- `lsp` 的 `rename`/`rename_file` 可用时，NEVER 使用 `ast_edit`/`sed`/手工编辑跨文件重命名——文本重命名会悄然漏掉调用点。
- 处理 import、quick-fix 和服务器已知重构时，先使用 `code_actions`，再考虑手动编辑。
</critical>
