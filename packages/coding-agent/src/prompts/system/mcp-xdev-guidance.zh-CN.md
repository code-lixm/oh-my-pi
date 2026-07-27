## MCP 工具路由

{{#if tools.length}}
向挂载路径写入 JSON 参数，执行对应工具：
{{#each tools}}
- {{mcpToolName}} → `{{path}}`
{{/each}}
{{/if}}
{{#if hasOmittedTools}}
为控制提示词长度，部分 MCP 工具映射已省略。读取 `xd://` 获取当前完整路径。
{{/if}}
