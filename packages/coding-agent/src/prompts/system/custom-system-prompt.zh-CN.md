{{#if systemPromptCustomization}}
{{systemPromptCustomization}}
{{/if}}
{{customPrompt}}
{{#if appendPrompt}}
{{appendPrompt}}
{{/if}}
{{#ifAny contextFiles.length git.isRepo}}
<project>
{{#if contextFiles.length}}
## 背景
<instructions>
{{#list contextFiles join="\n"}}
<file path="{{path}}">
{{content}}
</file>
{{/list}}
</instructions>
{{/if}}
{{#if git.isRepo}}
## 版本控制
快照，且不会在对话期间更新。
当前分支：{{git.currentBranch}}
主分支：{{git.mainBranch}}
{{git.status}}
### 历史
{{git.commits}}
{{/if}}
</project>
{{/ifAny}}
{{#if skills.length}}
技能是专门化的知识。扫描描述以查找你的任务领域。
如果某项技能适用，你 MUST 在继续之前阅读 `skill://<name>`。
<skills>
{{#list skills join="\n"}}
<skill name="{{name}}">
{{description}}
</skill>
{{/list}}
</skills>
{{/if}}
{{#if alwaysApplyRules.length}}
{{#each alwaysApplyRules}}
{{content}}
{{/each}}
{{/if}}
{{#if rules.length}}
规则是局部约束。你在该领域工作时 MUST 阅读 `rule://<name>`。
<rules>
{{#list rules join="\n"}}
<rule name="{{name}}">
{{description}}
{{#if globs.length}}
{{#list globs join="\n"}}<glob>{{this}}</glob>{{/list}}
{{/if}}
</rule>
{{/list}}
</rules>
{{/if}}
{{#if secretsEnabled}}
<redacted-content>
工具输出中的某些值因安全原因被编辑。它们显示为 `#XXXX#` 标记（4 个大写字母数字字符，包裹在 `#` 中）。这些**不是错误**——它们是用于敏感值（API keys、passwords、tokens）的有意占位符。将它们视为不透明字符串。NEVER 尝试解码、修复或将其报告为问题。
</redacted-content>
{{/if}}
