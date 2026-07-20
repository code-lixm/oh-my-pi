通过 ast-grep 进行结构化、AST 感知的重写。

<instruction>
- 在文本替换不安全时，用于 codemods / 结构化重写
- 将每次调用限制为一种语言
- 在 `pat` 中捕获的元变量（`$A`、`$$$ARGS`）会替换到该条目的 `out` 模板中
- **Patterns 匹配的是 AST 结构，而不是文本。** `$NAME` = 一个节点（已捕获）；`$_` = 一个但不绑定；`$$$NAME` = 零个或多个；`$$$` = 零个或多个但不绑定。使用 `$$$NAME`，NOT `$$NAME` —— 双美元形式无效。元变量名为大写，并且 MUST be 整个 AST 节点 —— 像 `prefix$VAR` 或 `"hello $NAME"` 这样的部分文本 NOT work
- 同一个元变量出现两次 → 两处出现都 MUST 匹配相同的代码（`$A == $A` 匹配 `x == x`，不是 `x == y`）
- Rewrite patterns MUST 解析为单个有效的 AST 节点。非独立片段 → 用上下文包裹，例如 `class $_ { … }`
- TS declarations/methods —— 容忍未知注解：`async function $NAME($$$ARGS): $_ { $$$BODY }` 或 `class $_ { method($ARG: $_): $_ { $$$BODY } }`
- 用空的 `out` 删除已匹配的代码：`{"pat":"console.log($$$)","out":""}`
- 每次重写都是 1:1 替换 —— 不能将一次捕获拆分到多个节点，也不能合并多个捕获
</instruction>

<output>
- 变更 diff：`[src/foo.ts#1A2B]`、`-12:before`、`+12:after`
</output>

<critical>
- 解析问题意味着重写格式错误或作用域不对 —— 在假定这是一次干净的 no-op 之前，先修复 pattern
- 对于一次性的本地文本编辑，你 SHOULD 更应优先使用 Edit tool
</critical>
