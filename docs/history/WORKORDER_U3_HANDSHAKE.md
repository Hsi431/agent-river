# 工單 U3 — 握手接入(給 Codex)

先讀 `docs/AGENT_RIVER_V3_SESSION_DASHBOARD.md`(LOCKED spec)§3,以及已完成的 U1(sessions.js)、U2(src/agent/dashboard/)。分支 `v3-session` 工作樹直接改,**不 commit 不 push**。

## 目標(一句話)
新 agent 跑一次 `agent-join`、owner 在看板按一次核准、拿到專屬 token,之後憑 token 寄/收信與發起 session;不改 code 就能接入。

## 設計決策(已定,不要重新發明)
1. Registry:`<stateDir>/agent-registry.json`,形狀鎖定 `{ "agents": { "<name>": { name, style, capabilities, status, requested_at, approved_at } } }`(status ∈ pending|active|rejected)。U2 的 `/agents` 已在讀這個檔(commands.js 的 readAgentRegistry),形狀要相容它。新模組 `src/agent/registry.js` 管讀寫。
2. CLI:`agent-join --name <name> --style poll|spawn --capabilities read[,write]` → 寫 pending;name 規則沿用 sessions.js 的 VALID_AGENT regex,重名(pending/active)拒絕。`agent-registry-list` 給 CLI 查。
3. 看板接核准:feed.js 加 pending 註冊事件(游標比照既有 task_keys 的做法),推播附 `join:approve:<name>` / `join:reject:<name>` inline keyboard;bot.js 的 callback 處理加 join 分支(owner 驗證與 gate 相同)。核准 → 產 token(crypto.randomBytes(32).toString('hex')),寫 `<stateDir>/agent-tokens/<name>.token`(mode 0o600,目錄 0o700),registry 轉 active;拒絕 → rejected。**token 明文只落那個檔,不進 registry、不進任何 jsonl、不推播**(推播只說「已核准 <name>,token 已落檔」)。
4. Token 驗證(核心):`src/agent/registry.js` 提供 `verifyAgentToken(agentHome, name, token)`(用 crypto.timingSafeEqual 比對)。強制點:
   - `exchange-submit`:`--from` 是 registry 裡 style=poll 的 active agent → 必須帶 `--token-file <路徑>` 或 env `AGENT_RIVER_TOKEN`,驗不過拒絕(錯誤碼 `bad_agent_token`)。
   - `exchange-claim` / `exchange-reply` / `exchange-inbox`:`--agent` 是 poll 型 active agent → 同上。
   - `session-open --initiator agent:<name>`:name 是 poll 型 → 同上;name 不在 registry active → 拒絕(`agent_not_registered`)。
   - **豁免**:owner 的 CLI 操作(from/agent 不在 registry 或是 spawn 型)行為完全不變——opus/codex runner 是 Node 內部呼叫函式層,不走 CLI token 檢查,一行都不要動它們的路徑。
5. spawn 型收編:提供 `registry-seed` CLI(或 agent-join 的 `--style spawn --seeded`,擇一,講清楚)把現有 primary agent(codex)與 enabled exchange_agents(opus)寫進 registry 為 active spawn 型(**不產 token,spawn 型不需要**),讓 `/agents` 看得到全員。既有 config 的 allowlist 邏輯(dispatchTargetAllowlist 等)不改——registry 是新增的顯示/驗證層,不是取代 config。
6. sessions.js 的 participants 驗證:允許清單擴為「既有 dispatchTargetAllowlist ∪ registry active agents」(poll 型接上後才能進 session)。函式簽名不改。

## 硬約束
- 不碰:`telegram*.js`、`v2/`、`direct-send.js`、`owner-mode.js`、runner 內部呼叫路徑(exchange-runner.js / codex-exchange-runner.js 一行不動)。非碰不可就停下說明。
- 既有函式只增不改簽名;既有測試不許改弱。
- 測試「真行為」:join→pending→看板核准 callback→token 檔存在且 mode 0600→registry active(全鏈一條測試);poll 型無 token / 錯 token 的 exchange-submit 與 session-open 被拒(雙斷言:錯誤碼+ledger 無新增);正確 token 成功;spawn 型與 owner 路徑完全不受影響(回歸);join 重名拒絕;非 owner 按 join callback 被拒。timingSafeEqual 長度不等時不能 throw(先比長度)。
- `npm test` 全綠才交。

## 交回前自審+自修
同前兩單:自跑 npm test、讀 diff 逐條對約束、`git diff --stat` 看範圍、審不過先自修。報告寫 `docs/history/WORKORDER_U3_REPORT.md`。
