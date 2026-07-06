# 工單 U7 — exec 型一行接入(給 Codex)

賣點工程:接入任意 agent = 一行註冊,合約是「stdin 進、stdout 出」。owner 已核准設計。先讀 docs/AGENT_PROMPT_TEMPLATE.md §C 了解 exec 型的行為合約。

## 設計決策(已定)
1. registry 新 style `exec`:`agent-join --name <n> --style exec --exec '<shell command>' [--capabilities read] [--exec-timeout-seconds N(預設 300)] [--exec-cwd <dir>]`。exec 規格存進 registry entry。**看板 join 推播必須顯示完整 command**(owner 核准的就是這條命令);核准後不發 token(exec 型是 Node 代管,同 spawn)。
2. 通用 runner:新模組 `src/agent/exec-runner.js` + CLI `exec-runner-once`。每輪:掃 registry 的 active exec agents,對每個 agent 撿一封 eligible 訊息(eligibility 完全比照 codex runner:to=該 agent + (session eligible 或 channel∈{telegram,dispatch} 且 from∈allowlist) + claim 可用),claim → 以 `sh -c '<command>'` 起行程(cwd=exec_cwd 或 repo 或 HOME;**訊息內容只走 stdin,絕不插進 command 字串**;stdin 給小信封:sender、session topic(若有)、訊息本文)→ stdout 截 64KB 當回覆(過既有 reply 的 secret-scan)→ `replyExchangeMessage` → session 訊息照 U8 呼叫 `relaySessionReply`。
3. 超時擊殺:重用 `src/agent/v2/kill.js` 的 `terminateGroup`(detached 起行程),timeout 用 exec_timeout_seconds。失敗/超時 → release claim,attempts 上限 2(比照 codex runner 模式),dispatch log 落 `<stateDir>/exec-runner-dispatch.jsonl`(帶 agent 名)。
4. systemd:`exec-runner-service-write` 產 timer+service(每 90 秒,比照 codex runner 產生器),只產檔不 enable。
5. 文件:README 兩份加「接入任意 agent」一節——三步(寫個讀 stdin 回 stdout 的入口 → agent-join --style exec → 看板核准),並連到 docs/AGENT_PROMPT_TEMPLATE.md;poll 型範本腳本 `scripts/poll-adapter-example.sh`(inbox→claim→餵指令→reply 的 30 行殼,頂部註解教改)。

## 硬約束
- 不碰:既有 runner 兩檔、telegram.js、v2/(import kill.js 除外)、dashboard 除 join 推播顯示 command 外不動。
- 測試(真行為):join(exec)→核准→registry 有 command 且推播文含 command;端到端——真訊息→exec-runner 用 `cat`(或帶獨特 token 的 echo 腳本)→ reply 落 ledger 且 session relay 觸發;超時擊殺真行程(比照 v2-blockers-round3 的手法);stdout 超限截斷;attempts 上限後不再撿。npm test 全綠。
- 交回前自審+自修,報告 docs/history/WORKORDER_U7_REPORT.md。不 commit 不 push。
