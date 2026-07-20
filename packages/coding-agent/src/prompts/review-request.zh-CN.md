## 代码审查请求

### 模式

{{mode}}

### 已更改文件（{{len files}} 个文件，+{{totalAdded}}/-{{totalRemoved}} 行）

{{#if files.length}}
{{#table files headers="File|+/-|Type"}}
{{path}} | +{{linesAdded}}/-{{linesRemoved}} | {{ext}}
{{/table}}
{{else}}
_没有可审查的文件。_
{{/if}}
{{#if excluded.length}}
### 排除的文件 ({{len excluded}})

{{#list excluded prefix="- " join="\n"}}
`{{path}}` (+{{linesAdded}}/-{{linesRemoved}}) — {{reason}}
{{/list}}
{{/if}}

### 分配指南

使用带有 `agent: "reviewer"` 和 `tasks` 数组的 `task` 工具。
{{#when agentCount "==" 1}}恰好创建 **1 个审阅任务**。{{else}}并行生成 **{{agentCount}} 个审阅代理**。{{/when}}
{{#if multiAgent}}
按邻近性对文件进行分组，例如：
- 同一目录／模块 → 同一代理
- 相关功能 → 同一代理
- 测试及其实现文件 → 同一代理
{{/if}}

### 审查者说明

审查者 MUST：
1. 仅关注分配给你的文件
2. {{#if skipDiff}}{{diffInstruction}}{{else}}MUST 使用下面的 diff 块 (NEVER 重新运行 git diff){{/if}}
3. {{contextInstruction}}
4. 对发现和结论字段使用增量式 `yield` 部分；不要调用单独的发现工具

{{#if skipDiff}}
### 差异预览

_完整差异过大（{{len files}} 个文件）。每个文件仅显示前 ~{{linesPerFile}} 行。_

{{#list files join="\n\n"}}
#### {{path}}

{{#codeblock lang="diff"}}
{{hunksPreview}}
{{/codeblock}}
{{/list}}
{{else}}

### 差异

<diff>
{{rawDiff}}
</diff>
{{/if}}

{{#if additionalInstructions}}
### 附加说明

{{additionalInstructions}}
{{/if}}
