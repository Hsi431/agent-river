# Agent River v3 — Collab Session + 看板 + 握手接入(LOCKED SPEC)

狀態:LOCKED(2026-07-05,fnata 口頭核准全包方向)。本檔是驗收契約;實作與本檔衝突時,以本檔為準,除非 fnata 另行改判。
分工:規格/驗收/審查 = Fable(主對話);實作 = Codex(gpt-5.5,effort **high**,不用 xhigh)。
分支:`v3-session`(自 `v2-phase1` HEAD `bf7c9dd` 切出——main 落後,最新 code 在 v2-phase1)。鐵律:**codex 可在分支 commit,絕不 push;絕不動 main**。

## 0. 重新定位(為什麼做 v3)

agent-river 從「Telegram 遙控器 + 逐步審批」轉型為「**本機多 agent 協作匯流排 + 觀察看板**」。
獨特價值:讓任何 agent(codex、otter/蝦蝦、openclaw…)能在 owner 不在場時開口求援另一個 agent(含反向找 Claude——市面上沒有這條路),owner 用看板「看直播」取代「按核准」。
安全哲學從「事前逐步核准」改為「**事中可見 + 預算圈場 + 少數硬閘**」。硬閘(危險動作)不放鬆。

v1 遙控線 6/7 後流量為零;exchange mailbox 是唯一被真實使用的部分(6/22 前)。v3 圍繞 mailbox 重建,退役遙控線。

## 1. 核心概念:Collab Session

新 ledger:`~/.codex/agent/sessions.jsonl`(append-only,狀態以最後一筆 event 為準)。

Session 欄位(鎖定):
- `session_id`(唯一)、`topic`(owner 5–500 字;agent 發起 20–500 字)、`initiator`(`owner` 或 `agent:<name>`)
- `participants`:已註冊 agent 名單的子集,≥2 名(initiator 為 agent 時自動列入)
- `repo`(可選;必須在 `workspace_root` 內,沿用既有 repo-resolver 規則)
- `budget`:`{max_messages, max_minutes}`。owner 發起預設 10 封/30 分;**agent 發起固定上限 6 封/20 分,不可調高**。**計量語意(2026-07-06 修訂):預算只算 agent 的發言;owner 的開球與 /say 不扣,系統 relay 轉寄不扣**
- `write_access`:owner 發起時可對指定 participant 開 write(沿用既有 workspace-write 執行路徑);**agent 發起的 session 一律唯讀,無例外**
- `state`:`active | closed_ok | exhausted | killed`

行為(鎖定):
- session `active` 期間,participants 之間的 exchange 訊息(帶 `session_id`)**免逐步核准**:runner 自動撿、自動回,agent 每次發言扣預算。**session 綁 repo 時,runner 以該 repo 為工作目錄;未綁 repo 時 prompt 明示「未綁定 repo,勿假設題目與所在 codebase 相關」(2026-07-06 修訂)**。
- 預算耗盡 → session 轉 `exhausted`,推播看板;未完事項由最後一封信講清楚。
- owner 隨時可 `/kill <id>`;kill 後該 session 訊息不再被撿。
- **agent 發起 session 不等 owner 核准,自動開場**,但看板即時推播;這是「求援」場景的核心(owner 睡覺時也能跑)。
- 硬閘不變:危險動作(commit/push/install/delete/repo 外寫檔…,沿用既有分類)在任何 session 內都會被擋下,進看板等 owner 放行。secret-scan 對所有 session 訊息照跑。
- hop limit 在 session 內由預算取代;session 外的舊 dispatch 提案線暫時保留不動,列入第 4 單退役評估。

**信任邊界(鎖定,吸收 v2 的血淚教訓)**:
- **spawn 型 worker(headless claude/codex runner)維持 Node 代寫回信的既有模式**,headless settings 不開 exchange-submit(6/5 那次 deny-glob 失效的教訓:不在 allow 即拒絕,並用行為探針驗證)。
- **常駐型外部 agent(otter、openclaw)用 per-agent token 直接走 CLI 寄/收信**(見 §3),Node 不再是唯一出口,但每封信都要 token + session 預算 + secret-scan 三關。

## 2. 看板(Telegram bot)

