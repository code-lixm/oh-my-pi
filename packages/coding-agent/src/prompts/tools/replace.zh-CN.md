在文件中执行字符串替换，并带有模糊空白匹配。

<instruction>
- 你 MUST 使用能唯一标识该更改的最小 `old_text`
- 如果 `old_text` 不唯一，你 MUST 用更多上下文扩展它，或使用 `all: true` 替换所有出现位置
- 你 SHOULD 优先编辑现有文件，而不是创建新文件
</instruction>

<output>
返回 success/failure 状态。成功时，文件会在原处被修改并应用替换。失败时（例如，找不到 `old_text`，或在没有 `all: true` 的情况下匹配到多个位置），返回描述问题的错误。
</output>

<critical>
- 你 MUST 在编辑前至少在对话中读取该文件一次。若未先读取文件就尝试编辑，该工具会报错。
</critical>

<bash-alternatives>
替换是按内容寻址的——你通过它的文本来确定要改动的*内容*。

对于按模式定位的批量更改，命令行更高效：

|操作|命令|
|---|---|
|正则替换|`sd 'pattern' 'replacement' file`|
|跨文件批量替换|`sd 'pattern' 'replacement' **/*.ts`|

当 _内容本身_ 能标识位置时使用替换；对结构感知的代码修改使用 `ast_edit`。
对于原地编辑，优先使用此工具或 `write` —— 你会获得差异预览和模糊匹配。
</bash-alternatives>
