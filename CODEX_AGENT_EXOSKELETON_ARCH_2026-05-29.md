# Codex Agent Exoskeleton — Architecture & Build Spec

- Date: 2026-05-29
- Author: Claude Opus 4.7 (design), for the user + Codex to build
- Companion doc: `OPUS_REVIEW_2026-05-29.md` (Codex Memory River bugs + the
  push/pull memory design). Read that first; this doc assumes the Codex Memory
  River layer exists.

> 中文導讀：這份是把 Codex 包成「像 OpenClaw 那樣會自己活著的 agent」的工程藍圖。
> 核心心智模型只有一句：**Codex 是 stateless 的 worker，所有「活著」的狀態都放在
> 外面的 orchestrator。** 下面所有設計都是這句的展開。分成 A~E 五階段，每階段
> 各自能出貨，不用一次做完。

---

## 0. The one mental model (everything depends on this)

Codex CLI is **invocation-scoped**: you call it, it does one thing, it exits. An
OpenClaw-like agent is **persistent and stateful**. The only way to bridge this
without fighting Codex's grain:

> **The orchestrator is the agent. Codex is a stateless worker it spawns per step.**

- Persistent state (tasks, queue, memory, approvals, cost) lives in the
  orchestrator, on disk.
- Each unit of work = a fresh `codex exec` invocation. The orchestrator builds
  the full prompt/context for that invocation (including pushed memory) because
  the worker remembers nothing between calls.
- **Anti-pattern to avoid:** trying to make Codex itself remember across tasks,
  or keeping a Codex process alive long-term. Don't. State belongs to the
  orchestrator.

If a design choice ever conflicts with this model, the model wins.

---

## 1. Verify these about Codex CLI before building

The author's knowledge is current to ~2026-01; confirm specifics with
`codex --help` / `codex exec --help` before coding against them:

1. **Non-interactive run:** exact invocation for headless execution
   (`codex exec "<prompt>"` or equivalent), how to set the working directory,
   and how to pass an approval/sandbox policy.
2. **Output capture:** can you get structured output (JSON) or only stdout? Where
   does it write the session rollout file, and can you get that path back so the
   memory indexer can index the run afterward?
3. **Sandbox flags:** what command/network/filesystem sandboxing Codex exposes,
   so the exoskeleton can layer its own allowlist on top rather than duplicate it.
4. **Config:** `~/.codex` config format and whether per-invocation overrides
   (model, sandbox, cwd) are possible via flags vs config file.

Record the answers in this doc when found — they pin down the worker interface.

Verified on 2026-05-31:

- Non-interactive run is `codex exec [PROMPT]`; use `-C <DIR>` to set the worker
  cwd.
- `codex exec --json` prints JSONL events to stdout. `-o <FILE>` writes the last
  agent message to a file.
- `codex exec` supports `--sandbox read-only|workspace-write|danger-full-access`,
  `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, and
  `--ignore-rules`.
- Top-level Codex supports `--ask-for-approval`, model/config/profile overrides,
  and sandbox selection. Keep approval/sandbox handling isolated in the worker
  wrapper because the exact accepted flag position can change.
- Phase A implementation currently uses a fake worker and does not spawn
  `codex exec`; this prevents tests from consuming quota or mutating repos.

---

## 2. Target architecture

```
   Gateway (inbound: human commands)
   Triggers (wake: cron / webhook / events)
   Egress  (outbound: proactive reports, summaries)
                     |
        ┌────────────┴─────────────┐
        |        ORCHESTRATOR        |  ← the persistent "agent"
        |  task queue + state machine|
        |  per-repo lock             |
        |  cost guard + kill switch  |
        |  run log + cost ledger     |
        └────────────┬─────────────┘
                     |
     Memory (push/pull)  ←→  Approval (async, human-in-loop)
                     |
   Codex exec  (stateless worker, one git worktree per task)
