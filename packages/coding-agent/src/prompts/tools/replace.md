Single file string replacement; fuzzy whitespace matching.

<instruction>
- MUST use smallest `old_string` uniquely identifying change.
- Nonunique `old_string` → MUST add context or use `replace_all: true` for all occurrences.
- Rename a string across file → use `replace_all: true`.
- SHOULD edit existing files, not create new.
</instruction>

<output>
Success/failure status.
Success: file modified in place; replacement applied.
Failure — e.g., `old_string` absent or multiple matches without `replace_all: true`: error describes issue.
</output>

<critical>
- You MUST inspect the target through its latest `read`/`grep` or current-disk `codegraph` source section before editing; a CodeGraph `[PATH#TAG]` snapshot is valid current evidence.
- Stale or failed match? Refresh precise current text with `read`/`grep`; NEVER rerun CodeGraph solely to refresh a snapshot.
</critical>

<bash-alternatives>
Replace content-addressed — identify change by text.

Pattern-addressed bulk changes: bash more efficient:

|Operation|Command|
|---|---|
|Regex replace|`sd 'pattern' 'replacement' file`|
|Bulk replace across files|`sd 'pattern' 'replacement' **/*.ts`|

Use Replace when content identifies location; `ast_edit` for structure-aware codemods.
For in-place edits prefer Replace or `write` — diff preview and fuzzy matching.
</bash-alternatives>
