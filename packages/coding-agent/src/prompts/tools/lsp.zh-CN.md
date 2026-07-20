来自语言服务器的符号感知代码智能 —— 当文本搜索或编辑会漏掉调用点时，用于导航、重构和诊断的准确途径。

<operations>
基于位置 —— 传 `file` + `line` + `symbol`（该行上的子串；追加 `#N` 表示第 N 个匹配，例如 `kind#2`）：
- `definition`, `type_definition`, `implementation`, `references`, `hover` —— 标准 LSP 查找
- `rename` —— 在所有位置重命名该符号；**默认直接应用**，`apply: false` 仅预览；需要 `new_name`
- `code_actions` —— 该位置上的 quick-fix/refactor/imports；默认列出（`query` 按 kind 过滤，例如 `quickfix`, `source.organizeImports`），**仅在 `apply: true` + `query` 时应用其中一个**（此时 `query` = action title 子串或数字索引）

文件 / 工作区：
- `diagnostics` —— 针对某个路径、glob（`src/**/*.ts`）或整个工作区（`file: "*"`）的错误/警告
- `symbols` —— `file` 列出该文件的符号；`file: "*"` + `query` 搜索整个工作区
- `rename_file` —— 将 `file` 移动到 `new_name`，并通过服务器重写 imports/references；默认直接应用

服务器：
- `status`, `capabilities` —— 当前运行的内容 / 每个服务器的能力（单个用 `file`，全部用 `*`）
- `reload` —— 重启一个服务器（`file`）或全部（`*`）；`reload *` 也会重新读取项目 LSP 配置
- `request` —— 原始逃生舱口：`query` = 方法（`rust-analyzer/expandMacro`, `workspace/executeCommand`），`payload` = JSON 参数（否则由 `file`/`line`/`symbol` 自动构建）
</operations>

<caution>
- `line` 从 1 开始计数。具备项目语义的 `definition`/`references`/`rename` 在缺少 `symbol` 时会报 ERROR，而不是去猜错的标识符；未找到匹配或 `#N` 越界都会显式报错，绝不静默回退。
</caution>

<critical>
- 涉及符号的工作（rename、references、definition/type/impl、code actions）在有语言服务器可用时 MUST 使用 `lsp` —— 它会跟踪遮蔽、重新导出和跨文件用法，这些都是文本工具会漏掉的。
- NEVER 用 `ast_edit`、`sed` 或手工编辑做跨文件重命名；当 `lsp` `rename`/`rename_file` 能处理时更是如此 —— 文本重命名会静默漏掉调用点。
- 处理 imports、quick-fixes 和服务器已知重构时，优先尝试 `code_actions`，而不是手工编辑。
</critical>
