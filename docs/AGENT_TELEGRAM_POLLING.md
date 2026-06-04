# Codex Agent Telegram Polling Runbook

This advanced runbook is for the source-tree `codex-agent` Telegram polling
path. The top-level README has the shorter install and smoke-test path.

## Scope

Implemented:

- single-shot `getUpdates`
- allowlisted gateway commands
- `sendMessage` replies
- remote `agent run` for plan-only queued tasks
- approval skeleton commands: `agent approve TASK_ID`, `agent reject TASK_ID`
- free-form Telegram messages from allowlisted users are queued in local inbox
- local `telegram-state.json` offset tracking
- no raw Telegram update persistence except allowlisted free-form inbox entries

Not implemented:

- webhook
- daemon or long-running service
- installed cron/systemd timer
- automatic AI replies or Codex chat-session bridge
- execute mode
- real `codex exec`

## Manual Smoke Test

1. Export the bot token in the shell that will run the poller:

```sh
export TELEGRAM_BOT_TOKEN='...'
```

Do not put the token in agent config, audit logs, task requests, or durable
memories.

2. Send a message to the bot from Telegram:

```text
agent status
```

3. Run one poll:

```sh
node bin/codex-agent.js telegram-poll --state ~/.codex/agent
```

If Node's built-in `fetch` times out but `curl` works on this machine, use the
explicit curl transport:

```sh
node bin/codex-agent.js telegram-poll --state ~/.codex/agent --transport curl
```

The curl transport spawns the system `curl` binary with `child_process.execFile`
and fixed arguments. It does not use a shell. The bot token is passed through
curl config on stdin, not as a process argument. This makes `curl` a local
trusted runtime dependency when the fallback transport is enabled.

If the user is not allowlisted yet, the bot should reply:

```text
Access denied.
```

4. Read the denied user id from the gateway audit:

```sh
tail -n 5 ~/.codex/agent/gateway-audit.jsonl
```

The audit stores `user_id`, `command`, `allowed`, `ok`, `task_id`, and
`text_hash`. It does not store raw inbound Telegram text.

5. Allow the Telegram user id:

```sh
node bin/codex-agent.js allow-user --state ~/.codex/agent --user '<telegram_user_id>'
```

6. Send another message to the bot:

```text
agent help
```

7. Run one poll again:

```sh
node bin/codex-agent.js telegram-poll --state ~/.codex/agent
```

Expected reply shape in Telegram:

```text
Commands:
agent status [task_id]
agent submit --repo /path --request "Plan the next safe change"
agent approve task_...
agent reject task_...
agent run task_...
agent ask opus --text "Review this"
agent inbox opus
agent replies codex [--thread thread_id]
agent thread msg_...
@opus Review this
@opus inbox
@codex replies
```

Send a status command:

```text
agent status
```

Then poll once more. Expected reply shape in Telegram:

```text
Tasks: 0 queued=0 done=0 failed=0 runs=0 kill_switch=false remaining_tokens=20000
```

8. Submit a plan-only task:

```text
agent submit --repo /path/to/repo --request "Plan the next safe change"
```

Then poll once:

```sh
node bin/codex-agent.js telegram-poll --state ~/.codex/agent
```

This only enqueues a plan task. It does not run the worker. Approve the returned
`task_...`, then run that exact task from Telegram:

```text
agent approve task_...
agent run task_...
```

Then poll once:

```sh
node bin/codex-agent.js telegram-poll --state ~/.codex/agent
```

Expected reply shape in Telegram:

```text
Run: advanced=1 tasks=1 queued=0 done=1 failed=0 kill_switch=false remaining_tokens=19818
```

The same operation is available from the local CLI:

```sh
node bin/codex-agent.js run --state ~/.codex/agent
```

Approval commands are also available through Telegram for tasks that are already
in `approval: "pending"` state:

```text
agent approve task_...
agent reject task_...
```

Plan-only `agent submit` tasks do not require approval. The approval commands
are present to pin the Phase D state transition boundary before execute mode
exists.

9. Queue a free-form message without automatic execution:

```text
Can you look at the next bridge step?
```

Then poll once. The message is stored in `chat-inbox.jsonl` only if the Telegram
user is allowlisted; the bot does not auto-reply.

Read the local inbox:

```sh
node bin/codex-agent.js inbox --state ~/.codex/agent
```

Check bridge status:

```sh
node bin/codex-agent.js chat-status --state ~/.codex/agent
```

The local multi-agent exchange is separate from the Telegram-specific inbox.
It is the mailbox for Codex/Claude/OpenClaw handoffs:

```sh
node bin/codex-agent.js exchange-submit --state ~/.codex/agent --from human --to codex --text "Inspect this request"
node bin/codex-agent.js agent-enable --state ~/.codex/agent --agent codex --kind coding
node bin/codex-agent.js exchange-inbox --state ~/.codex/agent --agent codex
node bin/codex-agent.js exchange-claim --state ~/.codex/agent --id msg_... --agent codex
node bin/codex-agent.js exchange-reply --state ~/.codex/agent --id msg_... --agent codex --from-file /tmp/reply.txt
node bin/codex-agent.js exchange-replies --state ~/.codex/agent --agent human
node bin/codex-agent.js exchange-thread --state ~/.codex/agent --id msg_...
node bin/codex-agent.js exchange-status --state ~/.codex/agent
```

