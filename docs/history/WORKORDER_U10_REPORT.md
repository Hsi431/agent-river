# WORKORDER U10 Report

## 完成內容
- Session 收場 feed 在 session 有 `repo` 時附上 inline button: `task:from-session:<session_id>`，文字為「轉 edit task」；無 repo 的 session 不附按鈕。
- Dashboard callback 新增 `task:from-session:<session_id>` 處理，沿用 owner gate，非 owner 回「唯讀」且不建 task。
- 新增 `/task <session短碼或id> [repo=<名>]`，支援已收場或 active session。無 repo 且未指定 `repo=` 時回指定 repo 的提示。
- Session 轉 task 共用 `submitAgentTask`，建立 `executor="codex"`、`mode="edit"`、`repo=session.repo|repo override` 的 pending approval edit task。
- Task request 內含 session topic、最後一封信全文、逐字稿路徑，以及尾行 `[session:<id>]`；重複轉同一 session 允許建立新 task，並提示前一個 task id。
- `dashboardHint` 已加入 `/task`。

## 測試覆蓋
- 有 repo 的收場推播含「轉 edit task」按鈕；無 repo 不含。
- callback 產生的 task 欄位、request token、transcript path、session marker、pending approval 均已斷言。
- callback 建 task 後同一輪 dashboard feed 推出硬閘 edit task gate，且 gate 有放行按鈕。
- `/task` 無 repo 錯誤、`repo=` override、重複轉提醒均已覆蓋。
- 非 owner `task:from-session` callback 被拒，且不建立 task。

## 驗證
- `npm test` 全綠：19 個 test files / 19 passed。

## 範圍確認
- 未修改 `orchestrator.js`、`tasks.js`、`codex-runner.js` 行為。
- 未修改 sessions/exchange/runner 行為；dashboard 內部僅重用既有 repo resolver 與 `submitAgentTask`。
- 未 commit、未 push。
