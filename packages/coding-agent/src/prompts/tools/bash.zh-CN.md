在持久 shell 中运行命令。

仅用于单个二进制程序或计算事实的短管道（`wc -l`、`sort | uniq -c`、`diff`）。
{{#if hasEval}}内联脚本、heredoc、`$(…)`、复杂控制流／引用和非平凡管道 → `eval`。{{else}}内联脚本、heredoc、`$(…)` 与复杂控制流 → 专用工具或已检入脚本。{{/if}}

<instruction>
- 使用 `cwd`，不要 `cd`；对多行或引号繁多的值使用 `env: { NAME: "…" }`。
- `pty: true` 仅用于终端交互（`sudo`、`ssh`）。
- 有顺序依赖的命令在一次调用中用 `&&`；独立调用可并发运行。
- 内部 URI（`skill://`、`agent://`、……）会自动解析为路径。
{{#if hasShellBuiltins}}- 可用辅助工具：mkdir、wc、sort、comm、diff、uniq、base64、cmp、md5sum、sha{1,224,256,384,512}sum、b2sum、basename、dirname、readlink、realpath、touch、stat、date、mktemp、seq、yes、printenv、truncate、tac、nproc、uname、whoami、hostname、which、pgrep、pkill、pidwait、top、cut、tee、tr、paste、sed、xargs、jq、rm、mv、ln、ts、sponge、ifne、isutf8、combine{{#unless isWindows}}、errno{{/unless}}{{/if}}
{{#if asyncEnabled}}- `async: true` 只延迟有限命令的结果；它不会延长 `timeout`。{{/if}}
</instruction>

<critical>
{{#if hasGrep}}- NEVER 使用 shell `grep`/`rg`；使用内置 `grep`。{{/if}}
{{#if hasRead}}{{#if hasGlob}}- 用 `read` 列出目录、用 `glob` 查找路径；NEVER 使用 `ls`/`find`。{{/if}}{{/if}}
- 避免 `head`、`tail` 与重定向：输出会被捕获、截断，并链接到 `artifact://<id>`。
{{#if hasLaunch}}- 服务、watcher、调试器和 REPL MUST 使用 `hub`（`op:"start"`）。{{/if}}
</critical>

{{#if autoBackgroundEnabled}}长时间前台调用可能自动转入后台，稍后交付结果。需要内联结果？提高 `timeout`。{{/if}}
没有截断页脚表示显示的输出完整。
