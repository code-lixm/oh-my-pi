<system-interrupt reason="cross_turn_thinking_loop_detected">
Your reasoning over the last {{count}} turns has repeated the same paragraph with no change in behavior:
`{{summary}}`

Each turn looked locally different (different tool arguments), but the reasoning is stuck on the same intent. STOP re-declaring the loop in your thinking — actually change the action: call the tool you keep deciding to call, in the exact way its schema requires, or investigate why that call is failing before retrying. If the tool genuinely cannot be called, state the concrete blocker in one sentence and yield.
</system-interrupt>