```

Each box = a module with a narrow responsibility. Build bottom-up: the
orchestrator + worker spine first, channels last.

---

## 3. Core data models

State lives under a new root, e.g. `~/.codex/agent/` (keep separate from
Codex Memory River state; reuse `.local-agent-state` for dev). Append-only JSONL
where possible, mirroring Codex Memory River's style.

### 3.1 Task record (`agent/tasks/<id>.json`, mutable; full history appended)

```json
{
  "id": "task_<ts>_<hash>",
  "source": "cli|telegram|discord|cron|webhook",
  "requester": "user-id or 'local'",
  "repo": "/abs/path/to/repo",
  "request": "natural-language task",
  "mode": "plan|execute",
  "status": "queued",
  "approval": "not_required|required|granted|denied",
  "worktree": null,
  "attempts": 0,
  "max_attempts": 2,
  "cost": { "tokens": 0, "usd_estimate": 0 },
  "created_at": "ISO",
  "updated_at": "ISO",
  "history": [
    { "ts": "ISO", "state": "queued", "note": "...", "codex_session": null }
  ],
  "result": {
    "summary": null,
    "diff_ref": null,
    "tests": null,
    "artifacts": []
  }
}
```

### 3.2 Task state machine

```
queued
  → planning            (codex exec, mode=plan: produce a plan, no writes)
  → awaiting_approval    (if approval=required; emit egress, then WAIT)
  → executing            (codex exec, mode=execute, in worktree)
  → verifying            (run repo's test/lint allowlist)
  → reporting            (summarize result, emit egress)
  → done

any → failed             (error or max_attempts exceeded)
any → cancelled          (user/kill switch)
awaiting_approval → executing   (on approval granted)
awaiting_approval → cancelled   (on approval denied)
```

Rules:
- Transitions are the **only** way status changes; every transition appends to
  `history`. The orchestrator is the only writer.
- `awaiting_approval` is a true wait state: the task is parked, the orchestrator
  moves on to other tasks, and an inbound approval event resumes it. Approval is
  NOT a synchronous blocking call.
- Plan-only mode stops at `reporting` after `planning` (never enters
  `executing`). This is the safe default for remote/gateway-originated tasks.
- Phase A treats persisted `planning` or `reporting` tasks as interrupted work
  and marks them `failed` on the next `agent run`, rather than silently leaving
  non-terminal tasks orphaned.

### 3.3 Run log (`agent/runs.jsonl`, append-only)

One line per Codex invocation: `{ run_id, task_id, step, started_at, ended_at,
exit, codex_session, tokens, usd_estimate, error }`. This is the "what happened
last night" ledger, separate from the memory audit log.

### 3.4 Cost ledger (`agent/cost.jsonl`, append-only)

Per-invocation token/cost estimate, plus a rolling daily total the cost guard
reads.

Phase B implementation note: `agent/config.json` stores the local kill switch and
daily token budget. `agent/cost.jsonl` is append-only and is updated after each
fake worker invocation. The guard checks the current day's ledger before every
worker call.

---

## 4. The orchestrator loop (pseudocode)

Single long-lived process. **Single-process is a deliberate simplification** — it
means per-repo locking is just an in-memory `Set`, no distributed lock needed.
Phase B keeps this assumption: do not overlap multiple `codex-agent run`
processes for the same state directory.

```
loop forever:
  events = drain(inbound_queue)        # gateway cmds, approvals, trigger fires
  for e in events: apply(e)            # enqueue task / mark approval / etc.

  for task in runnable_tasks():        # status advanceable AND repo not locked
    if kill_switch_set(): pause_all(); break
    if interrupted(task): recover(task); continue
    if not cost_guard.ok(): pause(task, "budget"); notify(); continue
    lock(task.repo)
    try:
      advance(task)                    # run exactly one state transition
    finally:
      unlock(task.repo)

  sleep(short)                         # or block on inbound_queue
```

`advance(task)` for an active step:
1. Build the prompt: task.request + plan (if any) + **pushed Codex Memory River layer**
   (durable memories for this repo, per the push/pull rule) + tool/output
   conventions.
2. Spawn `codex exec` with cwd = task.worktree, capture stdout + session path.
3. Parse result, update task.result, append run log + cost, set next state.
4. On error: increment attempts; retry or → failed.

Key point: because the worker is stateless, **step N's prompt must carry
everything step N needs** — the orchestrator reconstructs context each time. This
is also where the push/pull memory discipline matters: inject the curated layer,
not the whole transcript.

---

## 5. Component specs (the pieces beyond memory + gateway)

Ordered by how load-bearing they are.

### 5.1 Orchestrator + task state machine  — **the spine; build first**
- Responsibility: own the queue, run the state machine, spawn workers, persist.
- Interface (CLI to start): `agent submit --repo X --request "..." --mode plan`,
  `agent status [task_id]`, `agent cancel task_id`, `agent run` (start the loop).
- Done when: you can submit a plan-only task from the CLI, watch it go
  queued→planning→reporting→done, and the plan appears in `result.summary`, with
  a run logged. No gateway yet. Worktrees start in §5.3 with execute-mode tasks.

### 5.2 Worker invocation contract (Codex exec wrapper)
- Responsibility: the one place that knows how to call Codex. Builds prompt,
  sets cwd/sandbox, runs, captures stdout + session path + exit + token estimate.
- Keep it the ONLY Codex-coupled module besides the memory `session-parser`.
- Done when: `runCodexStep(promptParts, {cwd, mode})` returns
  `{ text, sessionPath, exit, tokens }` reliably and is unit-tested with a fake
  codex binary.

### 5.3 Per-task worktree / sandbox
- Responsibility: never run a remote task on the user's working tree. Create a
  `git worktree add` under `agent/worktrees/<task_id>` off a chosen base; enforce
  a repo allowlist; pass command/network restrictions to Codex's sandbox; wrap in
  a timeout.
- Done when: an execute-mode task mutates only its worktree; the source checkout
  is untouched; worktree is cleaned up (or kept on failure for inspection).

### 5.4 Triggers / scheduler (wake-up)
- Responsibility: time/event sources that enqueue tasks. Start with cron-style
  config → `agent submit`. Webhooks later.
- Distinct from gateway: gateway = human pushes a command; triggers = the agent
  wakes itself.
- Done when: a cron entry like "every day 09:00, submit `recall + summarize
  yesterday` for repo X" reliably enqueues and runs.
- Phase B implementation note: the repo still does not install cron or run a
  daemon. The wake primitive is the safe single-shot `codex-agent run`, which an
  external scheduler may call after the operator configures it.

### 5.5 Cost guard + kill switch  — **do this early, before any autonomy**
- Responsibility: before every worker spawn, check a daily token/usd budget and a
  kill-switch file. On exceed: park tasks, notify, stop spawning.
- Why early: a scheduled/retry loop on a $20 plan can burn quota overnight. This
  is the seatbelt; install it before the car can drive itself.
- Done when: lowering the budget to ~0 parks new work and emits one
  notification; `codex-agent pause` halts the loop cleanly.
- Phase B implementation note: `codex-agent budget --tokens N`, `codex-agent
  pause`, and `codex-agent resume` control local seatbelts. Budget or kill-switch
  stops leave queued tasks queued and append a task-history note once per reason;
  the worker is not invoked. The daily budget is a soft UTC-day ceiling: a single
  worker invocation may push the ledger over the limit, and later invocations are
  parked.

### 5.6 Approval protocol (async, human-in-loop)
- Responsibility: at `awaiting_approval`, emit an egress message with the plan +
  a task id; park the task; resume on an inbound approve/deny event.
- It's a state + two events, not a blocking prompt. Survives orchestrator
  restart (state is on disk).
- Done when: a `--mode execute` task with `approval=required` pauses after
  planning, and a CLI `agent approve task_id` resumes it into executing.

### 5.7 Egress / notifier (proactive output)
- Responsibility: channel-agnostic `notify(channel, task_id, message)`. Summarize
  — never dump raw logs or secrets back to chat. Reuse Codex Memory River's
  secret-scan on all outbound text.
- Done when: task completion / blocked / failed each emit a concise summary to a
  stub channel (stdout), and the channel adapter is swappable.

### 5.8 Gateway (inbound) — **last, and read-only first**
- Phase-1 commands only mirror the memory bot: `/status /recall /preflight
  /rehydrate /candidates /maintain` + `agent submit --mode plan` + `agent
  status` + `agent run` for plan-only queued tasks + `agent approve TASK_ID`
  / `agent reject TASK_ID` for pending approval records. No execute, no shell,
  no auto-approve.
- Shares channel adapters with egress; shares allowlist + audit.
- Done when: from Telegram/Discord you can submit a plan-only task and read its
  status, with user-id allowlist enforced and every command audited. Execute mode
  stays CLI-only until 5.6 + 5.3 are solid.
- Phase C core implementation note: the repo now has a channel-agnostic local
  gateway core and CLI smoke path (`codex-agent gateway --from USER --text
  "agent status"`). It supports allowlisted `status`, `agent status`, and
  `agent submit --repo X --request "..."` text commands. It also supports
  allowlisted `agent run`, which invokes the same single-shot, plan-only,
  Phase-B-seatbelted runner as the local CLI. `runAgentOnce` explicitly refuses
  non-plan tasks before invoking the worker; future execute-mode work must be
  routed through Phase D approval before any remote channel can advance it. The
  Phase D skeleton adds `agent approve TASK_ID` and `agent reject TASK_ID` for
  tasks already in `approval: "pending"` state; pending tasks are skipped by
  `runAgentOnce` until approved, and rejected tasks are marked failed. The local
  chat envelope stores allowlisted free-form Telegram messages in
  `chat-inbox.jsonl`, generate local draft prompt files with `draft` /
  `draft-latest`, create tracked local handoff task files with `handoff` /
  `handoff-latest`, inspect bridge state with `chat-status` / `handoff-status`,
  prune old local raw chat state with `chat-prune --days N`, and queue manual
  replies with `codex-agent reply --id INBOX_ID --text "..."`
  / `--from-file FILE`, `codex-agent reply-latest --text "..."`, or
  `handoff-complete --id HANDOFF_ID --from-file FILE` /
  `handoff-complete-latest --from-file FILE`; `telegram-poll` sends queued
  replies and marks them sent. Exchange-0 adds a separate local multi-agent
  mailbox baseline with `agent-enable`, `exchange-submit`, `exchange-inbox`,
  `exchange-claim`, `exchange-release`, `exchange-reply`, `exchange-prune`, and
  `exchange-status`; this writes local message, claim, and reply JSONL ledgers
  but does not dispatch to Codex, Claude, OpenClaw, or shared memory. Exchange
  is single-process/manual only: claims have leases and local agent-registry
  checks, but there is still no multi-process atomic claim or real adapter
  execution. `bridge-once` is a convenience wrapper around one Telegram poll
  plus local inbox/status reporting; it sends already queued replies but does
  not generate replies. `codex-reply-once` is a fake-runner skeleton that drafts
  a reply for an inbox entry and queues it through `queueChatReply`; it uses an
  injectable runner whose production default is a clearly marked local fake, with
  no real `codex exec`, model, shell, or network, and still requires
  `bridge-once`/`telegram-poll` to send. `telegram-codex-once` is the one
  explicit, single-shot path that invokes real `codex exec` (read-only sandbox,
  `execFile`, no shell): it requires `--allow-real-codex`, is gated by the
  allowlist, the Phase B kill switch and daily token budget, a prompt secret-scan
  before invocation, and the `queueChatReply` secret/empty guard, and it appends
  a cost-ledger estimate. It is idempotent and retry-safe per inbox entry
  (existing queued/sent reply skips the model; queue rejection and pre-queue
  model failures stay retryable; successful model replies are recorded in
  `codex-replies.jsonl`) and applies a per-chat rate guard (default one
  model-generated reply per chat per 60s). It is manual single-shot only — not a
  daemon, webhook, scheduler, or automatic background chat, and not wired into
  Telegram polling. By default it replies only to a message received in the
  current poll; `--id <inbox_id>` is a manual retry for an existing/consumed
  inbox entry and still runs every gate. It takes a local single-process run lock
  (`telegram-codex.lock`, stale-broken after a TTL, released in finally) and
  supports `--require-reply-approval`, which parks the generated reply in a local
  approval ledger (`reply-approvals.jsonl`) instead of sending; an operator
  approves it into the normal queue (`reply-approval-approve`/`-reject`). The real
  Codex prompt is passed on stdin (not argv), so inbound text is not exposed in a
  process listing. Cost accounting uses real Codex token usage when the runner can
  parse codex's `tokens used` line (cost ledger + summary carry
  `cost_source:"codex_usage"`), falling back to the heuristic estimate
  (`cost_source:"estimate"`) otherwise. A local policy
  (`telegram-codex-policy`/`-set`) holds loop-readiness config (disabled by
  default, `require_approval` true, per-chat + global model-reply intervals,
  max-calls-per-run); enabling the loop without approval is refused.
  `telegram-codex-once` enforces the per-chat and global intervals;
  `telegram-codex-loop-dry-run` reports loop readiness without polling, calling
  Codex, or sending. `telegram-codex-loop` is a bounded, manually-started loop: a
  fixed `--iterations` of approval-mode `telegram-codex-once` with optional sleep
  between, refusing to start unless the policy is enabled with require_approval
  and `--allow-real-codex` is set; it never auto-approves/sends and stops early on
  kill switch / budget / lock. It is not a daemon/service. Remaining gap before an
  unattended service: a distributed/concurrency policy (the lock is single-process
  only) and an installed service — intentionally not built. Telegram Codex replies
  are NOT the live session: each run reconstructs context (direct-reply
  instructions + recent same-chat Telegram history, capped + optional in-process
  Memory River context block for a configured repo) and feeds it to a fresh
  `codex exec`. Memory is off by default, requires a `default_repo`, and fails
  closed (`reason:"memory_context_failed"`) before invoking Codex; same-chat-only,
  denied users excluded, char-capped, secret-scanned, no OpenClaw DB. Unattended
  operation is supported as drafting-only: `telegram-codex-service-print`/`-write`
  generate systemd `--user` unit+timer text (the CLI never runs systemctl or
  installs/starts anything; the token lives in an operator-created EnvironmentFile,
  never the repo/config), the timer runs the approval-forced bounded loop so it
  only produces pending approvals, and `telegram-codex-approval-send` lets the
  operator approve+send one reply (no Codex call). There is no direct auto-send;
  approval-before-send remains mandatory. DS0 (dry-run) adds a deterministic
  inbound classifier + output guard + hash-only decision audit
  (`direct-send-audit.jsonl`) that records what a future direct-send *would*
  decide (`would_auto_send`/`approval_required`) without sending or changing
  routing; no model classifier, no Memory River in the decision; direct-send
  policy is off-by-default and refuses memory/action-claim enablement. DS1
  (actually auto-sending casual classes) is intentionally not implemented.
  R1 near-realtime: `pollTelegramOnce` gained a `longPollSeconds` option (default
  0, existing paths unchanged) threaded into the `getUpdates` `timeout`, and
  `telegram-codex-bridge` is a foreground long-poll scheduler that calls the
  approval-forced `telegram-codex-once` per cycle — one read-only `codex exec` per
  message, on-disk JSONL authoritative, no in-memory session state. It refuses
  unless `--allow-real-codex` + policy `enabled` + `require_approval`, never
  direct-sends (replies are pending approvals; DS0 audit still runs), backs off
  (capped 60s, reset on success) on errors, bounds via `--max-cycles` /
  `--max-runtime-seconds` / `AbortSignal` (SIGINT/SIGTERM stop after the current
  cycle), and writes a heartbeat (`telegram-codex-bridge-status`).
  `telegram-codex-service-*  --mode bridge` generates a `Type=simple`,
  `Restart=always` systemd `--user` bridge unit (no timer, token via
  EnvironmentFile; CLI still never runs systemctl). No webhook, no public endpoint;
  one long-poller per bot token (Telegram returns 409 on a second), so the bridge
  and the timer are mutually exclusive for a given token.
  This is not an automatic AI reply path and does not connect to a Codex chat
  session. The gateway writes
  `agent/gateway-audit.jsonl` without raw inbound text, and secret-scans
  outbound replies. Telegram update adapter core maps local update JSON to
  `sendMessage` payloads for this gateway. Single-shot `codex-agent
  telegram-poll` reads `TELEGRAM_BOT_TOKEN`, calls `getUpdates` once, sends
  gateway replies, and stores only the next update offset. The default transport
  is Node `fetch`; `--transport curl` is an explicit fallback for environments
  where curl can reach Telegram but Node fetch cannot. The curl fallback crosses
  a subprocess boundary: it uses `child_process.execFile` with fixed args, no
  shell, and the bot token in stdin curl config rather than argv. Telegram
  webhook / long-running daemon and Discord adapters are still not implemented.

### 5.9 Observability
- Run log (3.3) + cost ledger (3.4) + an `agent log` command to replay "what
  happened." Cross-cutting; grows as you add the above.

---

## 6. Phased build plan (each phase ships independently)

| Phase | Contents | Ships as | Done when |
|---|---|---|---|
| **A. Spine** | 5.1 orchestrator + state machine, 5.2 worker contract, 5.9 run log | Local CLI agent: submit→plan→done | plan-only task runs end-to-end from CLI and is logged |
| **B. Seatbelt + wake** | 5.5 cost guard + kill switch, per-repo lock, 5.4 wake primitive | Scheduler-safe local agent that can't overspend | external scheduler can call single-shot run; budget=0 parks work; kill switch halts |
| **C. Voice** | 5.7 egress, 5.8 read-only gateway | Channel-agnostic local gateway core first; phone adapter next | local allowlisted text command can submit plan + read status with audit |
| **D. Consent** | 5.6 approval protocol end-to-end | Execute tasks gated by human approval | execute task pauses, `agent approve` resumes it |
| **E. Hands** | execute-mode remote tasks with full guardrails on | OpenClaw-like remote coding agent | remote execute task runs in worktree, reports diff+tests, after approval |

Stop and live on each phase for a while before the next. Phase A alone is already
useful (a local task runner with memory). Phases C–E are where the real
distributed-system + security surface appears — do not rush them.

---

## 7. Engineering scope, honestly

- **Bigger than Codex Memory River**, by roughly a factor — but it decomposes, and
  ~90% is plumbing (process management, JSON state, IO, parsing), not research.
- **Phase A is the bulk of the genuinely new design** (state machine + worker
  contract). Once it exists, B–E mostly hang capabilities off it.
- Risks that actually bite a solo build:
  1. Trying to do all 5 phases before using any → never ships. Mitigation: the
     phase table; each is independently usable.
  2. Letting Codex-the-builder design the async/approval/state parts itself →
     it under-designs long-horizon state. Mitigation: hand it *this doc's* models
     and "done when" criteria as the spec; let it write code, not architecture.
  3. Skipping 5.5 cost guard until "later" → an overnight loop burns the budget.
     Mitigation: it's in Phase B, before any self-waking autonomy.

---

## 8. Anti-goals / guardrails (carry over from the roadmap, still hold)

- No fully automatic memory writes — candidate → approve only.
- No auto-approve of execute-mode tasks; no shell-from-chat in early gateway.
- Don't mix OpenClaw's Memory River data into this system.
- Don't keep a Codex process alive long-term or push cross-task state into Codex
  — state is the orchestrator's, always (see §0).
- All outbound text passes secret-scan; no raw logs to chat.

---

## 9. For the builder (Codex), start here

1. Read `OPUS_REVIEW_2026-05-29.md`, finish Codex Memory River to v0.3 first.
2. Do §1 (verify Codex CLI flags) and record answers in this doc.
3. Build **Phase A** only. Treat §3 data models and §4 loop as the contract.
   Use the "Done when" in the §6 table as your acceptance test. Stop at the end
   of Phase A and report back before starting Phase B.