For a manual Codex -> Opus review loop:

```sh
node bin/codex-agent.js agent-enable --state ~/.codex/agent --agent opus --kind review
node bin/codex-agent.js exchange-submit --state ~/.codex/agent --from codex --to opus --thread ds7-a --from-file /tmp/review-request.txt
node bin/codex-agent.js exchange-inbox --state ~/.codex/agent --agent opus
node bin/codex-agent.js exchange-claim --state ~/.codex/agent --id msg_... --agent opus
node bin/codex-agent.js exchange-reply --state ~/.codex/agent --id msg_... --agent opus --from-file /tmp/opus-findings.txt
node bin/codex-agent.js exchange-replies --state ~/.codex/agent --agent codex --thread ds7-a
```

Telegram routes exchange mailbox messages through shortcut commands:

```text
agent thread msg_...
@opus Please review the latest patch
opus: Please review the latest patch
@opus inbox
@codex replies
```

`@opus ...` submits to the local exchange mailbox. When
`exchange_runner_enabled=true`, the gateway also kicks the Opus auto-runner
in-process so the message is handled immediately; the periodic systemd timer is
only a fallback. Read shortcuts (`@opus inbox`, `@codex replies`, `agent thread
msg_...`) only read mailbox state.

The Opus runner claims one eligible Telegram-origin Codex -> Opus message,
spawns headless Claude with restricted settings, and replies through
`exchange-reply`. It may inspect the repo read-only, run tests, and write scratch
files under `/tmp`; file edits or external actions must be requested back through
the owner flow.

#### Agent dispatch proposals

An agent reply may propose one cross-agent handoff by ending its final reply
with one fenced JSON block:

````md
```agent-dispatch
{
  "to": "codex",
  "task": "Implement the focused dispatch callback test.",
  "reason": "Codex owns this implementation path.",
  "mode": "plan"
}
```
````

Only the agent's final reply text is parsed, and only the first
`agent-dispatch` block is considered. Exchange threads, source files, raw
Telegram text, and invalid blocks are never parsed as dispatch proposals. Valid
blocks are stripped from the Telegram-visible reply; invalid blocks stay visible
for debugging.

Dispatch approval is routing consent only. The agent cannot submit mailbox
messages itself: runner settings still deny `exchange-submit`, and Node is the
only cross-agent outlet. Owner approval creates one of two outcomes:

- `to:"opus"`: Node submits an exchange message with `channel:"dispatch"`.
- `to:"codex"`: Node creates an `executor:"codex"` pending task; if it is an
  edit, the normal execution approval is still required.

Dispatch approvals are stored separately in `dispatch-approvals.jsonl` with an
`outcome` pointer to the created exchange message or task. Hop count starts at
1 for the first approved dispatch and is capped at 2.

Operators can inspect dispatch approvals without reading JSONL directly:

```sh
node bin/codex-agent.js dispatch-list --state ~/.codex/agent --status pending
node bin/codex-agent.js dispatch-list --state ~/.codex/agent --status approved
node bin/codex-agent.js dispatch-show --state ~/.codex/agent --id dispatch_...
```

Continuity is per Telegram chat, not shared with the live Codex session. The
runner stores `chat_id -> session_id` and resumes Claude for later `@opus`
messages in that chat. The mailbox remains the source of truth: runner prompts
instruct Opus to read the current thread, inspect same-chat session metadata,
and then read relevant prior `exchange-thread` records instead of relying only
on opaque Claude session memory.

Inspect session continuity without exposing raw request/reply text:

```sh
node bin/codex-agent.js exchange-runner-session-status --state ~/.codex/agent
node bin/codex-agent.js exchange-runner-session-status --state ~/.codex/agent --chat-id <telegram_chat_id>
```

The status output includes `chat_id`, `session_id`, `updated_at`, recent
`message_id`/`reply_id`, and request/reply hashes only.

Generate/review the runner service, restricted settings, and drift status:

```sh
node bin/codex-agent.js exchange-runner-settings-print --state ~/.codex/agent
node bin/codex-agent.js exchange-runner-settings-write --state ~/.codex/agent
node bin/codex-agent.js exchange-runner-service-print --state ~/.codex/agent --repo /path/to/agent-river
node bin/codex-agent.js exchange-runner-service-write --state ~/.codex/agent --dir ~/.config/systemd/user --repo /path/to/agent-river
node bin/codex-agent.js exchange-runner-service-status --state ~/.codex/agent --repo /path/to/agent-river
```

`exchange-runner-service-status` reports `unit.drift`, `timer.drift`, and
`settings.drift` as `missing`, `match`, `drifted`, or `unreadable` by comparing
the installed files with the repo generator output. The generator still only
writes files; it never runs `systemctl`.

Any Telegram user in `gateway_allowlist` can use these exchange read commands
and see mailbox summaries for any agent/thread. Treat gateway allowlist
membership as operator-level mailbox visibility. The reserved exchange target
`any` is not accepted by `agent ask`; broadcast-style messages remain CLI-only.

Exchange reply notifications are opt-in. When enabled, the Telegram bridge can
push replies to Telegram-origin Codex exchange messages:

```sh
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent \
  --exchange-notify-enabled true \
  --exchange-notify-chat-id <telegram_chat_id> \
  --exchange-notify-max-per-cycle 3
```

