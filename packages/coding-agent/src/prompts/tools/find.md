Fuzzy path and glob search over the indexed workspace.

<instruction>
- Use `find` for paths, filenames, directories, and concepts represented by path names; use `grep` for file contents.
- Keep `pattern` to 1–2 terms. Multiple terms narrow with AND semantics.
- `path` accepts a directory prefix, exact filename, glob, or external path. Use `exclude` to remove noisy trees.
- Exact glob examples: `path: "**/profile.h"`; subtree: `path: "src/**/profile.h"`.
- Need an alphabetical directory listing rather than ranked search? Use `read` on the directory.
</instruction>

<output>
Results match the whole repo-relative path and are ranked by frecency and git relevance. Weak scattered matches are capped; use the returned cursor for another page.
</output>
