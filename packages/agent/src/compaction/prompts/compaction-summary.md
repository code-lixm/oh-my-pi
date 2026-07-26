Summarize the conversation above so another LLM can resume the task.

Output exactly the Markdown structure inside `<template>`, keeping every heading and its order. Do not include the `<template>` tags or any prose outside this structure.

<template>
## Objective
- [One or two brief sentences describing what the user wants.]

## Important Details
- [Constraints, preferences, decisions with rationale, exact facts needed to continue, or `(none)`]

## Work State
### Completed
- [Finished work or verified facts; otherwise `(none)`]

### Active
- [Current work, partial changes, or investigation state; otherwise `(none)`]

### Blocked
- [Blockers, failing commands, or unanswered questions; otherwise `(none)`]

## Next Move
1. [Immediate concrete action, or `(none)`]
2. [Next action if known, or `(none)`]

## Relevant Files
- [Exact file or directory path: why it matters, or `(none)`]
</template>

Rules:
- Keep every section, even when empty. Use terse bullets, never prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, identifiers, and relevant tool output when known.
- If the conversation ends with an unanswered user question or a request awaiting user input, preserve that exact question or request under `### Blocked`.
- Include mentioned repository state changes: branch, uncommitted changes, merge/rebase state.
- Do not mention this summary process or that context was compacted.
