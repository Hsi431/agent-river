# Agent River Telegram Operations

This runbook covers the retained Telegram surface after the v3 dashboard
cutover. The retired v1 chat inbox, direct reply bridge, direct-send, reply
approval queue, and `codex-agent-telegram-bridge.service` are no longer
operator paths.

## Current Surfaces

- `dashboard-bridge`: production Telegram long-poller for the v3 dashboard.
- `dashboard-once`: one dashboard poll cycle for smoke tests.
- `telegram-poll`: retained transport/v2 debug smoke path.
- `telegram-update`: retained local JSON update smoke path.
- `@claude` / `@codex` v2 messages: routed through the dashboard for owners.
- Exchange/dispatch notifications: flushed by each dashboard cycle.

Retired commands include `bridge-once`, `codex-reply-once`,
`telegram-codex-once`, `telegram-codex-loop`,
`telegram-codex-bridge`, `reply-approval-*`, and
`telegram-codex-service-*`.

## Dashboard Service

Keep the bot token in an environment file referenced by systemd. Agent River
writes files only; it does not run `systemctl`.

```sh
mkdir -p ~/.config/codex-agent ~/.config/systemd/user
printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TELEGRAM_BOT_TOKEN" > ~/.config/codex-agent/telegram.env

node bin/codex-agent.js dashboard-service-print --state ~/.codex/agent --repo "$PWD"
node bin/codex-agent.js dashboard-service-write --state ~/.codex/agent --repo "$PWD" --dir ~/.config/systemd/user
node bin/codex-agent.js dashboard-service-status --state ~/.codex/agent --repo "$PWD"
```

Owners are read from `telegram_codex_policy.direct_send_user_allowlist`.
The dashboard notification chat defaults to
`telegram_codex_policy.exchange_notify_chat_id`, or can be passed as
`--dashboard-chat-id` for one-off runs.

## Cutover Runbook

Use this when replacing the retired Telegram bridge with the v3 dashboard:

```sh
export XDG_RUNTIME_DIR=/run/user/$(id -u)
cd ~/agent-river && node bin/codex-agent.js dashboard-service-write --dir ~/.config/systemd/user
systemctl --user daemon-reload
systemctl --user disable --now codex-agent-telegram-bridge.service
systemctl --user enable --now codex-agent-dashboard.service
journalctl --user -u codex-agent-dashboard.service -n 20
```

The Opus/Codex runner timers are separate and should not be changed by this
cutover.

## Owner Messages

Dashboard owners can send v2 launcher messages:

```text
@claude repo=agent-river -- review the current diff
@codex repo=agent-river mode=write -- update the docs
/status
/stop
```

Non-owner Telegram users receive a read-only response from the dashboard. Plain
free-form text is not stored in a chat inbox and does not start a model.

## Debug Smoke Paths

Use `dashboard-once` for the production path:

```sh
node bin/codex-agent.js dashboard-once --state ~/.codex/agent --transport curl --dashboard-chat-id '<chat_id>'
```

Use `telegram-poll` only for retained transport/v2 debugging:

```sh
node bin/codex-agent.js telegram-poll --state ~/.codex/agent --transport curl
```

The curl transport uses `execFile` and passes the Telegram token through curl
config on stdin, not argv.

## Exchange And Dispatch

Enable the exchange runner and dashboard notifications:

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

Dispatch proposals remain approval-gated:

```sh
node bin/codex-agent.js dispatch-list --state ~/.codex/agent --status pending
node bin/codex-agent.js dispatch-show --state ~/.codex/agent --id dispatch_...
```

Dashboard cycles flush v2 outbox results, exchange notifications, and dispatch
approval notifications.
