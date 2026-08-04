<system-notice>
上面的用户消息包含 **workflowz** 关键词：将此任务作为确定性的多子代理工作流执行。在 `eval` 工具中编写编排并扇出子代理——用于全面覆盖（拆解并行）、增强把握（提交前独立视角和对抗性检查），或处理单一上下文无法容纳的规模（审计、迁移、大范围扫描）。当扇出更周全时，这优先于默认内联完成整个任务的倾向。

<when>
任务可从拆解＋并行覆盖、或提交前独立／对抗性交叉检查中获益时，值得这样做。快速查找或单次编辑直接处理——不要启动 agents。{{#if scoutAvailable}}先内联使用 scout{{else}}先内联使用 explore{{/if}}（列出文件、界定 diff、定位调用点）发现工作清单，再围绕清单扇出；不必在 *task* 前知道形状，只须在 *fan-out* 前知道。常见形态：
- **理解** — 并行阅读子系统 → 结构化地图。
- **设计** — N 个独立方案的评审团 → 评分综合。
- **审查** — 按维度拆分 → 分维度发现 → 对抗性验证每项发现。
- **研究** — 多模态扫描 → 深读命中 → 综合。
- **迁移** — 发现位置 → 逐一转换 → 验证。
</when>

<helpers>
状态跨 `eval` 调用持久化，{{#if scoutAvailable}}因此可在一次调用中 scout，下一次调用中扇出。{{else}}因此可在一次调用中 explore，下一次调用中扇出。{{/if}}每个 eval 调用提供：

- `agent(prompt, *, agent="task", label=None, schema=None, isolated=None, apply=None, merge=None, handle=False)` — 运行一个子代理；返回其最终文本，或在提供 JSON Schema 字典 `schema` 时返回已验证对象。`schema` 会强制子代理产出结构化数据；按对象分支，NEVER 解析散文。`agent` 选择已发现的 agent{{#if scoutAvailable}}（`"scout"`、`"reviewer"` 等）{{/if}}；`label` 命名工件。共享背景写入 `local://` 文件并在各 prompt 中引用，不作为参数传入。子代理会被告知其最终文本就是返回值，因此返回原始数据。`agent()` 阻塞至子代理完成。递归遵循 `task.maxRecursionDepth`（默认 2；负数允许无限）。
- `parallel(thunks)` — 并发运行零参可调用对象，保留输入顺序；完成时返回。池受 `task` 并发度限制，NEVER 手调；按工作可拆宽度扇出。任一 thunk 抛错会传播；将有风险的调用包在 `try/except` 中以保留部分结果。循环中用默认参数绑定闭包值（`lambda d=d: …`），否则每个 thunk 都会捕获最后一个值。
- `pipeline(items, *stages)` — 将项目从左至右映射穿过 `stages`。阶段间存在屏障：全部项目完成阶段 N 后才进入 N+1。阶段一接收原项目，后续阶段接收前一阶段结果。并发池宽度与 `parallel()` 相同。
- `completion(prompt, *, model="default", system=None, schema=None)` — 无状态单次模型调用，没有工具和历史。层级：`"smol"`、`"default"`、`"slow"`。用于扇出内的廉价分类／评分。
- `log(message)` — 在状态树上方输出进度行。`phase(title)` — 开始阶段；后续状态行归入该组。
- `budget` — `budget.total` 是输出 token 上限（未设置时为 `None`），`budget.spent()` 是本轮已消耗 token（主循环＋eval 子代理），`budget.remaining()` 在无上限时为 `math.inf`，`budget.hard` 表示是否强制。用户以 `+Nk` 设置建议性上限（通过 `budget.remaining()` 自行限制），以 `+Nk!` 或 Goal Mode 设置硬上限（消耗达到上限后 `agent()` 拒绝生成）。循环先检查 `budget.total`，因为用户未设上限时它为 `None`。

所有内容都在 eval 调用内同步、内联运行：没有后台模式、恢复或独立进度应用。每个 eval 调用都是范围明确的扇出；可跨调用和回合串联多阶段工作流，并在决定前读取每次结果。
</helpers>

<structure>
对于独立的逐项链（审查→验证、获取→提取→评分），将整条链包装进一个函数并用 `parallel()` 运行；每个项目依次流经自己的步骤，互不等待：

**Python（`eval`，Python 后端）：**

```python
DIMENSIONS = [{"key": "bugs", "prompt": "…"}, {"key": "perf", "prompt": "…"}]
def review_and_verify(d):
    found = agent(d["prompt"], label=f"review:{d['key']}", schema=FINDINGS_SCHEMA)
    return parallel([lambda f=f: {**f, "verdict": agent(
        f"Refute if you can (default refuted when unsure): {f['title']}",
        label=f"verify:{f['file']}", schema=VERDICT_SCHEMA)} for f in found["findings"]])
phase("Review")
results = parallel([lambda d=d: review_and_verify(d) for d in DIMENSIONS])
confirmed = [f for group in results for f in group if f["verdict"]["is_real"]]
```

**JavaScript（`eval`，JavaScript 后端）：**

```js
const DIMENSIONS = [{ key: "bugs", prompt: "…" }, { key: "perf", prompt: "…" }];
async function reviewAndVerify(d) {
    const found = await agent(d.prompt, {
        label: `review:${d.key}`,
        schema: FINDINGS_SCHEMA,
    });
    return await parallel(found.findings.map((f) => async () => ({
        ...f,
        verdict: await agent(
            `Refute if you can (default refuted when unsure): ${f.title}`,
            { label: `verify:${f.file}`, schema: VERDICT_SCHEMA },
        ),
    })));
}
phase("Review");
const results = await parallel(DIMENSIONS.map((d) => async () => reviewAndVerify(d)));
const confirmed = results.flat().filter((f) => f.verdict.is_real);
```

仅当某阶段确实需要前一阶段的全部结果时才使用 `pipeline()`：跨集合去重／合并、零结果早退，或“与其他发现比较”。其阶段间屏障会让每项等待最慢的同行：

**Python（`eval`，Python 后端）：**

```python
phase("Find")
found = parallel([lambda d=d: agent(d["prompt"], schema=FINDINGS_SCHEMA) for d in DIMENSIONS])
findings = dedupe([f for r in found for f in r["findings"]])   # needs everything at once
phase("Verify")
verdicts = parallel([lambda f=f: agent(verify_prompt(f), schema=VERDICT_SCHEMA) for f in findings])
```

**JavaScript（`eval`，JavaScript 后端）：**

```js
phase("Find");
const found = await parallel(DIMENSIONS.map((d) => async () =>
    await agent(d.prompt, { schema: FINDINGS_SCHEMA }),
));
const findings = dedupe(found.flatMap((r) => r.findings)); // needs everything at once
phase("Verify");
const verdicts = await parallel(findings.map((f) => async () =>
    await agent(verifyPrompt(f), { schema: VERDICT_SCHEMA },
));
```

在调用之间用普通代码 flatten／map／filter；不要仅为此添加屏障。嵌套 `parallel()` 的池各自受限，因此总扇出必须保持合理。
</structure>

<patterns>
按任务所需组合 harness：
- **对抗性验证** — 每项发现派 N 个独立怀疑者，要求其反驳；仅保留多数存活项。`votes = parallel([lambda i=i: agent(f"Refute: {claim}. refuted=true if unsure.", schema=VERDICT) for i in range(3)])`，当 `sum(not v["refuted"] for v in votes) ≥ 2` 时保留。
- **视角多样验证** — 为验证者分配不同镜头（正确性、安全性、性能、可复现性），不要使用 N 个相同反驳者。
- **评审团** — 从不同角度生成 N 个尝试，由并行评审打分；综合胜者并吸收其余最佳部分。
- **循环至无新项** — 面对未知规模发现，持续生成 finder，直至连续 K 轮没有新项；对全部已见项去重，而非只对已确认项去重，否则永不收敛。
- **多模态扫描** — 并行 finder 各以不同方式搜索（按容器、内容、实体、时间），彼此盲隔离。
- **完整性批评者** — 最后派一个 agent 询问“遗漏了什么——哪种模态未运行、哪项主张未验证、哪个文件未读？”；答案成为下一轮。
- **预算／计数循环** — Python：`while len(bugs) < 10:`；JavaScript：`while (bugs.length < 10) { … }`。Python 中按 `budget.total` 和 `budget.remaining()` 门控显式预算；JavaScript 中使用 `await budget.total()` 和 `await budget.remaining()`。每轮 `log()`。
- **无静默上限** — 任何 top-N、无重试或采样限制都必须在行动前通过 `log()` 说明遗漏内容；静默截断会被误解为“已覆盖全部”。

按请求规模调整：“找任意 bug”→ 少量 finder、单轮投票验证；“彻底审计／全面覆盖”→ 更宽 finder 池、3–5 轮对抗性验证和综合阶段。
</patterns>

<execution>
- 先拆解表面；跨阶段时记录到 `todo`。
- 对任何会被分支使用的 agent 输出优先使用 `schema=`。
- 扇出返回后，你负责正确性：读取工件、运行门禁、验证后行动。
- 持续直到任务关闭；扇出返回只是一步，不是停止点。
</execution>
</system-notice>
