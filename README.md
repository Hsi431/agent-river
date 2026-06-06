# Agent River

**Drive Codex and Claude coding agents from Telegram — with a human approval gate on every risky move.**

[English](README.md) · [繁體中文](README.zh-Hant.md)

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)
![Runtime deps](https://img.shields.io/badge/runtime%20deps-0-success.svg)
[![CI](https://github.com/Hsi431/agent-river/actions/workflows/ci.yml/badge.svg)](https://github.com/Hsi431/agent-river/actions/workflows/ci.yml)

Agent River is a small, local control plane that lets you queue, run, and supervise
multiple AI coding agents — Codex and Claude (Opus/Sonnet) — from your phone over
Telegram. The agents do the work; **you stay in the loop.** Plans, edits, and
cross-agent hand-offs only happen after you tap **Approve**, and high-risk actions
like commit, push, deploy, install, and delete always stay manual.

It runs entirely on your own machine, keeps all state on local disk, has **zero
runtime dependencies**, and never spawns a shell — agents are launched as bounded,
tool-restricted workers, not handed a blank cheque.

> Status: **early but usable** for local, single-operator use. The core flows —
> Telegram gateway, approvals, dispatch, runners, ledger, secret-scan — are
> covered by 360+ tests and run without `codex-memory-river`.

---

## What it feels like

```text
You      ›  agent status
Bot      ›  Tasks: 3  queued=1 done=2 failed=0  kill_switch=false  remaining_tokens=18540

You      ›  @claude review the latest diff for security issues
Bot      ›  Claude received it, working on it now. (msg_17a3…)
            … a tool-restricted, read-only Claude reviews the repo …
Bot      ›  Claude:
            Findings by severity:
            • src/auth.js:42 — token compared with == (timing leak). …
            No edits made — the review lane is read-only.

You      ›  @opus fix the typo in the README intro
Bot      ›  Pending edit task created (task_17a3…); nothing changes until you approve.
            [ Approve ]  [ Reject ]  [ Status ]
You      ›  (taps Approve)
Bot      ›  Edit task approved and completed (task_17a3…).
            Changes: README.md | 2 +-
            Verify:  pass (npm test)
```

*Illustrative. The bot replies in your language; owner-facing notices default to
Traditional Chinese for Chinese input.*

---

## Why Agent River

- 🛡️ **Approval-gated by design.** Edit tasks *always* require an explicit owner
  Approve — it's enforced server-side, so callers can't bypass it. Agents can only
  *propose* cross-agent work; routing needs your consent, and execution needs a
  second approval. There is no "just trust the model" path.
- 🧯 **Brakes that actually stop the car.** A global kill switch (`pause`/`resume`),
  a daily token budget, and per-lane daily caps. A corrupt or unreadable config
  **fails closed** — kill switch on, budget zero.
- 👥 **Two authority tiers.** A *gateway allowlist* grants bounded operator access
  (status, submit/run plan tasks, send messages). *Owner* authority — required for
  edit execution, dispatch routing, callback approvals, and model controls — needs
  owner mode plus membership in a separate owner allowlist.
- 🔒 **Least-privilege agents.** The review lane spawns a headless Claude locked to
  read-only tools by a generated settings file; the edit lane can change files but
  never commit, push, deploy, install, delete, reach the network, or dispatch to
  other agents. A disallowed `git HEAD` change is detected and fails the task.
- 🧹 **Secrets don't leak.** Inbound text, stored messages, replies, diffs, and
  test output are scanned and redacted — OpenAI/GitHub/AWS/Slack/JWT/Google and
  Telegram tokens, credentialed URLs, key assignments, and more.
- 📦 **No supply chain to trust.** Zero runtime dependencies. Every subprocess is
  launched via `execFile` — never a shell. Bot tokens travel over stdin, never into
  argv or agent state.
- 🤝 **Multi-agent, multi-workflow.** Plan and edit lanes, a read-only review
  runner, owner Q&A, deterministic direct-send for trivial acks, and
  owner-approved Codex⇄Claude dispatch — all over one Telegram bot.

---

## How it works

The **persistent agent is the Node orchestrator** and its on-disk state under
`~/.codex/agent`. Codex and Claude are **spawned as stateless, bounded workers**
for individual steps, then exit. Telegram is treated as an untrusted transport:
only allowlisted users reach the gateway, and model output is untrusted until it
clears Node-owned safety and approval gates.

```text
Telegram ──▶ Gateway (allowlist · parse · audit)
                 │
                 ├─ plan/edit task ──▶ approval gate ──▶ bounded Codex/Claude worker ──▶ ledger
                 ├─ @opus / @claude ──▶ read-only review runner (restricted settings)
                 └─ agent-dispatch ──▶ owner approves routing ──▶ (still needs execution approval)

Safety envelope around everything: kill switch · token budget · secret scan · fail-closed config
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full model and
[`docs/ROADMAP.md`](docs/ROADMAP.md) for what's next.

---

## Requirements

- **Node.js 20+** (required).
- `codex` CLI — optional, for Codex execution.
- **Claude Code 2.1.162+** — optional, for the Claude/Opus review and edit runners.
- A **Telegram bot token** — optional, for Telegram polling/bridge flows.
- `codex-memory-river` — optional, for memory context when memory is enabled.

## Install

```sh
git clone https://github.com/Hsi431/agent-river.git agent-river
cd agent-river
npm install
npm test
```

Run the CLI straight from the source tree:

```sh
node bin/codex-agent.js --help
node bin/codex-agent.js status --state ~/.codex/agent
```

For development, use an isolated state directory so you never touch real state:

```sh
node bin/codex-agent.js status --state .local-agent-state
```

## Telegram quickstart

Keep the token in the environment, never in agent state:

```sh
export TELEGRAM_BOT_TOKEN='...'
node bin/codex-agent.js allow-user --state ~/.codex/agent --user '<telegram_user_id>'
node bin/codex-agent.js telegram-poll --state ~/.codex/agent --transport curl
```

Send `agent help` or `agent status` to the bot, then poll once. For a long-running
local bridge, generate the systemd `--user` files and **review them before enabling
manually** — Agent River writes unit files but never runs `systemctl`:

```sh
mkdir -p ~/.config/codex-agent ~/.config/systemd/user
printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TELEGRAM_BOT_TOKEN" > ~/.config/codex-agent/telegram.env

node bin/codex-agent.js telegram-codex-service-print --state ~/.codex/agent --mode bridge
node bin/codex-agent.js telegram-codex-service-write --state ~/.codex/agent --mode bridge --dir ~/.config/systemd/user
node bin/codex-agent.js telegram-codex-service-status --state ~/.codex/agent --mode bridge
```

## Telegram commands

Once the bot is running and your user id is allowlisted, these are the messages
you actually type **into the Telegram chat** (not the shell):

| You type | What it does |
|---|---|
| `agent help` | List the available commands |
| `status` · `agent status` | Show the task queue and safety status |
| `agent status task_…` | Show one task's status |
| `agent models` | Show the active Claude/Codex models and local token usage (owners also get inline model-switch buttons) |
| `agent submit --repo /path --request "…"` | Queue a plan task (still needs approval to run) |
| `agent run task_…` | Advance a task by one step |
| `agent approve task_…` · `agent reject task_…` | Approve or reject a pending task |
| `agent thread msg_…` | Show an exchange thread |
| `agent config opus-model sonnet\|opus\|default` | Set the Claude runner model |
| `agent config codex-model <model\|default>` | Set the Codex runner model |
| `@claude <message>` | Ask Claude — read-only review lane (alias for `@opus`) |
| `@opus <message>` | Ask Claude/Opus |
| `@codex <message>` | Send a message to Codex |
| `@opus inbox` · `@opus replies` | List pending messages / replies for that agent |
| `name: <message>` | Same as `@name <message>` |

Notes:

- **Inline buttons beat typing.** Pending edit tasks and dispatch approvals come
  with `[ Approve ] [ Reject ] [ Status ]` buttons — just tap them.
- **`@`-mentions need the target enabled first** (see the next section); otherwise
  the bot replies that the agent is not enabled.
- **Owner-only actions:** `@opus`-driven edits, the model-switch buttons, and
  dispatch approvals require owner authority (owner mode + owner allowlist).
- **Anything that isn't a command** from an allowlisted user is queued as chat,
  not executed.

## Claude/Opus review and cross-agent dispatch

Enable Claude in the exchange mailbox and turn on the runner:

```sh
node bin/codex-agent.js agent-enable --state ~/.codex/agent --agent opus --kind review
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent \
  --owner-mode-enabled true \
  --exchange-runner-enabled true \
  --exchange-notify-enabled true \
  --exchange-notify-chat-id '<telegram_chat_id>' \
  --default-repo "$PWD"

node bin/codex-agent.js exchange-runner-settings-write --state ~/.codex/agent
node bin/codex-agent.js exchange-runner-service-write --state ~/.codex/agent --dir ~/.config/systemd/user --repo "$PWD"
```

Agents propose dispatches as a fenced JSON block in their final reply. They only
*propose* — Node creates a pending approval, and you must approve routing before
anything is sent:

````md
```agent-dispatch
{"to":"codex","task":"Inspect the result and report observations only.","reason":"Codex owns the follow-up.","mode":"plan"}
```
````

```sh
node bin/codex-agent.js dispatch-list --state ~/.codex/agent --status pending
node bin/codex-agent.js dispatch-show --state ~/.codex/agent --id dispatch_...
```

## Safety model

This is the heart of the project, so it's worth stating plainly:

- **Two authority tiers.** Gateway allowlist = bounded operator access. Owner
  authority (owner mode + owner allowlist) is required for edit execution, callback
  approvals, dispatch routing, and model controls.
- **Owner approval before any edit execution.** Edit tasks are forced to `pending`
  server-side; callers cannot bypass the gate.
- **Dispatch approval is routing consent only.** Approving a Codex edit dispatch
  still triggers the normal execution approval before any file changes.
- **Agents cannot post to the mailbox themselves.** The review runner's settings
  deny `exchange-submit`/`claim`/`release`; Node owns mailbox writes.
- **Dangerous requests are declined** with a manual-action notice (commit, push,
  deploy, install, delete, reset, …).
- **Secrets are scanned and redacted** across every stored and outbound path; a
  reply that still looks secret-bearing is withheld.
- **Fail-closed config:** unreadable/invalid config disables everything.
- **External trust boundary.** Claude-runner safety depends on Claude Code
  continuing to enforce headless tool allowlists and reject compound commands that
  exceed an allowed Bash pattern. Treat Claude Code upgrades as security-sensitive.

Agent state under `~/.codex/agent` may contain raw local task, chat, and audit
text. **Keep it private and out of git.** See [`SECURITY.md`](SECURITY.md) for the
full threat model and how to report a vulnerability.

## Known limitations

- Use **one** primary bridge/runner set per state directory. JSONL ledgers are not
  a distributed multi-writer database.
- Gateway use has token budgets and lane/chat limits, but no general per-user
  request throttle.
- Generated systemd units assume paths without whitespace. Review generated files
  before enabling them.

## Optional: codex-memory-river

`codex-memory-river` is loaded only when enabled by policy or via `--memory-state`.
If it is requested but unavailable, Agent River fails closed with a clear
`memory_unavailable` / `memory_context_failed` reason instead of crashing startup.
To opt in from a workspace containing both repos:

```sh
npm install --no-save ../codex-memory-river
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent \
  --default-repo /path/to/repo --memory-enabled true
```

## Verifying changes

```sh
npm test
npm run test:no-memory
npm pack --dry-run
git diff --check
```

## Contributing & license

Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). Security reports:
[`SECURITY.md`](SECURITY.md). For the operational runbook, see
[`docs/AGENT_TELEGRAM_POLLING.md`](docs/AGENT_TELEGRAM_POLLING.md).

Licensed under the [MIT License](LICENSE).
