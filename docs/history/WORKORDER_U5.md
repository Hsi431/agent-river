# 工單 U5 — 看板易用性(給 Codex)

背景:owner 實測 `/session` 失敗只回通用模板,看不懂錯在哪;模型現況在看板上不可見不可改。三件事,範圍鎖死,不多做。

## 1. /session 錯誤講人話
`src/agent/dashboard/commands.js` 的 `/session` 處理,catch 不准再吞錯回通用模板。`sessions.js` 的驗證錯誤要能區分(topic 長度 / participant 不在名單 / budget 格式 / repo 解析失敗)——若需要,把錯誤改成帶 code 的 `sessionError`(檔內既有模式),commands.js 對 code 映射訊息;沒 code 的 fallback 照舊回用法。
dashboard 回覆格式:第一行具體錯誤(繁中,含實際數字,例:`題目太短:7 字,owner 開場至少 5 字`、`參與者 foo 未註冊,現有:codex,opus`),第二行用法。

## 2. topic 下限分級
owner 發起 min **5** 字、agent 發起維持 min **20** 字(`sessions.js` 的 TOPIC_MIN 改依 initiator),max 500 不變。LOCKED spec 已由 lead 修訂:把 `docs/AGENT_RIVER_V3_SESSION_DASHBOARD.md` §1 topic 那行改成「topic(owner 5–500 字;agent 發起 20–500 字)」。

## 3. 看板 /model 指令
- 無參數 → 顯示現況兩行:`opus runner: <exchange_runner_model>`、`codex runner: <codex_runner_model 或 '(codex CLI 預設)'>`。
- `/model opus <值>`、`/model codex <值>` → owner 才能改,走既有 `setTelegramCodexPolicy`(沿用其 requireClaudeModel 等驗證;驗證失敗回具體錯誤訊息)。
- `dashboardHint` 加上 `/model`。

## 硬約束與測試
- 只動:`src/agent/dashboard/commands.js`、`src/agent/sessions.js`、spec 文件那一行、對應測試檔。其他不碰。
- 測試(真行為+真斷言):錯誤映射各案例(斷言含具體數字);owner 5 字題目成功 + agent 發起 5 字被拒;`/model` 顯示、修改後 policy 檔真的變、非 owner 被拒。
- `npm test` 全綠才交。交回前自審+自修(跑測試、讀 diff 對約束),報告寫 `docs/history/WORKORDER_U5_REPORT.md`。不 commit 不 push。
