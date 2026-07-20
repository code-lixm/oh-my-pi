通过 `path` 加上可选的 `selector`，读取文件、目录、归档、SQLite、图像、文档、内部资源和网页 URL。

<instruction>
- SHOULD 并行处理相互独立的读取。
- SHOULD 对网页内容使用 `read`（不是浏览器工具）；仅当 `read` 无法提供时才使用浏览器。
</instruction>

## 参数

- `path` — 必填。本地路径、内部 URI（`skill://`、`agent://`、`artifact://`、`memory://`、`rule://`、`local://`、`vault://`、`mcp://`、`omp://`、`issue://`、`pr://`、`ssh://`），或 URL。内联 `:<sel>` 对范围／模式仍然有效（例如 `src/foo.ts:50-200`、`src/foo.ts:raw`、`db.sqlite:users:42`）。
- `selector` — 可选选择器，不带前导 `:`（例如 `"50-200"`、`"raw"`、`"raw:50-100"`、`"conflicts"`）。当 `path` 包含字面冒号时使用：`{"path":"test:1-2","selector":"1-2"}`。

## 选择器

- _(无)_ — 可解析的代码 → 结构化摘要；其他文件 → 从开头（最多 {{DEFAULT_LIMIT}} 行）。
- `:50` / `:50-` — 从第 50 行开始。
- `:50-200` — 第 50–200 行，包含两端。
- `:50+150` — 从第 50 行起的 150 行。
- `:20+1` — 锚定第 20 行。
- `:5-16,960-973` — 在一次调用中包含多个范围。
- `:raw` — 原样输出；无锚点／摘要／行前缀。
- `:2-4:raw` / `:raw:2-4` — 范围和原样输出；顺序不限。
- `:conflicts` — 每个未解决的 git 合并冲突块一行。

# 文件

- 目录 → 受深度限制的 dirent 列表。
{{#if IS_HL_MODE}}
- 文件 + 选择器 → 仅文件名的快照头 + 带编号的行：`[foo.ts#1A2B]`，然后是 `41:def alpha():`。对锚定编辑复制 `[FILENAME#TAG]`；操作使用裸行号。NEVER 不要伪造该标签。
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- 文件 + 选择器 → 带编号的行：`41|def alpha():`。
{{/if}}
{{/if}}
- 可解析的代码，无选择器 → **结构摘要**：保留声明，主体用 `…` 省略。页脚会标明恢复选择器；只重新发出你需要的范围。

# 文档与笔记本

PDF、Word、PowerPoint、Excel、RTF、EPUB → 提取的文本。笔记本（`.ipynb`）→ 可编辑的 `# %% [type] cell:N` 文本。`:raw` 会绕过转换器。

# 图像

{{#if INSPECT_IMAGE_ENABLED}}
图像 → 元数据。视觉分析：使用路径和问题调用 `inspect_image`。
{{else}}
图像 → 内联解码（PNG、JPEG、GIF、WEBP），用于直接视觉分析。
{{/if}}

# 压缩包

`.tar`、`.tar.gz`、`.tgz`、`.zip`。`archive.ext:path/inside/archive` 读取成员；内部路径采用普通选择器：`archive.zip:dir/file.ts:50-60`。

# SQLite

对于 `.sqlite`、`.sqlite3`、`.db`、`.db3`：
- `file.db` — 带行数的表
- `file.db:table` — 模式 + 示例行
- `file.db:table:key` — 按主键取行
- `file.db:table?limit=50&offset=100` — 分页
- `file.db:table?where=status='active'&order=created:desc` — 过滤/排序
- `file.db?q=SELECT …` — 只读 SELECT

# URL

- 默认使用阅读器模式：HTML、GitHub issues/PRs、Stack Overflow、Wikipedia、Reddit、NPM、arXiv、RSS/Atom、JSON 端点、PDF → 干净的文本/markdown。
- `:raw` → 原样 HTML；行选择器（`:50`、`:50-100`、`:50+150`）对抓取进行分页。
- 裸 `host:port` 会与选择器语法冲突——添加末尾斜杠：`https://example.com/:80`。

# 内部 URI

所有 URI 方案都采用相同的行选择器。`artifact://<id>` 可恢复溢出的输出；大型产物会阻塞无界的 `:raw`，因此请使用 `artifact://<id>:N-M` / `artifact://<id>:raw:N-M` 分页，并将报告的产物文件路径用于搜索／复制工作流。

`ssh://host/<absolute-path>` 读取远程文本文件（UTF-8，≤1 MiB）或列出目录下一层内容，目标为预配置的 SSH 主机或 `~/.ssh/config` 别名；`ssh://host/` 列出远程根目录，而裸 `ssh://` 列出已配置的主机。文件也可通过 `write` 写入，并可通过 `search` 搜索；目录仅支持列出（`search` 拒绝目录，`write` 拒绝覆盖目录）。远程路径中的字面量 `:`、`?` 或 `#` 必须进行百分号编码（`%3A`/`%3F`/`%23`）——末尾的 `:sel` 会被视为行选择器，而 `?`/`#` 会开始 URL 查询／片段。需要 POSIX 登录 shell（`sh`/`bash`/`zsh`）；Windows 主机或非 POSIX shell（fish、csh/tcsh）会被拒绝——请在那种情况下使用 `ssh` 工具。

<critical>
- 字面量冒号文件名 + 选择器？请使用 `selector`，不要使用递归 `path:"file:sel:sel"`。
- 摘要页脚标出了省略的范围？仅重新发出这些范围。NEVER 猜测 `..`/`…` 的内容。
</critical>
