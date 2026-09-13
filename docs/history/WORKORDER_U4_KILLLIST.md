# Workorder U4 Killlist - v1 Retirement Investigation

日期: 2026-07-05

範圍: 只做調查清單,等待 lead 逐檔核准後才可刪改。沒有刪檔、沒有程式碼變更、沒有跑 `npm test`。

依據: `docs/AGENT_RIVER_V3_SESSION_DASHBOARD.md` §4 lines 63-67:
退役 v1 任務管線的聊天/分類器面、舊 Telegram 指令面、chat-inbox/draft/handoff 車道;保留危險動作分類器在硬閘用途、workspace-write 執行機、exchange/dispatch/session/dashboard、secret-scan、safety kill-switch、v2 launcher。

## `src/agent/direct-send.js` - 334 lines

- 處置: 整檔刪。
- 理由: 這整檔只服務 DS1/DS2 direct-send inbound classifier、output guard、audit,屬於 v1 聊天/分類器面。
- 誰還在 import 它:
  - `src/agent/telegram-codex.js:8` imports `canBuildDirectSendPrompt`, `evaluateDirectSend`, `recordDirectSendAttempt`.
  - `test/agent-telegram.test.js:13` imports classifier/guard functions directly.
- 對應測試檔的處置:
  - `test/agent-telegram.test.js` - 3586 lines: 刪 direct-send unit/integration tests around lines 1940-2268 (`DS1 direct-send`, `DS2 trusted Q&A`, audit/gate tests) and remove import at line 13.
- 風險註記: 刪掉後 v1 `telegram-codex-once` auto-send/audit/trusted-QA behavior 會斷;這正是 U4 退役目標。不可移除 secret-scan 本身。

## `src/agent/owner-mode.js` - 422 lines

- 處置: 部分刪。
- 理由: owner allowlist/notice/approval markup 可被保留或搬移,但 `classifyOwnerActionMode`, `classifyOwnerInbound`, `classifyOpusAsk` 是 v1 chat lane 的 owner intent classifier。
- 部分刪函式名:
  - 刪/搬離 v1 chat classifier: `classifyOwnerActionMode`, `classifyOwnerInbound`, `classifyOpusAsk`, `isPreviousPlanFollowup`, `reviewerDelegationTarget`, `isLowRiskEdit`, `isEditActionRequest`, `actionRequestReasons`, `isLowRiskPlanRequest`, `hasDangerousAction`, `hasReadOnlyIntent`, `hasExplicitReadOnlyBoundary`, `isReadOnlyDangerousReference`.
  - 保留或 rehome: `isDangerousActionRequest` + `hasEnglishActionWord` + `escapeRegex`,因 §4 要保留危險動作分類器作硬閘用途。調查結果: `isDangerousActionRequest` 目前是 private function,只被本檔 `classifyOwnerActionMode` line 155、`classifyOpusAsk` line 234 間接使用;沒有被硬閘以外的檔案直接 import。
  - 保留或 rehome owner UI helpers: `isOwner`, notice constants, `ownerTaskReplyMarkup`, `ownerReplyApprovalMarkup`, parse owner callback/command helpers,除非同一批移除 v1 approval callbacks。
- 誰還在 import 它:
  - `src/agent/gateway.js:12-20` imports `classifyOpusAsk`, `isOwner`, owner notices/markup.
  - `src/agent/telegram-codex.js:23-52` imports `classifyOwnerInbound`, owner command parsers, notices, audit, follow-up/delegation classifiers.
  - `src/agent/telegram.js:13` imports `isOwner`, `ownerTaskReplyMarkup`.
  - `test/agent-owner-mode.test.js:13` imports classifiers directly.
- 對應測試檔的處置:
  - `test/agent-owner-mode.test.js` - 1904 lines: 大多數 owner-mode chat classifier/Telegram owner-flow tests 刪或改;保留 only 若硬閘 classifier 被 rehomed 後新增/改成硬閘測試。重點 line 735-787 classifier tests 必須改成硬閘測試或刪。
  - `test/agent-gateway.test.js` - 1341 lines: owner `@opus` edit/dangerous gateway paths需刪/改; exchange gateway tests 留。
  - `test/v2-wiring.test.js` - 83 lines: 若 `isOwner`/policy owner 判定搬移,需改 import dependency但保留 v2 launcher tests。
