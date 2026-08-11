# 持续 Harness 状态
{{#if memoryEntries}}
### Harness 记忆
{{#each memoryEntries}}
- **{{this.title}}** ({{this.scope}}，id：`{{this.id}}`): {{this.content}}
{{/each}}
{{/if}}
{{#if promptEntries}}
### 补充 Prompt 注记
{{#each promptEntries}}
- **{{this.title}}** ({{this.scope}}，id：`{{this.id}}`): {{this.content}}
{{/each}}
{{/if}}
{{#if skillEntries}}
### Skill 描述符
{{#each skillEntries}}
- **{{this.title}}** ({{this.scope}}，id：`{{this.id}}`): {{this.content}}
{{/each}}
{{/if}}
{{#if subagentEntries}}
### 子代理规格
{{#each subagentEntries}}
- **{{this.title}}** ({{this.scope}}，id：`{{this.id}}`): {{this.content}}
{{/each}}
{{/if}}
{{#if recentRefinements}}
### 最近 Refinement
{{#each recentRefinements}}
- {{this.summary}} ({{this.scope}}, {{this.timestamp}})
{{/each}}
{{/if}}
