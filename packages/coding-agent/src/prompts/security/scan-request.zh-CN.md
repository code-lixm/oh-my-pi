执行下面不可变的安全扫描计划。

仓库：{{repositoryRoot}}
目标类型：{{targetKind}}
修订版本：{{revision}}
基准修订版本：{{baseRevision}}
目标修订版本：{{headRevision}}
包含路径：{{includePaths}}
排除路径：{{excludePaths}}
知识库：{{knowledgeBases}}
计划指纹：{{planFingerprint}}
{{#if diffText}}

请求审查的基准到目标差异：

```diff
{{diffText}}
```
{{/if}}

首先清点精确范围。通过 `task` 将互不重叠的审查任务委派给 `security-reviewer`。核对所有执行者输出，检查消除不确定性所需的证据，然后仅调用一次 `security_publish`，提交 findings、如实的覆盖信息和最终报告。