Notifications are send-only: they read existing `exchange-replies.jsonl` rows,
send Telegram `sendMessage` chunks, and record successful sends in
`exchange-notifications.jsonl`. They do not create chat inbox rows, submit new
exchange messages, call Codex, or invoke any agent. Only replies whose original
message has `channel:"telegram"` and `from:"codex"` are eligible. Non-secret
reply text is delivered in full split into Telegram-sized chunks; secret-like
replies are withheld with only the message/reply ids for debugging.

Prune old local raw chat text, drafts, handoff files, and sent replies after a
retention window:

```sh
node bin/codex-agent.js chat-prune --state ~/.codex/agent --days 30
```

Create a local draft prompt file for the newest inbox entry:

```sh
node bin/codex-agent.js draft-latest --state ~/.codex/agent
```

Draft files are written under `~/.codex/agent/drafts/`, include the raw inbound
message text, and persist until manually deleted.

Create a tracked local handoff task for the newest inbox entry:

```sh
node bin/codex-agent.js handoff-latest --state ~/.codex/agent
node bin/codex-agent.js handoff-status --state ~/.codex/agent
```

After preparing a reply file manually, complete the handoff and queue the
Telegram reply:

```sh
node bin/codex-agent.js handoff-complete --state ~/.codex/agent --id handoff_... --from-file /tmp/reply.txt
```

For a single-operator flow, complete the newest pending handoff:

```sh
node bin/codex-agent.js handoff-complete-latest --state ~/.codex/agent --from-file /tmp/reply.txt
```

Handoffs are local markdown task files plus append-only status entries. They do
not call Codex or auto-send replies. Handoff files are written under
`~/.codex/agent/handoffs/`, include the raw inbound message text, and persist
until manually deleted.

Queue a manual reply using the inbox entry id from `codex-agent inbox`:

```sh
node bin/codex-agent.js reply --state ~/.codex/agent --id chat_... --text "Manual reply"
```

Long replies can be queued from a local file:

```sh
node bin/codex-agent.js reply --state ~/.codex/agent --id chat_... --from-file /tmp/reply.txt
```

For a single-operator smoke test, reply to the newest inbox entry:

```sh
node bin/codex-agent.js reply-latest --state ~/.codex/agent --text "Manual reply"
```

`draft-latest`, `handoff-latest`, and `reply-latest` target the newest inbound
message across all Telegram chats. `handoff-complete-latest` targets the newest
pending handoff. Use explicit ids from `inbox` or `handoff-status` for precise
targeting.

Poll again to send queued manual replies:

```sh
node bin/codex-agent.js telegram-poll --state ~/.codex/agent
```

For local smoke tests, `bridge-once` combines one Telegram poll with a local
inbox/status summary:

```sh
node bin/codex-agent.js bridge-once --state ~/.codex/agent --transport curl
```

It does not call Codex or generate replies. It only receives Telegram updates,
sends already queued manual replies, and reports the latest local inbox state.
Smoke test note: prefer `--transport curl` on hosts where Node `fetch` is flaky.

To draft a reply for an inbox entry with the fake runner skeleton:

```sh
node bin/codex-agent.js codex-reply-once --state ~/.codex/agent --id chat_...
```

If `--id` is omitted it targets the latest inbox entry. `codex-reply-once` is a
**fake-runner skeleton only**: it builds a conservative prompt and a clearly
marked local draft, but does **not** call real `codex exec`, a model, a shell,
or the network, and is **not** autonomous execution. The draft is queued through
the same secret/empty guards as a manual reply and is only delivered when you
later run `bridge-once` / `telegram-poll`.

### Real Codex reply: `telegram-codex-once`

```sh
node bin/codex-agent.js telegram-codex-once --state ~/.codex/agent --transport curl --allow-real-codex
```

This is an **explicit, single-shot, real `codex exec`** invocation that **may
spend model quota**. One manual cycle: poll Telegram once → pick the latest
allowlisted free-form inbox entry → run one real Codex reply → queue it through
`queueChatReply` → poll once more to send → exit. It is **not** a daemon,
webhook, scheduler, or automatic background chat, and it is **not** wired into
`telegram-poll`/`bridge-once`; you must run it yourself each time.

**Context, not a live session.** This is NOT connected to your live Codex
session. Following the orchestrator-keeps-state / Codex-is-a-stateless-worker
principle, each run **reconstructs** context from local state and feeds it to a
fresh `codex exec`: the direct-reply instructions + recent **same-chat** Telegram
history (prior inbound messages and sent replies, capped by count and chars) +,
optionally, a **Codex Memory River** context block for a configured repo + the
incoming message. Only allowlisted same-chat history is included; tool logs and
gateway audits are never read; the assembled prompt is secret-scanned before
`codex exec`. To enable repo memory:

```sh
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent --default-repo /path/to/repo --memory-enabled true
# tune history/size if needed:
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent --history-messages 8 --context-max-chars 6000
```

Memory is **off by default** and cannot be enabled without a `--default-repo`. If
the memory preflight fails, the run returns `reason:"memory_context_failed"` and
does **not** invoke Codex. Memory uses the in-process Memory River
preflight/context-block (brief mode) — it never shells out and never reads
OpenClaw's database.

**Direct reply vs. manual draft mode.** These two commands use different prompts:

