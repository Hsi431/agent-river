# Agent River

**Drive Codex and Claude coding agents from Telegram — with a human approval gate on every risky move.**

[English](README.md) · [繁體中文](README.zh-Hant.md)

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)
![Runtime deps](https://img.shields.io/badge/runtime%20deps-0-success.svg)
[![CI](https://github.com/Hsi431/agent-river/actions/workflows/ci.yml/badge.svg)](https://github.com/Hsi431/agent-river/actions/workflows/ci.yml)

Agent River is a small, local control plane that lets you queue, run, and supervise
multiple AI coding agents — Codex and Claude (Opus/Sonnet) — from your phone over
Telegram. The agents do the work; **you stay in the loop.** Edits and cross-agent routing
are governed by an approval policy — most actions wait for your tap — and
high-risk operations like commit, push, deploy, install, and delete always stay
manual.

It runs entirely on your own machine, keeps all state on local disk, has **zero
runtime dependencies**, and never spawns a shell — agents are launched as bounded,
tool-restricted workers, not handed a blank cheque.

> Status: **early but usable** for local, single-operator use. The core flows —
> v2 direct agent control (`@agent repo= mode=`), the Telegram gateway, approvals,
> dispatch, runners, ledger, secret-scan — are covered by 500+ tests and run
> without `codex-memory-river`.

---

## What it feels like

**v2 — direct control.** Name an agent, a repo, and a capability; the rest is your prompt:

```text
You  ›  @claude repo=agent-river -- when was the README last changed?
Bot  ›  ▶ claude · /home/you/agent-river · mode=read · session=new   turn=v2turn_…
           … the turn runs in the background; /status and /stop work meanwhile …
Bot  ›  • README.md — last modified 2026-06-06 15:12:58 +0800
           Last README commit: 801f943 (2026-06-06 15:14:25).

You  ›  @codex repo=agent-river mode=write -- fix the typo in the intro
Bot  ›  ▶ codex · /home/you/agent-river · mode=write · session=new   turn=v2turn_…
           … write turns may edit the repo; inspect `git diff` yourself, re-send if needed …
```

**v1 — approval lanes** (still available): plan/edit tasks with `[ Approve ]`
buttons, a read-only review runner, and owner-approved cross-agent dispatch.

*Illustrative. The bot replies in your language; owner-facing notices default to
Traditional Chinese for Chinese input.*

---

## Driving agents directly (v2)

The v2 path turns Telegram into a remote launcher for the `claude` and `codex`
CLIs on your machine — as **general agents**, not bespoke review/coding pipelines.
One deterministic grammar, no intent-guessing:

```text
@<agent> [repo=<name|/abs>] [mode=read|write] [--] <your prompt>
```

- **Agents:** `@claude` and `@codex` (plus `@opus`, a Claude alias). No other
  `@name` is a v2 agent — it falls through to v1.
- **`repo=`** picks the working directory — a direct child of your `workspace_root`,
  or an absolute path. Omit it to use your active repo, else `default_repo`. The
  canonical git top-level is the repo identity, so `repo=proj` and `repo=proj/src`
  are the same session.
- **`mode=read`** (default) reviews / answers / plans **read-only**. **`mode=write`**
  may edit the repo and **requires an explicit `repo=`** (so a write never lands in
  the wrong project). Telegram can select only `read`/`write` — never
  `danger-full-access`.
- Text after the leading control tokens (or after `--`) is the prompt.

What you get:

- An immediate **start ack** — `agent · repo (real path) · mode · session` — then
  the turn runs **in the background**; the result arrives as a follow-up message.
- **`/stop`** terminates the running agent's whole process group; **`/status`**
  (or `/context`) reports the active turn and your sessions without calling a
  model. The kill switch stops everything.
- **Sessions resume** per `(you, chat, agent, repo, mode)`: a follow-up in the same
  lane remembers context; a different repo or mode is a separate session. One
  active turn per session key at a time.
- A `write` turn with an uncertain result is **never auto-rerun** — inspect
  `git diff` and re-send.

Enable it once (owner):

```sh
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent \
  --v2-enabled true --workspace-root /home/you
```

**Trust model:** running an agent over Telegram is treated as **equivalent to you
running `claude`/`codex` by hand** in that repo (local parity). The boundary is the
owner allowlist, the provider's own permission system, and the read/write
capability ceiling — not an OS sandbox. See
[`docs/AGENT_RIVER_V2_PHASE1.md`](docs/AGENT_RIVER_V2_PHASE1.md).

---

## Why Agent River

- 🛡️ **Approval-gated by design.** Every edit task enters an approval state
  server-side, so nothing edits files unnoticed; most need an explicit owner
  Approve, and only small low-risk owner edits can be auto-approved by policy.
  Agents can only *propose* cross-agent work — routing needs your consent, and
  execution needs its own approval.
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
- 🧹 **Secret scanning on the paths that leave your machine.** Agent-to-agent
  messages, replies, diffs, test output, and outbound Telegram replies are scanned
  and redacted — OpenAI/GitHub/AWS/Slack/JWT/Google and Telegram tokens,
  credentialed URLs, key assignments, and more. (Raw chat you send is stored
  locally as-is, so keep agent state private.)
- 📦 **No supply chain to trust.** Zero runtime dependencies. Every subprocess is
  launched via `execFile` — never a shell. Bot tokens never touch argv or agent
  state (the curl transport passes the token through a stdin config file).
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
| `@claude repo=… [mode=read\|write] -- …` | **v2:** run Claude in a repo (ack now, result in the background) |
| `@codex repo=… [mode=read\|write] -- …` | **v2:** run Codex in a repo |
| `/stop` | **v2:** stop the running turn — terminates the whole process group |
| `/status` · `/context` | **v2:** active turn + your sessions (no model call) |
| `@claude <message>` · `@opus <message>` | **v1:** read-only review lane (`@opus` is a Claude alias) |
| `@codex <message>` | **v1:** send a message to Codex |
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
- **Secrets are scanned and redacted** on agent-to-agent messages, replies, diffs,
  test output, and outbound Telegram replies; a reply that still looks
  secret-bearing is withheld. Raw inbound chat is stored locally unredacted — keep
  agent state private.
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
