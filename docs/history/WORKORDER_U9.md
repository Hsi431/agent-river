# 工單 U9 — 可靠性+收割(給 Codex)

owner 實測痛點:codex runner 因舊模型名連掛兩次,看板只推「Blocked」不講原因(錯誤原文明明抓到了只記大小);owner 無法中途插話;session 收場後產出蒸發;開場有兩則重複推播。四件事,範圍鎖死。

## 1. 失敗推播帶錯誤原文
- 三個 runner(exchange / codex-exchange / exec)在 `failed_released` / `timed_out_released` / `blocked_terminal` / `claim_failed` 的 dispatch jsonl 紀錄裡加 `error` 欄位(sanitize 後 ≤300 字,exec-runner 的 sanitizeError 模式)。
- dashboard feed 新增游標掃三份 runner dispatch ledger(byte-offset,比照既有 ledgers 模式),推播**終局失敗**(blocked_terminal,及 exec 的第 2 次 failure):`⚠ <agent> 放棄回覆 #<session短碼或msg id>:<error 原文>`。非終局(第 1 次失敗會重試)不推,避免吵。

## 2. /say 中途插話
- dashboard 指令 `/say <session短碼或id> <話>`:session 必須 active,以 from=owner 廣播給全部 participants(比照 kickoff,每人一封、各扣預算);回覆確認+剩餘預算。錯誤講人話(找不到 session / 已收場 / 預算不足,沿用 describeSessionError 模式)。dashboardHint 加 /say。

## 3. 收場自動收割(v1=逐字稿,不呼叫 LLM、不綁 memory-river)
- session 進入任何終局狀態時(feed 偵測到 session_closed event),把整場對話(kickoff、messages、replies,依時間排序,含 from/to/時間)寫成 markdown 逐字稿落 `<stateDir>/session-transcripts/<session_id>.md`(目錄自建)。
- 收場推播改為:`session #xx 收場 reason=<r>,逐字稿:<路徑>` + **最後一封信全文**(不截 60 字;過 redactSecrets)。
- 冪等:同一 session 只寫一次(檔案存在即跳過)。

## 4. 開場雙推播去重
- 經 dashboard `/session` 開的場,同一 cycle 的 feed 跳過該 session 的 `session_opened` 事件(指令回覆已涵蓋);cursor 照常推進。CLI 開的場照舊推播。

## 硬約束
- 不碰:runner 的 eligibility/relay 邏輯、sessions.js 驗證、v2/、telegram.js。
- 測試(真行為):dispatch 紀錄含 error 欄位;終局失敗推播含錯誤原文(獨特 token);/say 廣播扣預算+session 不存在的錯誤訊息;收場後逐字稿檔存在且含全部訊息(獨特 token 雙斷言)+推播含路徑+冪等(觸發兩次只寫一次);dashboard 開場無重複推播、CLI 開場有推播。npm test 全綠。
- 報告 docs/history/WORKORDER_U9_REPORT.md。不 commit 不 push。