- 風險註記: 若直接刪整檔會斷 v2 owner判定、gateway model controls、dashboard owner allowlist間接依賴;應先把 owner allowlist與 dangerous hard-gate classifier抽到保留模組。

## `src/agent/telegram-codex.js` - 884 lines

- 處置: 整檔刪。
- 理由: 這是舊 Telegram v1 大腦: poll free-form chat inbox -> Codex reply -> queue/send/approval/direct-send/owner-mode。
- 誰還在 import 它:
  - `src/agent/telegram-codex-bridge.js:5` imports `telegramCodexOnce`.
  - `src/agent/cli.js:20` imports `telegramCodexLoop`, `telegramCodexLoopDryRun`, `telegramCodexOnce`.
  - `test/agent-owner-mode.test.js:7` imports `telegramCodexOnce`.
  - `test/agent-telegram.test.js:9` imports `telegramCodexLoop`, `telegramCodexLoopDryRun`, `telegramCodexOnce`.
- 對應測試檔的處置:
  - `test/agent-telegram.test.js` - 3586 lines: 刪 `telegram-codex-once` tests lines 1605-2268, loop tests lines 2732-2836, lock/cost/approval tests lines 3028-3228, real-runner source check line 3365.
  - `test/agent-owner-mode.test.js` - 1904 lines: 刪依賴 `telegramCodexOnce` 的 owner-mode chat tests。
- 風險註記: 刪掉後 `telegram-codex-once`, `telegram-codex-loop`, approval-before-send, direct reply, owner-mode over Telegram 都會斷;v3 dashboard bridge必須已替代舊 bridge。

## `src/agent/telegram-codex-bridge.js` - 212 lines

- 處置: 整檔刪。
- 理由: foreground long-poll wrapper只排程 `telegramCodexOnce`,屬舊 Telegram bridge 大腦。
- 誰還在 import 它:
  - `src/agent/cli.js:21` imports `telegramCodexBridge`, `telegramCodexBridgeStatus`.
  - `test/agent-telegram.test.js:10` imports bridge functions.
  - `test/v2-blockers-round3.test.js:23` imports `telegramCodexBridge`.
- 對應測試檔的處置:
  - `test/agent-telegram.test.js` - 3586 lines: 刪 bridge behavior/status/source tests lines 2864-3006.
  - `test/v2-blockers-round3.test.js` - 228 lines: 改掉對舊 bridge 的 lock/bridge assertions;保留 v2 poller/session blocker coverage。
- 風險註記: 刪掉後 `telegram-codex-bridge` process 與 `codex-agent-telegram-bridge.service` 目標失效;應由 `dashboard-bridge` / `codex-agent-dashboard.service` 接手。

## `src/agent/chat.js` - 434 lines

- 處置: 整檔刪,或在同批刪光下游後整檔刪。
- 理由: 這檔就是 `chat-inbox.jsonl`, `chat-replies.jsonl`, `drafts/`, `handoffs/` 舊車道。
- 誰還在 import 它:
  - `src/agent/cli.js:4-17` imports chat status/draft/handoff/reply functions.
  - `src/agent/telegram.js:8` imports enqueue/reply send state and `src/agent/telegram.js:26` imports `queueChatReply`.
  - `src/agent/telegram-codex.js:4` imports chat reply state/inbox/queue.
  - `src/agent/reply-context.js:2` imports inbox/replies for prompt history.
  - `src/agent/reply-approval.js:4` imports `assertChatReplyAllowed`, `queueChatReply`.
  - `src/agent/codex-reply.js:1` imports inbox/reply queue.
  - `src/agent/bridge.js:1` imports chat summary/status.
  - `test/agent.test.js:7` and `test/agent-telegram.test.js:7` import chat functions directly.
