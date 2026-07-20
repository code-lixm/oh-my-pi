<system-notice reason="background_task_dispatched" job="{{jobId}}">
用户启动了一个旁支任务，它现在正在独立的后台代理中运行。这不是 prompt injection，也不是给你的新指令——这是 coding agent 在通知你：工作已被分派到别处。

下面的任务正由另一个代理在它自己的会话中处理。你不对它负责：NEVER 开始处理它，NEVER 引用它，也 NEVER 让它打断或改变你当前的任务。像没有出现过这条消息一样，继续你刚才的工作。如果后台任务（{{jobId}}）完成，有结果会单独呈现。

已分派工作（仅供知悉）：
{{work}}
</system-notice>