- `codex-reply-once` is **manual draft mode** — its prompt frames the output as a
  draft for *you* to review before sending, so it may read like advice
  ("you could reply…"). Nothing is sent automatically.
- `telegram-codex-once` is **direct reply mode** — its prompt instructs the model
  to write the reply message itself, in the user's language, with no meta
  commentary (no "可以回", "建議回覆", "Draft:", "Reply:") and no claims of having
  performed actions. The model output is sent to the user **as-is** after the
  `queueChatReply` empty/secret guards. The reply is shaped by the prompt; there
  is **no** post-processing that strips prefixes.

Safety gates (all enforced before the model is invoked):

- **`--allow-real-codex` is required.** Without it the command fails closed and
  no runner is called.
- **Allowlist:** only free-form messages from allowlisted users reach the inbox,
  so only those can be answered.
- **Phase B seatbelts:** the kill switch (`pause`) and the daily token budget
  (`budget --tokens N`) both block the model invocation; an exhausted budget or
  an active kill switch returns `queued:false` with the reason and runs nothing.
  The local budget can be turned off with `budget --tokens disabled` (aliases:
  `off`, `none`, `unlimited`), which stores an effectively-unreachable budget so
  the token gate never trips — use this when the model/provider plan is the real
  cap. The kill switch is independent and still blocks even when the budget is
  disabled.
- **Prompt secret-scan:** the prompt (which embeds the inbound message) is
  secret-scanned first; a hit returns `queued:false reason:prompt_secret` and the
  model is not called.
- **Read-only sandbox:** Codex runs with `--sandbox read-only` via `execFile`
  (no shell), so it cannot mutate repo files.
- **Reply secret/empty guard:** the generated reply still passes through
  `queueChatReply`, so empty or secret-like output is rejected before queueing.
- **Cost ledger:** a conservative token estimate is appended to the cost ledger
  after each invocation.

It is **idempotent and retry-safe per inbox entry** (still single-shot/manual):

- If a reply for the selected inbox is already **sent**, it returns
  `reason:"already_replied"` and does **not** invoke the model.
- If a reply is already **queued** (e.g. a previous send failed), it skips the
  model and only re-sends the queued reply (`reason:"already_queued"`). A
  successful run later sends it and reports `already_replied`. So repeated runs
  never produce a second real Codex call for the same message.
- If the model fails *before* a reply is queued, a later run may retry the model.
- If `queueChatReply` rejects the model output (empty/secret), it returns
  `reason:"reply_rejected"` and does **not** mark the inbox replied (retry
  allowed); the model invocation is still charged to the cost ledger.
- A successful model reply is recorded in `~/.codex/agent/codex-replies.jsonl`
  for the rate guard.

It also applies a **per-chat rate guard**: at most one model-generated reply per
chat per 60 seconds. A second (different) message from the same chat inside that
window returns `reason:"rate_limited"` without invoking the model; other chats
are unaffected.

The real Codex prompt is passed to `codex exec` on **stdin**, never as a process
argument, so the inbound text is not visible in a local process listing (`ps`).
This closes the ps-visible prompt-exposure risk for `telegram-codex-once`.

**Cost accounting** uses **real Codex token usage when parseable**: the runner
parses codex's `tokens used` line from stdout (or stderr), and the cost-ledger
entry plus the run's JSON summary carry `cost_source:"codex_usage"` with the real
token count. When codex prints no parseable usage, it falls back to the heuristic
word-count estimate and reports `cost_source:"estimate"`. Raw stdout/stderr are
never included in the summary or logs (only the parsed integer is used).

Rate policy is now explicit. `telegram-codex-once` enforces both a **per-chat**
and a **global** model-reply interval (defaults 300s each, from the local
policy); a hit returns `reason:"rate_limited"` or `"global_rate_limited"` with a
`rate` object. Inspect/adjust the policy with `telegram-codex-policy` /
`telegram-codex-policy-set`. The production-safe command is still
`telegram-codex-once` run **manually**.

```sh
# view the policy + derived safety summary
node bin/codex-agent.js telegram-codex-policy --state ~/.codex/agent

# adjust (intervals must be positive; loop cannot be enabled without approval)
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent --per-chat-interval-seconds 120

# readiness diagnostic for a hypothetical future loop — no poll, no Codex, no send
node bin/codex-agent.js telegram-codex-loop-dry-run --state ~/.codex/agent
```

The dry-run is a diagnostic only: it does not poll Telegram, call Codex, or send
anything — it just reports what a loop *would* do (policy, lock, safety, whether
the global/per-chat rate would block, and whether an inbox entry is available).

#### Bounded manual loop (`telegram-codex-loop`)

`telegram-codex-loop` runs a **fixed number** of `telegram-codex-once` iterations
(always in approval-before-send mode) with an optional sleep between them, then
exits. It is **not** a daemon/service — nothing is installed, there is no infinite
loop, and you start it yourself. It refuses to start unless the policy has
`enabled=true` **and** `require_approval=true`, and `--allow-real-codex` is passed.

