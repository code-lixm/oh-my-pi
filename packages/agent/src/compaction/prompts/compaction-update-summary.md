Update the anchored summary in `<previous-summary>` using the conversation history above so the same execution chain can continue after compaction.
Preserve still-true details, remove stale details, and merge in new facts.

Output exactly the Markdown structure shown inside `<template>` and keep the section order unchanged. Do not include the `<template>` tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [user constraints/preferences; settled decisions with rationale/evidence; verified facts/assumptions; exact state needed to continue; or `(none)`]

## Work State
### Completed
- [completed work or delivered updates; verified facts/commands with outcomes; otherwise `(none)`]

### Active
- [current work, partial changes, pending decisions, or investigation state; otherwise `(none)`]

### Blocked
- [blockers, failing commands with outcomes, essential missing state, or unknowns; otherwise `(none)`]

## Next Move
1. [immediate concrete action, or `(none)`]
2. [next action if known, or `(none)`]

## Relevant Files
- [recoverable file, artifact/history URI, or summary reference: why it matters; otherwise `(none)`]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, command outcomes, error strings, URLs, identifiers, and recoverable URIs when known.
- NEVER invent state, paths, results, or recoverable references.
- Essential state missing? State the exact gap in Blocked; make recovery the first Next Move.
- Continue from recorded state; NEVER redo Completed work.
- NEVER reopen settled decisions without new contradictory evidence.
- Do not mention the summary process or that context was compacted.
