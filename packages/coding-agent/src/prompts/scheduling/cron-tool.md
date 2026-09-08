Manage the current session's scheduled prompts (cron jobs).

Scheduled prompts are persisted, session-scoped automation: each job fires its
prompt into THIS conversation on a schedule and shares the session's lifecycle —
jobs live in the session's artifacts, stop firing when the session ends, and are
visible via /cron and /schedule. Use this tool whenever the user asks for
something to happen repeatedly or at a future time ("every 10 minutes check
...", "tomorrow at 9am remind ...", "每 5 分钟检查一次…").

Schedule syntax:
- One-shot: `in 30m`, `in 2h`, `at 2026-09-06T09:00:00` (local ISO)
- Interval: `every 10m`, `each 2h` (minimum 10 seconds)
- Cron: five fields `minute hour day month weekday` (e.g. `0 9 * * 1-5`) or
  `@hourly` / `@daily` / `@weekly` / `@monthly`

Delivery semantics — choose deliberately:
- `follow_up` (default): the fired prompt runs after the current turn finishes.
- `steer`: the fired prompt is injected at the next model boundary, steering
  the current work.

Guidelines:
- The prompt should be a complete, self-contained instruction; it is delivered
  verbatim into the conversation when it fires.
- Recurring jobs fire indefinitely until cancelled or the session ends — cancel
  finished one-off automations when the user no longer needs them.
- Confirm the timezone-sensitive wording of "daily"/"at 9am" with the user
  when the conversation is ambiguous.