```sh
# 1) enable the loop in policy (approval stays required)
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent --enabled true

# 2) run a bounded loop (3 iterations, 30s between them)
TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" node bin/codex-agent.js telegram-codex-loop --state ~/.codex/agent --transport curl --allow-real-codex --iterations 3 --sleep-seconds 30

# 3) the loop only PARKS replies as pending approvals — review and act on them:
node bin/codex-agent.js reply-approval-list --state ~/.codex/agent
node bin/codex-agent.js reply-approval-approve --id approval_... --state ~/.codex/agent
node bin/codex-agent.js reply-approval-reject  --id approval_... --state ~/.codex/agent

# 4) send approved replies (the loop's next poll, or an explicit poll, delivers them)
TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" node bin/codex-agent.js bridge-once --state ~/.codex/agent --transport curl
```

`--iterations` is required (positive integer); `--sleep-seconds` defaults to the
policy global interval (non-negative). The loop **never approves or sends Codex
replies automatically** — every generated reply is a pending approval. It stops
early on `kill_switch`, `daily_token_budget`, or `locked`. No sleep happens after
the final iteration.

#### Unattended drafting via systemd `--user` (no auto-send)

"Unattended" here means **unattended *drafting* into the approval queue**, never
unattended sending. A systemd `--user` timer can run the bounded, approval-only
loop periodically so replies are drafted as pending approvals while you're away;
you still approve/send each one yourself. This repo **generates** the unit files
but **never installs, enables, starts, or runs `systemctl`** — those steps are
yours.

Setup:

```sh
# 1) enable the loop policy (approval stays required; optionally repo memory)
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent --enabled true \
  --default-repo /path/to/repo --memory-enabled true

# 2) create the env file with your bot token (NEVER stored in the repo or unit)
mkdir -p ~/.config/codex-agent
printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TELEGRAM_BOT_TOKEN" > ~/.config/codex-agent/telegram.env
chmod 600 ~/.config/codex-agent/telegram.env

# 3) review the generated unit/timer, then write them (write only — no install)
node bin/codex-agent.js telegram-codex-service-print --state ~/.codex/agent
node bin/codex-agent.js telegram-codex-service-write --state ~/.codex/agent --dir ~/.config/systemd/user
node bin/codex-agent.js telegram-codex-service-status --state ~/.codex/agent

# 4) YOU run systemd manually (the CLI never does this):
systemctl --user daemon-reload
systemctl --user enable --now codex-agent-telegram.timer
#   logs:    journalctl --user -u codex-agent-telegram.service
#   stop:    systemctl --user disable --now codex-agent-telegram.timer

# 5) approve + send a drafted reply (operator-triggered; does not call Codex)
node bin/codex-agent.js reply-approval-list --state ~/.codex/agent
node bin/codex-agent.js telegram-codex-approval-send --id approval_... --state ~/.codex/agent --transport curl
```

The generated unit runs `telegram-codex-loop … --iterations 1 --sleep-seconds 0`
(approval-forced), uses `EnvironmentFile=%h/.config/codex-agent/telegram.env` for
the token, and `WorkingDirectory` = the repo. `telegram-codex-approval-send`
approves a pending reply and polls once to deliver it (needs `TELEGRAM_BOT_TOKEN`;
never invokes Codex). By default the timer only drafts pending approvals. DS1
direct-send can auto-send only the narrow casual classes described below, and
only when explicitly enabled for a direct-send allowlisted user.

Direct-send remains off by default. Anything outside the DS1 casual classes, or
anything failing the deterministic gates, still routes to the approval queue.

#### Near-realtime bridge (`telegram-codex-bridge`) — R1

The **bridge** is a foreground, long-running process that gives near-realtime
*receipt + drafting* without any public endpoint. It is **only a scheduler**: each
cycle it long-polls Telegram once and calls the existing single-shot
`telegram-codex-once`. Codex stays invocation-scoped (one read-only `codex exec`
per message), on-disk JSONL stays authoritative, and replies normally park as
pending approvals. If DS1 direct-send is explicitly enabled, only narrow
casual-class replies can bypass approval; everything else remains approval-first.

**Bridge vs. timer — pick one, not both, per bot token:**

- **Timer** (`telegram-codex-service-print/write` default, oneshot loop): wakes on
  a schedule, polls with `timeout:0` (catches only already-arrived updates), then
  exits. Latency floored at the timer interval. Cold node+codex spawn per fire.
  Good low-footprint fallback.
- **Bridge** (R1): one persistent process owns a **long-poll** `getUpdates`
  (`timeout≈25s`), so a new message is received within ~1s. No inbound port, no
  TLS, no public endpoint — it is still classic outbound bot polling to
  `api.telegram.org`. Near-realtime, at the cost of being a genuinely always-on
  process.

Telegram allows only **one** long-poller per bot token (a second poller, or a
webhook, makes `getUpdates` return **409 Conflict**). So: run **one** bridge per
token, and **do not run the timer and the bridge simultaneously** for the same
token. The single-process run lock guards local overlap; it is not cross-host.

Exact foreground command (manual; Ctrl-C to stop after the current cycle):

```sh
# enable the policy (approval stays required), then run the bridge in the foreground
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent --enabled true
TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" node bin/codex-agent.js telegram-codex-bridge \
  --state ~/.codex/agent --transport curl --allow-real-codex --long-poll-seconds 25

# bounded run for testing (exit after N cycles or T seconds):
TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" node bin/codex-agent.js telegram-codex-bridge \
  --state ~/.codex/agent --transport curl --allow-real-codex --max-cycles 5
```

