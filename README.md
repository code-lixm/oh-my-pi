# robomp

A self-hosted GitHub triage-and-fix bot that drives [`omp --mode rpc`](https://github.com/can1357/oh-my-pi).
For every issue opened on an allowlisted repository, robomp:

1. **Triages** — reads the issue, classifies it (`bug` / `question` / `enhancement` / …) and applies labels via the GitHub API.
2. **Branches on the classification:**
   - `bug` / `documentation` → reproduce in an isolated workspace, fix on a fresh branch, open a PR with a four-section body (`Repro / Cause / Fix / Verification`) that closes the issue.
   - `question` → answer in one comment, no PR.
   - `enhancement` / `proposal` → one thoughtful comment, no PR.
   - `invalid` / `duplicate` → one brief comment, no PR.
3. **Keeps the conversation going** — follow-up comments and PR review comments resume the same omp session so the agent retains its prior reasoning and tool history.
4. **Cleans up** on issue close / PR merge.

The orchestrator runs in Docker on a single developer machine. There is no multi-tenant story; the LLM provider is whatever your local `~/.omp/agent/models.yml` points at; the only credentials inside the container are a GitHub PAT and the bot account's webhook secret.

---

## Status

| Surface | State |
|---|---|
| Webhook receiver (HMAC-verified) | ✅ |
| Per-issue durable event queue (sqlite, dedupe, restart-safe) | ✅ |
| Per-issue git worktrees with credentialed remote | ✅ |
| `classify_issue` + automatic labelling | ✅ |
| Reproduce → fix → PR flow with template enforcement | ✅ |
| Follow-up comment / review-comment session resume | ✅ |
| Workspace cleanup on merge/close | ✅ |
| Identity + working-tree + lint pre-push gates | ✅ |
| Closing-keyword (`Fixes #N`) validation on PR open | ✅ |
| Model pool with per-task random pick | ✅ |
| 80 unit tests (one integration test gated on `ROBOMP_INTEGRATION=1`) | ✅ |
| Production hardening (multi-host, fine-grained PATs, drained restarts) | — out of scope for v1 |

---

## Architecture

```
                ┌──────────────────────────────────────────────────────┐
                │ robomp container                                     │
                │                                                      │
 GitHub ─webhook─▶ FastAPI (server.py)                                 │
                │      │ HMAC-verify + route()                         │
                │      ▼                                               │
                │  sqlite events table (durable queue)                 │
                │      │                                               │
                │      ▼                                               │
                │  WorkerPool (queue.py) — MAX_CONCURRENCY tasks       │
                │      │ per-issue serialization                       │
                │      ▼                                               │
                │  tasks.{triage_issue, handle_comment,                │
                │         handle_review, handle_pr_conversation,      │
                │         cleanup_workspace}                           │
                │      │                                               │
                │      ▼                                               │
                │  worker.run_task — spawns RpcClient                  │
                │      │ ┌── omp subprocess (bun … coding-agent) ───┐  │
                │      └─┤   - cwd  = per-issue git worktree         │  │
                │        │   - host tools: gh_*, classify_*, repro_  │  │
                │        │   - session resumed across follow-ups     │  │
                │        └────────────────────────────────────────────┘ │
                │                                                      │
                │  github_client.py (httpx, follow_redirects)         │
                │  sandbox.py (clone pool, worktree lifecycle)        │
                │  host_tools.py (audited, credential-redacted)        │
                └──────────────────────────────────────────────────────┘
   Mounts (host → container, read-only unless noted):
     /work/pi                       → /work/pi              (omp source)
     ~/.omp/agent/models.yml        → /root/.omp/agent/models.yml
     ./data                         → /data                 (rw — sqlite, logs, workspaces)
   extra_hosts:
     llm-gateway.internal:host-gateway  (so models.yml URLs reach the host proxy)
```

The orchestrator container is the isolation boundary. Per-issue git worktrees under `/data/workspaces/<owner>__<repo>__<n>/repo/` give per-task filesystem isolation. There is no docker-in-docker.

---

## End-to-end flow

Numbered concretely so you can grep logs for each step.

1. **`POST /webhook/github`** — body HMAC-verified against `GITHUB_WEBHOOK_SECRET`; bad sig returns `401` (GitHub stops retrying).
2. **Route** (`github_events.route`) — decides one of `triage_issue` / `handle_comment` / `handle_pr_conversation` / `handle_review` / `cleanup_workspace`, or `skip`. Bot-authored events (`user.login == bot_login`, `*[bot]`, `user.type == "Bot"`) are skipped. PR-derived events resolve to the originating issue's serialization key so two events for the same issue can't run concurrently.
3. **Persist + enqueue** — sqlite `events` row, `INSERT OR IGNORE` on `X-GitHub-Delivery` (dedupes redeliveries). Endpoint returns `202`.
4. **Dispatcher** — `WorkerPool._dispatch_loop` claims the next queued row atomically (`BEGIN IMMEDIATE; SELECT … WHERE state='queued'; UPDATE … 'running'; COMMIT`), guarded by an in-process `_inflight` set keyed by the originating issue. Concurrency capped by `ROBOMP_MAX_CONCURRENCY`.
5. **Workspace** — `sandbox.ensure_workspace`:
   - Idempotent shared clone (`--filter=blob:none`) under `/data/workspaces/_pool/<owner>__<repo>`.
   - Worktree at `/data/workspaces/<owner>__<repo>__<n>/repo` on a deterministic branch `farm/<8hex>/<slug>` derived from `(repo, number)`.
   - `git remote set-url origin` always re-set with the credentialed URL (rotates with PAT).
   - `git config user.email/user.name` set to the configured identity.
6. **omp subprocess** — `RpcClient(omp --mode rpc, cwd=worktree, session_dir=…, no_session=False)` so follow-ups resume the same conversation/tool history. Model is randomly picked from `ROBOMP_MODEL` (CSV pool).
7. **Agent (Claude / GPT / …)** drives the work via:
   - **Built-in omp tools** — `read`, `edit`, `write`, `bash`, `lsp`, etc. — operate on the worktree only.
   - **Host tools** — the only surface that mutates GitHub or persists audit rows. See below.
8. **Done** — event marked `done`; on exception, marked `failed` with a credential-redacted traceback in `events.last_error`. Per-issue inflight slot released.

---

## Host tools (the agent's GitHub surface)

| Tool | Purpose | Notes |
|---|---|---|
| `classify_issue` | First action on every new issue. Apply primary + optional priority/functional/provider/platform labels in one call; persist the primary type in sqlite. | Validates: bug ⇒ requires priority; non-bug ⇒ priority forbidden; provider must start with `provider:`; rejects unknown primaries. |
| `set_issue_labels` | Append labels later (e.g. add `wontfix`). Never removes existing. | Used for one-off adjustments outside the initial classify call. |
| `gh_post_comment` | Comment on the originating issue or any specified PR/issue number. | All `gh_*` errors propagate as `RpcCommandError` the agent can recover from. |
| `repro_record` | Persist a reproduction transcript (command, output, exit code, reproduced flag) under `context/repro/`. | Required before claiming a fix; PR template references the path. |
| `gh_push_branch` | `git push --set-upstream origin <branch>` from the worktree. | Refuses to push when (a) working tree dirty, (b) any commit's author ≠ configured identity, (c) `bun run fix:tools` (if defined) produces uncommitted changes. |
| `gh_open_pr` | Open a PR from the worktree branch. | Validates body has `## Repro`/`## Cause`/`## Fix`/`## Verification` headers AND `Fixes #N` (or `Closes`/`Resolves`) so GitHub auto-closes the issue on merge. Idempotent push first. Writes `pr.json` artifact + updates `issues.pr_number/state` in sqlite. |
| `gh_request_review` | Add reviewers / assignees. | Optional. |
| `mark_unable_to_reproduce` | Close the loop without a PR. Posts a structured "Could not reproduce" comment with diagnosis + info request and marks issue `abandoned`. | Use when reproduction genuinely fails after a real attempt. |
| `fetch_issue_thread` | Refetch the issue + comments from GitHub mid-task. | For long-running tasks that want fresh context. |

Every host-tool invocation is audited into the `tool_calls` table with timestamps, args, results, and error messages. Tokens never appear in any audited field — `host_tools._audit` only receives the agent-supplied args, and `git push` errors flow through `sandbox.GitCommandError` which redacts `user:password@` from argv and stderr.

---

## Workflow branches (set by classification)

```
                      classify_issue → primary
                              │
       ┌──────────────────────┼─────────────────────┐
       ▼                      ▼                     ▼
  bug | documentation    question         enhancement | proposal
       │                      │                     │
       ▼                      ▼                     ▼
  ack comment            answer in one         restate + feasibility
  repro_record           gh_post_comment       in one gh_post_comment
  diagnose               (no PR, no branch)    (no PR; wait for opt-in)
  bun run fix
  commit (Fixes #N)
  gh_push_branch
  gh_open_pr (template)
  link comment
```

`invalid` / `duplicate` get one brief explanatory comment and nothing else.

All persona rules live in `src/robomp/prompts/system_append.md` and are appended to omp's own system prompt at session start, so they govern every turn.

---

## Setup

### Prerequisites

- Docker + Docker Compose v2.
- A checkout of `oh-my-pi` (`$PI_ROOT`, default `/work/pi`).
- A LiteLLM-or-equivalent proxy on the host that your `~/.omp/agent/models.yml` already points at (default expectation: `http://llm-gateway.internal:4000`).
- A GitHub account for the bot, with **Write** access on every repo in `ROBOMP_REPO_ALLOWLIST`. Generate a fine-grained PAT scoped to those repos with:
  - Contents: Read+Write
  - Pull requests: Read+Write
  - Issues: Read+Write
  - Metadata: Read

> A classic `repo`-scoped PAT works too but is strictly broader than needed.

### One-time

```bash
cp .env.example .env
$EDITOR .env                       # fill in the GitHub fields + commit identity
openssl rand -hex 32 > /tmp/sec    # generate webhook secret; paste into .env *and* GitHub later

make build                         # rsync $PI_ROOT → .pi-context/ then docker compose build
make up                            # docker compose up -d
curl -fsS http://localhost:8080/healthz   # { "status": "ok" }
```

The image is a multi-stage build:

1. `natives-builder` — rust + bun; compiles `pi-natives` for the image's arch, exports the `.node` artifact.
2. `python-builder` — wheels `omp-rpc` from `$PI_ROOT/python/omp-rpc`.
3. `runtime` — slim image; copies the `.node` into `/opt/bun/bin/` (pi's loader fallback path), installs the omp-rpc wheel, installs robomp, ships an `omp` shim that calls `bun $PI_ROOT/packages/coding-agent/src/cli.ts`.

`bin/stage-pi.sh` rsyncs `$PI_ROOT` into `.pi-context/` excluding `target/`, `runs/`, `node_modules/`, `.fallow/`, and other build artifacts — without that filter the build context would be ~125 GB.

### Cloudflare tunnel (recommended)

robomp does not ship a tunnel. For a stable hostname:

```bash
brew install cloudflared
cloudflared tunnel login                          # authorize your zone in the browser
cloudflared tunnel create robomp                  # creates ~/.cloudflared/<uuid>.json
cloudflared tunnel route dns robomp robomp.yourdomain.com

cat > ~/.cloudflared/robomp.yml <<EOF
tunnel: <uuid>
credentials-file: $HOME/.cloudflared/<uuid>.json

ingress:
  - hostname: robomp.yourdomain.com
    path: ^/webhook/github\$
    service: http://localhost:8080
  - service: http_status:404
EOF

# foreground (logs to stdout):
cloudflared tunnel --config ~/.cloudflared/robomp.yml run robomp

# or install as a launchd / systemd service for auto-start:
sudo cloudflared --config ~/.cloudflared/robomp.yml service install
```

Note the `path: ^/webhook/github$` constraint — `/healthz`, `/events`, `/issues`, `/replay` stay localhost-only.

If you don't have a Cloudflare zone, `smee.io` and `ngrok http 8080` work fine too — point GitHub's *Payload URL* at whatever public URL your tunnel gives you and use `/webhook/github` as the path.

### GitHub webhook config

In the target repo's *Settings → Webhooks → Add webhook*:

| Field | Value |
|---|---|
| Payload URL | `https://robomp.yourdomain.com/webhook/github` (or your tunnel) |
| Content type | `application/json` |
| Secret | matches `GITHUB_WEBHOOK_SECRET` in `.env` |
| SSL verification | enabled |
| Events | Issues, Issue comments, Pull requests, Pull request reviews, Pull request review comments |
| Active | ✓ |

GitHub fires a `ping` on save; you should see `POST /webhook/github 202` in `docker compose logs robomp` within a second.

---

## Configuration reference

All variables are read from `.env` (via `env_file:` in `docker-compose.yml`). Validated by Pydantic at startup; missing required vars fail-fast.

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | yes | PAT for the bot account. Used as both REST bearer and HTTPS-clone password. |
| `GITHUB_WEBHOOK_SECRET` | yes | Shared HMAC secret with the GitHub webhook config. |
| `ROBOMP_BOT_LOGIN` | yes | The bot account's login name (e.g. `roboomp`). Used to skip self-comments and as default `git user.name`. |
| `ROBOMP_REPO_ALLOWLIST` | yes | Comma-separated `owner/repo` entries. Case-insensitive. |
| `ROBOMP_GIT_AUTHOR_NAME` | no (default: `ROBOMP_BOT_LOGIN`) | `git config user.name` for bot commits. |
| `ROBOMP_GIT_AUTHOR_EMAIL` | yes | `git config user.email` for bot commits. `gh_push_branch` refuses to push commits authored by anyone else. |
| `ROBOMP_MODEL` | no (default: `p-anthropic/claude-sonnet-4-6`) | Either a single id or a comma-separated **pool**. One is picked uniformly at random per task; the chosen model is logged as `rpc_model_pick`. |
| `ROBOMP_THINKING` | no (default: `high`) | `off` / `low` / `medium` / `high`. Passed to omp as `--thinking`; `off` omits the flag. |
| `ROBOMP_PROVIDER` | no | Force a specific provider id on omp. Normally unset — `ROBOMP_MODEL` carries `<provider>/<model>`. |
| `ROBOMP_MAX_CONCURRENCY` | no (default: `8`) | Async semaphore cap for in-flight tasks. |
| `ROBOMP_TASK_TIMEOUT_SECONDS` | no (default: `2400`) | Hard ceiling for a single `prompt_and_wait` (one full agent turn). |
| `ROBOMP_REQUEST_TIMEOUT_SECONDS` | no (default: `120`) | Per-RPC-command timeout (e.g. `set_todos`). |
| `ROBOMP_OMP_COMMAND` | no (default: `omp`) | Executable for the agent subprocess. The shipped image installs an `omp` shim. |
| `ROBOMP_WORKSPACE_ROOT` | no (default: `/data/workspaces` in-container) | Per-issue worktree directory. |
| `ROBOMP_SQLITE_PATH` | no (default: `/data/robomp.sqlite`) | Durable state file. |
| `ROBOMP_LOG_DIR` | no (default: `/data/logs`) | JSON-structured rotating logs (`robomp.log.jsonl`). |
| `ROBOMP_BIND_HOST` / `ROBOMP_BIND_PORT` | no | Receiver bind (`0.0.0.0:8080` by default). |
| `ROBOMP_REPLAY_TOKEN` | no | If set, enables `POST /replay` gated on `X-Robomp-Replay-Token`. Empty/whitespace counts as disabled. |

---

## CLI

The container's entrypoint is `python -m robomp serve`. Other subcommands:

```bash
docker compose exec robomp robomp triage  owner/repo#123   # fetch issue live, drive full pipeline offline
docker compose exec robomp robomp status                   # tabular dump of the issues table
docker compose exec robomp robomp replay  <delivery_id>    # re-enqueue a stored event (good for debugging a single delivery)
docker compose exec robomp robomp cleanup owner/repo#123   # force workspace removal + state=abandoned
```

`triage` is the workhorse for offline development — it constructs a synthetic `issues.opened` payload from the live issue and runs the whole pipeline without ever touching the webhook receiver.

---

## Operational notes

- **No PR without a recorded repro.** The persona prompt requires `repro_record` before any code change; if reproduction genuinely fails, `mark_unable_to_reproduce` closes the loop politely.
- **One PR per issue.** Follow-up comments and reviews push commits to the same `farm/<hex>/<slug>` branch; the same PR receives all amendments.
- **Session persistence.** Each issue has its own `.omp-session/` directory under the workspace, mounted via `/data` so it survives container restarts. Follow-ups resume the prior conversation without re-reading the issue.
- **At-least-once.** On crash mid-task, `WorkerPool.start()` resets `running` events to `queued` and retries. A comment/PR posted before the crash *will* be reposted; design follow-ups to be idempotent (e.g. don't repeat the same `gh_post_comment` if you can detect via `fetch_issue_thread` that you already posted).
- **Logs.** All output is structured JSON (`{"ts","level","logger","msg",…}`) on stdout and rotated into `/data/logs/robomp.log.jsonl`. Useful filters:
  ```bash
  docker compose logs -f robomp | grep -v issues.labeled
  docker compose exec robomp python -c "
  import sqlite3; c = sqlite3.connect('/data/robomp.sqlite'); c.row_factory = sqlite3.Row
  for r in c.execute(\"SELECT ts, tool, error FROM tool_calls WHERE issue_key=? ORDER BY id\", ('owner/repo#123',)):
      print(r['ts'], r['tool'], r['error'] or 'ok')"
  ```
- **Inspection endpoints (localhost-only via the tunnel ingress rule):**
  - `GET /events?limit=50` — recent webhook deliveries with state.
  - `GET /issues?limit=100` — current per-issue state + classification.
  - `GET /healthz` / `GET /readyz` — trivial.

---

## Verification

```bash
# Unit tests (fast — no network, no GitHub, no omp subprocess).
pytest -x tests/                              # 80 tests, ~2s

# Gated integration: a real `omp --mode rpc` subprocess against a fake GitHub
# (httpx.MockTransport) and a local bare git repo. Requires omp on PATH.
ROBOMP_INTEGRATION=1 pytest -x tests/test_worker_smoke.py

# Live container.
make build && make up
curl -fsS http://localhost:8080/healthz       # {"status":"ok"}

# Live end-to-end against a real (or test) issue:
docker compose exec robomp robomp triage owner/repo#1
docker compose logs -f robomp                 # in another shell, watch each tool call
```

---

## Security posture (v1)

- **GitHub PAT** is the only credential needed for normal operation. A fine-grained token scoped to the allowlisted repos is the recommended posture (and what `gh_push_branch` assumes for HTTPS auth).
- **Webhook signature** is verified with constant-time HMAC-SHA256; bad signatures return `401` (not `5xx`) so GitHub stops retrying spam.
- **Allowlist**. `route()` skips any event whose `repository.full_name` isn't in `ROBOMP_REPO_ALLOWLIST` (case-insensitive). No state mutation, no audit row beyond `state=skipped`.
- **Bot self-comments + bot-authored review comments** are filtered out at routing time (by `login == bot_login`, `*[bot]` suffix, or `user.type == "Bot"`).
- **Token never enters audited data.** `subprocess` errors flow through `sandbox.GitCommandError` which redacts `https://user:password@host` → `https://***@host` from argv, stdout, and stderr before raising. `host_tools._audit` only records the agent's tool arguments and structured results, never the credentialed clone URL.
- **Pre-push gates** in `gh_push_branch`:
  1. branch must match the workspace branch (no opportunistic pushing to arbitrary refs),
  2. working tree must be clean,
  3. every commit between `origin/<default-branch>..HEAD` must carry the configured `ROBOMP_GIT_AUTHOR_NAME` + `ROBOMP_GIT_AUTHOR_EMAIL`,
  4. if `bun run fix:tools` (or `fix`) is defined and succeeds, it must not produce any working-tree diff (i.e. commits are already formatted).
- **`/webhook/github` is the only public path.** The recommended Cloudflare ingress config restricts the tunnel hostname to that exact path; admin/inspection routes are localhost-only.
- **LLM credentials never enter the container.** The host's LiteLLM proxy is reached via `extra_hosts: ["llm-gateway.internal:host-gateway"]`; the only thing mounted in is `~/.omp/agent/models.yml` (whose `apiKey` fields are stub characters — real auth happens at the gateway).

---

## Repo layout

```
robomp/
├── Dockerfile                  # multi-stage: natives-builder, python-builder, runtime
├── docker-compose.yml          # mounts, extra_hosts, env_file
├── Makefile                    # `make build`, `make up`, `make stage`
├── bin/
│   └── stage-pi.sh             # rsync $PI_ROOT → .pi-context/ excluding target/runs/etc.
├── entrypoint.sh
├── pyproject.toml
├── README.md
├── .env.example
├── src/robomp/
│   ├── __init__.py
│   ├── __main__.py
│   ├── cli.py                  # `robomp serve|triage|replay|status|cleanup`
│   ├── config.py               # Pydantic Settings; model_pool, pick_model, validators
│   ├── db.py                   # sqlite schema + DAO, classification column + migration
│   ├── github_client.py        # httpx wrapper; redirect handling; retry-after parsing
│   ├── github_events.py        # verify_signature + route() dispatch
│   ├── host_tools.py           # 9 host tools (classify_issue first), all audited
│   ├── logging_config.py       # JSON formatter + rotating file
│   ├── persona.py              # mustache-style prompt renderer
│   ├── prompts/
│   │   ├── system_append.md
│   │   ├── kickoff_issue.md
│   │   ├── followup_comment.md
│   │   └── followup_review.md
│   ├── queue.py                # WorkerPool, _dispatch_loop, _claim_next_unique
│   ├── sandbox.py              # clone pool + worktree lifecycle; GitCommandError redactor
│   ├── server.py               # FastAPI app, /webhook/github, /events, /issues, /replay
│   ├── tasks.py                # triage_issue, handle_comment, handle_pr_conversation,
│   │                           # handle_review, cleanup_workspace
│   └── worker.py               # RpcClient driver, todo seeding, model picker
└── tests/                      # 80 passing, 1 skipped (gated integration)
```

---

## Troubleshooting

| Symptom | Likely cause / check |
|---|---|
| `401 invalid signature` on webhook | `GITHUB_WEBHOOK_SECRET` mismatch with the repo webhook config. |
| Container exits immediately with `PI_ROOT … missing` | The host's pi checkout isn't mounted at `/work/pi`. Adjust `volumes:` (or `PI_ROOT=` env when invoking compose). |
| `git push` fails with `Authentication required` | The PAT does not have push access on the repo, or `ROBOMP_BOT_LOGIN` doesn't match the PAT's account. The credentialed remote URL is `https://<bot_login>:<token>@github.com/<owner>/<repo>.git`. |
| `refusing to push: commit author identity mismatch` | Some commit on the branch was authored under a different name/email. Amend with `git commit --amend --reset-author --no-edit`. The error lists every offending sha. |
| `refusing to push: working tree is dirty` | Agent has uncommitted edits (often from `bun fix` running after a commit). `git add -A && git commit --amend --no-edit --reset-author` and retry. |
| `refusing to push: `bun run fix:tools` produced unformatted-file changes` | Committed code isn't formatted. Same amend command as above. |
| Agent loops on the same comment | A non-bot reply triggered `handle_comment`; check `/events?limit=20` to see what was queued and `/issues` for the per-issue state. |
| PR opened without the four template sections, or without `Fixes #N` | Shouldn't happen — `gh_open_pr` validates both. If you see it, the agent reached an out-of-process write somehow; inspect `tool_calls`. |
| `omp` fails with `Failed to load pi_natives` | The `pi_natives.linux-<arch>.node` is missing. Rebuild the image (`make build`); the `natives-builder` stage compiles it from `.pi-context/`. |
| Tasks all fail with `No API key found for <provider>` | `~/.omp/agent/models.yml` isn't mounted, or its provider id doesn't match what's in `ROBOMP_MODEL`. Check `docker compose exec robomp ls /root/.omp/agent/`. |

---

## License

MIT.
