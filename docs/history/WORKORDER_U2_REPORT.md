# WORKORDER U2 self-review report

## What I ran
- `node --test test/agent-dashboard.test.js` — pass.
- `npm test` — pass, 17 test files, 17 pass.
- `git diff --stat` / `git status --short --branch` — reviewed changed tracked files and new untracked files.
- Forbidden-area diff check: no changes under `src/agent/telegram*.js`, `src/agent/v2/`, `src/agent/direct-send.js`, or `src/agent/owner-mode.js`.

## Round 2
- Fixed dashboard owner checks to use only `telegram_codex_policy.direct_send_user_allowlist`; `gateway_allowlist` no longer grants dashboard control access.
- Added regression coverage for a gateway-only user attempting `/sessions` and `gate:approve:*`; both return `唯讀`, and the task remains unchanged.
- Round-2 verification: `node --test test/agent-dashboard.test.js` pass; `npm test` pass, 17 test files, 17 pass.

## Constraint review
- Added the dashboard implementation under `src/agent/dashboard/`: minimal Telegram Bot API client, strict command parser, poll-based feed, callback handling, and single-instance lock.
- Added CLI subcommands: `dashboard-once`, `dashboard-bridge`, `dashboard-service-print`, `dashboard-service-write`, and `dashboard-service-status`.
- Did not modify any existing `telegram*.js` file. The dashboard uses its own small fetch/curl Bot API client because the existing low-level helpers are not cleanly exported.
- Token source remains `TELEGRAM_BOT_TOKEN`; dashboard feed chat defaults to the existing `telegram_codex_policy.exchange_notify_chat_id`, with `--dashboard-chat-id` override for tests/manual runs.
- Feed is poll-based only. It reads `sessions.jsonl`, session-bearing exchange messages/replies, and pending edit tasks. Cursor state is stored in `<stateDir>/dashboard-cursor.json`; initial cursor creation starts at current ledger tails.
- Gate messages attach `gate:approve:<task_id>` / `gate:reject:<task_id>` inline callbacks. Callbacks call existing `approveAgentTask` / `rejectAgentTask`; orchestrator/task signatures were not changed.
- Commands are strict: `/session`, `/sessions`, `/kill`, `/agents`; parse failures return a one-line usage string, and other text returns the v3 dashboard hint.
- `/session` calls U1 `openSession` with `initiator=owner`; `/kill` accepts full id or the first 6 chars of `shortHash(session_id)`.
- `/agents` only reads `<stateDir>/agent-registry.json`; missing/corrupt/empty registry returns `尚無註冊 agent`.
- Non-owner messages and callbacks are rejected with `唯讀`; owner check uses only `telegram_codex_policy.direct_send_user_allowlist`.
- Every dashboard outbound message and callback answer is redacted through `redactSecrets` before transport.
- Added `<stateDir>/dashboard.lock` with stale-lock reclaim and live second-instance refusal.
- Added dashboard systemd unit generation only; no enable/start/restart/systemctl execution is performed.

## Test coverage added
- Feed cursor behavior with real ledgers: initialize at tail, append session/exchange/reply/gate events, first poll sends them, second poll and restart do not replay.
- `/session` command writes a real `sessions.jsonl` opening event with budget/write access.
- Non-owner rejection and strict parser failure behavior.
- Gateway-only users are rejected for `/sessions` and gate callbacks without mutating task state.
- Gate callback approval/rejection changes real task approval state.
- Dashboard service unit generation and dashboard lock behavior.
- CLI smoke for `dashboard-service-write`.

## Files changed
- `src/agent/dashboard/client.js`
- `src/agent/dashboard/feed.js`
- `src/agent/dashboard/commands.js`
- `src/agent/dashboard/bot.js`
- `src/agent/paths.js`
- `src/agent/service.js`
- `src/agent/cli.js`
- `test/agent-dashboard.test.js`
- `docs/history/WORKORDER_U2_REPORT.md`

## Notes / uncertain points
- U3 has not implemented the agent registration write side yet. U2 only reads `agent-registry.json` for `/agents`; registration approval callbacks are left for the U3 producer/contract.
- The existing task store is a `tasks/` directory, not a single `tasks.json`; the dashboard watches pending edit tasks through the existing `listTasks()` API.
- No commit and no push performed.
