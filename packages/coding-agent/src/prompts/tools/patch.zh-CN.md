根据给定的 diff hunk 对文件进行修补。用于编辑现有文件的主要工具。

<instruction>
**Hunk 头部：**
- `@@` — 当上下文行是唯一时使用裸头部
- `@@ $ANCHOR` — 从文件中逐字复制的锚点（整行或唯一子串）
**锚点选择：**
1. 当仅靠上下文行即可唯一匹配时，优先使用裸 `@@`；否则选择从文件中复制的高度具体的锚点：
   - 完整函数签名
   - 类声明
   - 唯一的字符串字面量／错误信息
   - 带有不常见名称的配置键
2. 在出现 "Found multiple matches" 时：添加上下文行，使用带有独立锚点的多个 hunk，或使用更长的锚点子串
**上下文行：**
使用足够多带有 ` ` 前缀的行以使匹配唯一（通常为 2–8 行）
在编辑结构化代码块（嵌套大括号、标签、缩进区域）时，包含开始行和结束行，以便编辑保持在代码块内部
</instruction>

<parameters>
```ts
// Input is { path: string, edits: Entry[] }. `path` is required and applies to every entry.
type Entry =
   // Diff is one or more hunks for the top-level path.
   // - Each hunk begins with "@@" (anchor optional).
   // - Each hunk body only has lines starting with ' ' | '+' | '-'.
   // - Each hunk includes at least one change (+ or -).
   | { op: "update", diff: string }
   // Diff is full file content, no prefixes.
   | { op: "create", diff: string }
   // No diff for delete.
   | { op: "delete" }
   // New path for update+move from the top-level path.
   | { op: "update", rename: string, diff: string }
```
</parameters>

<output>
返回成功／失败；失败时，错误信息表明：
- "Found multiple matches" — 锚点／上下文不够唯一
- "No match found" — 上下文行在文件中不存在（内容错误或读取已过时）
- diff 格式中的语法错误
</output>

<critical>
- 你 MUST 在编辑前读取目标文件
- 你 MUST 逐字复制锚点和上下文行（包括空白字符）
- 你 NEVER 使用锚点作为注释（不要使用行号、位置标签、像 `@@ @@` 这样的占位符）
- 你 NEVER 在预期块之外放置新行
- 如果编辑失败或破坏了结构，你 MUST 重新读取文件，并基于当前内容生成新的补丁——你 NEVER 重试相同的 diff
- NEVER 使用编辑来修复缩进、空白，或重新格式化代码。格式化应作为单个命令在最后运行一次（`bun fmt`、`cargo fmt`、`prettier --write` 等。）——而不是进行 N 次单独编辑。如果你在编辑后看到不一致的缩进，不要处理它；格式化程序会在一次处理中修复所有这些问题。
</critical>

<avoid>
- 通用锚点：`import`、`export`、`describe`、`function`、`const`
- 在多个代码块中重复添加相同内容（重复块）
- 为细微更改覆盖整个文件（对于重大重构或短文件可接受）
</avoid>
