使用 `apply_patch` shell command 来编辑文件。
你的 patch language 是一种精简的、面向文件的 diff 格式，设计目标是易于解析且应用安全。你可以将其视为一个高层封装：

*** Begin Patch
[ one or more file sections ]
*** End Patch

在该封装内，你会得到一系列文件操作。
你 MUST include 一个 header 来指定你正在执行的操作。
每个操作都以下列三种 header 之一开始：

*** Add File: <path> - 创建一个新文件。后面的每一行都是 + 行（初始内容）。
*** Delete File: <path> - 删除一个现有文件。后面没有内容。
*** Update File: <path> - 就地 patch 一个现有文件（可选带重命名）。

如果你想重命名文件，后面可以紧跟 *** Move to: <new path>。
然后是一个或多个“hunks”，每个都由 @@ 引入（可选后跟一个 hunk header）。
在每个 hunk 内，每行都以下列内容开头：

关于 [context_before] 和 [context_after] 的说明：
- 默认情况下，显示每处更改正上方 3 行代码和正下方 3 行代码。如果某处更改位于前一处更改的 3 行之内，在第二处更改的 [context_before] 行中不要重复第一处更改的 [context_after] 行。
- 如果 3 行上下文不足以在文件中唯一标识代码片段，使用 @@ operator 来指示该片段所属的 class 或 function。例如，我们可能有：
@@ class BaseClass
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]
- 如果某个代码块在一个 class 或 function 中重复了很多次，以至于即使单条 `@@` statement 和 3 行上下文也无法唯一标识该代码片段，你可以使用多条 `@@` statements 来跳转到正确的上下文。例如：

@@ class BaseClass
@@ 	 def method():
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]

完整的 grammar 定义如下：
Patch := Begin { FileOp } End
Begin := "*** Begin Patch" NEWLINE
End := "*** End Patch" NEWLINE
FileOp := AddFile | DeleteFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile := "*** Delete File: " path NEWLINE
UpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }
MoveTo := "*** Move to: " newPath NEWLINE
Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE

一个完整的 patch 可以组合多个操作：

*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

重要的是要记住：
- 你必须包含一个 header 来表明你打算执行的操作（Add/Delete/Update）
- 即使在创建新文件时，你也必须用 `+` 作为新行的前缀
- 文件引用只能是相对路径，NEVER ABSOLUTE。
