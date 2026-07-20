<system-notice>
{{#if multiple}}LSP 诊断在对 {{files.length}} 文件的编辑返回后延迟到达：
{{else}}LSP 诊断在编辑返回后延迟到达：
{{/if}}
{{#each files}}{{this.path}} — {{this.summary}}
{{#each this.messages}}{{this}}
{{/each}}{{#unless @last}}
{{/unless}}{{/each}}</system-notice>
