# Agent River

Local approval-gated Codex/Telegram agent control plane.

Agent River keeps agent state under `~/.codex/agent`. It can optionally use
Codex Memory River for memory context, but core Telegram, approval, dispatch,
runner, ledger, and secret-scan flows do not require it. It is designed for a
local operator: Telegram can queue, approve, and inspect work, but high-risk
operations such as commit, push, deploy, install, and delete stay manual.

## Status

This repository is early but usable for local smoke testing:

- Telegram gateway commands and allowlisted owner mode.
- Approval-gated plan/edit tasks.
- Opus exchange runner for read-only review and bounded edit execution.
- Owner-approved cross-agent dispatch from Opus to Codex or Opus.
- Systemd `--user` unit/timer generation only; the CLI does not enable or start
  services for you.

## Requirements

- Node.js 20 or newer.
- Optional: `codex` CLI for Codex execution.
- Optional: Claude Code 2.1.162 or newer for the Opus exchange runner.
- Optional: `codex-memory-river` for Memory River context when memory is enabled.
- Optional: a Telegram bot token for Telegram polling/bridge flows.

## Install

After checking out the repository:

```sh
cd agent-river
npm install
npm test
```

Run the CLI from the source tree:

```sh
node bin/codex-agent.js status --state ~/.codex/agent
node bin/codex-agent.js --help
```

For development smoke tests, use an isolated state directory:

```sh
node bin/codex-agent.js status --state .local-agent-state
```

Memory River is loaded only when enabled by policy or when `--memory-state` is
passed to a command that builds model context. If the integration is requested
but unavailable, Agent River fails closed with a clear `memory_unavailable` or
`memory_context_failed` reason instead of crashing core startup.

To opt in from a workspace containing both repos:

```sh
npm install --no-save ../codex-memory-river
node bin/codex-agent.js telegram-codex-policy-set \
  --state ~/.codex/agent \
  --default-repo /path/to/repo \
  --memory-enabled true
```

## Telegram Quickstart

Keep tokens in the environment, not in agent state:

```sh
export TELEGRAM_BOT_TOKEN='...'
node bin/codex-agent.js allow-user --state ~/.codex/agent --user '<telegram_user_id>'
node bin/codex-agent.js telegram-poll --state ~/.codex/agent --transport curl
```

Send `agent help` or `agent status` to the bot, then poll once. For a long-running
local bridge, generate systemd files and review them before enabling manually:

```sh
mkdir -p ~/.config/codex-agent ~/.config/systemd/user
printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TELEGRAM_BOT_TOKEN" > ~/.config/codex-agent/telegram.env

node bin/codex-agent.js telegram-codex-service-print --state ~/.codex/agent --mode bridge
node bin/codex-agent.js telegram-codex-service-write --state ~/.codex/agent --mode bridge --dir ~/.config/systemd/user
node bin/codex-agent.js telegram-codex-service-status --state ~/.codex/agent --mode bridge
```

The generated unit still requires you to run `systemctl --user ...` manually.

## Opus And Dispatch

Enable Opus in the exchange mailbox:

```sh
node bin/codex-agent.js agent-enable --state ~/.codex/agent --agent opus --kind review
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent \
  --owner-mode-enabled true \
  --exchange-runner-enabled true \
  --exchange-notify-enabled true \
  --exchange-notify-chat-id '<telegram_chat_id>' \
  --default-repo "$PWD"
```

Generate runner settings and systemd files:

```sh
node bin/codex-agent.js exchange-runner-settings-print --state ~/.codex/agent
node bin/codex-agent.js exchange-runner-settings-write --state ~/.codex/agent
node bin/codex-agent.js exchange-runner-service-print --state ~/.codex/agent --repo "$PWD"
node bin/codex-agent.js exchange-runner-service-write --state ~/.codex/agent --dir ~/.config/systemd/user --repo "$PWD"
```

Dispatch proposals are fenced JSON blocks in an agent's final reply. Agents only
propose; Node creates a pending dispatch approval, and the owner must approve it
before anything is routed:

````md
```agent-dispatch
{"to":"codex","task":"Inspect the result and report observations only.","reason":"Codex owns the follow-up observation.","mode":"plan"}
```
````

Inspect dispatch state locally:

```sh
node bin/codex-agent.js dispatch-list --state ~/.codex/agent --status pending
node bin/codex-agent.js dispatch-show --state ~/.codex/agent --id dispatch_...
```

## Safety Model

- The gateway allowlist grants operator access to bounded commands, plan-task
  submission, and exchange messaging. It does not grant owner authority.
- Owner authority additionally requires owner mode and membership in the direct
  send user allowlist. Owner checks protect edit execution, callback approvals,
  dispatch routing, and model controls.
- Owner approvals are required before Telegram-driven edit execution.
- Dispatch approval is routing consent only; Codex edit tasks still require the
  normal execution approval.
- Agents cannot submit cross-agent mailbox messages directly; runner settings
  deny `exchange-submit`.
- Dangerous owner requests are declined with a manual-action notice.
- Agent state under `~/.codex/agent` may contain raw local task/chat text. Keep
  it private and out of git.
- Claude runner safety depends on Claude Code continuing to enforce headless
  tool allowlists and rejecting compound commands that exceed an allowed Bash
  pattern. Treat Claude Code upgrades as security-sensitive.

See [`SECURITY.md`](SECURITY.md) for the threat model, external trust
boundaries, vulnerability reporting, and deployment limitations.
Contribution guidelines are in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Known Limitations

- Use one primary bridge/runner set per state directory. JSONL ledgers are not a
  distributed multi-writer database.
- Gateway use has token budgets and lane/chat limits, but no general per-user
  request throttle.
- Generated systemd units assume paths without whitespace. Review generated
  files before enabling them.

## Verification

Before publishing or deploying local changes:

```sh
npm test
npm run test:no-memory
npm pack --dry-run
git diff --check
```

For a deeper operational runbook, see
[`docs/AGENT_TELEGRAM_POLLING.md`](docs/AGENT_TELEGRAM_POLLING.md).
