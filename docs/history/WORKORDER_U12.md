# 工單 U12 — 預算語意修正 + 直播降噪 + repo 綁定落地(給 Codex)

owner 實測三個體感問題,LOCKED spec §1 已由 lead 修訂(見該檔 2026-07-06 修訂標記)。三件事,範圍鎖死。

## 1. 預算只算 agent 發言
- `consumeBudget` 的觸發點改為:**agent 的 reply**(replyExchangeMessage,任何 agent)與 **agent 的 session submit**(submitExchangeMessage 且 from ≠ "owner" 且 channel ≠ relay 頻道)。owner 的 submit(開球、/say)**不扣**;`relaySessionReply` 的轉寄 submit(channel `session-relay`)**不扣**(它只是把已扣過的發言搬給下一位)。
- 各處 exhaustion 判斷(assertSessionMessageAllowed / isSessionExchangeEligible / expireIfNeeded)照舊比對 messages_used,不用改;開球與 /say 的「預算不足」預檢邏輯同步更新(owner 訊息不再需要預算空間,但 session 已 exhausted 仍要拒絕)。
- 顯示(feed 一行摘要、/sessions、開場回覆)自然跟著 messages_used 走;開場回覆的「已開球 2 封(2/6)」改為「已開球 2 封(0/6)」之類——開球不佔額。

## 2. 直播降噪
- feed 的 session 訊息推播:**from === "owner" 的一律不推**(開場確認與 /say 回覆已涵蓋);agent 發言照推。收場推播不變。

## 3. repo 綁定落地(遺毒清除)
- 兩個 spawn 型 runner(exchange-runner.js / codex-exchange-runner.js)與 exec-runner 撿到 session 訊息時:訊息帶 `repo` → 以該 repo 為工作目錄(spawn cwd / codex `-C`;用 fs.realpathSync 驗證存在,失敗 fallback 原 repoDir 並在 dispatch log 記 `repo_fallback`);訊息不帶 repo → cwd 維持現狀,但 **prompt 加一行**:「本對話未綁定任何 repo;不要假設題目與你目前所在的 codebase 相關,依題目本身回答」。綁 repo 時 prompt 加:「本 session 綁定 repo:<路徑>」。
- exec-runner 的 resolveExecCwd 已有 message.repo 分支,確認行為一致即可(prompt 信封加同樣的 repo 標示欄位)。

## 硬約束
- 不碰:dashboard 控制件、registry、v2/、telegram.js。opus runner 的 claude headless settings(安全信封)**一行不准動**——cwd 換 repo 不需要動 settings(它的 Bash 白名單與 repo 無關的部分保持原樣)。
- 測試(真行為):owner 開球+/say 後 messages_used 仍 0;agent reply 扣 1、relay 不扣;完整 ping-pong 一輪的預算數對(kickoff 0 + A回1 + relay 0 + B回1 = 2/N);feed 不推 owner 訊息、推 agent 訊息;session 綁 repo 時 runner spawn 收到的 cwd/-C 是 session repo(假 spawn 斷言參數);未綁 repo 時 prompt 含「未綁定」字樣;repo 無效時 fallback+記錄。npm test 全綠。
- 報告 docs/history/WORKORDER_U12_REPORT.md。不 commit 不 push。
