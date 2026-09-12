通过 OpenAI 的 gpt-image-2（Images API）根据文本提示词生成图像。

<instructions>
- 提供一条详细的 `prompt`：主体、场景、构图、光照、风格。
- 需要渲染的文本内容：使用全大写或加引号。
- `filename_prefix`：简短标签（仅字母/数字/连字符），便于之后查找输出文件。
- 图片保存在配置的输出目录；结果中会报告文件路径。
- `output_dir` 可覆盖单次调用的默认输出位置。
</instructions>
