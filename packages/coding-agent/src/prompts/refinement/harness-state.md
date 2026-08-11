# Continual Harness State
{{#if memoryEntries}}
### Harness Memories
{{#each memoryEntries}}
- **{{this.title}}** ({{this.scope}}, id: `{{this.id}}`): {{this.content}}
{{/each}}
{{/if}}
{{#if promptEntries}}
### Supplemental Prompt Notes
{{#each promptEntries}}
- **{{this.title}}** ({{this.scope}}, id: `{{this.id}}`): {{this.content}}
{{/each}}
{{/if}}
{{#if skillEntries}}
### Skill Descriptors
{{#each skillEntries}}
- **{{this.title}}** ({{this.scope}}, id: `{{this.id}}`): {{this.content}}
{{/each}}
{{/if}}
{{#if subagentEntries}}
### Subagent Specifications
{{#each subagentEntries}}
- **{{this.title}}** ({{this.scope}}, id: `{{this.id}}`): {{this.content}}
{{/each}}
{{/if}}
{{#if recentRefinements}}
### Recent Refinements
{{#each recentRefinements}}
- {{this.summary}} ({{this.scope}}, {{this.timestamp}})
{{/each}}
{{/if}}
