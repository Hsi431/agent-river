# 工單 U2 — 看板 bot(給 Codex)

先讀 `docs/AGENT_RIVER_V3_SESSION_DASHBOARD.md`(LOCKED spec)§2,和已完成的 U1(`src/agent/sessions.js`、exchange 的 session 掛載)。分支 `v3-session` 工作樹直接改,**不 commit 不 push**。

## 目標(一句話)
一個取代舊 telegram bridge 大腦的看板 bot:唯讀直播 session/硬閘事件,控制件只有 spec §2 列的五種,沿用同一顆 bot token。

## 設計決策(已定,不要重新發明)
1. 新模組群放 `src/agent/dashboard/`(如 `bot.js`、`feed.js`、`commands.js`),入口是新 CLI subcommand `dashboard-bridge`(長輪詢 loop,參數風格比照既有 `telegram-bridge`)+ `dashboard-once`(單輪,測試用)。**不修改任何既有 `telegram*.js`**;若其中有可乾淨 import 的低階 Telegram HTTP helper(sendMessage/getUpdates/answerCallback 那層)就 import 重用,拉不乾淨就在 dashboard/ 內寫最小 client(fetch 直打 Bot API,長輪詢 getUpdates offset 遞增)。token/owner chat id 沿用既有 config 的同一組欄位(同一顆 bot)。
2. 推播(feed):poll-based,無 watcher。每輪掃描:
   - `sessions.jsonl` 新 event(opened/closed:含 reason 與 clamp 標記)
   - 掛 session 的 exchange messages/replies(一行摘要:`#<session 短碼> <from>→<to>: <前60字>(<used>/<max>封)`)
   - `tasks.json` 進入待核准狀態的 edit task(= 硬閘事件),附 inline keyboard `gate:approve:<task_id>` / `gate:reject:<task_id>`,callback 直接呼叫既有 `approveAgentTask`/`rejectAgentTask`(orchestrator.js,只增不改)
   游標落檔 `<stateDir>/dashboard-cursor.json`(記各 ledger 已推進度),重啟不重播舊事件、也不漏新事件(游標初始化=當下檔尾)。
3. 指令(嚴格文法,解析失敗回一行用法說明,不做自然語言猜測):
   - `/session <a,b[,c]> [repo=<名>] [budget=<N>/<M>] [write=<agent>] -- <題目>` → 呼叫 U1 `openSession`(initiator=owner);成功回 `session #<短碼> 開場(參與者/預算/repo)`
   - `/sessions` → `listActiveSessions` 摘要;`/kill <id或短碼>` → `killSession`
   - `/agents` → 先讀 U3 未來的 registry 檔(`<stateDir>/agent-registry.json`),不存在就回「尚無註冊 agent」(U3 會補寫入端;本單只讀)
   - 其他任何文字(含舊 v1 指令)→ 一行提示「這是 v3 看板,指令:/session /sessions /kill /agents」
   - 短碼 = session_id 的 shortHash 前 6 碼,`/kill` 兩種都收
4. 權限:訊息 sender 不在既有 owner allowlist → 只回「唯讀」提示,任何指令與 callback 都拒絕(callback 也要驗 sender)。
5. systemd:加 `dashboard-service-write` subcommand 產生 unit 檔(比照既有 `codex-runner-service-write` 模式),**只產檔,不 enable 不 restart**。舊 bridge 的停用由 owner 手動做,不寫進 code。
6. 單一實例鎖:比照既有 v2-poller.lock 模式,`<stateDir>/dashboard.lock`,防止與第二個 dashboard-bridge 並跑。與舊 bridge 的互斥不用做(owner 切換時手動停舊的)。

## 硬約束
- 不碰:`src/agent/telegram*.js`(import 除外)、`src/agent/v2/`、`direct-send.js`、`owner-mode.js`、既有 orchestrator/exchange/sessions 的函式簽名(只增不改)。非碰不可就停下說明。
- 推播與 callback 的每一條路徑都要過既有 secret-scan(outbound 文字用 redactSecrets 過一遍再送)。
- 測試「真行為」:注入假 transport(比照 agent-telegram.test.js 的手法),用真 ledger 檔跑 feed 游標(兩輪 poll:第一輪推新事件、第二輪不重推;重啟後游標生效不重播)、/session 開場真的寫 sessions.jsonl、gate callback 真的改 task 狀態、非 owner 被拒、解析失敗回用法。獨特 token 字串+雙斷言,不准恆真。
- `npm test` 全綠才交。

## 交回前自審+自修
同 U1:自跑 npm test、讀 diff 對約束逐條檢查(`git diff --stat` 看範圍)、審不過先自修。報告寫 `docs/history/WORKORDER_U2_REPORT.md`(跑了什麼+結果、逐條約束自評、改了哪些檔、不確定的點)。
