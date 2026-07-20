在持久内核中运行一步代码。

<instruction>
**一次 eval 调用 = 一个单元 = 一个逻辑步骤。** 状态按语言在独立的 eval 调用、工具调用和 `task` 子代理之间持久保留——在一次调用中定义 helpers/datasets/clients，后续调用即可直接复用它们。

以增量方式工作：一次调用中 import，在下一次中定义，测试，然后使用——每个都各自是一次 eval 调用。仅在 `reset`、内核崩溃或某个证明状态已丢失的 `NameError`/`ReferenceError` 之后才重新运行 setup。使用 `parallel(thunks)` helper 在单元*内部*并行化工作，而不是通过批处理步骤。

字段：

- `language` — {{#if py}}`"py"` IPython kernel{{/if}}{{#ifAll py js}}、{{/ifAll}}{{#if js}}`"js"` persistent JavaScript VM{{/if}}{{#if rb}}{{#ifAny py js}}、{{/ifAny}}`"rb"` persistent Ruby kernel{{/if}}{{#if jl}}{{#ifAny py js rb}}、{{/ifAny}}`"jl"` persistent Julia kernel{{/if}}。
- `code` — 单元主体，逐字不变。换行/引号采用 JSON 编码；无围栏，无标题。
- `title`（可选）— 简短的 transcript 标签（例如 `"imports"`）。
- `timeout`（可选）— 秒数。仅对重计算或较长的非代理工具调用提高。
- `reset`（可选）— 先清除此语言的内核。{{#ifAll py js}} 按语言区分：`py` reset 绝不会触及 JS VM。{{/ifAll}}

{{#if py}}实时事件循环：直接使用顶层 `await`；`asyncio.run(…)` 会引发 "cannot be called from a running event loop"。{{/if}}
{{#if js}}JS 在 **Bun** 下运行：Bun 全局对象/API 可用（`Bun.file`、`Bun.write`、`Bun.$`、`fetch`、`Buffer`）；顶层 `await`/`return` 可直接工作。{{/if}}
{{#if rb}}Ruby：同步；helper 选项是关键字参数（例如 `output("id", limit: 2)`）；最后一个表达式会自动显示，除非它是 `nil`、赋值或定义（像 IRB 一样）。{{/if}}
{{#if jl}}Julia：同步；helper 选项是标准关键字参数（例如 `output("id", limit=2)`）；最后一个表达式会自动显示，除非它是赋值或定义（像 Julia REPL 一样）。{{/if}}
出错时，修复并仅重新运行失败的步骤——先前调用的状态会保留。
</instruction>

<prelude>
{{#ifAll py js}}相同的 helpers + 参数顺序，两种运行时都是如此。Python：同步，选项 = 末尾 kwargs。JS：异步/`await`able，选项 = 一个末尾 object literal，绝不使用位置参数（额外参数会抛错）。{{else}}{{#if py}}同步；选项 = 末尾 kwargs。{{/if}}{{#if js}}异步/`await`able；选项 = 一个末尾 object literal，绝不使用位置参数（额外参数会抛错）。{{/if}}{{/ifAll}}{{#if rb}} Ruby：同步，选项 = 末尾关键字参数。{{/if}}{{#if jl}} Julia：同步，选项 = 末尾关键字参数。{{/if}}
```
display(value) → None
    Cell output; figures/images/dataframes shown natively.
print(value, ...) → None
    Text output.
read(path, offset?=1, limit?=None) → str
    File as text; offset/limit 1-indexed lines. Accepts `local://…`.
write(path, content) → str
    Write file (creates parents) → resolved path. `local://…` persists across turns/subagents.
env(key?=None, value?=None) → str | None | dict
    No args → full env dict; one → value of `key`; two → set `key=value`, return value.
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
    Task/agent output by id; one → text/dict, multiple → list.
tool.<name>(args) → unknown
    Invoke any session tool; `args` = its parameter object.
completion(prompt, model?="default", system?=None, schema?=None) → str | dict
    Oneshot, stateless (no history/tools). `model`: "smol" fast | "default" session | "slow" most capable. `schema` (JSON-Schema) → structured output, parsed object.
{{#if spawns}}agent(prompt, agent?="{{spawnDefaultAgent}}", model?=None, label?=None, schema?=None, handle?=False) → str | dict
    Run a subagent → final output. `agent` picks another discovered agent; omit it to use `{{spawnDefaultAgent}}`.{{#if spawnAllowedAgentsText}} Allowed agents: {{spawnAllowedAgentsText}}.{{/if}} `schema` as in completion(). Background via `local://` files named in the prompt. `handle` → DAG node dict { text, output, handle: "agent://<id>", id, agent } (parsed under `data` when `schema` set).
{{#if js}}    JS: options are ONE trailing object — agent(prompt, { agent, schema, handle }).
{{/if}}
{{/if}}
parallel(thunks) → list
    Thunks through a bounded pool (wide as a `task` batch — don't pre-shrink), input order kept; returns when all finish, a throwing thunk propagates.
pipeline(items, ...stages) → list
    Map items through one-arg stages left-to-right, barrier between stages; stage 1 gets the item, later stages the previous result.
log(message) → None
    Progress line above the status tree.
phase(title) → None
    Phase grouping subsequent status lines.
budget → per-turn token budget
    {{#if py}}`budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()` (math.inf when no ceiling), `budget.hard`.{{/if}}{{#if js}}`await budget.total()` (ceiling or null), `await budget.spent()`, `await budget.remaining()` (Infinity when no ceiling), `await budget.hard()`.{{/if}}{{#if rb}} Ruby: `budget.total` (ceiling or nil), `budget.spent`, `budget.remaining` (Float::INFINITY when no ceiling), `budget.hard`.{{/if}}{{#if jl}} Julia: `budget.total` (ceiling or nothing), `budget.spent()`, `budget.remaining()` (Inf when no ceiling), `budget.hard`.{{/if}} Ceiling: `+Nk` (advisory) or `+Nk!`/Goal Mode (hard — `agent()` won't spawn past it); spend still tracked.
```
</prelude>
{{#if spawns}}
<dag>
通过 stage helpers 传递句柄以构建依赖图——无环波次：
- **命名节点。** 捕获每个 `agent(…, {{#if py}}handle=True{{/if}}{{#if js}}{ handle: true }{{/if}}{{#if jl}}handle=true{{/if}})` 结果；携带 `handle`（`agent://<id>`）+ `output`。
- **通过引用连线边。** 将上游节点的 `handle`/`output` 放入依赖 stage 的 prompt 中——大型 transcript 不会被重新内联。批量情况下：`write("local://<name>.md", …)`，传递该 URI。
- **`pipeline(items, *stages)` = 分阶段的波次**，阶段之间有屏障（每个条目都先完成第 N 阶段，之后任何条目才会进入 N+1）。**`parallel(thunks)` = 一次波次**，由独立节点组成。
- **隔离失败。** 引发异常的节点会重新引发最低索引错误，并中止其所在波次；将有风险的节点包裹在 try/except 中，这样失败只会降级其依赖子树，独立分支仍可完成。
- **仅限无环。** 节点绝不会等待它自己的后代。
</dag>
{{/if}}

<critical>
先前的顶层名称（`data`、`sessions`、helpers、imports）会保留到下一次 eval 调用中——复用它们；NEVER 重新 import、re-require 或重新声明 helper。仅当文件自上次读取后可能已更改时才重新读取。仅在 `reset`、崩溃或 `NameError`/`ReferenceError` 之后才重新运行 setup。
</critical>