- 對應測試檔的處置:
  - `test/agent.test.js` - 1934 lines: 刪 chat draft/handoff/reply/prune tests around lines 712-1124, `codex-reply-once` tests lines 1753-1844, direct chat reply guard tests around 1532-1552.
  - `test/agent-telegram.test.js` - 3586 lines: 刪 free-form chat inbox/reply send tests around lines 366-387, 1064-1180, 1444-1509, and all telegram-codex tests using chat ledgers.
- 風險註記: 刪掉後 old manual inbox/draft/handoff/reply queue全斷;exchange mailbox、sessions、dashboard不應受影響。

## `src/agent/reply-context.js` - 71 lines

- 處置: 整檔刪。
- 理由: 只為 `telegram-codex.js` 組 direct Telegram reply prompt與同聊天室 history。
- 誰還在 import 它:
  - `src/agent/telegram-codex.js:5` imports `buildTelegramReplyPrompt`.
  - `test/agent-telegram.test.js:12` imports `buildTelegramReplyPrompt`.
- 對應測試檔的處置:
  - `test/agent-telegram.test.js` - 3586 lines: 刪 prompt history/memory context tests around lines 2516-2601。
- 風險註記: 刪掉後 v1 Telegram reply prompt context 斷;Memory River adapter本身保留。

## `src/agent/reply-approval.js` - 93 lines

- 處置: 整檔刪。
- 理由: 只服務 v1 model reply approval queue,依賴 chat reply queue。
- 誰還在 import 它:
  - `src/agent/cli.js:22` imports approval CLI functions.
  - `src/agent/telegram-codex.js:7` imports `approveReply`, `createReplyApproval`, `rejectReply`.
  - `test/agent-owner-mode.test.js:10` imports `listPendingReplyApprovals`.
  - `test/agent-telegram.test.js:18` imports approval functions.
- 對應測試檔的處置:
  - `test/agent-telegram.test.js` - 3586 lines: 刪 reply approval tests around lines 2488-2498, 3113-3190 and CLI approval tests lines 575-577 via docs only.
  - `test/agent-owner-mode.test.js` - 1904 lines: 刪 owner reply approval tests using `listPendingReplyApprovals`.
- 風險註記: 刪掉後 `reply-approval-*` 舊 pending approval flow 斷;dashboard hard-gate approval走 task approval,不應依賴此檔。

## `src/agent/codex-reply.js` - 77 lines

- 處置: 整檔刪。
- 理由: 這是舊 chat-inbox fake runner/manual draft reply skeleton,不是 v3 mailbox runner。
- 誰還在 import 它:
  - `src/agent/cli.js:19` imports `codexReplyOnce`.
  - `src/agent/reply-context.js:1` imports `directReplyInstructionLines`.
  - `test/agent.test.js:8` imports `codexReplyOnce`; `test/agent.test.js:1844` source-checks this file.
  - `test/agent-telegram.test.js:17` imports prompt builders.
- 對應測試檔的處置:
  - `test/agent.test.js` - 1934 lines: 刪 `codex-reply-once` tests lines 1753-1844.
  - `test/agent-telegram.test.js` - 3586 lines: 刪 direct/manual reply prompt assertions tied to v1 reply path.
- 風險註記: 刪掉後 old fake reply smoke path 斷;real workspace-write runner `orchestrator/tasks/codex-runner` 不受影響。

## `src/agent/bridge.js` - 35 lines

- 處置: 整檔刪。
- 理由: `bridge-once` 只是 old `telegram-poll` + local chat inbox/status summary。
- 誰還在 import 它:
  - `src/agent/cli.js:18` imports `runBridgeOnce`.
  - `test/agent-telegram.test.js:8` imports `runBridgeOnce`.
- 對應測試檔的處置:
  - `test/agent-telegram.test.js` - 3586 lines: 刪 `bridge once polls Telegram and returns local inbox summary` around lines 1444-1462。
- 風險註記: 刪掉後 `bridge-once` CLI斷;v3 `dashboard-once`/`dashboard-bridge`保留。

