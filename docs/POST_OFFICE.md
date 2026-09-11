# Agent River 中央郵局

Agent River 接收 agent 的信、選擇收件者、喚醒處理程序，並把結果送回寄件 agent。
Owner 在 GUI 看完整往返，也能寄信、追問、改派及停止後續投遞。一般通信不需要逐封核准。

## 開啟郵局

先照 README 完成本機初始化及 agent 註冊，再啟動：

```sh
node bin/codex-agent.js web --state ~/.codex/agent --repo "$PWD" --port 4310
```

開啟 **http://127.0.0.1:4310/mail**。這個程序每兩秒檢查新郵件，各 runner 分別執行，
沿用原有 runner lock。投遞程序只處理新郵局信件，不會順便消耗舊 mailbox 工作。
需啟用 `exchange_runner_enabled`；原有每日額度及停止開關仍適用。

右側「自動投遞」顯示程序的實際回報。沒有程序、設定缺失、暫停或失敗不能當成已完成。
Poll 型 agent 由自己的程序領信；Web worker 會自動喚醒 Codex、Claude 和 exec 型 agent。

## agent 寄信

```sh
node /absolute/path/agent-river/bin/codex-agent.js mail-send \
  --state ~/.codex/agent --from otter --to codex \
  --subject '請幫我看這個問題' --repo /absolute/path/project \
  --text '請說明這段程式為什麼重複投遞。'
```

回傳 `message.thread_id` 是這件事的對話識別。省略 `--to` 或使用 `--to any` 會自動分派：

- `--capability review`：優先找 review agent，通常是 Claude（registry 名稱 `opus`）。
- `--capability coding`：優先找 coding agent，通常是 Codex。
- `--capability general`：優先一般協助 agent，通常是 Otter。
- `auto`：依信件裡的審查／程式關鍵字選類別，沒有合適類別時用可用收件者；實際理由寫入信封並顯示在 GUI。

這是可解釋的規則分派，沒有額外呼叫模型替每封信分類。`claude` 是 `opus` 的收件別名。
自動分派避開原寄件者；指定收件者不會偷偷換人。收件者必須已註冊且可用。

Poll 型 agent 寄信時沿用 `--token-file`，領取／回覆仍用 `exchange-inbox`、
`exchange-claim`、`exchange-reply`。`mail-send` 是新郵局入口；舊 `exchange-submit`
仍保留原本的低階 mailbox 語義，不會自動把所有歷史信件轉成待執行任務。

## exec agent 的求助與回信

原有 `exec-v1` 的 stdin/stdout adapter 可直接使用。新郵局信封多出：

- `conversation_id`：整件事的穩定識別。
- `message_kind`：`request` 或 `result`。
- `text`：含目前信件、有限的往返上下文與回信規則。

Agent 需要另一位幫忙時，在輸出結尾放一個控制區塊：

````text
需要 Codex 幫忙確認。
```agent-mail
{"to":"codex","text":"請確認這個回信流程何時結束。","capability":"coding"}
```
````

郵局自動投遞，結果會以 `result` 送回提出求助的 agent，供它完成原始工作。
完成時只輸出最終文字，不加控制區塊。一般結果不會自動變成新求助；結果沿原始請求返回，
回到 owner 或沒有上層請求時結束。Owner 仍可在同一對話繼續追問。
單一對話最多 12 封 request，避免 agent 持續自行擴張工作。

Codex／Claude 郵件處理沿用既有唯讀 runner；通信不會額外授予修改檔案權限。
Exec agent 使用註冊時指定的程式及其既有工具能力。

## GUI 操作

- 左欄搜尋／篩選每件事，不必從零散帳本重建對話。
- 中欄顯示請求、處理狀態、求助、結果送達與最後結論；底部可插話或追問。
- 右欄顯示參與 agent、投遞程序、repo 與對話識別。
- 改派只允許尚未被領走的信；舊信立即失去投遞資格。
- 停止會阻止待處理工作與後續投遞。正在執行的一輪可能完成，回覆仍留在時間線。
- 每五秒更新；正在填寫表單時暫停更新，搜尋／篩選狀態會保留。
- 舊信件與 session 保留在原收件匣，沒有搬動或刪除。

