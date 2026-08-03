在持久内核中运行一段代码；状态跨调用和子代理保持。

增量工作：import → 定义 → 测试 → 使用，每步各用一个单元。仅在 `reset` 或内核崩溃后重新运行 setup。
在单元内部用 `parallel(thunks)` 并行，不要通过批处理并行。

{{#if py}}顶层 `await` 可用；`asyncio.run(…)` 会报错。{{/if}}
{{#if js}}JS 运行于 **Bun**：可用全局变量（`Bun.file`、`Bun.write`、`Bun.$`、`fetch`、`Buffer`）；顶层 `await`/`return` 可用。{{/if}}

出错时，修复并只重新运行失败步骤。

<prelude>
{{#ifAll py js}}Python：同步，kwargs。JS：异步，使用唯一的末尾 object literal，绝不使用位置参数。{{else}}{{#if py}}同步，kwargs。{{/if}}{{#if js}}异步，使用唯一的末尾 object literal，绝不使用位置参数。{{/if}}{{/ifAll}}{{#if rb}} Ruby：同步，kwargs。{{/if}}{{#if jl}} Julia：同步，kwargs。{{/if}}
```
display(value) → None        print(value, ...) → None
read(path, offset?=1, limit?=None) → str
write(path, content) → str
env(key?=None, value?=None) → str | None | dict
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
tool.<name>(args) → unknown
    调用任意会话工具；`args` 是其参数对象。
completion(prompt, model?="default"|"smol"|"slow", system?=None, schema?=None) → str | dict
    一次性、无状态（没有历史／工具）。`model`：`"smol"` 快速，`"default"` 会话，`"slow"` 最强。`schema`（JSON-Schema）→ 已解析对象。
{{#if spawns}}agent(prompt, agent?="{{spawnDefaultAgent}}", label?=None, schema?=None, schema{{#if js}}Mode{{else}}_mode{{/if}}?="permissive", isolated?=None, apply?=None, merge?=None, handle?=False) → str | dict
    运行子代理 → 最终输出。`agent` 选择已发现的代理；省略则使用 `{{spawnDefaultAgent}}`。{{#if spawnAllowedAgentsText}} 允许的代理：{{spawnAllowedAgentsText}}。{{/if}} `schema` 覆盖代理／会话 schema；`schemaMode`/`schema_mode`：`"permissive"` | `"strict"`。有效 schema 返回已解析数据。`isolated` 请求工作树；`apply`/`merge` 控制其改动。通过提示词中命名的 `local://` 文件后台执行。`handle` → `{ text, output, handle: "agent://<id>", id, agent }`；结构化时解析 `data`。
{{#if js}}    JS：使用唯一的末尾对象 — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge, handle })。{{/if}}
{{/if}}
parallel(thunks) → list     pipeline(items, ...stages) → list
log(message) → None         phase(title) → None
budget → {{#if py}}`budget.total`（上限或 None）、`budget.spent()`、`budget.remaining()`{{/if}}{{#if js}}`await budget.total()`、`await budget.spent()`、`await budget.remaining()`{{/if}}{{#if rb}}`budget.total`、`budget.spent`、`budget.remaining`{{/if}}{{#if jl}}`budget.total`、`budget.spent()`、`budget.remaining()`{{/if}}；上限 `+Nk` 为建议，`+Nk!` 为硬限制。
```
</prelude>
{{#if spawns}}
<dag>
用 `agent(…, handle=true)` 和 `pipeline`/`parallel` 构建无环波次：
- **命名节点。** 捕获代理结果 → `handle`（`agent://<id>`）+ `output`。
- **连接边。** 将上游 `handle`/`output` 放入下游提示词。批量数据使用 `write("local://<name>.md", …)`。
- **`pipeline`** = 分阶段波次，有屏障。**`parallel`** = 一次波次。
- **隔离失败。** 将有风险的节点包装在 try/except；失败只降级其子树。
- **仅限无环。** 节点不会等待自己的后代。
</dag>
{{/if}}

<critical>
先前顶层名称会存活到下一个单元；复用，NEVER 重新 import／声明。仅在文件自上次读取后发生变化时重新读取。
</critical>
