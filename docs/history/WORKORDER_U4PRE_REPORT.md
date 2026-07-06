# WORKORDER U4-pre 自審報告

日期: 2026-07-05
分支: v3-session

## 範圍

本次只執行 `WORKORDER_U4_KILLLIST.md` 的 `Lead 裁決` 中 U4-pre 三點:

1. dashboard owner 的 `@agent` 非 slash 訊息接到既有 v2 lane。
2. dashboard cycle 接手 `sendPendingV2Outbox`、`sendPendingExchangeNotifications`、`sendPendingDispatchNotifications` 三個 flush。
3. 補 dashboard 測試覆蓋 v2 start ack/outbox flush 與三個 flush 的真 ledger 路徑。

未刪任何檔案,未執行 U4-A 列出的刪除項,未 commit,未 push。

## 變更

- `src/agent/telegram.js`
  - export 既有 `maybeHandleV2` 與三個 pending flush 函式。
  - `maybeHandleV2` 保留原本預設 owner policy check,新增 dashboard 呼叫用的顯式參數與測試注入點。
  - 三個 flush 函式本體未搬動、未重寫。

- `src/agent/dashboard/bot.js`
  - owner 且訊息 trim 後以 `@` 開頭時,轉交 `maybeHandleV2`。
  - 非 owner 仍先回 `唯讀`。
  - dashboard cycle 在 feed 後 flush v2 outbox、exchange notifications、dispatch notifications,並回傳各 flush 結果供測試/診斷。

- `test/agent-dashboard.test.js`
  - 新增 owner `@claude` 經 dashboard 進 v2 的測試:假 Telegram transport、fake adapter,斷言 start ack 與同輪 v2 outbox flush。
  - 新增 dashboard cycle 三 flush 測試:用真 JSONL ledger seed v2 outbox、exchange reply notification、dispatch approval notification,斷言送出與 ledger sent/notified 狀態。

## 自審

- 刪檔檢查: `git diff --name-status` 只有 `M` 三個既有檔與本報告新增,無 `D`。
- U4-A 邊界:未碰 `direct-send.js`、`telegram-codex.js`、`telegram-codex-bridge.js`、`chat.js`、`reply-context.js`、`reply-approval.js`、`codex-reply.js`、`bridge.js` 等刪除項。
- 行為邊界:dashboard v2 route 只在 dashboard owner 通過後啟用;未知/未啟用 v2 的 `@...` 仍回 dashboard hint。
- 風險:dashboard 目前只把 flush 需要的 `sendMessage` 方法適配到既有 flush 函式;三個目標 flush 目前也只使用 `sendMessage`。

## 驗證

```
npm test
```

結果: pass,18 個 test file 全綠。