## `src/agent/telegram.js` - 943 lines

- 處置: 部分刪。
- 理由: 同檔混有 v2 launcher/Telegram transport/notification flush 與 v1 chat/gateway/callback面,不可整檔刪。
- 部分刪函式名/區塊:
  - 刪 v1 chat queue branch: `handleTelegramUpdate` lines 46-61 的 free-form `enqueueChatMessage` fallback。
  - 刪 old gateway/model-control callback path if dashboard fully replaces it: `handleTelegramCallback`, `parseOwnerCallbackData`, `modelControlsMarkup`, `formatTelegramModelStatus`, `claudeModelLabel` lines 686-921, except dispatch/gate callback若尚未由 dashboard fully covered則先保留到替代確認。
  - 刪 chat reply flush: `sendPendingTelegramReplies` lines 434-456 and `pollTelegramOnce` line 301 use.
  - 保留 v2 launcher: `maybeHandleV2`, `v2Payload`, v2 outbox flush lines 89-230 and `sendPendingV2Outbox` lines 206-230.
  - 保留 Telegram transport/poller state if `telegram-poll` remains a v2 smoke path: `parseTelegramUpdateJson`, `acquirePollerLock`, `releasePollerLock`, `pollTelegramOnce`, `createTelegramRequest`, send helpers.
  - 保留 exchange/dispatch notification only if still used after dashboard migration: `sendPendingExchangeNotifications`, `sendPendingDispatchNotifications`; otherwise list as later dashboard migration cleanup,not U4 immediate delete.
- gateway 對 v1/v2 依賴調查:
  - `telegram.js` 目前先跑 `maybeHandleV2` lines 39-44;命中 v2 後不進 gateway。
  - v1 fallback 使用 `isGatewayText`/`handleGatewayMessage` lines 64-86;非 gateway text 進 chat-inbox lines 46-61。
  - `gateway.js` 本身沒有 import v2;v2 只依賴 `telegram.js` wrapper。
- 誰還在 import 它:
  - `src/agent/cli.js:43` imports `handleTelegramUpdate`, `parseTelegramUpdateJson`, `pollTelegramOnce`.
  - `src/agent/telegram-codex.js:10` imports `pollTelegramOnce`.
  - `src/agent/telegram-codex-bridge.js:6` imports poller lock helpers.
  - `src/agent/reply-approval.js:5` imports `pollTelegramOnce`.
  - `src/agent/bridge.js:2` imports `pollTelegramOnce`.
  - `test/agent-telegram.test.js:19`, `test/v2-wiring.test.js:6`, `test/v2-amendments.test.js:16` import Telegram functions.
- 對應測試檔的處置:
  - `test/agent-telegram.test.js` - 3586 lines: 刪 v1 adapter/gateway/chat/callback/model-control tests where tied to old command surface;保留/改 Telegram transport and v2 outbox tests as needed.
  - `test/v2-wiring.test.js` - 83 lines: 保留,但若 v1 fallback removed, line 60 "non-owner @agent falls through to v1" 預期需改。
  - `test/v2-amendments.test.js` - 506 lines: 保留 poller lock tests importing `acquirePollerLock`, `releasePollerLock`.
- 風險註記: 誤刪整檔會斷 v2 `@agent` launcher與 Telegram request primitives;只可切 v1 branch。

## `src/agent/gateway.js` - 593 lines

- 處置: 部分刪。
- 理由: gateway 還承載 exchange mailbox command parser與 model config,但 owner `@opus` edit/dangerous chat routing 是 v1 owner-mode classifier面。
- 部分刪函式名/區塊:
  - 刪 `routeOwnerOpusAsk` lines 302-354 and imports `classifyOpusAsk`, owner edit notices/markup lines 11-20,若 hard-gate改由 dashboard/task approval處理。
  - 保留 `parseGatewayCommand`, `parseGatewayShortcut`, `exchange_ask`, `exchange_inbox`, `exchange_replies`, `exchange_thread`, `agent_config`, `agent_models` unless dashboard fully replaces Telegram command gateway.
