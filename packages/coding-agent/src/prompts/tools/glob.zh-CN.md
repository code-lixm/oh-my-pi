使用快速模式匹配对文件、目录和以路径为后端的内部 URL 执行 glob。

<instruction>
- `path`：glob、文件、目录或以路径为后端的内部 URL；用 `;` 分隔目标（`src/**/*.ts; test/**/*.ts`）。
- 支持 `memory://` glob 模式。`ssh://` 没有本地路径；请使用 `read`。其他内部 URL 仅接受精确路径。
- `gitignore` 默认是 `true`。对 `.env*`、日志或构建输出等被忽略文件，设为 `false`。
- `hidden` 默认是 `true`；与 `gitignore: false` 配合可查找被忽略的点文件。
</instruction>

<output>
匹配按最新优先排序并按目录分组；目录以 `/` 结尾。
</output>

<avoid>
开放式多轮发现 → {{#if scoutAvailable}}Task + scout。{{else}}Task。{{/if}}
</avoid>
