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

## 本機部署與驗證

- 程式放在自行選擇的 checkout，例如 `~/projects/agent-river`。
- 使用獨立狀態目錄，例如 `~/.local/state/agent-river`，將正式資料與測試資料分開。
- 依 README 啟動網頁郵局；需要常駐執行時，可使用 CLI 產生 systemd user service。
- 驗證單人寄信、依能力分派，以及完成對話後的追問；從 GUI 確認回覆與投遞狀態。
- 需要驗證 agent 互相委派時，使用無敏感內容的測試主題；實際啟動 agent 會產生模型用量。

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

## 外部 adapter 啟動與工具能力

外部 agent 的啟動時間可能超過單次 RPC 期限。Adapter 應先透過唯讀狀態查詢確認就緒，
再送出請求，並為整體執行設定期限。逾時時只重試安全的狀態查詢；若尚未確認請求是否
已被接受，不應直接重送，以免重複執行。

Adapter 由外部 agent 的專案維護，不包含在此 repo。可用工具也取決於該 agent 的設定；
郵件成功送達不代表收件者具備行事曆或其他外部服務的存取能力。

## Owner 群組討論

在「撰寫信件」將寄信方式切換為「群組討論」，勾選 Codex、Claude（opus）、Otter，
即可一次寄給多位收件者。你的信在主對話只顯示一次，回覆集中在同一主題。
每位 agent 沿用自己的模型與思考設定；群組不共用單一模型欄位。

群組討論預設共 3 輪，可選 1–3 輪。每輪等所有收件者成功回覆，再將整輪回覆交給各位繼續討論；
最後一輪要求整理共識、分歧與建議下一步。選 1 輪則各自回覆後停止。
任一 runner 失敗或回覆了不適用的 agent-mail 控制區塊，都會暫停後續輪次。
「停止這件事」也會阻止下一輪；已在執行的回覆仍會保留。輪次與每位收件者使用穩定投遞鍵，
重啟可補齊未完成的派送，不會重複建立整輪。

你可在「插話或追問」保留全選，或只勾選想追問的對象。新的追問會開始一組新的有限輪次，
先前討論不再自動追加輪次；已在執行的舊回覆仍可能完成。
新追問附上寄出當時最近的前文（最多 24 筆、24,000 字元），自動接續則附上上一輪所有回覆。
單人郵件仍保留原本的 agent 求助機制；群組回覆中的 agent-mail 不會觸發額外轉寄。
群組採每次發起最多 3 輪的上限，不套用單人自動轉寄鏈的 12 封上限；runner 每日額度與停止開關仍適用。
舊版未設定輪數的群組維持單輪，不會因升級自動重開。

API：`POST /api/mail` 接受 `targets: ["codex", "opus", "otter"]`，搭配 `request`、可選的 `subject`／`repo`，
以及 `rounds: 1`、`2` 或 `3`（省略為 3）。追問使用 `POST /api/mail/:id/messages`；
提供 `targets` 選定對象，省略則寄給這個群組的所有參與者。
