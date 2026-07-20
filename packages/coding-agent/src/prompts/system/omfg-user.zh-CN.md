<omfg>
用户对反复出现的代理行为感到沮丧。
编写一条本可在本次对话更早阶段捕捉到该违规行为的一次性时间旅行流规则（TTSR）。

TTSR 机制：
- 规则是带有 YAML 前置元数据的标记文件。
- `condition` 是针对助手流式输出测试的一条或多条脚本语言正则模式。
- `scope` 是以逗号分隔的允许名单。如果存在，只检查列出的流。
- `text` = 仅助手正文。`thinking` = 隐藏推理摘要。`tool` = 每个工具的参数。
- `tool:<name>(<glob>)` = 单个工具，仅当类路径参数匹配通配模式时。示例：`tool:write(*.rb)`、`tool:edit(*.ts)`。
- SHOULD 对代码问题使用文件专用的工具作用域。鲁比代码应通过 `write` → `tool:write(*.rb)` 生成，而不是直接用 `tool` 或 `text`。
- 工具参数在流式传输时可能会被序列化。针对含引号代码的条件 SHOULD 允许 JSON 转义。
- 当 `condition` 在 `scope` 内匹配时，流会被中断，并注入标记正文作为纠正指引。

输出契约：
- 只输出一个 JSON 对象，不得包含任何其他内容。
- JSON 字段：`name`、`description`、`condition`、`scope`、`body`。
- `name` MUST 使用 kebab-case。
- `description` MUST 是单行摘要。
- `condition` MUST 是 JavaScript 正则表达式字符串或字符串数组。
- `condition` MUST 匹配本次对话前文中可见的具体违规助手输出。
- JSON 中的正则反斜杠只转义一次：使用 `"\\beval\\s*\\("`，NEVER 使用 `"\\\\beval\\\\s*\\\\("`。
- 保持 `condition` 精确；NEVER 使用宽泛的全匹配模式。
- `scope` MUST 是字符串或字符串数组。
- 在投诉允许的范围内尽量缩小 `scope`。除非同一不良行为同时出现在工具参数和助手正文中，否则 NEVER 使用 `tool, text`。
- `body` MUST 是简明解释正确行为的 markdown 指引。
- 调用方负责组装 YAML frontmatter。NEVER 输出 markdown frontmatter，也不要用 fenced code block 包裹 JSON。

示例结构：
{
  "name": "ts-no-any",
  "description": "Never use `any` in TypeScript — use `unknown`, a generic, or the real type",
  "condition": ": any|as any",
  "scope": ["tool:edit(*.ts)", "tool:edit(*.tsx)", "tool:write(*.ts)", "tool:write(*.tsx)"],
  "body": "Never use `: any` or `as any`. Use `unknown`, a domain type, a generic, or a type guard."
}

投诉：
{{complaint}}

{{#if feedback}}
此前失败的尝试或用户要求的修订：
{{feedback}}

最新候选 JSON：
{{previousRule}}

重新生成一条已修正的规则。修复所列校验失败项或用户修订要求。NEVER 重复失败的 scope 或 condition。
{{/if}}
</omfg>
