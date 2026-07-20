使用正则表达式搜索文件。

<instruction>
- 支持 Rust regex 和 PCRE2 语法。
- `path`：SHOULD 限定到已知路径（例如 `src`）；可通过分隔列表传入多个路径（`src; tests`）。`selector` 只用于按行号过滤，绝不用来选择路径/根目录（`"/"` 应放在 `path` 中）。
- 文件名里有字面量冒号且还要加行范围？使用 `selector`（例如 `{"path":"test:1-2","selector":"1-2"}`），不要写递归形式的 `path:"test:1-2:1-2"`。
- 字面量 `\n` 或 `\\n` 出现在 `pattern` 中时，会检测为跨行模式。
</instruction>

<output>
{{#if IS_HL_MODE}}
- 对每个匹配文件：返回带快照标签头和行号的内容：`[src/login.ts#1A2B]`、`*42:if (user.id) {`（匹配行）、` 43:return user;`（上下文）。锚定编辑时复制这个头；操作里使用裸行号。
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- 输出带行号前缀。
{{/if}}
{{/if}}
</output>

<critical>
- 对任何内容搜索，都 MUST 使用内建 `grep`。NEVER 通过 Bash shell 调用 `grep`、`rg`、`ripgrep`、`ag`、`ack`、`git grep`、`awk`、`sed`-for-search，或任何 CLI 搜索——哪怕只查一个匹配或做一次快速检查也不行。
- 需要多轮开放式搜索？MUST 使用 Task 工具和 scout 子代理，而不是链式调用 `grep`。
</critical>
