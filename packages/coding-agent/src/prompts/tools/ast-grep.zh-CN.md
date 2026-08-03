通过 ast-grep 做结构化代码搜索。当语法形态比文本更重要时使用（调用、声明、语言结构）。

<instruction>
- 每次调用限定一种语言。`pat` 是一个 AST 模式；不相关的模式应分开调用。
- `$NAME` 捕获一个节点；`$_` 匹配但不绑定；`$$$NAME` 捕获零个或多个；`$$$` 匹配零个或多个且不绑定。
  - 使用 `$$$NAME`，NOT `$$NAME`（无效）。名称必须大写且是整个节点——`prefix$VAR` 无效。
- 同一个元变量出现两次 → MUST 匹配相同的代码（`$A == $A` 匹配 `x == x`，不匹配 `x == y`）。
- 模式 MUST 解析为单个 AST 节点。非独立片段 → 包裹为：`class $_ { … }`。
- C++ 表达式语句调用需要结尾的 `;`：`ns::doThing($ARG);`、`$CALLEE($ARG);`。
- TS：容忍注解 —— `async function $NAME($$$ARGS): $_ { $$$BODY }`。
- 声明形式不同——`function foo`、方法 `foo()`、`const foo = () => {}`；断定不存在前，先搜索正确的形式。
- 最宽松的存在性检查：`pat: "executeBash"`，并缩小 `path`。
</instruction>

<critical>
- AVOID 扫描仓库根目录——先缩小 `path`。
- 解析问题 = 查询失败，不是不存在：断定“无匹配”前先修正模式或收紧 `path`。
- 宽泛的跨子系统探索 → 先使用 Task 工具 + scout 子代理。
</critical>