- gateway 對 v1/v2 依賴調查:
  - v1: `exchange_ask` lines 225-265 supports Telegram `@opus` shortcuts and owner-only `routeOwnerOpusAsk` lines 233-237.
  - v2: no direct import/dependency;v2 routing happens in `telegram.js` before gateway fallback.
- 誰還在 import 它:
  - `src/agent/telegram.js:9` imports `handleGatewayMessage`.
  - `src/agent/cli.js:39` imports `handleGatewayMessage`.
  - `test/agent-gateway.test.js:7` imports `handleGatewayMessage`, `parseGatewayCommand`, `safeGatewayReply`.
  - `scripts/no-memory-smoke.js:25` imports `./src/agent/gateway.js`.
- 對應測試檔的處置:
  - `test/agent-gateway.test.js` - 1341 lines: 刪 owner `@opus` edit/dangerous classifier tests;保留 exchange/gateway parser tests if CLI gateway still supported.
- 風險註記: 刪錯會斷 exchange shortcut (`@opus`, `agent thread`, inbox/replies)與 model config controls;若舊 Telegram 指令面全退役,CLI `gateway` subcommand也可能變孤兒。

## `src/agent/cli.js` - 616 lines

- 處置: 部分刪。
- 理由: CLI 同時暴露保留的 exchange/session/runner/dashboard 與 old chat/Telegram v1 subcommands。
- 會變孤兒的 subcommands:
  - chat-inbox/draft/handoff/reply lane: `inbox` lines 80-81, `chat-status` 82-83, `chat-prune` 84-85, `draft` 179-180, `draft-latest` 181-182, `handoff` 183-184, `handoff-latest` 185-186, `handoff-status` 187-188, `handoff-complete` 189-194, `handoff-complete-latest` 195-199, `reply` 200-207, `reply-latest` 208-214.
  - old Telegram v1 brain: `bridge-once` 267-274, `codex-reply-once` 275-276, `telegram-codex-once` 277-287, `reply-approval-list` 288-289, `reply-approval-approve` 290-291, `reply-approval-reject` 292-293, `telegram-codex-loop-dry-run` 333-334, `telegram-codex-approval-send` 366-374, `telegram-codex-loop` 375-385, `telegram-codex-bridge` 386-410, `telegram-codex-bridge-status` 411-412.
  - old systemd generators: `telegram-codex-service-print` 360-361, `telegram-codex-service-write` 362-363, `telegram-codex-service-status` 364-365.
  - policy flags to prune from `telegram-codex-policy-set`: direct-send and owner-mode classifier flags lines 308-315, 325-328; loop policy flags lines 299-303 may be removed if no old loop remains. Keep `default_repo`, `exchange_notify_*`, `exchange_runner_*`, `codex_runner_model`, `v2_enabled`, `workspace_root`.
  - `telegram-update` 251-258 and `telegram-poll` 259-266: not automatically orphaned if retained as v2/transport smoke path; if dashboard fully owns Telegram polling, retire them too.
- 誰還在 import 它:
  - Entry point `bin/codex-agent.js` imports `runAgentCli` (verified by source tree; keep CLI file).
  - Tests invoke `runAgentCli` broadly, especially `test/agent.test.js`, `test/agent-telegram.test.js`, `test/agent-dashboard.test.js`.
- 對應測試檔的處置:
  - `test/agent.test.js` - 1934 lines: 刪 chat/draft/handoff/reply/codex-reply CLI tests.
  - `test/agent-telegram.test.js` - 3586 lines: 刪 old Telegram CLI, policy, loop, service tests; keep exchange runner service tests lines 2342-2413 and dashboard tests elsewhere.
  - `test/agent-dashboard.test.js` - 280+ lines: 保留 dashboard CLI/service tests lines 218-239.
- 風險註記: CLI 是共享入口;只移除孤兒 case/import/help lines,不可碰 exchange/session/registry/runner/dashboard commands。

## `src/agent/service.js` - 630 lines