It **refuses** unless `--allow-real-codex` is passed **and** the policy has
`enabled=true` **and** `require_approval=true`. On a cycle error it backs off
(exponential, capped at 60s; reset after a success) — never a tight error loop.
`SIGINT`/`SIGTERM` stop it cleanly after the current cycle (the in-flight long-poll
is not interrupted). Inspect the heartbeat any time:

```sh
node bin/codex-agent.js telegram-codex-bridge-status --state ~/.codex/agent
# running / last_started_at / last_cycle_at / last_inbound_at / last_error / iterations
```

Approving and sending under the bridge is identical to every other path — the
bridge only drafts:

```sh
node bin/codex-agent.js reply-approval-list --state ~/.codex/agent
node bin/codex-agent.js telegram-codex-approval-send --id approval_... --state ~/.codex/agent --transport curl
```

**Run the bridge as a systemd `--user` service (generation only — never installs):**

```sh
# review, then write the bridge unit (Type=simple, Restart=always; no timer, no token)
node bin/codex-agent.js telegram-codex-service-print --state ~/.codex/agent --mode bridge
node bin/codex-agent.js telegram-codex-service-write --state ~/.codex/agent --mode bridge --dir ~/.config/systemd/user
node bin/codex-agent.js telegram-codex-service-status --state ~/.codex/agent --mode bridge

# YOU run systemd manually (the CLI never does this):
systemctl --user daemon-reload
systemctl --user enable --now codex-agent-telegram-bridge.service
#   logs: journalctl --user -u codex-agent-telegram-bridge.service
#   stop/disable: systemctl --user disable --now codex-agent-telegram-bridge.service
```

The generated bridge unit runs `telegram-codex-bridge … --allow-real-codex`
(approval-forced), uses `EnvironmentFile=%h/.config/codex-agent/telegram.env` for
the token (never a literal), `WorkingDirectory` = the repo, `Type=simple`,
`Restart=always`. If you previously enabled the **timer** unit, disable it before
enabling the bridge so they do not both poll the same token:

```sh
systemctl --user disable --now codex-agent-telegram.timer
```

#### Direct-send DS1 (narrow casual auto-send, off by default)

DS1 is a deliberately tiny human-out-of-the-loop path. After Codex generates a
reply, the agent runs a **deterministic** inbound classifier and an output guard.
It auto-sends only when all direct-send gates pass; otherwise the reply is parked
as a pending approval. There is no model classifier, and Memory River context is
not assembled for direct-send candidates.

- Inbound is auto-send eligible only for tight `greeting`/`ack`/`smalltalk`
  classes; questions, requests/imperatives, code/paths/URLs, secrets, injection
  phrases, multi-sentence, too-long, and unsupported/uncertain text all classify
  as `approval_required`.
- The output guard rejects completion/action claims, tool/file/command references,
  secrets, over-length, and obvious language mismatch.
- Each model result appends one line to `~/.codex/agent/direct-send-audit.jsonl`
  with `class`, `decision` (`auto_sent` | `approval_required`),
  `inbound_reasons`, `output_reasons`, `gate_reasons`, `direct_send_enabled`,
  token count, and **hash-only** `text_hash`/`reply_hash` (no raw inbound or
  reply text).
- Auto-sent replies are still queued through `queueChatReply` and sent by the
  normal Telegram reply flusher. They carry `source:"direct_send"` in
  `chat-replies.jsonl`.

Enable DS1 for a specific Telegram user (who must also be in the gateway
allowlist):

```sh
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent \
  --direct-send-enabled true --direct-send-user <telegram_user_id>

node bin/codex-agent.js telegram-codex-policy --state ~/.codex/agent
tail -n 20 ~/.codex/agent/direct-send-audit.jsonl
```

Policy fields are off/conservative by default (`direct_send_enabled=false`, empty
user allowlist, `direct_send_memory=false`, `direct_send_allow_action_claims=false`).
`telegram-codex-policy-set` can adjust `--direct-send-enabled`,
`--direct-send-user`/`--direct-send-user-remove`, `--direct-send-max-chars`,
`--direct-send-daily-max`, `--direct-send-min-remaining-tokens`; enabling memory
or action claims for direct-send is **refused**. The existing kill switch, daily
token budget, per-chat/global rate guards, direct-send daily cap, minimum
remaining-token headroom, prompt/reply secret scans, run lock, and Telegram
allowlist all still apply. Disable immediately with either:

```sh
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent --direct-send-enabled false
node bin/codex-agent.js pause --state ~/.codex/agent
```

#### Direct-send DS2 (trusted Q&A auto-send, off by default)

DS2 is an explicit trusted-user extension of direct-send. It only applies when
`direct_send_enabled=true`, `direct_send_trusted_qa_enabled=true`, and the
Telegram user is already in `direct_send_user_allowlist`. It can auto-send
ordinary question/answer replies, while commands/imperatives, code, paths/URLs,
secrets, prompt-injection phrases, unsupported scripts, action claims, tool/file
references, and over-length output still route to approval.

```sh
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent \
  --direct-send-enabled true \
  --direct-send-user <telegram_user_id> \
  --direct-send-trusted-qa-enabled true \
  --direct-send-trusted-qa-max-chars 1200
```

#### Owner Mode DS3 (owner Q&A + action requests, off by default)

