Record up to three structured, user-selectable next-step offers for a final handoff.

<instruction>
- Call only after completing the current response.
- Read-only, no-side-effect, inspection-only, or tool-limited request? NEVER call unless the user explicitly asks to save choices.
- Offer only natural, safe follow-up actions.
- Use stable kebab-case `id` values.
- Keep each `label` concise and actionable.
- Set `requiresConfirmation` for actions that still need user approval.
- This tool records choices; it NEVER executes them.
- Do not offer completed work or required in-scope verification.
</instruction>

<critical>
- Emit at most three offers.
- NEVER override a read-only or tool-limited request.
- NEVER infer offers from final-response text.
- A later bare-number selection remains ordinary user intent.
- Dangerous work MUST still pass normal approval.
</critical>