- **沿用現有 agent-river bot token**(即現在 `codex-agent-telegram-bridge.service` 用的那顆)。舊 bridge 大腦整個換掉:v1 指令面不搬,一律不認。蝦蝦是另一顆 bot,互不相干。
- 推播(唯讀直播):session 開場/收場/耗盡/被殺;每封 session 訊息一行摘要(`#12 codex→opus:<60字內主旨>(3/10 封)`);硬閘攔截事件;agent 註冊申請。
- 控制件(看板上僅此五種,不再多):
  1. `/session <參與者逗號串> [repo=<名>] [budget=<N>封/<M>分] [write=<agent名>] -- <題目>` 開場
  2. `/sessions` 列活躍 session;`/kill <id>` 殺 session
  3. 硬閘攔截訊息附「放行 / 拒絕」按鈕(沿用既有 approval callback 機制)
  4. agent 註冊申請附「核准 / 拒絕」按鈕
  5. `/agents` 列已註冊 agent 與狀態
- 同一套開場/查詢/殺,CLI 也要有對應 subcommand(bot 與 CLI 走同一底層函式)。
- owner 判定沿用既有 owner allowlist 機制;非 owner 的 Telegram 使用者一律只讀不能控。

## 3. 握手接入(agent 註冊協定)

目標:接新 agent 不改 agent-river 的 code。刻意壓小,不做泛用 plugin framework。

- `join`:`node bin/codex-agent.js agent-join --name <name> --style poll|spawn --capabilities read[,write]` → 寫入 pending 註冊 → 看板推播 → owner 按核准 → 發 per-agent token(落檔 `~/.codex/agent/agent-tokens/<name>.token`,chmod 600),agent 進 allowlist。
- **token 驗證**:常駐型 agent 之後所有 mailbox 操作(`exchange-submit / inbox / claim / reply` + 發起 session)必須帶 token(`--token-file` 或環境變數);token 不符 = 拒絕。防冒名。
- `style: poll` = agent 自己輪詢信箱(otter/openclaw 這型);`style: spawn` = agent-river 起行程(現有 codex/claude runner 收編為此型,平移不重寫)。
- 合約動詞就四件事:表明身分(token)、收信、回信、認 session 預算。不多給。
- 界線(寫進 README):agent-river 管信箱流量與自家 runner 的執行權限;**不管**外部 agent 在它自己家的行為(openclaw 的權限是 openclaw 自己的設定問題)。
- otter 端的輪詢 loop 是 otter-agent repo 的後續工作,不在本 ticket。

## 4. 瘦身(新路跑通後才動手)

退役:v1 任務管線的聊天/分類器面(`direct-send.js` 全部、owner-mode 的 edit/dangerous 意圖分類器中僅供聊天車道用的部分)、舊 Telegram 指令面、chat-inbox/draft/handoff 車道(與 exchange 重疊,6/19 codex 已點名)。
保留:危險動作分類器在硬閘的用途、workspace-write 執行機、exchange/dispatch 核心、secret-scan、safety kill-switch。
執行方式:codex 先交「逐檔刪除清單 + 每檔理由 + 引用它的測試處置」,**Fable 逐檔核准後才准刪**。刪完全測試綠。

## 5. 交付切單與順序(orchestrate 用)

1. **U1 session core**:sessions.jsonl + 預算計量 + runner 撿信邏輯改為認 session + agent 發起 session(唯讀+固定小預算)+ 硬閘接入。純後端,不動 Telegram。
2. **U2 看板 bot**:新 bridge 取代舊 bridge(同 token),§2 全部。依賴 U1。
3. **U3 握手**:註冊協定 + token 驗證 + spawn 型收編。依賴 U1,與 U2 可並行。
4. **U4 瘦身**:§4,依賴 U2 上線(舊線的替代品就位)。

每單驗收(鎖定):
- `npm test` 全綠(既有 506 + 新增);新行為要有**真行為測試**(如真 spawn、真檔案 ledger),不准只有 assertion 式設定檢查。
- 權限/安全邊界改動必附**行為探針測試**(實際 spawn 驗證被拒,not `allow.includes(...)`)。
- codex self-report 不算數,Fable 讀真 diff 逐檔核 + 跑測試後才 commit gate 放行。
- 不 push、不動 main、不自動部署 systemd 變更(unit 檔可產生,啟用等 fnata)。

## 6. Non-goals(v3 明確不做)

跨機器/網路協定(A2A 等)、web UI、泛用 plugin framework、otter 端 code、每動作遠端核准(Phase 2 mode B)、OS 沙箱(Phase 2 遺留,另案)。
