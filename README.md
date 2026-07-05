# Agent River

**Drive local Codex and Claude agents from Telegram through the v3 dashboard.**

[English](README.md) · [繁體中文](README.zh-Hant.md)

Agent River is a local control plane for AI coding agents. It keeps state on
disk, starts bounded Codex/Claude workers for individual turns, and uses a
Telegram dashboard for owner operations, v2 agent launches, exchange
notifications, and dispatch approvals.

Status: early but usable for a single local operator. The v3 dashboard, v2
launcher, exchange/session ledgers, dispatch approvals, runners, safety gates,
and secret scanning are covered by the test suite.

## Core Flows

- **v3 dashboard:** the production Telegram long-poller. It accepts owner
  messages, handles dashboard callbacks, and flushes v2 outbox, exchange
  notifications, and dispatch notifications.
- **v2 launcher:** owners can send `@claude` or `@codex` messages with
  `repo=` and `mode=read|write`. The bot acknowledges immediately; the result
  is delivered later from the outbox.
- **Exchange mailbox:** agents exchange scoped messages through local JSONL
  ledgers. Runners claim work and write replies.
- **Dispatch approvals:** agents can propose cross-agent routing; Node creates a
  pending approval and waits for owner consent.
- **Safety:** kill switch, daily budget, secret scanning, fail-closed config,
  poller locks, and process-group termination for v2 turns.

Retired v1 surfaces are gone: chat inbox/draft/handoff lanes, direct-send,
manual reply approval, `telegram-codex-*`, `bridge-once`, `codex-reply-once`,
and `codex-agent-telegram-bridge.service`.

## Install

```sh
git clone https://github.com/Hsi431/agent-river.git agent-river
cd agent-river
npm install
npm test
```

Run from the source tree:

```sh
node bin/codex-agent.js --help
node bin/codex-agent.js status --state ~/.codex/agent
```

## Telegram Dashboard

Keep the bot token out of agent state:

```sh
export TELEGRAM_BOT_TOKEN='...'
mkdir -p ~/.config/codex-agent ~/.config/systemd/user
printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TELEGRAM_BOT_TOKEN" > ~/.config/codex-agent/telegram.env
```

Generate the v3 dashboard service:

```sh
node bin/codex-agent.js dashboard-service-print --state ~/.codex/agent --repo "$PWD"
node bin/codex-agent.js dashboard-service-write --state ~/.codex/agent --repo "$PWD" --dir ~/.config/systemd/user
node bin/codex-agent.js dashboard-service-status --state ~/.codex/agent --repo "$PWD"
```

Cutover from the retired bridge:

```sh
export XDG_RUNTIME_DIR=/run/user/$(id -u)
cd ~/agent-river && node bin/codex-agent.js dashboard-service-write --dir ~/.config/systemd/user
systemctl --user daemon-reload
systemctl --user disable --now codex-agent-telegram-bridge.service
systemctl --user enable --now codex-agent-dashboard.service
journalctl --user -u codex-agent-dashboard.service -n 20
```

## Owner Use

Owners are listed in `telegram_codex_policy.direct_send_user_allowlist`; this
field is retained as the owner list after the v1 direct-send retirement.

Enable v2 routing and a workspace root:

```sh
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent \
  --v2-enabled true --workspace-root /home/you --default-repo "$PWD"
```

Messages to the dashboard:

```text
@claude repo=agent-river -- review the current diff
@codex repo=agent-river mode=write -- update the docs
/status
/stop
```

Non-owner users receive a read-only dashboard response. Plain free-form text is
not stored in a chat inbox and does not invoke a model.

## Exchange Runner

```sh
node bin/codex-agent.js agent-enable --state ~/.codex/agent --agent opus --kind review
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent \
  --exchange-runner-enabled true \
  --exchange-notify-enabled true \
  --exchange-notify-chat-id '<telegram_chat_id>' \
  --default-repo "$PWD"

node bin/codex-agent.js exchange-runner-settings-write --state ~/.codex/agent
node bin/codex-agent.js exchange-runner-service-write --state ~/.codex/agent --dir ~/.config/systemd/user --repo "$PWD"
```

Dispatch approvals:

```sh
node bin/codex-agent.js dispatch-list --state ~/.codex/agent --status pending
node bin/codex-agent.js dispatch-show --state ~/.codex/agent --id dispatch_...
```

## Debug Telegram Polling

`telegram-poll` and `telegram-update` remain as v2/transport smoke paths:

```sh
node bin/codex-agent.js telegram-poll --state ~/.codex/agent --transport curl
node bin/codex-agent.js telegram-update --state ~/.codex/agent --update-json '{"message":{"from":{"id":123},"chat":{"id":456},"text":"/status"}}'
```

For normal operation, run `dashboard-bridge` or the dashboard systemd service.

## Safety Model

- Owner authority comes from the retained owner allowlist.
- Write turns require explicit v2 `mode=write` and repo resolution.
- Dangerous local operations such as commit, push, deploy, install, delete, and
  reset stay outside Telegram automation.
- Agent output is scanned before it leaves the machine.
- Invalid config fails closed.
- The dashboard lock prevents multiple dashboard pollers for one state
  directory.

Agent state under `~/.codex/agent` can contain local task and audit text. Keep it
private and out of git.

## Verify

```sh
npm test
npm run test:no-memory
npm pack --dry-run
git diff --check
```

Operational details: [`docs/AGENT_TELEGRAM_POLLING.md`](docs/AGENT_TELEGRAM_POLLING.md).

Licensed under the [MIT License](LICENSE).
