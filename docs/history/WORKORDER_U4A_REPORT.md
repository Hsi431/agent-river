# Workorder U4-A Report

日期: 2026-07-05
分支: `v3-session`
提交: 未 commit、未 push

## Round 2 審查修正

- Lead 否決前一輪偏離: `memory_enabled` 仍有 retained user (`orchestrator.js`) 且 prod config 開啟,不屬於 U4-A 瘦身批處理。
- `src/agent/safety.js`: restored `memory_enabled` default、`setTelegramCodexPolicy` parse branch、no-default-repo guard、normalize output。
- `src/agent/orchestrator.js`: restored `buildContextBlock` 判斷式 `Boolean(memoryStateHome || policy.memory_enabled)`。
- `src/agent/cli.js`: restored `telegram-codex-policy-set --memory-enabled` wiring and `validateValueOptions` entry。
- `test/agent.test.js`: added policy-memory regression coverage: policy `memory_enabled=true` makes `buildContextBlock` call context builder with `enabled=true`。
- 驗證: `npm test` pass, 18/18 test files。

## 刪檔

依 Lead 裁決刪除整檔:

| file | lines |
|---|---:|
| `src/agent/direct-send.js` | 334 |
| `src/agent/telegram-codex.js` | 884 |
| `src/agent/telegram-codex-bridge.js` | 212 |
| `src/agent/chat.js` | 434 |
| `src/agent/reply-context.js` | 71 |
| `src/agent/reply-approval.js` | 93 |
| `src/agent/codex-reply.js` | 77 |
| `src/agent/bridge.js` | 35 |
| `src/agent/owner-mode.js` | 422 |

刪檔合計: 9 檔, 2562 lines。前 8 檔是 U4-A 核准整檔刪;`owner-mode.js` 依裁決先抽出 hard gate 後刪。

## 新增/改檔

- 新增 `src/agent/hard-gate.js`: export `isDangerousActionRequest`, `hasEnglishActionWord`, `escapeRegex`。
- `src/agent/telegram.js`: 移除 free-form chat enqueue fallback、pending chat reply flush、v1 owner/model callback 區塊;保留 v2 lane、transport、poller lock、v2 outbox、exchange/dispatch notification flush。v2 owner check 改讀 `direct_send_user_allowlist`。
- `src/agent/gateway.js`: 移除 `routeOwnerOpusAsk` 與 owner classifier imports;保留 exchange shortcuts、runner trigger、model config,owner 判定改讀 `direct_send_user_allowlist`。
- `src/agent/cli.js`: 移除 killlist orphan subcommands;保留 `telegram-update`/`telegram-poll`、exchange/session/runner/dashboard commands。
- `src/agent/service.js`: 移除 `telegram-codex-service-*` generator/status;保留 runner/dashboard service generators and shared `ENV_FILE`/`SERVICE_PATH`。
- `src/agent/safety.js`: 移除舊 loop/direct-send/owner-mode policy fields;保留 `direct_send_user_allowlist`, `default_repo`, `memory_enabled`, exchange runner/notification, codex runner model, v2, workspace root, kill switch/budget APIs。
- `src/agent/paths.js`: 移除 retired v1 ledger keys;保留 telegram state/outbox, exchange/session/dashboard/registry/v2/runner paths。
- `src/agent/orchestrator.js`: round-2 restored memory context enablement from `memoryStateHome || policy.memory_enabled` because `memory_enabled` remains retained policy。
- Tests: deleted retired v1 blocks only; rewrote owner-mode classifier tests as hard-gate tests; adjusted v2 poller lock coverage away from retired bridge; retained dashboard/exchange/v2/runner/transport coverage。
- Docs: rewrote `README.md`, `README.zh-Hant.md`, and `docs/AGENT_TELEGRAM_POLLING.md` around v3 dashboard operations and included cutover runbook。

## 測試數變化

- Workorder note: previous count was 528。
- Local measured baseline before edits: 539 `test(...)` declarations, 18 Node test files passing。
- Final: 349 `test(...)` declarations, 18 Node test files passing。
- Net against measured baseline: -190 test declarations。

## 逐條裁決執行情況

- `direct-send.js`: done,整檔刪;對應 direct-send/DS1/DS2 tests removed。
- `owner-mode.js`: done,先抽 `hard-gate.js`,再刪檔;v2 不再 import `isOwner`,改讀 policy allowlist。
- `telegram-codex.js`: done,整檔刪;loop/once/cost/approval/direct-reply tests removed。
- `telegram-codex-bridge.js`: done,整檔刪;v2 blocker lock tests rewritten to retained poller lock functions。
- `chat.js`: done,整檔刪;chat/draft/handoff/manual reply tests removed。
- `reply-context.js`: done,整檔刪;reply context tests removed。
- `reply-approval.js`: done,整檔刪;reply approval tests removed。
- `codex-reply.js`: done,整檔刪;manual fake reply tests removed。
- `bridge.js`: done,整檔刪;`bridge-once` tests removed。
- `telegram.js`: done,partial delete only;v2/transport/poller lock/v2 outbox/exchange/dispatch notification retained。
- `gateway.js`: done,partial delete only;exchange shortcuts/model config retained。
- `cli.js`: done,orphan subcommands deleted;`telegram-poll`/`telegram-update` retained。
- `service.js`: done,telegram-codex generators retired;runner/dashboard generators retained。
- `safety.js`: done,only retired direct-send/loop/owner-mode fields removed;`direct_send_user_allowlist` retained。
- `paths.js`: done,retired keys removed after module deletion;telegram/v2 keys retained。
- README two + Telegram polling doc: done,v3 dashboard operation and cutover runbook added。

## 偏離/注意事項

- No scope expansion beyond Lead裁決。
- Round-2 review overturned the previous `memory_enabled` deviation; retained policy users now keep the full field chain and orchestrator behavior。
- The CLI no longer exposes retired direct-send/owner-mode flags. The retained owner allowlist remains stored at `telegram_codex_policy.direct_send_user_allowlist` as裁決要求。

## 驗證

- `npm test`: pass, 18/18 test files。
- `git diff --check`: pass。