- 處置: 部分刪。
- 理由: 只退役 `telegram-codex-service-*` 產生器;保留 exchange/codex runner與 dashboard unit generators。
- systemd unit 產生器處置:
  - 退役: `buildTelegramCodexService` lines 30-96, `buildBridgeService` lines 98-147, `writeTelegramCodexService` lines 149-172, `telegramCodexServiceStatus` lines 595-630, constants `SERVICE_NAME`, `TIMER_NAME`, `BRIDGE_SERVICE_NAME` lines 17-20 if no longer referenced.
  - 保留: `buildOpusRunnerService`/`writeOpusRunnerService`/`opusRunnerServiceStatus` lines 188-277, `buildCodexRunnerService`/`writeCodexRunnerService`/`codexRunnerServiceStatus` lines 431-517, `buildDashboardService`/`writeDashboardService`/`dashboardServiceStatus` lines 524-593, settings generators lines 292-418.
- 誰還在 import 它:
  - `src/agent/cli.js:23` imports all service functions including retired Telegram ones and retained runner/dashboard ones.
  - `test/agent-dashboard.test.js:15` imports `buildDashboardService` (retained).
  - `test/agent-telegram.test.js:2338` source-checks `service.js` for systemctl behavior.
- 對應測試檔的處置:
  - `test/agent-telegram.test.js` - 3586 lines: 刪 Telegram service tests lines 2278-2338 and bridge service tests lines 2984-3006;保留 exchange-runner service tests lines 2342-2413.
  - `test/agent-dashboard.test.js` - 280+ lines: 保留 dashboard service tests lines 202-239.
- 風險註記: 誤刪 shared `ENV_FILE`/`SERVICE_PATH` 會影響 dashboard/runner units;需先確認 constants仍被保留 generators使用。

## `src/agent/safety.js` - 572 lines

- 處置: 部分刪。
- 理由: safety config同時保存 v1 telegram-codex policy、owner allowlist、exchange runner、v2 repo settings;只能刪 v1 direct-send/loop fields。
- 部分刪欄位/區塊:
  - 刪 direct-send policy defaults lines 172-181, set/normalize branches lines 235-252, 288-297, 329-337, 355-368 if owner allowlist已另行保留/改名。
  - 刪 owner-mode classifier flags `owner_mode_enabled`, `owner_low_risk_auto_plan_enabled` lines 182-183, 253-258, 338-341 only after v2/dashboard owner判定不再依賴 `isOwner`。
  - 刪 old loop-only fields `enabled`, `require_approval`, `global_interval_seconds`, `per_chat_interval_seconds`, `max_model_calls_per_run`, `history_messages`, `context_max_chars`, `memory_enabled` if no retained code uses them.
  - 保留 `default_repo`, `exchange_notify_*`, `exchange_runner_*`, `codex_runner_model`, `v2_enabled`, `workspace_root`, kill switch and budget APIs.
  - 保留 owner allowlist semantics: current code uses `direct_send_user_allowlist` as owner list (`owner-mode.js:isOwner`, dashboard `isDashboardOwner`), so either keep it or migrate to a renamed owner allowlist in same approved work.
- 誰還在 import 它:
  - Broadly imported by runner/dashboard/gateway/v2 tests; key consumers include `src/agent/gateway.js:9`, `src/agent/telegram.js:11`, `src/agent/telegram-codex.js:12-18`, `src/agent/dashboard/bot.js:6`, `src/agent/dashboard/commands.js:4`, `src/agent/exchange-runner.js`, `src/agent/codex-exchange-runner.js`, `src/agent/v2/*`.
- 對應測試檔的處置:
  - `test/agent-telegram.test.js` - 3586 lines: 刪 direct-send/telegram-codex policy tests around lines 2632-2728;保留 exchange runner model/codex model policy tests lines 3269-3311.
  - `test/v2-*`, `test/agent-dashboard.test.js`, `test/agent-exchange-runner.test.js`, `test/agent-codex-exchange-runner.test.js`: 改 owner allowlist setup only if field rename happens;保留行為。
