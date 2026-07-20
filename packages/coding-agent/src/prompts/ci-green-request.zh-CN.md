<critical>
你 MUST 持续处理，直到当前分支的 CI 变绿。
NEVER 在只修一次后就停下。
</critical>

<instruction>
- 如果可用，你 SHOULD 使用 `github` 工具并传 `op: run_watch`，不要带其他参数。
- 否则使用 `gh` cli。
- 每次 push 后，都以当前 HEAD 的 workflow runs 作为事实来源。
</instruction>

<procedure>
1. 观察当前 HEAD commit 的 workflow runs。
2. 如果有任何 run 失败，检查失败 job 的输出和 logs。
3. 找出根因并做最小且正确的修复。
4. 如果能降低下一次失败 push 的概率，就运行本地验证。
{{#if headTag}}5. 原子性地 push 分支和 tag `{{headTag}}`：`git push --atomic "{{remote}}" "{{branch}}" "+refs/tags/{{headTag}}"`。{{else}}5. 推送分支。{{/if}}
6. 立即再次观察新 HEAD commit 的 workflow runs。
7. 重复以上步骤，直到最新 HEAD commit 的 workflow runs 成功。
</procedure>

<caution>
- 把每次 push 都视为一次新的 CI 尝试。新 HEAD 出现后，立即重新观察。
- 如果 watcher 输出不够，就在改代码前检查底层 workflow 或 job 上下文。
</caution>

{{#if headTag}}
<instruction>
把分支和 tag 一起 push，这样 tag 才不会指向未 push 或非 green 的 commit。`--atomic` 会让分支和 tag 更新作为一次 ref 事务一起成功或失败；`+refs/tags/{{headTag}}` 会把 tag 强制移动到新的 HEAD。NEVER 先 push 分支、之后再单独 retag。
</instruction>
{{/if}}

<critical>
只有当最新 HEAD commit 的 workflow runs 成功时，任务才算完成。
{{#if headTag}}最新 HEAD commit MUST 带有 tag `{{headTag}}`，并通过 `git push --atomic` 与分支原子性地一起 push。{{/if}}
</critical>
