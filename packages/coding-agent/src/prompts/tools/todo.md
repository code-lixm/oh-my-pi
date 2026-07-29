**Tasks referenced by verbatim content string, NEVER an auto-generated ID — no "task-1"/"task-N" exists. Pass the content text in the `task` field.**

On each completion the earliest still-open task (in phase order) auto-promotes to `in_progress`.
Completing tasks out of phase order can move this pointer **back** to an earlier phase — expected; completed tasks are never reverted.

## Operations

|`op`|Required fields|Effect|
|---|---|---|
|`init`|`list: [{phase, items: string[]}]`|Initialize full list (replaces existing)|
|`init`|`items: string[]`|Flattened single-phase init|
|`start`|`task`|Mark in progress|
|`done`|`task`|Mark one completed; phase-wide completion is rejected|
|`drop`|`task` or `phase`|Mark abandoned|
|`block`|`task` or `phase`, optional `reason`|Mark **blocked** — open but waiting on external input; excluded from the stop-time incomplete-todo reminder|
|`unblock`|`task` or `phase`|Return a blocked task to `pending`|
|`rm`|`task` or `phase` (optional)|Remove task or phase; omit both to clear|
|`append`|`phase`, `items: string[]`|Append tasks to `phase`; lazily creates phase|
|`view`|—|Read-only: echo list|

## Anatomy
- **Task content**: 5–10 words; what, not how. Unique identifier.
- **Phase name**: short noun phrase (e.g. `Foundation`, `Auth`, `Verification`). Unique identifier. NEVER prefix `1.`, `A)`, `Phase 1:`.

## Rules
- Mark each task done immediately after finishing; NEVER batch-close a phase.
- A subagent result is a ledger boundary: reconcile completed tasks before the next action.
- Implementation evidence closes implementation tasks only; verification stays open until its command succeeds.
- NEVER make a todo call your turn's only tool call — batch it with the next real action.
- Waiting externally? `block`; agent-actionable blocker? `append` an unblocking task.
- Keep `task`/`phase` strings stable once introduced.
- Lost the exact task text? `view` echoes the list — NEVER guess from memory.

## When to create a list
- Task requires 3+ distinct steps
- User explicitly requests one
- User provides a set of tasks
- New instructions arrive mid-task — capture before proceeding

<critical>
User hands you a multi-step plan — phased todo, numbered/bulleted checklist, or "N bugs/items/tasks":
- You MUST `init` the list with EVERY item as its own task before working.
- Enumerate all; NEVER summarize into fewer tasks, sample "the important ones", drop items, or track the rest from memory.
</critical>