Owner Mode is for a private Telegram owner. It reuses
`direct_send_user_allowlist` and only applies when `owner_mode_enabled=true`.
Owner Q&A auto-sends when reply guards pass. Low-risk read-only owner action
requests such as check/status/review/summarize/explain/analyze run one
plan-only task immediately when `owner_low_risk_auto_plan_enabled=true` (the
default). Edit requests such as fix/implement/add/modify create a queued edit
task with `approval:"pending"` and send a Telegram notice with Approve / Reject
/ Status inline buttons; nothing modifies files until the owner approves.
Dangerous commit/push/deploy/delete/install requests are declined and must be
handled locally. Blocked secret/injection content gets a Telegram-visible
refusal notice. Owner paths should not silently park work.

```sh
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent \
  --direct-send-enabled true \
  --direct-send-user <telegram_user_id> \
  --owner-mode-enabled true \
  --owner-low-risk-auto-plan-enabled true
```

Owner action approval remains local/CLI-only in DS3:

```sh
node bin/codex-agent.js approve --state ~/.codex/agent task_...
```

#### Owner Mode DS4 (Telegram approval + plan/edit run)

DS4 lets the allowlisted owner approve a pending owner task from Telegram:

```text
approve task_...
```

The approved task is run once and scoped to that single task id. Plan tasks run
read-only. Edit tasks run with a workspace-write Codex sandbox, then the
orchestrator runs the fixed post-edit verification command (`npm test`) and
captures `git diff HEAD --stat` after verification. The
Telegram result notice reports diff stat and wrapper verification pass/fail.
Post-commit smoke remains an operator-triggered local check, not a Telegram or
worker action.
Edit tasks do not automatically commit, push, deploy, delete, or install
dependencies; if an edit task changes git `HEAD`, it is marked failed.

#### Owner Mode DS5 (Telegram status + reject)

DS5 adds minimal task controls for the allowlisted owner:

```text
status task_...
reject task_...
```

`status` reports only task id, status, approval, and the latest history note.
It does not include the raw request or plan summary. `reject` only rejects a
pending task. Malformed task commands get a notice instead of becoming Q&A or a
new action task. Existing `agent ...` Telegram commands continue to use the
local gateway command path.

#### Owner Mode DS7-C (inline task buttons)

Owner action notices include Telegram inline buttons:

```text
Approve | Reject | Status
```

Button callbacks use `owner:<action>:task_...`, are accepted only from the
owner allowlist, and are converted into the same owner task command flow as
typed `approve/status/reject task_...`. The bridge answers callback queries to
clear Telegram's spinner, then sends a normal result notice. Buttons do not add
edit execution and do not bypass plan-only approval rules.

#### Long Telegram replies

Queued Telegram replies and immediate gateway `sendMessage` payloads are sent
in Telegram-sized chunks. Inline keyboards are attached only to the first chunk.
A queued reply is marked sent only after every chunk succeeds; if any later
chunk fails, the reply remains queued and is retried by the next poll.

#### Run lock

`telegram-codex-once` takes a local lock (`~/.codex/agent/telegram-codex.lock`)
before polling/model/send. If another run holds a **fresh** lock it returns
`reason:"locked"` and does nothing (no poll, no model, no send). A **stale** lock
(older than ~10 minutes, e.g. left by a crash) is broken automatically. The lock
is always released when the run finishes, including on error. This is a
single-process guard; it is not a cross-host/distributed lock.

#### Approval-before-send mode (`--require-reply-approval`)

Two modes:

- **Direct mode (default):** the model reply is queued and sent in the same run.
- **Approval-before-send mode:** add `--require-reply-approval`. The run polls,
  generates the Codex reply, validates it through the `queueChatReply`
  secret/empty guard, and parks it as a **pending approval** instead of sending.
  It returns `reason:"approval_required"` with an `approval_id` and sends nothing.

```sh
# generate a reply that needs approval before it can be sent
TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" node bin/codex-agent.js telegram-codex-once --state ~/.codex/agent --transport curl --allow-real-codex --require-reply-approval

# review, then approve (queues it for the next poll to send) or reject (terminal)
node bin/codex-agent.js reply-approval-list --state ~/.codex/agent
node bin/codex-agent.js reply-approval-approve --id approval_... --state ~/.codex/agent
node bin/codex-agent.js reply-approval-reject  --id approval_... --state ~/.codex/agent
```

Approving moves the reply into the normal queued path, so the next `bridge-once`
/ `telegram-poll` (or another `telegram-codex-once`) sends it. Rejecting is
terminal and never sends. Pending approvals hold only the reply text locally
under `~/.codex/agent` (no prompt or model logs). **Any future background/looping
mode must use approval-before-send** (human approval per reply) until the
remaining blockers are closed.

#### Manual retry with `--id`

By default `telegram-codex-once` replies only to a message received in *this*
run. If a model invocation failed or `queueChatReply` rejected, the Telegram
offset is already consumed, so a plain re-run reports `no_new_inbox_entry`. To
retry that specific message, pass its inbox id (from `codex-agent inbox`):

```sh
TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" node bin/codex-agent.js telegram-codex-once --state ~/.codex/agent --transport curl --allow-real-codex --id chat_...
```

`--id` processes an existing inbox entry even when this poll received nothing. It
still runs every gate — allowlist, kill switch, daily budget, idempotency
(already-queued/sent replies skip the model), per-chat rate limit, prompt
secret-scan, and `queueChatReply`. A nonexistent id returns `inbox_not_found`
without invoking the model. The run still does one initial poll first to flush
any queued replies and advance the offset.

