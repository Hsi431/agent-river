# Agent River

**從 Telegram 指揮 Codex 與 Claude 程式 agent,每個有風險的動作都要先經過你同意。**

[English](README.md) · [繁體中文](README.zh-Hant.md)

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)
![Runtime deps](https://img.shields.io/badge/runtime%20deps-0-success.svg)
[![CI](https://github.com/Hsi431/agent-river/actions/workflows/ci.yml/badge.svg)](https://github.com/Hsi431/agent-river/actions/workflows/ci.yml)

Agent River 是一個輕量的本機控制平面。你可以用手機透過 Telegram 排程、執行、盯著
多個 AI 程式 agent(Codex 與 Claude 的 Opus／Sonnet)幫你做事,而且全程由你拍板:
改檔和跨 agent 路由都受核准政策管控,多數動作要等你按下「核准」才會真的動;commit、
push、部署、安裝、刪除這類高風險操作則一律保持手動。

整套東西跑在你自己的機器上,狀態全存在本機,沒有任何 runtime 相依套件,也從不開
shell。每個 agent 都是以受限、綁好工具範圍的 worker 身分被叫起來做一件事,而不是
給它一張空白支票。

> 狀態:**早期但可用**,適合本機、單人操作。核心流程(Telegram gateway、核准、派工、
> runner、帳本、機密掃描)都有 360+ 測試涵蓋,而且不裝 `codex-memory-river` 也能跑。

---

## 實際用起來像這樣

```text
你       ›  agent status
Bot      ›  Tasks: 3  queued=1 done=2 failed=0  kill_switch=false  remaining_tokens=18540

你       ›  @claude 幫我 review 最新的 diff 有沒有安全問題
Bot      ›  Claude 收到,正在處理,完成後回你。(msg_17a3…)
            …(一個受限、唯讀的 Claude 開始看這個 repo)…
Bot      ›  Claude:
            依嚴重度列出問題:
            • src/auth.js:42 — token 用 == 比較,有 timing 洩漏風險。…
            沒有改任何檔案,review 通道是唯讀的。

你       ›  @opus 把 README 開頭那個錯字修掉
Bot      ›  已建立待批准 edit 任務(task_17a3…),等你核准後才會改檔。
            [ Approve ]  [ Reject ]  [ Status ]
你       ›  (點下 Approve)
Bot      ›  已核准並完成 edit 任務(task_17a3…)。
            變更:README.md | 2 +-
            驗證:pass (npm test)
```

*以上為示意。Bot 會用你的語言回覆;中文輸入時,給 owner 看的通知預設用繁體中文。*

---

## 它好在哪

- 🛡️ **核准閘門是設計的核心。** 每個 edit 任務都會在後端進入待核准狀態,不會偷偷改檔;
  多數需要 owner 明確按核准,只有小型、低風險的 owner edit 才會依政策自動核准。Agent
  對於跨 agent 的工作只能「提議」:路由要你同意,執行還得再核准一次。
- 🧯 **煞得住的煞車。** 全域 kill switch(`pause`／`resume`)、每日 token 預算、各通道
  每日上限。設定檔壞掉或讀不到時會 fail-closed:kill switch 打開、預算歸零,寧可不動
  也不亂動。
- 👥 **權限分兩層。** Gateway 白名單給的是受限的操作員權限(查狀態、送出和執行 plan
  任務、發訊息)。真正敏感的動作,像 edit 執行、派工路由、callback 核准、模型切換,
  需要的是 owner 權限:得開啟 owner 模式,並列在另一份 owner 白名單裡。
- 🔒 **Agent 只拿最小權限。** Review 通道叫起來的 headless Claude,會被一份產生好的
  設定檔鎖在唯讀工具裡;edit 通道雖然能改檔,但絕不能 commit、push、部署、安裝、刪除、
  連網,也不能再派工給別的 agent。萬一它偷偷動了 `git HEAD`,會被抓出來並讓任務失敗。
- 🧹 **離開機器的路徑都會掃機密。** Agent 之間的訊息、回覆、diff、測試輸出,以及回送到
  Telegram 的內容,都會掃描並遮蔽:OpenAI／GitHub／AWS／Slack／JWT／Google 和 Telegram
  的 token、含帳密的網址、金鑰賦值等等。(你自己發的聊天訊息會原文存在本機,所以 agent
  狀態要保持私密。)
- 📦 **沒有要你信任的供應鏈。** 零 runtime 相依套件。每個子程序都用 `execFile` 啟動,
  從不經過 shell;bot token 不會進 argv 或 agent 狀態(curl transport 透過 stdin 的
  config 檔傳入)。
- 🤝 **多 agent、多工作流,一個 bot 全包。** Plan 與 edit 通道、唯讀 review runner、
  owner 問答、瑣事自動回覆(direct-send),還有 owner 核准的 Codex⇄Claude 派工。

---

## 它怎麼運作

真正常駐的 agent 其實是 Node orchestrator,以及它存在 `~/.codex/agent` 的磁碟狀態。
Codex 和 Claude 只是被叫起來做單一步驟的無狀態 worker,做完就結束。Telegram 一律
當成不可信的傳輸層:只有白名單裡的人進得了 gateway,而模型的輸出在通過 Node 把關的
安全與核准閘門之前,也一律視為不可信。

```text
Telegram ──▶ Gateway(白名單 · 解析 · 稽核)
                 │
                 ├─ plan/edit 任務 ──▶ 核准閘門 ──▶ 受限 Codex/Claude worker ──▶ 帳本
                 ├─ @opus / @claude ──▶ 唯讀 review runner(受限設定)
                 └─ agent-dispatch ──▶ owner 核准路由 ──▶(仍需要執行核准)

包覆一切的安全外殼:kill switch · token 預算 · 機密掃描 · fail-closed 設定
```

完整模型見 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),後續規劃見
[`docs/ROADMAP.md`](docs/ROADMAP.md)。

---

## 需求

- **Node.js 20 以上**(必要)。
- `codex` CLI:選用,要跑 Codex 時才需要。
- **Claude Code 2.1.162 以上**:選用,要用 Claude/Opus 的 review 與 edit runner 時需要。
- **Telegram bot token**:選用,要用 Telegram 輪詢／bridge 流程時需要。
- `codex-memory-river`:選用,啟用 memory 時提供記憶脈絡。

## 安裝

```sh
git clone https://github.com/Hsi431/agent-river.git agent-river
cd agent-river
npm install
npm test
```

直接從原始碼跑 CLI:

```sh
node bin/codex-agent.js --help
node bin/codex-agent.js status --state ~/.codex/agent
```

開發時請用獨立的狀態目錄,才不會動到正式狀態:

```sh
node bin/codex-agent.js status --state .local-agent-state
```

## Telegram 快速上手

token 放環境變數就好,別寫進 agent 狀態:

```sh
export TELEGRAM_BOT_TOKEN='...'
node bin/codex-agent.js allow-user --state ~/.codex/agent --user '<telegram_user_id>'
node bin/codex-agent.js telegram-poll --state ~/.codex/agent --transport curl
```

對 bot 送出 `agent help` 或 `agent status`,然後輪詢一次。想長時間掛著本機 bridge,
就產生 systemd `--user` 檔案,**自己手動啟用前先看過一遍**:Agent River 只會幫你
寫出 unit 檔,從不替你執行 `systemctl`。

```sh
mkdir -p ~/.config/codex-agent ~/.config/systemd/user
printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TELEGRAM_BOT_TOKEN" > ~/.config/codex-agent/telegram.env

node bin/codex-agent.js telegram-codex-service-print --state ~/.codex/agent --mode bridge
node bin/codex-agent.js telegram-codex-service-write --state ~/.codex/agent --mode bridge --dir ~/.config/systemd/user
node bin/codex-agent.js telegram-codex-service-status --state ~/.codex/agent --mode bridge
```

## Telegram 指令速查

Bot 跑起來、而且你的 user id 在白名單裡之後,以下是你**直接打進 Telegram 對話框**的
訊息(不是打在終端機):

| 你打 | 作用 |
|---|---|
| `agent help` | 列出所有可用指令 |
| `status`、`agent status` | 顯示任務佇列與安全狀態 |
| `agent status task_…` | 顯示單一任務狀態 |
| `agent models` | 顯示目前的 Claude/Codex 模型與本機 token 用量(owner 還會多出切換模型的內嵌按鈕) |
| `agent submit --repo /path --request "…"` | 排一個 plan 任務(仍要核准才會跑) |
| `agent run task_…` | 把任務往前推一步 |
| `agent approve task_…`、`agent reject task_…` | 核准或拒絕待批准的任務 |
| `agent thread msg_…` | 顯示某條交換訊息的對話串 |
| `agent config opus-model sonnet\|opus\|default` | 設定 Claude runner 的模型 |
| `agent config codex-model <model\|default>` | 設定 Codex runner 的模型 |
| `@claude <訊息>` | 找 Claude,唯讀 review 通道(等同 `@opus`) |
| `@opus <訊息>` | 找 Claude/Opus |
| `@codex <訊息>` | 發訊息給 Codex |
| `@opus inbox`、`@opus replies` | 列出該 agent 的待處理訊息／回覆 |
| `name: <訊息>` | 跟 `@name <訊息>` 一樣 |

幾個提醒:

- **能用按鈕就別用打字。** 待批准的 edit 任務和派工,訊息下方會附
  `[ Approve ] [ Reject ] [ Status ]` 按鈕,直接點就好。
- **`@` 提及要先把對方 agent 啟用**(見下一節),不然 bot 會回說該 agent 未啟用。
- **owner 限定動作:** `@opus` 觸發的改檔、切換模型的按鈕、派工核准,都需要 owner
  權限(owner 模式 + owner 白名單)。
- 白名單使用者打的**任何非指令訊息**,會被當成聊天排進佇列,不會被執行。

## Claude/Opus review 與跨 agent 派工

在交換信箱啟用 Claude,並把 runner 打開:

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

Agent 會在最終回覆裡用一段圍欄 JSON 提出派工,但它只能「提議」:Node 會建一筆待核准
項目,要等你核准路由,東西才會被送出去。

````md
```agent-dispatch
{"to":"codex","task":"Inspect the result and report observations only.","reason":"Codex owns the follow-up.","mode":"plan"}
```
````

```sh
node bin/codex-agent.js dispatch-list --state ~/.codex/agent --status pending
node bin/codex-agent.js dispatch-show --state ~/.codex/agent --id dispatch_...
```

## 安全模型

這是整個專案的重點,所以直接講白:

- **權限分兩層。** Gateway 白名單是受限的操作員權限;edit 執行、callback 核准、派工
  路由、模型切換這些敏感動作,要的是 owner 權限(owner 模式 + owner 白名單)。
- **任何 edit 執行前都要 owner 核准。** Edit 任務在後端被強制設成 `pending`,呼叫端
  無法繞過。
- **派工核准只是同意路由。** 就算核准了一筆 Codex edit 派工,真正改檔前還是會再走一次
  正常的執行核准。
- **Agent 不能自己寫信箱。** Review runner 的設定拒絕 `exchange-submit`／`claim`／
  `release`,信箱寫入由 Node 掌控。
- **危險請求會被婉拒**,並提醒你手動處理(commit、push、部署、安裝、刪除、reset…)。
- **機密會掃描並遮蔽**,涵蓋 agent 之間的訊息、回覆、diff、測試輸出與回送 Telegram 的
  內容;看起來還是含機密的回覆會被攔下不送。原始入站聊天會原文存在本機,所以 agent
  狀態要保持私密。
- **設定 fail-closed。** 讀不到或無效的設定,會把一切停掉。
- **外部信任邊界。** Claude runner 的安全性,靠的是 Claude Code 持續落實 headless 工具
  白名單、並擋掉超出允許 Bash 樣式的複合指令。所以 Claude Code 的升級要當成跟安全有關
  的事看待。

`~/.codex/agent` 底下的 agent 狀態,可能含有原始的本機任務、聊天和稽核文字。**請保持
私密、別進 git。** 完整威脅模型和漏洞回報方式見 [`SECURITY.md`](SECURITY.md)。

## 已知限制

- 每個狀態目錄只用**一組**主要 bridge/runner。JSONL 帳本不是分散式的多寫入者資料庫。
- Gateway 有 token 預算和通道／聊天上限,但沒有一般性的「每使用者請求」節流。
- 產生的 systemd unit 假設路徑不含空白,啟用前請先看過產生的檔案。

## 選用:codex-memory-river

`codex-memory-river` 只在政策啟用、或用 `--memory-state` 指定時才會載入。要是它被要求
卻無法使用,Agent River 會以明確的 `memory_unavailable` / `memory_context_failed`
原因 fail-closed,而不是讓啟動崩潰。要從同時放著兩個 repo 的工作區啟用:

```sh
npm install --no-save ../codex-memory-river
node bin/codex-agent.js telegram-codex-policy-set --state ~/.codex/agent \
  --default-repo /path/to/repo --memory-enabled true
```

## 驗證變更

```sh
npm test
npm run test:no-memory
npm pack --dry-run
git diff --check
```

## 貢獻與授權

歡迎貢獻,見 [`CONTRIBUTING.md`](CONTRIBUTING.md)。安全回報見 [`SECURITY.md`](SECURITY.md)。
操作手冊見 [`docs/AGENT_TELEGRAM_POLLING.md`](docs/AGENT_TELEGRAM_POLLING.md)。

以 [MIT License](LICENSE) 授權。
