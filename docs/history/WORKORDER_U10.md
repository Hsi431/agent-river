# 工單 U10 — session 結論轉 edit task(給 Codex)

閉環工程:討論(session)→ 動手(既有 workspace-write edit task)。全程重用既有核准機器,不造新執行路徑。

## 設計決策(已定)
1. **收場推播加按鈕**:U9 的 session 收場推播,若該 session 有 `repo`,附 inline button `task:from-session:<session_id>`(文字「轉 edit task」)。無 repo 的 session 不附按鈕。
2. **callback 處理**(bot.js,owner 驗證同 gate/join):按下 → 用既有 `submitAgentTask` 建 edit task:`executor: "codex"`、`mode: "edit"`、`repo: session.repo`、`request` = 組合文字(session topic + 「結論(最後一封信)」全文 + 一行「完整逐字稿:<transcript 路徑>」)。task 進既有 pending approval 狀態 → 既有 feed gateEvents 自然會推「硬閘 edit task … 放行/拒絕」。也就是兩步指尖:轉任務 → 放行。
3. **指令變體**:`/task <session短碼或id> [repo=<名>]` — 對已收場(或 active)session 手動轉;session 無 repo 且未帶 repo= → 回「這場沒綁 repo,用 /task <id> repo=<名> 指定」。repo= 解析沿用 resolveSessionRepo 同款規則與錯誤訊息。
4. **冪等**:同一 session 重複轉 → 允許(可能要開多個任務),但回覆要附前一個 task id 提醒(「注意:此 session 已轉過 task_xxx」);判斷靠 tasks 的 request 內含 session_id 標記(request 尾行加 `[session:<id>]`)。
5. dashboardHint 加 /task。

## 硬約束
- **不動** orchestrator.js / tasks.js / codex-runner.js 的任何行為——只呼叫既有 `submitAgentTask`。不動 sessions/exchange/runner。
- 測試(真行為):有 repo 的收場推播含按鈕、無 repo 不含;callback 建出的 task 欄位正確(executor/mode/repo/request 含 topic+最後信+transcript 路徑+session 標記,獨特 token 斷言);task 進 pending 且下一輪 feed 推出帶放行按鈕的 gate 事件;/task 無 repo 的錯誤訊息;重複轉的提醒;非 owner callback 被拒。npm test 全綠。
- 報告 docs/history/WORKORDER_U10_REPORT.md。不 commit 不 push。