### Troubleshooting `telegram-codex-once`

- **`Codex produced no reply (...)`** — `codex exec` returned no usable final
  text. The runner reads the `-o` output file first and falls back to stdout; if
  both are empty it raises this error. The parenthetical is a sanitized
  diagnostic — byte counts only (`outFile`, `stdout`, `stderr`) plus
  `errored`/`timedOut` flags. It deliberately contains **no** prompt text or raw
  (possibly secret-bearing) model output.
- **`Codex exec failed (...)`** — the `codex` process errored or timed out. Same
  sanitized byte-count diagnostic. Check that `codex` is on `PATH` and that the
  read-only invocation works manually:
  `codex exec --sandbox read-only --skip-git-repo-check -o "$tmp" "Reply with exactly: hello"`.
- A failed model invocation does **not** queue a reply and does **not** mark the
  inbox replied.
- **`no_new_inbox_entry`** — the poll received no new allowlisted free-form
  message this run, so there is nothing to reply to. `telegram-codex-once`
  deliberately replies only to a message received by **this** run; it does **not**
  reply to a historical/stale latest inbox entry. Gateway commands (`agent ...`,
  `status`) and denied users do not create inbox entries and so never trigger a
  Codex reply. (Any already-queued reply from a prior run is still re-sent by the
  poll, without invoking Codex.) Targeting an older entry is reserved for a future
  explicit `--id`.
- The runner invokes `codex` from the **repo working directory** (`process.cwd()`,
  not a temp dir, which can fail with "Read-only file system") and closes
  `codex`'s stdin so it does not block on "Reading additional input from stdin".
  The `-o` output file still lives in the system temp dir.

## Safety Notes

- `telegram-poll` is single-shot. Use an external scheduler only after manual
  testing.
- `bridge-once` is also single-shot. It is a convenience wrapper around
  `telegram-poll` plus local inbox/status reporting, not an autonomous chat
  loop.
- `codex-reply-once` uses a fake local runner only. It never calls real
  `codex exec`, a model, a shell, or the network; it only queues a clearly
  marked draft through `queueChatReply`. Sending still requires a separate
  `bridge-once` / `telegram-poll`.
- Default transport is Node `fetch`; `--transport curl` is an explicit fallback.
- The curl fallback crosses a subprocess boundary: it uses the system `curl`
  found on `PATH` through `execFile`, with no shell.
- Do not overlap multiple `telegram-poll` processes against the same state
  directory.
- `telegram-state.json` stores only `next_offset`.
- `chat-inbox.jsonl` stores raw free-form text only for allowlisted users.
  Denied users are audited by hash and are not written to the inbox.
- `chat-replies.jsonl` stores manually queued outbound text locally; replies are
  sent by the next `telegram-poll` and then marked sent with an append-only
  event.
- `chat-prune --days N` is an explicit local retention tool. It rewrites the
  chat inbox and reply queue to remove old raw text, deletes matching draft and
  handoff markdown files, marks pruned pending handoffs as `expired`, and keeps
  queued replies. The handoff ledger is retained without raw inbound text; old
  completed handoffs may keep a dangling `path` after their markdown is deleted.
- `exchange-*` commands are a local mailbox baseline only. They store message/
  reply text under `~/.codex/agent`, redact secret-like submitted text (replies
  are secret-scanned/rejected), use append-only claim/reply ledgers, and prevent
  more than one active claim for the same message. They do not call Codex,
  Claude, OpenClaw, a dispatcher model, or shared memory.
- `exchange-thread --id` is a local operator inspection command: it returns any
  message and its replies by id, is not scoped to a requester, and is not an
  auth boundary.
- Exchange mailbox commands are a single-process manual baseline, not a multi-process work
  queue. Claim is read-then-append, so overlapping `exchange-claim` processes
  can race; do not run concurrent claimers against the same state directory.
- Exchange agents must be enabled locally with `agent-enable` before they can
  claim or reply. This is a local registry, not authentication for separate
  OS users or remote processes.
- Exchange claims have leases and can be released with `exchange-release`.
  Expired/released claims return the message to the open inbox. Real agent
  adapters still need a single-process dispatcher or stronger storage before
  processing mailbox work.
- `exchange-prune --days N` removes completed exchange messages, their claim
  events, and their replies after the retention window, measured from
  `message.created_at`. It keeps open, claimed, released, and expired messages.
- In `exchange-status`, `open` means claimable. Released and expired messages
  are counted as open and also counted in their diagnostic released/expired
  buckets, so these counters are not a partition.
- Keep `~/.codex/agent` private (`chmod 700 ~/.codex/agent`) because it now
  contains local task state and allowlisted free-form chat text.
- Telegram API transport errors are reported without the bot token.
- Updates are acknowledged after gateway side effects, even if `sendMessage`
  fails, to avoid duplicate task creation.
- Replies inherit gateway secret-scan behavior.
- `agent run task_...` still uses the Phase B seatbelts: kill switch, daily
  token budget, and single-process per-repo run locking. It remains plan-only
  execution, not execute mode.
- The runner refuses non-plan tasks before invoking the worker. Future execute
  mode must go through the Phase D approval protocol before any remote channel
  can advance it.
