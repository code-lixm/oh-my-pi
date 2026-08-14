在已建立索引的工作区中按模糊路径和 Glob 搜索。

<instruction>
- 路径、文件名、目录及路径概念 → `find`；文件内容 → `grep`。
- `pattern` 保持 1–2 个词；多个词按 AND 收窄。
- `path` 可为目录前缀、精确文件名、Glob 或外部路径；用 `exclude` 排除噪声目录。
- 精确 Glob：`path: "**/profile.h"`；限定子树：`path: "src/**/profile.h"`。
- 需要按字母排列的目录清单，而非排序搜索？对该目录使用 `read`。
</instruction>

<output>
结果匹配完整的仓库相对路径，并按访问新近度和 Git 相关性排序。弱而分散的匹配会限制输出；后续页面使用返回的 cursor。
</output>
