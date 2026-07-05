# 工單 U8 — session 開球 + 接力(給 Codex)

owner 實測:`/session codex,opus -- 打招呼` 開場成功但永遠沒有回音。根因:(1) 開場沒有把 topic 變成第一封信;(2) runner 只回寄件者,participants 之間沒有接力。本單補齊這兩塊,這是旗艦場景。

## 設計決策(已定)
1. **owner 是隱性參與者**:`sessions.js` 的 participants 檢查(assertSessionMessageAllowed / isSessionExchangeEligible)把字面值 `"owner"` 視為 owner 發起 session 的合法 from/to(agent 發起的 session 也把 `"owner"` 視為合法收件者,讓求援結果能寄回)。owner 的信照樣扣預算、照樣 secret-scan。
2. **開球**:owner 開 session 成功後,自動把 topic 作為 kickoff 訊息廣播給**每一位** participant(from=`owner`,一人一封,各扣預算)。dashboard `/session` 與 CLI `session-open` 都做(CLI 加 `--no-kickoff` 可關,預設開;agent 發起的 session 不 kickoff——它自己會寄第一封)。開場回覆文案附預算提醒(例:`session #xx 開場,已開球 2 封(2/6)`)。
3. **接力(核心)**:兩個 runner(exchange-runner.js / codex-exchange-runner.js)成功寫回 session reply 之後,若 session 仍 active 且預算未爆:由 Node 把該 reply 的文字作為**新的 session 訊息**轉寄給下一位 participant(participants 中排除回覆者本人,兩人場=對方;三人以上=照 participants 排序輪替)。from=回覆的 agent。預算爆了就走既有 exhausted 收場,不轉寄。轉寄失敗(如 budget_exhausted race)吞掉不 crash,runner summary 記 relay_skipped 原因。
4. **迴圈保險**:接力只由「runner 寫回的 reply」觸發,kickoff 與人工 submit 不觸發二次;預算是唯一終結者,不加別的聰明判斷。
5. 收件者是 `owner` 的信不進 runner(沒有 owner runner),它的意義是留在帳本+feed 推播給人看。

## 硬約束
- 只動:sessions.js、exchange.js(若 kickoff 需要)、兩個 runner、dashboard commands.js、cli.js 的 session-open、對應測試。禁區照舊(telegram*.js 的 v2 lane、v2/、dashboard 其他件)。
- 既有非 session 行為零改動;既有測試不改弱。
- 測試(真行為):開球後 ledger 有 N 封 from=owner 的 session 訊息且預算正確扣;兩人 session 完整 ping-pong 一輪(kickoff→A reply→自動轉寄給 B→B reply)用假 spawn 驗到 ledger 層;預算爆時接力停且 session exhausted;agent 發起不 kickoff;--no-kickoff 生效。npm test 全綠。

## 交回
自審+自修照舊,報告 docs/history/WORKORDER_U8_REPORT.md。不 commit 不 push。