- 風險註記: 粗暴刪 `telegram_codex_policy` 會斷 v2 repo resolver、dashboard owner判定、runner model selection。

## `src/agent/paths.js` - 58 lines

- 處置: 部分刪。
- 理由: 只移除 old v1 ledger path keys;保留 tasks/runs/exchange/session/dashboard/registry/v2/runner paths。
- 部分刪 keys:
  - 刪 `chatInbox` line 27, `chatReplies` line 28, `draftsDir` line 29, `handoffs` line 30, `handoffsDir` line 31.
  - 刪 `codexReplies` line 45, `telegramCodexLock` line 46, `replyApprovals` line 47, `directSendAudit` line 49, `ownerModeAudit` line 50, `bridgeStatus` line 51 only after corresponding v1 modules removed.
  - 保留 `telegramState`/`telegramOutbox` lines 25-26 if `telegram.js` remains for v2;保留 `v2PollerLock`, `v2Outbox` lines 52-53.
- 誰還在 import 它:
  - Almost all modules import `agentPaths`; direct key users listed by `rg`: `src/agent/chat.js`, `src/agent/telegram.js`, `src/agent/telegram-codex.js`, `src/agent/telegram-codex-bridge.js`, `src/agent/reply-approval.js`, `src/agent/direct-send.js`, `src/agent/owner-mode.js`, `src/agent/v2/poller.js`, plus many tests.
- 對應測試檔的處置:
  - Any test reading removed paths must be deleted/updated: `test/agent.test.js`, `test/agent-telegram.test.js`, `test/agent-owner-mode.test.js`.
  - Keep path users in `test/v2-blockers-round3.test.js` lines 144/174 (`v2PollerLock`) and v2 outbox tests.
- 風險註記: Remove only unused keys after module deletion; deleting path keys too early causes import-time/runtime failures in retained v2/dashboard/exchange tests.

## `docs/AGENT_TELEGRAM_POLLING.md` - 1012 lines

- 處置: 部分刪/重寫。
- 理由: This doc describes old Telegram polling, direct replies, direct-send, systemd bridge, chat inbox/draft/handoff.
- 誰還在 import 它:
  - 無程式 import; `rg` evidence only documentation references.
- 對應測試檔的處置:
  - 無直接測試 import; update after code removal to point to v3 dashboard/session docs.
- 風險註記: Leaving stale docs will instruct operators to run retired commands/services.

## `README.md` - 346 lines / `README.zh-Hant.md` - 315 lines

- 處置: 部分刪/改。
- 理由: README still advertises `telegram-poll`, `telegram-codex-service-*`, owner-mode/direct-send policy setup and old bridge operations.
- 誰還在 import 它:
  - 無程式 import; `rg` evidence found README command references at `README.md:92,196,207-209,255,327` and `README.zh-Hant.md:82,177,188-190,234,297`.
- 對應測試檔的處置:
  - 無直接測試 import; documentation-only.
- 風險註記: Stale README can cause owner to re-enable retired `codex-agent-telegram-bridge.service`.

## 保留清單交叉檢查

- 必須保留: `src/agent/orchestrator.js` (490 lines), `src/agent/tasks.js` (176 lines), `src/agent/codex-runner.js` (156 lines): workspace-write/plan/edit runner path。
- 必須保留: `src/agent/exchange.js`, `src/agent/dispatch.js`, `src/agent/sessions.js`, `src/agent/registry.js`, `src/agent/dashboard/*`。
- 必須保留: `src/lib/secret-scan.js` and `src/agent/safety.js` kill switch/budget core。
- 必須保留: `src/agent/v2/*`; if `telegram.js` is narrowed, keep v2 launcher behavior or move it explicitly to dashboard/poller replacement first。
- `npm test` not run per instruction; this file is investigation output only.

---

# Lead 裁決(Fable,2026-07-05)

