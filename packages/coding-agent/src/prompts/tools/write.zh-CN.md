在指定路径创建或覆盖文件。

<conditions>
- 创建任务明确要求的新文件
- 编辑时替换整个文件内容会更复杂
- 支持 `.tar`、`.tar.gz`、`.tgz` 和 `.zip` 归档条目，通过 `archive.ext:path/inside/archive`
- 支持 SQLite 行操作，通过 `db.sqlite:table`（插入）、`db.sqlite:table:key`（用 JSON 内容更新，用空内容删除）
</conditions>

<critical>
- 你 SHOULD 使用编辑工具来修改现有文件
- 除非被明确要求，否则你 NEVER 创建文档文件（*.md、README）
- 除非被要求，否则你 NEVER 使用表情符号
</critical>
