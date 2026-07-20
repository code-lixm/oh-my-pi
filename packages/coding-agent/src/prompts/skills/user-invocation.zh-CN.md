[重要：用户已调用“{{name}}”技能，这表明他们希望你遵循其指示。该技能的完整内容已在下方加载。]

{{body}}

---

[技能目录: {{baseDir}}]
将此技能中的任何相对路径（例如 `scripts/foo.js`、`templates/config.yaml`）相对于该目录并使用其绝对路径进行解析：读取引用的资产和模板，并在技能说明要求时使用 terminal 工具运行脚本。
{{#if userArgs}}
用户: {{userArgs}}
{{/if}}
