<project-context>
["这些上下文文件承载了该项目中用户的长期指令（AGENTS.md 等）。主导代理受其约束。应据此约束该代理，并在它一开始偏离时立即指出；绝不要建议违反这些文件所规定的内容。"]
{{#each contextFiles}}
<file path="{{path}}">
{{content}}
</file>
{{/each}}
</project-context>