```sh
node bin/codex-agent.js mail-list --state ~/.codex/agent
node bin/codex-agent.js mail-show --state ~/.codex/agent --id mail_...
node bin/codex-agent.js mail-stop --state ~/.codex/agent --id mail_...
```

新流程沿用 `exchange-messages.jsonl`、claims 與 replies。`mail-events.jsonl` 僅記錄
停止、改派與回覆後投遞結果；`mail-delivery.json` 是投遞程序的狀態回報。
重啟時會補處理已保存的回覆，修復完成標記，並用 delivery key 避免重複送出結果。
不宣稱 provider 執行具有 exactly-once 語義：若它已執行但回覆未落檔，仍受既有 runner 重試規則約束。

## 本機試運轉（2026-09-11）

- 程式：`/home/fnata_claw/agent-river-post-office`，分支 `feat/post-office`。
- 狀態：`/home/fnata_claw/.local/state/agent-river-post-office`，與原 Telegram 狀態分開。
- 實際往返：owner → Otter → Codex → Otter 整理結論，3 封信後結束。
- 實際 GUI 寄信：選擇 review 自動分派，由 Claude 回覆完成。
- 每個步驟的真實信件與回覆都可在 GUI 查看；測試用假資料不在此狀態目錄。
- 常駐服務：`agent-river-post-office.service`，已啟用，與原 Telegram dashboard 分開。
- 新服務啟動後，已從 GUI 對完成的對話追問，Otter 實際回覆「郵局追問已收到」。
- 驗證：432/432 測試、no-memory 432/432、套件 dry-run 與 diff 格式檢查通過；
  桌面 1600px 與手機 390px 實際瀏覽器檢查沒有橫向溢出。

## 每封信指定模型與思考等級

收件 agent、模型與思考等級是獨立選項。GUI 新信與追問表單都有模型欄位及思考等級選單；
CLI 使用 `--model MODEL_ID --effort LEVEL`。留空沿用收件 runner 設定，不保證特定模型。
模型 ID 不限於固定名單；必須是該收件者的 provider 實際支援的模型。思考等級同樣依模型支援，
不相容的選擇會報錯，不會靜默改成別的模型。GUI 標示「指定執行設定」代表傳給 runner 的要求，
不是 provider 已確認的模型版本或成功執行證明。

Agent 求助也可逐封指定，例如：

````text
```agent-mail
{"to":"codex","model":"gpt-6-astra","effort":"high","text":"請分析這個設計的取捨。"}
```
````

Claude 收件者使用 Claude 模型 ID／別名（如 `opus`、`sonnet`）；Codex 使用 Codex 模型 ID。
Otter adapter 支援 `gpt-*` 與 `deepseek-*` 模型，並將 effort 傳給其 thinking level。
模型選擇由寄件者依工作決定；不把實作、審查或一般協助永久綁到單一模型。
轉信可換模型，回傳結果時沿用原求助者在該封信的模型與思考等級。

## Otter 啟動逾時修正（2026-09-11）

實際啟動測得：30 秒時 RPC 尚未就緒，55 秒時才成功回覆 get_state。
原 adapter 在 start 的 100ms 延遲後立刻 prompt，撞上內層 30 秒期限；外層 300 秒期限無法避免。
Otter adapter 現在先用唯讀 get_state 確認就緒，逾時只重試狀態查詢，不重送 acceptance 未知的 prompt。
整體啟動與回覆仍受 adapter 的 240 秒期限約束。郵件提示也補上主旨，讓「如主旨」有完整上下文。
這個修正位於獨立的 `/home/fnata_claw/otter-agent/src/agent-river-exec-adapter.mjs`。

修正後已重試原本的行程問題，Otter 正常回覆、沒有再被啟動逾時擋住。
該路徑目前沒有註冊 Calendar 工具，回覆表示無法取得行程；這不代表已查到行程。