逐檔裁決如下。執行順序改為三步:**U4-pre(純新增,先做)→ owner cutover(owner 手動)→ U4-A(刪除批,cutover 後才准跑)**。理由:live systemd 服務跑在本工作樹上,先刪 v1 檔案會讓舊 bridge 在任何重啟後 import 失敗進 crash loop;且同一 bot token 只允許一個 getUpdates 輪詢者,dashboard 必須先吸收 v2 路由,cutover 才不會殺掉 v2 launcher。

## U4-pre(新工單,純新增/改 dashboard 與 telegram.js 的呼叫點,不刪任何檔)
1. dashboard bot 吸收 v2:owner 訊息以 `@` 開頭(非 `/` 指令)→ 轉交既有 `maybeHandleV2` 路徑(import telegram.js 的 v2 lane 或抽出的入口),行為與舊 bridge 一致(含 §9 start ack 與背景結果 outbox)。非 owner 照舊只回唯讀。
2. dashboard cycle 接手三個 flush:`sendPendingV2Outbox`、`sendPendingExchangeNotifications`、`sendPendingDispatchNotifications`(直接 import 呼叫,函式本體不動)。
3. 測試:@claude 文法經 dashboard 轉入 v2(假 transport,斷言 start ack + outbox flush);三個 flush 在 dashboard cycle 被呼叫(真 ledger 檔)。npm test 全綠。

## U4-A 逐檔裁決(cutover 後執行)
- direct-send.js / telegram-codex.js / telegram-codex-bridge.js / chat.js / reply-context.js / reply-approval.js / codex-reply.js / bridge.js:**核准整檔刪**,連同 killlist 列的對應測試區塊。
- owner-mode.js:**核准刪檔**,但先把 `isDangerousActionRequest` + `hasEnglishActionWord` + `escapeRegex` 抽到新 `src/agent/hard-gate.js`(公開 export,帶原 classifier 測試中對應的案例,改寫為 hard-gate 測試)。`isOwner` 隨檔亡(dashboard 自有 isDashboardOwner);動手前 grep 證實 v2 lane 不依賴 `isOwner`,若依賴,v2 改讀 policy 的 direct_send_user_allowlist,不准回頭 import 舊檔。
- telegram.js:**部分刪核准**——刪 free-form chat enqueue fallback、`sendPendingTelegramReplies`、v1 owner callback/model-control 區塊(lines ~686-921 中屬 v1 者);保留 v2 lane、transport 原語、poller lock、v2 outbox、兩個 notification flush(已由 U4-pre 接到 dashboard)。
- gateway.js:**部分刪核准**——刪 `routeOwnerOpusAsk` 與 owner classifier imports;exchange shortcuts 與 model config 保留(CLI `gateway` 續用)。
- cli.js:killlist 列的孤兒 subcommand **全數核准刪**;`telegram-poll`/`telegram-update` 保留(v2/transport 除錯煙霧路徑)。
- service.js:telegram-codex 三個產生器**退役核准**;共用常數(ENV_FILE/SERVICE_PATH)確認仍被保留產生器引用後留下。
- safety.js:**只准刪** grep 證實無保留使用者的 direct-send 內容欄位與舊 loop 欄位;`direct_send_user_allowlist` **絕對保留**(它就是 owner 名單);`owner_mode_enabled` 可刪(唯一使用者 isOwner 已亡)。
- paths.js:對應模組亡後刪 key;`telegramState`/`telegramOutbox`/v2 keys 留。
- README 兩份 + AGENT_TELEGRAM_POLLING.md:改寫,舊指令段落刪除,補 v3 看板運維段(含 cutover runbook)。

## Cutover runbook(owner 手動,兩分鐘)
```
export XDG_RUNTIME_DIR=/run/user/$(id -u)
cd ~/agent-river && node bin/codex-agent.js dashboard-service-write --dir ~/.config/systemd/user
systemctl --user daemon-reload
systemctl --user disable --now codex-agent-telegram-bridge.service
systemctl --user enable --now codex-agent-dashboard.service
journalctl --user -u codex-agent-dashboard.service -n 20   # 確認起來、無 error
```
(opus/codex runner timer 不動;蝦蝦是另一顆 bot 不受影響。)
