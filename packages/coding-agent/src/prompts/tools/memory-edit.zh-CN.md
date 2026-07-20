按 id 编辑 Mnemopi 长期记忆。

仅可对 `recall` 工具返回的 id 使用。操作包括：
- `update`：替换一条工作记忆的内容和/或重要性。
- `forget`：永久删除一条工作记忆。
- `invalidate`：软性废弃一条工作记忆或情景记忆，并可选地指向 `replacement_id`。

事实 id（recall 结果中标记为 `[facts]` 的项）是只读的：请使用 `read memory://<id>` 查看；对 fact id 执行任何编辑操作都会返回 `not_editable`。

当一条记忆已经过时，但其历史仍可能有用时，优先使用 `invalidate`。只有在内容必须被硬删除时，才使用 `forget`。

**在执行 `update` 前，始终先读取完整记忆。** recall 结果是裁剪后的预览（尾随的 `…` 表示内容被截断，`full_length` 给出原始长度）；`update` 会整体替换 content，因此如果直接覆盖预览，就会删除未显示的尾部内容。先用 `read memory://<id>` 取回完整条目，再把合并后的内容传入 `content`。
