# 工單 U11 — 包裝/第一個五分鐘(給 Codex)

目標:陌生人 clone 下來五分鐘內跑起全套。五件事,範圍鎖死。

## 1. 執行檔正名
package.json 加 `"bin": { "agent-river": "./bin/codex-agent.js" }`(舊路徑照舊,systemd 產生器與文件的絕對路徑不改)。README 指令示例維持 `node bin/codex-agent.js`(本 repo 內用法),但 quickstart 提到 `npm link` 後可用 `agent-river <cmd>`。

## 2. `init` 一鍵初始化
新 subcommand `init [--state <dir>] [--workspace-root <dir>] [--systemd-dir <dir>]`:
- 建 state dir、跑 registry-seed、設 workspace_root(給了才設)。
- 產出全部 systemd unit 檔(dashboard + opus/codex runner + exec-runner,呼叫既有四個 service-write)。
- 檢查 `~/.config/codex-agent/telegram.env` 是否存在,不存在就建含註解的空模板(TELEGRAM_BOT_TOKEN=)。
- 結尾印 next-steps 清單:填 token → `systemctl --user daemon-reload` → enable 各 unit → Telegram 打 /session。**絕不自己跑 systemctl**。
- 冪等:重跑不毀既有 config(已存在的值不覆蓋)。

## 3. Quickstart(README 兩份,放最前面)
五步:clone → `npm install` → `node bin/codex-agent.js init` → 填 telegram.env + enable units → Telegram `/session codex,opus -- 題目`。並加一行系統需求:**Linux + systemd(user session);其他平台未支援**。

## 4. 版號 + CHANGELOG
package.json 0.2.0 → **0.3.0**。CHANGELOG.md 加 0.3.0 段,要點(照這些寫,精煉即可):
- Collab sessions:預算圈場(只算 agent 發言)、開球+自動接力、agent 發起求援(唯讀+固定小額)、逐字稿收割、session 轉 edit task(兩步核准)。
- Dashboard bot 取代 v1 遙控:直播 feed、/session /say /sessions /kill /agents /model /task、硬閘與註冊核准按鈕、失敗推播帶錯誤原文。
- 握手接入:agent-join(poll+token / exec 一行接入)、per-agent token、參與者 prompt 模板(docs/AGENT_PROMPT_TEMPLATE.md)。
- v2 @agent launcher 併入 dashboard 單一輪詢者。
- Breaking:v1 聊天/分類器/舊 Telegram 指令面全退役(-9.3k 行),舊 `codex-agent-telegram-bridge.service` 由 `codex-agent-dashboard.service` 取代(cutover 見 docs/history/WORKORDER_U4_KILLLIST.md)。

## 5. 雜項
dashboardHint 與 README 指令清單同步(含 /task)。`init` 有真行為測試(tmp state:units 檔存在、env 模板存在、冪等重跑不覆蓋)。

## 硬約束
不碰 src/agent/ 的執行邏輯(只加 init 的組裝呼叫)。npm test 全綠。報告 docs/history/WORKORDER_U11_REPORT.md。不 commit 不 push。
