# 工單 U1 — Collab Session core(給 Codex)

先讀 `docs/AGENT_RIVER_V3_SESSION_DASHBOARD.md`(LOCKED spec,驗收契約)。本工單只涵蓋 §1 session core,**不動任何 Telegram 相關檔案**(那是 U2)。分支已在 `v3-session`,直接在工作樹改,**不 commit、不 push**(commit gate 在 lead)。

## 目標(一句話)
讓已註冊 agent 之間的 exchange 訊息能掛在一個有預算的 collab session 底下自動流動,免逐步 owner 核准,預算耗盡自動收場,危險動作硬閘照舊。

## 設計決策(已定,不要重新發明)
1. 新模組 `src/agent/sessions.js` + ledger `<stateDir>/sessions.jsonl`(append-only events:`session_opened / session_message / session_closed`,closed 帶 reason `ok|exhausted|killed`)。讀取時 fold events 得目前狀態,格式比照既有 exchange.js 的 jsonl 慣例。
2. Session 欄位照 spec §1 鎖定清單:session_id、topic(20–500 字)、initiator(`owner` 或 `agent:<name>`)、participants(≥2,`exchange_agents`/dispatchTargetAllowlist 既有名單子集)、repo(可選,沿用既有 workspace_root 解析與限制)、budget(owner 預設 10 封/30 分;**initiator 為 agent 時強制 6 封/20 分,傳入更大值一律 clamp 並記 event**)、write_access(agent 發起一律空,owner 發起可指定)、state。
3. API(供 U2/U3 用,先做函式層+CLI,不做 bot):`openSession / getSession / listActiveSessions / killSession / closeSession / consumeBudget`。CLI subcommand:`session-open --initiator owner --participants a,b [--repo X] [--budget-messages N] [--budget-minutes M] [--write-access a] --topic "..."`、`session-list`、`session-kill --id`、加 `session-show --id`。agent 發起走 `session-open --initiator agent:<name>`(token 驗證是 U3,本單先留 initiator 欄位,不做驗證)。
4. exchange 訊息掛 session:`exchange-submit` 加選用 `--session <id>`;`submitExchangeMessage` 記 `session_id` 欄位。掛了 session 的訊息:
   - 提交時檢查 session `active`、from/to 都在 participants、預算未爆;任一不符 → 拒絕(明確錯誤碼 `session_not_active / not_participant / budget_exhausted`)。
   - 提交成功即 `consumeBudget`(以「訊息數」計;分鐘預算用 opened_at + max_minutes 到期判定,`getSession` 時惰性判定過期並自動 close(reason exhausted),不用 timer)。
5. runner 撿信邏輯(`exchange-runner.js` 的 opus 側 + `codex-exchange-runner.js`):新增 eligibility——訊息帶 `session_id` 且該 session `active` 且 from/to ∈ participants ⇒ **eligible,不需要 channel ∈ {telegram,dispatch} 的舊條件**(舊條件對非 session 訊息照舊保留,行為完全不變)。runner 回信也要掛同一 session_id 並扣預算;session 已死則跳過並在 runner dispatch log 記 skip 原因。
6. 硬閘不動:不改 codex-runner 的 sandbox 分級、不改 service.js 的 claude headless allow/deny(spawn 型 worker 維持 Node 代寫回信;**不准**在任何 settings 開 exchange-submit)。write_access 本單只落欄位與讀取函式,實際 workspace-write 接線留給後續(現行 owner 核准 edit 路徑不動)。
7. secret-scan:session 訊息與回信走既有掃描路徑,不得繞過。

## 硬約束
- 既有 API/CLI 只增不改名;既有 506 測試不許改弱(改測試=紅旗,除非明確是新行為的正當更新且註明)。
- 不碰:`src/agent/telegram*.js`、`src/agent/v2/`、`src/agent/direct-send.js`、`src/agent/owner-mode.js`、systemd unit 產生器。若發現非碰不可,**停下來寫明原因,不要硬改**。
- 新測試要求「真行為」:真的寫 ledger 檔、真的跑 fold、真的驗 runner eligibility(用假訊息+獨特 token 字串+雙斷言);預算 clamp、過期自動關、非 participant 拒絕、殺掉後 runner skip,各要有測試。不准恆真斷言。
- `npm test` 全綠才算完。

## 交回前自審+自修(必做)
交回前自己跑 `npm test`、讀自己的 diff 逐條對上面硬約束(有沒有改名、有沒有碰禁區 `git diff --stat` 看、測試是不是真驗證)。審不過自己先修,綠了才交。交回附簡短自審報告:跑了什麼+結果、逐條約束自評、改了哪些檔、不確定/沒解的點。報告寫到 `docs/history/WORKORDER_U1_REPORT.md`。
