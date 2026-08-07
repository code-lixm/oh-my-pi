# next_step_offer

> Stage one to three structured follow-up choices for a successful final response without executing any action.

## Source
- Entry: `packages/coding-agent/src/tools/next-step-offer.ts`
- State machine: `packages/coding-agent/src/session/next-step-offers.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/next-step-offer.md`
- Selection prompt: `packages/coding-agent/src/prompts/system/next-step-selection.md`

## Registration / Visibility
- Tool metadata: `approval = "write"`, `strict = true`.
- Registration requires `communication.nextSteps = "auto"` and an active `SessionManager`.
- The tool records choices only. It does not run commands, call another tool, or approve a later action.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `offers` | array (1–3 items) | Yes | Structured choices staged for the containing assistant response. |
| `offers[].id` | `string` | Yes | Unique stable kebab-case identifier. |
| `offers[].label` | `string` | Yes | Non-empty trimmed user-visible action label. |
| `offers[].description` | `string` | No | Optional non-empty context for the action. |
| `offers[].requiresConfirmation` | `boolean` | Yes | Whether executing the selected action still needs normal user approval. |

More than three offers, duplicate/invalid IDs, blank labels, or blank supplied descriptions are rejected.

## Outputs
On success the tool returns:

```text
Structured next-step offers recorded for this response; no action was executed.
```

`details.offers` contains the normalized staged choices.

## Lifecycle
1. The tool stages choices in memory for the current assistant turn.
2. A later successful final binds them to that persisted assistant message, session, branch, model, and expiry.
3. Only the most recent successful final's choices remain active. A later offer-less final clears prior choices.
4. An eligible bare number is rewritten into explicit ordinary user intent, then consumes the active offer exactly once.
5. The selected action still follows the normal tool approval and safety path.

## Invalidation
Active or staged offers are invalidated by:

- a substantive intervening user message
- session, branch, or model changes
- expiry
- compaction that did not explicitly retain the metadata
- interrupted or superseded assistant turns

Invalidation is persisted in the session journal. Branch-transition invalidation is attached as leaf-preserving metadata so reopening a session keeps the selected semantic leaf and cannot revive an inherited ancestor offer.

## Limits
- Maximum three active choices.
- Default lifetime: 30 minutes.
- Only exact positive decimal input such as `1` is eligible; whitespace, leading zeroes, signed values, decimals, or surrounding text remain ordinary input.
- A selection is not approval. `requiresConfirmation` remains in force.
