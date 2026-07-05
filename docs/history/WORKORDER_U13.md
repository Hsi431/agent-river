# 工單 U13 — push 前安全加固(給 Codex)

盲審(docs/history/SECURITY_REVIEW_V3_PREPUSH.md)四個 MAJOR,lead 已對真 code 逐條確認為真。修這四個,MINOR(jsonl 記憶體放大)不在本單(併入 backlog 的 ledger 輪替)。範圍鎖死。

## 1. exchange-release 補 token gate
`src/agent/cli.js` 的 `exchange-release` case 加 `requirePollAgentTokenIfNeeded({ agentHome, name: requireArg(args,"agent"), tokenFile: args["token-file"] })`,與 claim/reply 一致。測試:active poll agent 無 token 的 release 被拒(bad_agent_token);owner/spawn agent 不受影響。

## 2. runner cwd 重新驗證 workspace_root + fail-closed
`src/agent/runner-repo.js` 的 `resolveMessageRepoBinding` 加參數 `workspaceRoot`:綁定 repo 的 realpath 必須落在 `workspaceRoot` 內(用 path 前綴 + sep 檢查,防 `/ws-evil` 混淆);realpath 失敗或落在 workspace 外 → **不 fallback 到 service repoDir**(那正是舊「遺毒」),改走 unbound 行為(cwd = 一個中性安全目錄,建議 os.homedir();promptLine 用 UNBOUND_REPO_PROMPT_LINE),並在回傳的 repoFallback 記 reason(`outside_workspace` / `realpath_failed`)。三個 runner 呼叫點把 workspaceRoot 從 `getTelegramCodexPolicy(agentHome).workspace_root` 傳入。workspaceRoot 未設定時維持現行為(realpath-only)但仍不 fallback 到 repoDir(改用 homedir + unbound)。測試:綁 workspace 外的 repo → cwd 是 homedir + unbound prompt + repoFallback reason;綁 workspace 內合法 repo → cwd 正確;前綴混淆(/ws vs /ws-evil)被擋。

## 3. exec 子行程 env 白名單(不繼承 parent secrets)
`src/agent/exec-runner.js` 的 `runExecCommand`:env 不再用整包 `process.env`,改成白名單最小集——`PATH`、`HOME`、`LANG`、`LC_*`、`TZ`、`USER`(存在才帶),外加一個 `AGENT_RIVER_MESSAGE=1` 標記。**絕不帶** `TELEGRAM_BOT_TOKEN`、`AGENT_RIVER_TOKEN`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 等。測試:spawn 收到的 env 不含 TELEGRAM_BOT_TOKEN/OPENAI_API_KEY(設一個假的在 process.env 驗證被濾掉),含 PATH。注意:只動 exec-runner(第三方命令面);claude/codex runner 的 env 需要繼承(它們是自己的 CLI,靠 env 認證)——不要動那些。

## 4. v2 outbox 送出前過 secret 濾網
v2 result text 進 outbox 或送 Telegram 前套 `redactSecrets`(與 dashboard 出站、exchange reply 一致)。改在 `src/agent/v2/poller.js` 寫 `appendV2Outbox` 的 `text` 前 redact(源頭擋,逐字稿/log 也乾淨)。測試:result.text 含假 secret pattern → outbox 落檔已 redact。

## 硬約束
- 不碰 claude/codex runner 的 env 繼承、settings 安全信封、dashboard 控制件邏輯。
- 每個 fix 附真行為測試(獨特 token、雙斷言)。npm test 全綠。
- 報告 docs/history/WORKORDER_U13_REPORT.md,逐條對應 finding。不 commit 不 push。
