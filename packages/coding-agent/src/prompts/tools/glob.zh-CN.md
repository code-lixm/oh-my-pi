通过快速模式匹配对文件和目录执行 glob，适用于任何规模的代码库。

<instruction>
- `path`：一个 glob、文件或目录。通过传递以分号分隔的列表（`src/**/*.ts; test/**/*.ts`）可一次搜索多个。
- `gitignore`（默认 `true`）会隐藏 `.gitignore` 匹配项。将 `gitignore: false` 设为可查找 `.env*`、`*.log`、新的构建输出，或仓库忽略的任何内容。
- `hidden`（默认 `true`）；与 `gitignore: false` 结合以同时显示也被 gitignored 的点文件。
</instruction>

<output>
按 mtime 对匹配路径排序（最新优先），按 `# <dir>/` 标题分组并在下方显示 basename；目录会带有结尾的 `/`。
</output>

<avoid>
需要多轮 glob/search 的开放式搜索：你 MUST 改用 Task tool。
</avoid>
