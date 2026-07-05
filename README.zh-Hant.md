# Agent River

**透過 v3 Telegram 看板指揮本機 Codex 與 Claude agent。**

[English](README.md) · [繁體中文](README.zh-Hant.md)

Agent River 是本機 AI coding agent 控制平面。狀態存在磁碟上,每個 turn 才啟動受限的
Codex/Claude worker。Telegram v3 看板負責 owner 操作、v2 agent 啟動、exchange 通知
與 dispatch 核准。

狀態:早期但可用,適合單一本機 operator。v3 看板、v2 launcher、exchange/session 帳本、
dispatch 核准、runner、安全閘與機密掃描都有測試覆蓋。

## Quickstart

系統需求:**Linux + systemd(user session);其他平台未支援**。

```sh
git clone https://github.com/Hsi431/agent-river.git agent-river
cd agent-river
npm install
node bin/codex-agent.js init
```

接著填 `~/.config/codex-agent/telegram.env`,reload 並 enable 產生的 user units:

```sh
systemctl --user daemon-reload
systemctl --user enable --now codex-agent-dashboard.service
systemctl --user enable --now codex-agent-opus-runner.timer
systemctl --user enable --now codex-agent-codex-runner.timer
systemctl --user enable --now codex-agent-exec-runner.timer
```

到 Telegram 開 session:

```text
/session codex,opus -- 題目
```

可選:跑過 `npm link` 後,也可用 `agent-river <cmd>`。

## 核心流程

- **v3 看板:**正式 Telegram long-poller。接 owner 訊息、處理看板 callback,並 flush v2
  outbox、exchange 通知與 dispatch 通知。
- **v2 launcher:**owner 可以送 `@claude` 或 `@codex`,搭配 `repo=` 與
  `mode=read|write`。Bot 先回 ack,結果稍後從 outbox 送回。
- **Exchange mailbox:**agent 透過本機 JSONL 帳本交換訊息。Runner claim 工作並寫回覆。
- **Dispatch 核准:**agent 只能提議跨 agent 路由;Node 建 pending approval 等 owner 同意。
- **安全:**kill switch、每日預算、機密掃描、fail-closed config、poller lock、v2 turn
  process group 終止。

已退役的 v1 surface 不再可用:chat inbox/draft/handoff、direct-send、manual reply
approval、`telegram-codex-*`、`bridge-once`、`codex-reply-once`、以及
`codex-agent-telegram-bridge.service`。

## 安裝

```sh
git clone https://github.com/Hsi431/agent-river.git agent-river
cd agent-river
npm install
npm test
```

直接從 source tree 執行:

```sh
node bin/codex-agent.js --help
node bin/codex-agent.js status --state ~/.codex/agent
```

## Telegram 看板

Bot token 不要寫進 agent state:

```sh
export TELEGRAM_BOT_TOKEN='...'
mkdir -p ~/.config/codex-agent ~/.config/systemd/user
printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TELEGRAM_BOT_TOKEN" > ~/.config/codex-agent/telegram.env
```

產生 v3 dashboard service:

```sh
node bin/codex-agent.js dashboard-service-print --state ~/.codex/agent --repo "$PWD"
node bin/codex-agent.js dashboard-service-write --state ~/.codex/agent --repo "$PWD" --dir ~/.config/systemd/user
node bin/codex-agent.js dashboard-service-status --state ~/.codex/agent --repo "$PWD"
```

從舊 bridge cutover:

```sh
export XDG_RUNTIME_DIR=/run/user/$(id -u)
cd ~/agent-river && node bin/codex-agent.js dashboard-service-write --dir ~/.config/systemd/user
systemctl --user daemon-reload
systemctl --user disable --now codex-agent-telegram-bridge.service
systemctl --user enable --now codex-agent-dashboard.service
journalctl --user -u codex-agent-dashboard.service -n 20
```

## Owner 使用方式

Owner 名單存在 `telegram_codex_policy.direct_send_user_allowlist`;v1 direct-send 退役後,
這個欄位保留作 owner list。

啟用 v2 routing 與 workspace root:

```sh
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent \
  --v2-enabled true --workspace-root /home/you --default-repo "$PWD"
```

傳給看板的訊息:

```text
@claude repo=agent-river -- review the current diff
@codex repo=agent-river mode=write -- update the docs
/session codex,opus -- plan this change
/say <session> continue with the next step
/sessions
/kill <session>
/agents
/model
/task <session> repo=agent-river
/status
/stop
```

非 owner 使用者只會得到唯讀回覆。一般 free-form 文字不再寫入 chat inbox,也不會啟動模型。

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

## 接入任意 agent

exec 型 agent 使用 [`docs/AGENT_PROMPT_TEMPLATE.md`](docs/AGENT_PROMPT_TEMPLATE.md)
描述的簡單合約:stdin 進、stdout 出。Agent River 負責 mailbox claim/reply。

1. 寫一個入口程式,從 stdin 讀一個 request envelope,把最終回覆寫到 stdout。
2. 註冊它:

```sh
node bin/codex-agent.js agent-join --state ~/.codex/agent \
  --name localbot --style exec \
  --exec '/path/to/localbot --once' \
  --exec-timeout-seconds 300
```

3. 在看板核准 pending join,再跑 exec runner:

```sh
node bin/codex-agent.js exec-runner-once --state ~/.codex/agent --repo "$PWD"
node bin/codex-agent.js exec-runner-service-write --state ~/.codex/agent --dir ~/.config/systemd/user --repo "$PWD"
```

poll 型 agent 可用 [`scripts/poll-adapter-example.sh`](scripts/poll-adapter-example.sh)
把 token-protected mailbox CLI 接到自己的指令。

Dispatch approval:

```sh
node bin/codex-agent.js dispatch-list --state ~/.codex/agent --status pending
node bin/codex-agent.js dispatch-show --state ~/.codex/agent --id dispatch_...
```

## Debug Telegram Polling

`telegram-poll` 與 `telegram-update` 保留作 v2/transport smoke path:

```sh
node bin/codex-agent.js telegram-poll --state ~/.codex/agent --transport curl
node bin/codex-agent.js telegram-update --state ~/.codex/agent --update-json '{"message":{"from":{"id":123},"chat":{"id":456},"text":"/status"}}'
```

正式運作請跑 `dashboard-bridge` 或 dashboard systemd service。

## 安全模型

- Owner 權限來自保留的 owner allowlist。
- Write turn 必須明確使用 v2 `mode=write` 並解析到 repo。
- commit、push、deploy、install、delete、reset 等危險本機操作不交給 Telegram 自動化。
- Agent output 離開機器前會掃描。
- 無效設定 fail closed。
- Dashboard lock 防止同一 state directory 開多個 dashboard poller。

`~/.codex/agent` 可能包含本機 task 與 audit 文字,請保持私密、不要進 git。

## 驗證

```sh
npm test
npm run test:no-memory
npm pack --dry-run
git diff --check
```

操作細節見 [`docs/AGENT_TELEGRAM_POLLING.md`](docs/AGENT_TELEGRAM_POLLING.md)。

以 [MIT License](LICENSE) 授權。
